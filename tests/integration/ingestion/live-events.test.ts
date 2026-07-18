import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("live event stream", () => {
  test("streams accepted session events over authenticated SSE", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const connection = await ensureDaemon({ homeDirectory: home });
    const origin = `http://${connection.host}:${connection.port}`;

    try {
      const createdResponse = await fetch(`${origin}/v1/control/sessions`, {
        body: JSON.stringify({
          hypothesisIds: ["H1"],
          runId: "baseline",
          workspace: "/workspace/live",
        }),
        headers: {
          Authorization: `Bearer ${connection.controlToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const created = (await createdResponse.json()) as {
        ingestUrl: string;
        sessionId: string;
      };
      const controller = new AbortController();
      const streamResponse = await fetch(`${origin}/v1/events/${created.sessionId}`, {
        headers: { Authorization: `Bearer ${connection.controlToken}` },
        signal: controller.signal,
      });
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");

      await fetch(created.ingestUrl, {
        body: JSON.stringify({
          data: { live: true },
          hypothesisId: "H1",
          location: "src/live.ts:1",
          message: "Live event",
          runId: "baseline",
          schemaVersion: 1,
          sessionId: created.sessionId,
          timestamp: Date.now(),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const reader = streamResponse.body?.getReader();
      const text = await Promise.race([
        (async () => {
          let received = "";
          while (!received.includes('"message":"Live event"')) {
            const chunk = await reader?.read();
            if (!chunk || chunk.done) {
              break;
            }
            received += new TextDecoder().decode(chunk.value);
          }
          return received;
        })(),
        Bun.sleep(2_000).then(() => {
          throw new Error("Timed out waiting for SSE event");
        }),
      ]);
      expect(text).toContain('"message":"Live event"');
      controller.abort();
      await reader?.cancel();
    } finally {
      await requestDaemonShutdown(connection);
    }
  }, 10_000);
});
