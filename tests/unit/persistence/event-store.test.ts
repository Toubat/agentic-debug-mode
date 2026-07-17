import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../../../src/daemon/event-store";
import { Persistence } from "../../../src/daemon/persistence";
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

describe("event store", () => {
  test("serializes a clear between earlier and later appends", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const session = await new SessionRegistry(persistence).create();
    const store = new EventStore(persistence);
    const before = event("before", 1);
    const after = event("after", 2);

    const firstAppend = store.append(session.id, before);
    const clear = store.clear(session.id);
    const secondAppend = store.append(session.id, after);
    await Promise.all([firstAppend, clear, secondAppend]);

    expect(await store.read(session.id)).toEqual([after]);
  });

  test("streams a bounded snapshot page with aggregate counts", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const session = await new SessionRegistry(persistence).create();
    const store = new EventStore(persistence);
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
      records: [expect.objectContaining({ id: "second" })],
      recordsByHypothesis: { H1: 2, H9: 1 },
      totalRecords: 3,
      watermark: 3,
    });
  });
});
