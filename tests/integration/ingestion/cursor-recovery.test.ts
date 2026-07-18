import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("direct append cursor recovery", () => {
  test("restarts from a safe boundary when cursor metadata is corrupted", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const connection = await ensureDaemon({ homeDirectory: home });
    const persistence = await Persistence.open(home);

    try {
      const created = (await (
        await fetch(`http://${connection.host}:${connection.port}/v1/control/sessions`, {
          body: JSON.stringify({
            hypothesisIds: ["H1"],
            runId: "baseline",
            workspace: "/workspace/project",
          }),
          headers: {
            Authorization: `Bearer ${connection.controlToken}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        })
      ).json()) as { sessionId: string };
      await writeFile(
        persistence.sessionFile(created.sessionId, "incoming.cursor.json"),
        "{corrupt",
      );
      await appendFile(
        persistence.sessionFile(created.sessionId, "incoming.ndjson"),
        `${JSON.stringify({
          data: { recovered: true },
          hypothesisId: "H1",
          id: "after-corrupt-cursor",
          location: "worker.go:1",
          message: "Recovered event",
          runId: "baseline",
          schemaVersion: 1,
          sessionId: created.sessionId,
          timestamp: 1,
        })}\n`,
      );

      const store = new EventStore(persistence);
      const deadline = Date.now() + 2_000;
      while ((await store.read(created.sessionId)).length === 0 && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(await store.read(created.sessionId)).toHaveLength(1);
    } finally {
      await requestDaemonShutdown(connection);
    }
  });
});
