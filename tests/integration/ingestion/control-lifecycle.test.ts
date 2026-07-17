import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { EventStore } from "../../../src/daemon/event-store";
import { Persistence } from "../../../src/daemon/persistence";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

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
        ingestUrl: `${origin}/v1/ingest/${created.sessionId}`,
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
});
