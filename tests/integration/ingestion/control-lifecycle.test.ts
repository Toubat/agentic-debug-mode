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
  test("declares a new immutable run and clears only the selected run", async () => {
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
          body: JSON.stringify({
            hypothesisIds: ["H1"],
            runId: "baseline",
            workspace: "/workspace/project",
          }),
          headers,
          method: "POST",
        })
      ).json()) as {
        ingestUrl: string;
        sessionId: string;
      };
      const event = (runId: string, id: string) => ({
        data: { id },
        hypothesisId: "H1",
        id,
        location: "src/example.ts:1",
        message: "Lifecycle event",
        runId,
        schemaVersion: 1,
        sessionId: created.sessionId,
        timestamp: 1,
      });
      await fetch(created.ingestUrl, {
        body: JSON.stringify(event("baseline", "baseline-event")),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const runResponse = await fetch(`${origin}/v1/control/sessions/${created.sessionId}/runs`, {
        body: JSON.stringify({
          hypothesisIds: ["H1"],
          runId: "fixed",
        }),
        headers,
        method: "POST",
      });
      expect(runResponse.status).toBe(201);
      await fetch(created.ingestUrl, {
        body: JSON.stringify(event("fixed", "fixed-event")),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const clearResponse = await fetch(
        `${origin}/v1/control/sessions/${created.sessionId}/clear`,
        {
          body: JSON.stringify({ runId: "baseline" }),
          headers,
          method: "POST",
        },
      );
      expect(clearResponse.status).toBe(200);
      expect(
        (await new EventStore(await Persistence.open(home)).read(created.sessionId)).map(
          (item) => item.id,
        ),
      ).toEqual(["fixed-event"]);
    } finally {
      await requestDaemonShutdown(connection);
    }
  });
});
