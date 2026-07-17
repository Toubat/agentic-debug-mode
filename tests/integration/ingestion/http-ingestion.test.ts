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
  test("creates a session and normalizes an event", async () => {
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
          body: JSON.stringify({}),
          headers: controlHeaders,
          method: "POST",
        },
      );
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as {
        ingestUrl: string;
        sessionId: string;
      };

      const ingestResponse = await fetch(created.ingestUrl, {
        body: JSON.stringify({
          data: { subtotal: 9_000 },
          hypothesisId: "H1",
          location: "src/cart.ts:84",
          message: "Before discount calculation",
          timestamp: 1_784_310_000_123,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      expect(ingestResponse.status).toBe(202);

      const events = await new EventStore(await Persistence.open(home)).read(created.sessionId);
      expect(events).toEqual([
        {
          data: { subtotal: 9_000 },
          hypothesisId: "H1",
          id: expect.stringMatching(/^evt_/),
          location: "src/cart.ts:84",
          message: "Before discount calculation",
          receivedAt: expect.any(Number),
          sequence: 1,
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
          body: JSON.stringify({}),
          headers: {
            Authorization: `Bearer ${connection.controlToken}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      const created = (await createdResponse.json()) as {
        ingestUrl: string;
        sessionId: string;
      };
      const event = {
        data: { attempt: 1 },
        hypothesisId: "H1",
        id: "caller-event-1",
        location: "src/retry.ts:10",
        message: "Retried event",
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

  test("routes probe payloads to their session", async () => {
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
          body: JSON.stringify({}),
          headers: controlHeaders,
          method: "POST",
        },
      );
      const created = (await createdResponse.json()) as {
        ingestUrl: string;
        sessionId: string;
      };

      const ingestResponse = await fetch(created.ingestUrl, {
        body: JSON.stringify({
          data: { fixed: true },
          hypothesisId: "H1",
          location: "src/cart.ts:84",
          message: "Existing probe after fix",
          timestamp: 1_784_310_000_124,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      expect(ingestResponse.status).toBe(202);

      const events = new EventStore(await Persistence.open(home));
      expect(await events.read(created.sessionId)).toEqual([
        expect.objectContaining({
          data: { fixed: true },
          message: "Existing probe after fix",
        }),
      ]);
    } finally {
      await requestDaemonShutdown(connection);
    }
  });
});
