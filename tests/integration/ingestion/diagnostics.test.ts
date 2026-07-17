import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { DiagnosticStore } from "../../../src/daemon/diagnostic-store";
import { EventStore } from "../../../src/daemon/event-store";
import { Persistence } from "../../../src/daemon/persistence";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ingestion diagnostics", () => {
  test("redacts secrets and records malformed or undeclared evidence", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const connection = await ensureDaemon({ homeDirectory: home });

    try {
      const createdResponse = await fetch(
        `http://${connection.host}:${connection.port}/v1/control/sessions`,
        {
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
        },
      );
      const created = (await createdResponse.json()) as {
        ingestUrl: string;
        runId: string;
        sessionId: string;
      };
      await fetch(created.ingestUrl, {
        body: JSON.stringify({
          data: { nested: { token: "must-not-persist" } },
          hypothesisId: "H9",
          location: "src/auth.ts:20",
          message: "Captured auth state",
          runId: created.runId,
          schemaVersion: 1,
          sessionId: created.sessionId,
          timestamp: 1,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      await fetch(created.ingestUrl, {
        body: "{not-json",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const persistence = await Persistence.open(home);
      expect((await new EventStore(persistence).read(created.sessionId))[0]?.data).toEqual({
        nested: { token: "[REDACTED]" },
      });
      expect(
        (await new DiagnosticStore(persistence).read(created.sessionId)).map(
          (diagnostic) => diagnostic.reason,
        ),
      ).toEqual(["UNDECLARED_HYPOTHESIS_ID", "SECRET_REDACTED", "INVALID_JSON"]);
    } finally {
      await requestDaemonShutdown(connection);
    }
  });
});
