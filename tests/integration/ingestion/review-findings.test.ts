import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticStore } from "../../../src/daemon/diagnostic-store";
import { DirectAppendObserver } from "../../../src/daemon/direct-append-observer";
import { EventStore } from "../../../src/daemon/event-store";
import { IngestApi, IngestionService } from "../../../src/daemon/ingest-api";
import { Persistence } from "../../../src/daemon/persistence";
import { EventSequence } from "../../../src/daemon/sequence";
import { SessionRegistry } from "../../../src/daemon/session-registry";

const MAX_RECORD_BYTES = 64 * 1024;
const temporaryDirectories: string[] = [];

interface DirectAppendTestHooks {
  afterEventAppend?(): Promise<void>;
}

interface IngestApiTestHooks {
  afterBodyRead?(): Promise<void>;
}

type ObserverConstructor = new (
  persistence: Persistence,
  sessions: SessionRegistry,
  ingestion: IngestionService,
  hooks?: DirectAppendTestHooks,
) => DirectAppendObserver;

type ApiConstructor = new (ingestion: IngestionService, hooks?: IngestApiTestHooks) => IngestApi;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-review-"));
  temporaryDirectories.push(home);
  const persistence = await Persistence.open(home);
  const events = new EventStore(persistence);
  const diagnostics = new DiagnosticStore(persistence);
  const sequence = new EventSequence(events);
  const sessions = new SessionRegistry(persistence, events, diagnostics, sequence);
  const ingestion = new IngestionService(sessions, events, diagnostics, sequence);
  return { diagnostics, events, ingestion, persistence, sessions };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: { value: 42 },
    hypothesisId: "H1",
    location: "src/example.ts:1",
    message: "Observed value",
    timestamp: 1_784_310_000_001,
    ...overrides,
  };
}

function withExactBytes(target: number, multibyte = false): string {
  const base = event({ ignoredPadding: "" });
  const empty = JSON.stringify(base);
  const missing = target - Buffer.byteLength(empty);
  if (missing < 0) {
    throw new Error("Target is smaller than the base event");
  }
  const padding = multibyte
    ? `${"é".repeat(Math.floor(missing / 2))}${missing % 2 === 0 ? "" : "x"}`
    : "x".repeat(missing);
  const record = JSON.stringify(event({ ignoredPadding: padding }));
  if (Buffer.byteLength(record) !== target) {
    throw new Error("Failed to construct an exact-size record");
  }
  return record;
}

function processSession(observer: DirectAppendObserver, sessionId: string): Promise<void> {
  return (
    observer as unknown as {
      processSession(sessionId: string): Promise<void>;
    }
  ).processSession(sessionId);
}

function normalizeDiagnostic(diagnostic: Record<string, unknown>): Record<string, unknown> {
  const { diagnosticId: _, observedAt: __, ...stable } = diagnostic;
  return stable;
}

describe("Task 5 review findings", () => {
  test("replays a direct record idempotently after cursor persistence fails", async () => {
    const { events, ingestion, persistence, sessions } = await fixture();
    const session = await sessions.create();
    const line = JSON.stringify(event({ id: "caller-controlled" }));
    await appendFile(sessions.incomingPath(session.id), `${line}\n`);
    let failOnce = true;
    const Observer = DirectAppendObserver as unknown as ObserverConstructor;
    const failing = new Observer(persistence, sessions, ingestion, {
      afterEventAppend: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("injected cursor persistence failure");
        }
      },
    });

    await expect(processSession(failing, session.id)).rejects.toThrow(
      "injected cursor persistence failure",
    );
    const first = await events.read(session.id);
    expect(first).toHaveLength(1);
    expect(first[0]?.id).not.toBe("caller-controlled");
    expect(
      JSON.parse(
        await readFile(persistence.sessionFile(session.id, "incoming.cursor.json"), "utf8"),
      ),
    ).toEqual({ offset: 0 });

    const restartedEvents = new EventStore(persistence);
    const restartedDiagnostics = new DiagnosticStore(persistence);
    const restartedSequence = new EventSequence(restartedEvents);
    const restartedSessions = new SessionRegistry(
      persistence,
      restartedEvents,
      restartedDiagnostics,
      restartedSequence,
    );
    const restartedIngestion = new IngestionService(
      restartedSessions,
      restartedEvents,
      restartedDiagnostics,
      restartedSequence,
    );
    const restarted = new Observer(persistence, restartedSessions, restartedIngestion);
    await processSession(restarted, session.id);

    expect(await restartedEvents.read(session.id)).toEqual(first);
    expect(
      await restartedIngestion.ingest(session.id, event({ message: "After replay", timestamp: 2 })),
    ).toBe("accepted");
    expect((await restartedEvents.read(session.id)).map((stored) => stored.sequence)).toEqual([
      1, 2,
    ]);
  });

  test("uses identical malformed diagnostics for HTTP and direct append", async () => {
    const { diagnostics, ingestion, persistence, sessions } = await fixture();
    const httpSession = await sessions.create();
    const fileSession = await sessions.create();
    const malformed = '{"token":"must-not-leak"';
    const Api = IngestApi as unknown as ApiConstructor;
    const api = new Api(ingestion);

    const response = await api.handle(
      new Request(`http://127.0.0.1/ingest/${httpSession.id}`, {
        body: malformed,
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
      `/ingest/${httpSession.id}`,
    );
    expect(response?.status).toBe(202);
    await appendFile(sessions.incomingPath(fileSession.id), `${malformed}\n`);
    const Observer = DirectAppendObserver as unknown as ObserverConstructor;
    await processSession(new Observer(persistence, sessions, ingestion), fileSession.id);

    const [httpDiagnostic] = await diagnostics.read(httpSession.id);
    const [fileDiagnostic] = await diagnostics.read(fileSession.id);
    expect(normalizeDiagnostic(httpDiagnostic as unknown as Record<string, unknown>)).toEqual(
      normalizeDiagnostic(fileDiagnostic as unknown as Record<string, unknown>),
    );
    expect(httpDiagnostic?.redactedPreview).not.toContain("must-not-leak");
  });

  test("applies the same record byte boundary to HTTP and direct append", async () => {
    const { diagnostics, events, ingestion, persistence, sessions } = await fixture();
    const session = await sessions.create();
    const Api = IngestApi as unknown as ApiConstructor;
    const api = new Api(ingestion);
    const Observer = DirectAppendObserver as unknown as ObserverConstructor;
    const observer = new Observer(persistence, sessions, ingestion);
    const atLimit = withExactBytes(MAX_RECORD_BYTES, true);
    const overLimit = `${atLimit}x`;

    const accepted = await api.handle(
      new Request(`http://127.0.0.1/ingest/${session.id}`, {
        body: atLimit,
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
      `/ingest/${session.id}`,
    );
    expect(accepted?.status).toBe(202);
    await appendFile(sessions.incomingPath(session.id), `${atLimit}\n`);
    await processSession(observer, session.id);
    expect(await events.read(session.id)).toHaveLength(2);

    const rejected = await api.handle(
      new Request(`http://127.0.0.1/ingest/${session.id}`, {
        body: overLimit,
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
      `/ingest/${session.id}`,
    );
    expect(rejected?.status).toBe(413);
    await appendFile(sessions.incomingPath(session.id), `${overLimit}\n`);
    await processSession(observer, session.id);
    expect(await events.read(session.id)).toHaveLength(2);
    expect((await diagnostics.read(session.id)).map((item) => item.reason)).toEqual([
      "INVALID_JSON",
      "INVALID_JSON",
    ]);
  });

  test("rejects oversized hypothesis IDs through both transports", async () => {
    const { events, ingestion, persistence, sessions } = await fixture();
    const session = await sessions.create();
    const raw = JSON.stringify(event({ hypothesisId: "H".repeat(257) }));
    const Api = IngestApi as unknown as ApiConstructor;
    const response = await new Api(ingestion).handle(
      new Request(`http://127.0.0.1/ingest/${session.id}`, {
        body: raw,
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
      `/ingest/${session.id}`,
    );
    expect(await response?.json()).toEqual({ accepted: 0, invalid: 1 });
    await appendFile(sessions.incomingPath(session.id), `${raw}\n`);
    const Observer = DirectAppendObserver as unknown as ObserverConstructor;
    await processSession(new Observer(persistence, sessions, ingestion), session.id);
    expect(await events.read(session.id)).toEqual([]);
  });

  test("returns typed not-found when deletion wins after body read", async () => {
    const { ingestion, sessions } = await fixture();
    const Api = IngestApi as unknown as ApiConstructor;
    for (const body of [JSON.stringify(event()), "{not-json"]) {
      const session = await sessions.create();
      const api = new Api(ingestion, {
        afterBodyRead: async () => {
          expect(await sessions.remove(session.id)).toBe(true);
        },
      });
      const response = await api.handle(
        new Request(`http://127.0.0.1/ingest/${session.id}`, {
          body,
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
        `/ingest/${session.id}`,
      );
      expect(response?.status).toBe(404);
      expect(await response?.json()).toEqual({ code: "SESSION_NOT_FOUND" });
    }
  });
});
