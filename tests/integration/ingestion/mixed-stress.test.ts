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

describe("mixed ingestion stress", () => {
  test("assigns unique monotonic sequences across concurrent HTTP and direct appends", async () => {
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
            runId: "stress",
            workspace: "/workspace/stress",
          }),
          headers: {
            Authorization: `Bearer ${connection.controlToken}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      const created = (await response.json()) as {
        ingestUrl: string;
        runId: string;
        sessionId: string;
      };
      const makeEvent = (transport: string, index: number) => ({
        data: { index, transport },
        hypothesisId: "H1",
        id: `${transport}-${index}`,
        location: `${transport}.ts:${index + 1}`,
        message: `${transport} event`,
        runId: created.runId,
        schemaVersion: 1,
        sessionId: created.sessionId,
        timestamp: index,
      });
      const direct = Array.from({ length: 100 }, (_, index) =>
        JSON.stringify(makeEvent("direct", index)),
      ).join("\n");
      const directWrite = appendFile(
        persistence.sessionFile(created.sessionId, "incoming.ndjson"),
        `${direct}\n`,
      );
      const httpWrites = Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          fetch(created.ingestUrl, {
            body: JSON.stringify(makeEvent("http", index)),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }),
        ),
      );
      await Promise.all([directWrite, httpWrites]);

      const store = new EventStore(persistence);
      const deadline = Date.now() + 5_000;
      while ((await store.read(created.sessionId)).length < 200 && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      const events = await store.read(created.sessionId);
      expect(events).toHaveLength(200);
      expect(events.map((event) => event.sequence).sort((left, right) => left - right)).toEqual(
        Array.from({ length: 200 }, (_, index) => index + 1),
      );
    } finally {
      await requestDaemonShutdown(connection);
    }
  }, 15_000);
});
