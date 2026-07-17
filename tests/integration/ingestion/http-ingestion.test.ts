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

describe("HTTP ingestion", () => {
  test("creates a scoped run and normalizes an authenticated capability event", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const connection = await ensureDaemon({ homeDirectory: home });
    const controlHeaders = {
      Authorization: `Bearer ${connection.controlToken}`,
      "Content-Type": "application/json",
    };

    try {
      const createdResponse = await fetch(
        `http://${connection.host}:${connection.port}/v1/control/sessions`,
        {
          body: JSON.stringify({
            hypothesisIds: ["H1", "H2"],
            runId: "baseline",
            workspace: "/workspace/project",
          }),
          headers: controlHeaders,
          method: "POST",
        },
      );
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as {
        ingestUrl: string;
        runId: string;
        sessionId: string;
      };

      const ingestResponse = await fetch(created.ingestUrl, {
        body: JSON.stringify({
          data: { subtotal: 9_000 },
          hypothesisId: "H1",
          location: "src/cart.ts:84",
          message: "Before discount calculation",
          runId: created.runId,
          schemaVersion: 1,
          sessionId: created.sessionId,
          timestamp: 1_784_310_000_123,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      expect(ingestResponse.status).toBe(202);

      const events = await new EventStore(await Persistence.open(home)).read(
        created.sessionId,
        created.runId,
      );
      expect(events).toEqual([
        {
          data: { subtotal: 9_000 },
          hypothesisId: "H1",
          id: expect.stringMatching(/^evt_/),
          location: "src/cart.ts:84",
          message: "Before discount calculation",
          receivedAt: expect.any(Number),
          runId: "baseline",
          schemaVersion: 1,
          sequence: 1,
          sessionId: created.sessionId,
          timestamp: 1_784_310_000_123,
        },
      ]);
    } finally {
      await requestDaemonShutdown(connection);
    }
  });

  test("deduplicates retries that carry the same caller event ID", async () => {
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
      const event = {
        data: { attempt: 1 },
        hypothesisId: "H1",
        id: "caller-event-1",
        location: "src/retry.ts:10",
        message: "Retried event",
        runId: created.runId,
        schemaVersion: 1,
        sessionId: created.sessionId,
        timestamp: 1_784_310_000_123,
      };

      await Promise.all([
        fetch(created.ingestUrl, {
          body: JSON.stringify(event),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
        fetch(created.ingestUrl, {
          body: JSON.stringify(event),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      ]);

      expect(
        await new EventStore(await Persistence.open(home)).read(created.sessionId),
      ).toHaveLength(1);
    } finally {
      await requestDaemonShutdown(connection);
    }
  });
});
