import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
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

describe("direct append ingestion", () => {
  test("ingests only complete NDJSON records through the shared normalizer", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const connection = await ensureDaemon({ homeDirectory: home });
    const persistence = await Persistence.open(home);

    try {
      const response = await fetch(
        `http://${connection.host}:${connection.port}/v1/control/sessions`,
        {
          body: JSON.stringify({
            hypothesisIds: ["H1"],
            runId: "baseline",
            workspace: "/workspace/direct",
          }),
          headers: {
            Authorization: `Bearer ${connection.controlToken}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      const created = (await response.json()) as {
        runId: string;
        sessionId: string;
      };
      const incoming = persistence.sessionFile(created.sessionId, "incoming.ndjson");
      const first = {
        data: { record: 1 },
        hypothesisId: "H1",
        id: "direct-1",
        location: "worker.py:10",
        message: "First record",
        runId: created.runId,
        schemaVersion: 1,
        sessionId: created.sessionId,
        timestamp: 1,
      };
      const second = {
        ...first,
        data: { record: 2 },
        id: "direct-2",
        message: "Second record",
        timestamp: 2,
      };
      await appendFile(incoming, `${JSON.stringify(first)}\n${JSON.stringify(second)}`);

      const store = new EventStore(persistence);
      const firstDeadline = Date.now() + 2_000;
      while ((await store.read(created.sessionId)).length < 1 && Date.now() < firstDeadline) {
        await Bun.sleep(20);
      }
      expect(await store.read(created.sessionId)).toHaveLength(1);

      await appendFile(incoming, "\n");
      const secondDeadline = Date.now() + 2_000;
      while ((await store.read(created.sessionId)).length < 2 && Date.now() < secondDeadline) {
        await Bun.sleep(20);
      }
      expect(await store.read(created.sessionId)).toHaveLength(2);
    } finally {
      await requestDaemonShutdown(connection);
    }
  }, 10_000);
});
