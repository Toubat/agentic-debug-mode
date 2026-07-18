import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticStore } from "../../../src/daemon/diagnostic-store";
import { EventStore, type EventStoreOptions } from "../../../src/daemon/event-store";
import { Persistence } from "../../../src/daemon/persistence";
import { EventSequence } from "../../../src/daemon/sequence";
import { SessionRegistry } from "../../../src/daemon/session-registry";
import type { NormalizedEvent } from "../../../src/domain/event";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

function event(id: string, sequence: number): NormalizedEvent {
  return {
    data: { id },
    hypothesisId: "H1",
    id,
    location: "src/example.ts:1",
    message: "Observed value",
    receivedAt: sequence,
    sequence,
    timestamp: sequence,
  };
}

async function fixture(options: EventStoreOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
  temporaryDirectories.push(home);
  const persistence = await Persistence.open(home);
  const store = new EventStore(persistence, options);
  const diagnostics = new DiagnosticStore(persistence);
  const sequence = new EventSequence(store);
  const session = await new SessionRegistry(persistence, store, diagnostics, sequence).create();
  return { persistence, session, store };
}

describe("event store", () => {
  test("serializes a clear between earlier and later appends", async () => {
    const { session, store } = await fixture();
    const before = event("before", 1);
    const after = event("after", 2);

    const firstAppend = store.append(session.id, before);
    const clear = store.clear(session.id);
    const secondAppend = store.append(session.id, after);
    await Promise.all([firstAppend, clear, secondAppend]);

    expect(await store.read(session.id)).toEqual([after]);
  });

  test("streams a bounded snapshot page with aggregate counts", async () => {
    const { session, store } = await fixture();
    await store.append(session.id, event("first", 1));
    await store.append(session.id, event("second", 2));
    await store.append(session.id, {
      ...event("undeclared", 3),
      hypothesisId: "H9",
    });

    expect(
      await store.readPage(session.id, {
        hypothesisIds: [],
        limit: 1,
        offset: 1,
        watermark: 3,
      }),
    ).toEqual({
      evidenceEpoch: session.evidenceEpoch,
      records: [expect.objectContaining({ id: "second" })],
      recordsByHypothesis: { H1: 2, H9: 1 },
      totalRecords: 3,
      watermark: 3,
    });
  });

  test("externally sorts a larger page in bounded chunks and cleans temporary files", async () => {
    const { persistence, session, store } = await fixture({ sortChunkSize: 7 });
    const events = Array.from({ length: 250 }, (_, index) => ({
      ...event(`event-${index + 1}`, index + 1),
      timestamp: (index * 37) % 17,
    }));
    for (const item of events) {
      await store.append(session.id, item);
    }
    const expected = [...events].sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        left.sequence - right.sequence ||
        left.id.localeCompare(right.id),
    );

    const page = await store.readPage(session.id, {
      hypothesisIds: [],
      limit: 25,
      offset: 40,
    });

    expect(page.records.map((item) => item.id)).toEqual(
      expected.slice(40, 65).map((item) => item.id),
    );
    expect(page.totalRecords).toBe(250);
    expect(page.recordsByHypothesis).toEqual({ H1: 250 });
    expect(await readdir(join(persistence.sessionDirectory(session.id), "log-sort"))).toEqual([]);
  });

  test("closes every sorted reader after repeated early-limit pages", async () => {
    let openReaders = 0;
    let totalOpened = 0;
    const { session, store } = await fixture({
      sortChunkSize: 2,
      sortedReaderHooks: {
        onClose: () => {
          openReaders -= 1;
        },
        onOpen: () => {
          openReaders += 1;
          totalOpened += 1;
        },
      },
    });
    for (let index = 0; index < 20; index += 1) {
      await store.append(session.id, {
        ...event(`reader-${index + 1}`, index + 1),
        timestamp: 20 - index,
      });
    }

    for (let offset = 0; offset < 5; offset += 1) {
      const page = await store.readPage(session.id, {
        hypothesisIds: [],
        limit: 1,
        offset,
      });
      expect(page.records).toHaveLength(1);
      expect(openReaders).toBe(0);
    }
    expect(totalOpened).toBeGreaterThan(0);
  });

  test("closes readers opened before a partial reader-open failure", async () => {
    let openReaders = 0;
    const { session, store } = await fixture({
      sortChunkSize: 1,
      sortedReaderHooks: {
        failOpenAt: 1,
        onClose: () => {
          openReaders -= 1;
        },
        onOpen: () => {
          openReaders += 1;
        },
      },
    });
    await store.append(session.id, event("first-reader", 1));
    await store.append(session.id, event("second-reader", 2));

    await expect(
      store.readPage(session.id, {
        hypothesisIds: [],
        limit: 1,
        offset: 0,
      }),
    ).rejects.toThrow("Injected sorted reader open failure");
    expect(openReaders).toBe(0);
  });
});
