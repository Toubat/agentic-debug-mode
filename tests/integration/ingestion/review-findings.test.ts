import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
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
  afterDiagnosticAppend?(): Promise<void>;
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

async function rawPost(
  port: number,
  target: string,
  body: string,
): Promise<{ body: string; status: number }> {
  const response = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(
        [
          `POST ${target} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          body,
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const received = Buffer.concat(chunks);
      const separator = received.indexOf("\r\n\r\n");
      if (separator < 0) {
        return;
      }
      const headers = received.subarray(0, separator).toString("latin1");
      const contentLength = /(?:^|\r\n)content-length:\s*(\d+)/i.exec(headers)?.[1];
      if (
        (contentLength !== undefined &&
          received.byteLength >= separator + 4 + Number(contentLength)) ||
        (/(?:^|\r\n)transfer-encoding:\s*chunked/i.test(headers) &&
          received.subarray(separator + 4).includes("\r\n0\r\n\r\n"))
      ) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("error", reject);
  });
  const separator = response.indexOf("\r\n\r\n");
  const headers = response.subarray(0, separator).toString("latin1");
  const encodedBody = response.subarray(separator + 4);
  let responseBody: Buffer;
  if (/(?:^|\r\n)transfer-encoding:\s*chunked/i.test(headers)) {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < encodedBody.byteLength) {
      const sizeEnd = encodedBody.indexOf("\r\n", offset);
      const size = Number.parseInt(encodedBody.subarray(offset, sizeEnd).toString("ascii"), 16);
      if (size === 0) {
        break;
      }
      const start = sizeEnd + 2;
      chunks.push(encodedBody.subarray(start, start + size));
      offset = start + size + 2;
    }
    responseBody = Buffer.concat(chunks);
  } else {
    responseBody = encodedBody;
  }
  const status = Number(headers.slice(0, headers.indexOf("\r\n")).split(" ")[1]);
  return { body: responseBody.toString("utf8"), status };
}

describe("Task 5 review findings", () => {
  test("rejects raw traversal targets before URL normalization can retarget", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-raw-target-"));
    temporaryDirectories.push(home);
    const connection = await ensureDaemon({ homeDirectory: home });
    const persistence = await Persistence.open(home);
    try {
      const created = (await (
        await fetch(`http://${connection.host}:${connection.port}/v1/control/sessions`, {
          headers: { Authorization: `Bearer ${connection.controlToken}` },
          method: "POST",
        })
      ).json()) as { sessionId: string };
      const body = JSON.stringify(event());
      const targets = [
        `/ingest/not-a-session/../${created.sessionId}`,
        `/ingest/%2e%2E/ingest/${created.sessionId}`,
        `/ingest/%2E%2e%2Fingest%2F${created.sessionId}`,
        `/ingest/${created.sessionId}?retarget=/ingest/${created.sessionId}`,
        `/ingest/${created.sessionId}#retarget`,
      ];

      for (const target of targets) {
        const response = await rawPost(connection.port, target, body);
        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ code: "INVALID_ARGUMENTS" });
      }
      expect(await new EventStore(persistence).read(created.sessionId)).toEqual([]);
    } finally {
      await requestDaemonShutdown(connection);
    }
  });

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

  test("replays direct malformed and over-limit diagnostics idempotently", async () => {
    for (const line of ['{"malformed":', withExactBytes(MAX_RECORD_BYTES + 1)]) {
      const { diagnostics, events, ingestion, persistence, sessions } = await fixture();
      const session = await sessions.create();
      await appendFile(sessions.incomingPath(session.id), `${line}\n`);
      let failOnce = true;
      const Observer = DirectAppendObserver as unknown as ObserverConstructor;
      const failing = new Observer(persistence, sessions, ingestion, {
        afterDiagnosticAppend: async () => {
          if (failOnce) {
            failOnce = false;
            throw new Error("injected diagnostic cursor failure");
          }
        },
      });

      await expect(processSession(failing, session.id)).rejects.toThrow(
        "injected diagnostic cursor failure",
      );
      const [firstDiagnostic] = await diagnostics.read(session.id);
      if (!firstDiagnostic) {
        throw new Error("Expected the first direct diagnostic");
      }
      expect(firstDiagnostic?.diagnosticId).toMatch(/^diag_[0-9a-f]{64}$/);
      expect(await events.read(session.id)).toEqual([]);
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
      await processSession(
        new Observer(persistence, restartedSessions, restartedIngestion),
        session.id,
      );

      expect(await restartedDiagnostics.read(session.id)).toEqual([firstDiagnostic]);
      expect(await restartedIngestion.ingest(session.id, event())).toBe("accepted");
      expect((await restartedEvents.read(session.id)).map((stored) => stored.sequence)).toEqual([
        1,
      ]);
    }
  });

  test("reports and replays a multichunk UTF-8 record without materializing it", async () => {
    const { diagnostics, ingestion, persistence, sessions } = await fixture();
    const session = await sessions.create();
    const line = `{"value":"${"é".repeat(300_000)}"}`;
    const expectedBytes = Buffer.byteLength(line);
    await appendFile(sessions.incomingPath(session.id), `${line}\n`);
    let failOnce = true;
    const Observer = DirectAppendObserver as unknown as ObserverConstructor;
    const failing = new Observer(persistence, sessions, ingestion, {
      afterDiagnosticAppend: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("injected large-record cursor failure");
        }
      },
    });

    await expect(processSession(failing, session.id)).rejects.toThrow(
      "injected large-record cursor failure",
    );
    const [firstDiagnostic] = await diagnostics.read(session.id);
    if (!firstDiagnostic) {
      throw new Error("Expected the large-record diagnostic");
    }
    expect(firstDiagnostic?.message).toContain(`${expectedBytes} bytes`);
    expect(firstDiagnostic?.redactedPreview.length).toBeLessThanOrEqual(128);
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
    await processSession(
      new Observer(persistence, restartedSessions, restartedIngestion),
      session.id,
    );

    expect(await restartedDiagnostics.read(session.id)).toEqual([firstDiagnostic]);
    expect(
      JSON.parse(
        await readFile(persistence.sessionFile(session.id, "incoming.cursor.json"), "utf8"),
      ),
    ).toEqual({ offset: expectedBytes + 1 });
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
    const [httpDiagnostic, fileDiagnostic] = await diagnostics.read(session.id);
    expect(normalizeDiagnostic(httpDiagnostic as unknown as Record<string, unknown>)).toEqual(
      normalizeDiagnostic(fileDiagnostic as unknown as Record<string, unknown>),
    );
    expect(httpDiagnostic?.message).toContain(`actual: ${MAX_RECORD_BYTES + 1} bytes`);
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
