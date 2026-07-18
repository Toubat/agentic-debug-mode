import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import {
  ActivityTracker,
  type Clock,
  IDLE_TIMEOUT_MILLISECONDS,
} from "../../../src/daemon/activity";
import type { ControlApi } from "../../../src/daemon/control-api";
import { DiagnosticStore } from "../../../src/daemon/diagnostic-store";
import { DirectAppendObserver } from "../../../src/daemon/direct-append-observer";
import { EventStore } from "../../../src/daemon/event-store";
import type { IngestApi } from "../../../src/daemon/ingest-api";
import { IngestionService } from "../../../src/daemon/ingest-api";
import { Persistence } from "../../../src/daemon/persistence";
import { EventSequence } from "../../../src/daemon/sequence";
import { startDaemonServer } from "../../../src/daemon/server";
import { SessionRegistry } from "../../../src/daemon/session-registry";
import { MAX_INGESTION_RECORD_BYTES } from "../../../src/domain/ingestion";

interface ScheduledCallback {
  callback: () => void;
  cleared: boolean;
  dueAt: number;
  id: number;
}

class FakeClock implements Clock {
  private currentTime = 0;
  private nextId = 1;
  readonly scheduled: ScheduledCallback[] = [];

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
    const scheduled = {
      callback,
      cleared: false,
      dueAt: this.currentTime + milliseconds,
      id: this.nextId,
    };
    this.nextId += 1;
    this.scheduled.push(scheduled);
    return scheduled as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    const scheduled = handle as unknown as ScheduledCallback;
    scheduled.cleared = true;
  }

  advance(milliseconds: number): void {
    this.currentTime += milliseconds;
    while (true) {
      const next = this.scheduled.find(
        (scheduled) => !scheduled.cleared && scheduled.dueAt <= this.currentTime,
      );
      if (!next) {
        return;
      }
      next.cleared = true;
      next.callback();
    }
  }

  fireStale(index: number): void {
    this.scheduled[index]?.callback();
  }
}

class ZeroHandleClock implements Clock {
  readonly callbacks: Array<() => void> = [];
  readonly cleared: Array<ReturnType<typeof setTimeout>> = [];

  now(): number {
    return 0;
  }

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    this.callbacks.push(callback);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.cleared.push(handle);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("daemon inactivity tracking", () => {
  test("stops exactly at thirty idle minutes", () => {
    const clock = new FakeClock();
    let stops = 0;
    const activity = new ActivityTracker(clock, () => {
      stops += 1;
    });

    clock.advance(IDLE_TIMEOUT_MILLISECONDS - 1);
    expect(stops).toBe(0);
    clock.advance(1);
    expect(stops).toBe(1);

    clock.advance(IDLE_TIMEOUT_MILLISECONDS);
    activity.stop();
    expect(stops).toBe(1);
  });

  test("touch rearms once and stale callbacks cannot stop newly active service", () => {
    const clock = new FakeClock();
    let stops = 0;
    const activity = new ActivityTracker(clock, () => {
      stops += 1;
    });

    clock.advance(IDLE_TIMEOUT_MILLISECONDS - 1);
    activity.touch();
    expect(clock.scheduled).toHaveLength(2);
    clock.fireStale(0);
    expect(stops).toBe(0);

    clock.advance(IDLE_TIMEOUT_MILLISECONDS - 1);
    expect(stops).toBe(0);
    clock.advance(1);
    expect(stops).toBe(1);
  });

  test("leases prevent shutdown and release starts a fresh idle window", () => {
    const clock = new FakeClock();
    let stops = 0;
    const activity = new ActivityTracker(clock, () => {
      stops += 1;
    });

    const release = activity.acquireLease();
    clock.advance(IDLE_TIMEOUT_MILLISECONDS * 2);
    expect(stops).toBe(0);

    release();
    release();
    clock.advance(IDLE_TIMEOUT_MILLISECONDS - 1);
    expect(stops).toBe(0);
    clock.advance(1);
    expect(stops).toBe(1);
  });

  test("stop is idempotent and prevents later callbacks", () => {
    const clock = new FakeClock();
    let stops = 0;
    const activity = new ActivityTracker(clock, () => {
      stops += 1;
    });

    activity.stop();
    activity.stop();
    activity.touch();
    clock.fireStale(0);
    clock.advance(IDLE_TIMEOUT_MILLISECONDS);

    expect(stops).toBe(0);
    expect(clock.scheduled).toHaveLength(1);
  });

  test("clears a timer whose clock handle is zero", () => {
    const clock = new ZeroHandleClock();
    const activity = new ActivityTracker(clock, () => undefined);

    activity.touch();
    const release = activity.acquireLease();
    release();
    activity.stop();

    expect(clock.cleared).toHaveLength(3);
    expect(clock.cleared.every((handle) => (handle as unknown as number) === 0)).toBe(true);
    expect(clock.callbacks).toHaveLength(3);
  });
});

describe("daemon server inactivity shutdown", () => {
  test("every request touches activity and shutdown removes only service state", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-idle-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const sessions = new SessionRegistry(persistence);
    const session = await sessions.create(0);
    const clock = new FakeClock();
    const token = "idle-control-token";
    const controlApi = {
      async handle() {
        return undefined;
      },
    } as unknown as ControlApi;
    const ingestApi = {
      async handle(_request: Request, pathname: string) {
        if (pathname.startsWith("/ingest/")) {
          return Response.json({ code: "INVALID_ARGUMENTS" }, { status: 400 });
        }
        return undefined;
      },
    } as unknown as IngestApi;
    const service = await startDaemonServer({
      clock,
      controlApi,
      controlToken: token,
      getActiveSessionCount: async () => 1,
      ingestApi,
      nonce: randomUUID(),
      stateRoot: persistence.stateRoot,
    });
    const connection = { ...service.metadata, controlToken: token };

    try {
      clock.advance(IDLE_TIMEOUT_MILLISECONDS - 1);
      const rejected = await fetch(
        `http://${connection.host}:${connection.port}/ingest/not-a-session`,
        { method: "POST" },
      );
      expect(rejected.status).toBe(400);

      clock.advance(IDLE_TIMEOUT_MILLISECONDS - 1);
      let stopped = false;
      void service.stopped.then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      clock.advance(1);
      await service.stopped;
      expect(await sessions.get(session.id)).toEqual(session);
    } finally {
      await requestDaemonShutdown(connection).catch(() => undefined);
    }
  });

  test("live response lease survives the idle boundary and releases on cancellation", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-idle-stream-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const clock = new FakeClock();
    const token = "idle-stream-control-token";
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let markFinished: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    const controlApi = {
      async handle(_request: Request, pathname: string) {
        if (pathname !== "/v1/events/session") {
          return undefined;
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    } as unknown as ControlApi;
    const ingestApi = {
      async handle() {
        return undefined;
      },
    } as unknown as IngestApi;
    const service = await startDaemonServer({
      clock,
      controlApi,
      controlToken: token,
      getActiveSessionCount: async () => 0,
      hooks: {
        onResponseFinished() {
          markFinished?.();
        },
      },
      ingestApi,
      nonce: randomUUID(),
      stateRoot: persistence.stateRoot,
    });
    const connection = { ...service.metadata, controlToken: token };
    const abort = new AbortController();

    try {
      const response = await fetch(
        `http://${connection.host}:${connection.port}/v1/events/session`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        },
      );
      const reader = response.body?.getReader();
      expect((await reader?.read())?.done).toBe(false);

      clock.advance(IDLE_TIMEOUT_MILLISECONDS * 2);
      let stopped = false;
      void service.stopped.then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      abort.abort();
      await reader?.cancel().catch(() => undefined);
      streamController?.close();
      await finished;
      clock.advance(IDLE_TIMEOUT_MILLISECONDS);
      await service.stopped;
    } finally {
      abort.abort();
      await requestDaemonShutdown(connection).catch(() => undefined);
    }
  });
});

describe("direct ingestion inactivity", () => {
  test("touches once for every complete record attempt but not trailing bytes", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-idle-direct-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const events = new EventStore(persistence);
    const diagnostics = new DiagnosticStore(persistence);
    const sequence = new EventSequence(events);
    const sessions = new SessionRegistry(persistence, events, diagnostics, sequence);
    const session = await sessions.create(0);
    const ingestion = new IngestionService(sessions, events, diagnostics, sequence);
    let touches = 0;
    const observer = new DirectAppendObserver(persistence, sessions, ingestion, {
      onCompleteRecordObserved() {
        touches += 1;
      },
    });
    const incoming = sessions.incomingPath(session.id);
    const valid = JSON.stringify({
      data: { value: 1 },
      hypothesisId: "H1",
      location: "src/example.ts:1",
      message: "Observed",
      timestamp: 1,
    });
    const invalid = JSON.stringify({ message: "missing required fields" });
    await appendFile(
      incoming,
      `${valid}\n{malformed\n${invalid}\n${"x".repeat(MAX_INGESTION_RECORD_BYTES + 1)}\n{trailing`,
    );

    await (
      observer as unknown as {
        tick(): Promise<void>;
      }
    ).tick();
    expect(touches).toBe(4);

    await appendFile(incoming, "\n");
    await (
      observer as unknown as {
        tick(): Promise<void>;
      }
    ).tick();
    expect(touches).toBe(5);
  });

  test("touches before a complete record ingestion held across the idle deadline", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-idle-direct-held-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const sessions = new SessionRegistry(persistence);
    const session = await sessions.create(0);
    const clock = new FakeClock();
    let stops = 0;
    const activity = new ActivityTracker(clock, () => {
      stops += 1;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let rejectIngestion: ((error: Error) => void) | undefined;
    const heldIngestion = new Promise<never>((_resolve, reject) => {
      rejectIngestion = reject;
    });
    const ingestion = {
      ingestRecord() {
        markStarted?.();
        return heldIngestion;
      },
    } as unknown as IngestionService;
    const observer = new DirectAppendObserver(persistence, sessions, ingestion, {
      onCompleteRecordObserved() {
        activity.touch();
      },
    });
    await appendFile(sessions.incomingPath(session.id), '{"complete":true}\n');

    clock.advance(IDLE_TIMEOUT_MILLISECONDS - 1);
    const tick = (
      observer as unknown as {
        tick(): Promise<void>;
      }
    ).tick();
    await started;
    clock.advance(1);

    expect(stops).toBe(0);
    rejectIngestion?.(new Error("held ingestion failed"));
    await expect(tick).rejects.toThrow("held ingestion failed");
    clock.advance(IDLE_TIMEOUT_MILLISECONDS - 2);
    expect(stops).toBe(0);
    clock.advance(1);
    expect(stops).toBe(1);
  });
});
