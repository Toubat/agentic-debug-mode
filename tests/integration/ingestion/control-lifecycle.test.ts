import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { ControlApi } from "../../../src/daemon/control-api";
import { DiagnosticStore } from "../../../src/daemon/diagnostic-store";
import { EventStore } from "../../../src/daemon/event-store";
import { Persistence } from "../../../src/daemon/persistence";
import { SessionRegistry } from "../../../src/daemon/session-registry";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

function holdSessionOperation(persistence: Persistence, sessionId: string) {
  let release: (() => void) | undefined;
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const operation = persistence.runSessionOperation(
    sessionId,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        markEntered?.();
      }),
  );
  return {
    entered,
    operation,
    release: () => release?.(),
  };
}

describe("control API lifecycle", () => {
  test("creates, resets, lists, and removes one explicit session", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const connection = await ensureDaemon({ homeDirectory: home });
    const origin = `http://${connection.host}:${connection.port}`;
    const headers = {
      Authorization: `Bearer ${connection.controlToken}`,
      "Content-Type": "application/json",
    };

    try {
      const created = (await (
        await fetch(`${origin}/v1/control/sessions`, {
          headers,
          method: "POST",
        })
      ).json()) as {
        appendPath: string;
        ingestUrl: string;
        sessionId: string;
      };
      expect(created).toEqual({
        appendPath: expect.stringContaining("incoming.ndjson"),
        ingestUrl: `${origin}/ingest/${created.sessionId}`,
        sessionId: expect.any(String),
      });

      await fetch(created.ingestUrl, {
        body: JSON.stringify({
          data: { id: "event-before-reset" },
          hypothesisId: "H1",
          location: "src/example.ts:1",
          message: "Lifecycle event",
          timestamp: 1,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const resetResponse = await fetch(
        `${origin}/v1/control/sessions/${created.sessionId}/reset`,
        {
          headers,
          method: "POST",
        },
      );
      expect(resetResponse.status).toBe(200);
      expect(await resetResponse.json()).toEqual({
        appendPath: created.appendPath,
        ingestUrl: created.ingestUrl,
        sessionId: created.sessionId,
      });
      expect(await new EventStore(await Persistence.open(home)).read(created.sessionId)).toEqual(
        [],
      );

      const listedResponse = await fetch(`${origin}/v1/control/sessions?all=false`, {
        headers,
      });
      expect(listedResponse.status).toBe(200);
      const listed = (await listedResponse.json()) as {
        sessions: Array<{ id: string }>;
      };
      expect(listed.sessions.map((session) => session.id)).toContain(created.sessionId);

      const deleteResponse = await fetch(`${origin}/v1/control/sessions/${created.sessionId}`, {
        headers,
        method: "DELETE",
      });
      expect(deleteResponse.status).toBe(200);
      expect(await deleteResponse.json()).toEqual({
        removed: true,
        sessionId: created.sessionId,
      });

      for (const [method, path] of [
        ["POST", `/v1/control/sessions/${created.sessionId}/reset`],
        ["DELETE", `/v1/control/sessions/${created.sessionId}`],
      ] as const) {
        const missing = await fetch(`${origin}${path}`, { headers, method });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ code: "SESSION_NOT_FOUND" });
      }
    } finally {
      await requestDaemonShutdown(connection);
    }
  });

  test("returns typed outcomes for both reset-clean operation orderings", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const events = new EventStore(persistence);
    const diagnostics = new DiagnosticStore(persistence);
    const sessions = new SessionRegistry(persistence, events, diagnostics);
    const api = new ControlApi(sessions, events, diagnostics);
    const origin = "http://127.0.0.1:12345";

    const cleanWinner = await sessions.create();
    const cleanHeld = holdSessionOperation(persistence, cleanWinner.id);
    await cleanHeld.entered;
    const cleanResponse = api.handle(
      new Request(`${origin}/v1/control/sessions/${cleanWinner.id}`, { method: "DELETE" }),
      `/v1/control/sessions/${cleanWinner.id}`,
      origin,
    );
    const losingResetResponse = api.handle(
      new Request(`${origin}/v1/control/sessions/${cleanWinner.id}/reset`, { method: "POST" }),
      `/v1/control/sessions/${cleanWinner.id}/reset`,
      origin,
    );
    cleanHeld.release();

    await cleanHeld.operation;
    expect((await cleanResponse)?.status).toBe(200);
    const resetNotFound = await losingResetResponse;
    expect(resetNotFound?.status).toBe(404);
    expect(await resetNotFound?.json()).toEqual({ code: "SESSION_NOT_FOUND" });

    const resetWinner = await sessions.create();
    const resetHeld = holdSessionOperation(persistence, resetWinner.id);
    await resetHeld.entered;
    const resetResponse = api.handle(
      new Request(`${origin}/v1/control/sessions/${resetWinner.id}/reset`, { method: "POST" }),
      `/v1/control/sessions/${resetWinner.id}/reset`,
      origin,
    );
    const queuedCleanResponse = api.handle(
      new Request(`${origin}/v1/control/sessions/${resetWinner.id}`, { method: "DELETE" }),
      `/v1/control/sessions/${resetWinner.id}`,
      origin,
    );
    resetHeld.release();

    await resetHeld.operation;
    expect((await resetResponse)?.status).toBe(200);
    expect((await queuedCleanResponse)?.status).toBe(200);
    expect(await sessions.get(resetWinner.id)).toBeUndefined();
  });
});
