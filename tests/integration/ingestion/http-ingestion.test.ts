import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      const origin = `http://${connection.host}:${connection.port}`;
      expect(created.ingestUrl).toBe(`${origin}/ingest/${created.sessionId}`);

      const ingestResponse = await fetch(created.ingestUrl, {
        body: JSON.stringify({
          data: { subtotal: 9_000 },
          hypothesisId: "H1",
          id: "caller-controlled",
          location: "src/cart.ts:84",
          message: "Before discount calculation",
          runId: "caller-run",
          schemaVersion: 99,
          sessionId: "caller-session",
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
      const persisted = await readFile(
        (await Persistence.open(home)).sessionFile(created.sessionId, "events.ndjson"),
        "utf8",
      );
      expect(persisted).not.toContain("caller-controlled");
      expect(persisted).not.toContain("caller-run");
      expect(persisted).not.toContain("caller-session");
      expect(persisted).not.toContain("schemaVersion");
    } finally {
      await requestDaemonShutdown(connection);
    }
  });

  test("ignores caller event IDs and assigns normalized IDs", async () => {
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

      const events = await new EventStore(await Persistence.open(home)).read(created.sessionId);
      expect(events).toHaveLength(2);
      expect(events.map((stored) => stored.id)).not.toContain("caller-event-1");
      expect(new Set(events.map((stored) => stored.id))).toHaveLength(2);
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

  test("rejects obsolete and unknown ingestion routes without retargeting", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const connection = await ensureDaemon({ homeDirectory: home });
    const origin = `http://${connection.host}:${connection.port}`;
    const raw = {
      data: { value: 42 },
      hypothesisId: "free-form-label",
      location: "src/example.ts:1",
      message: "Observed value",
      timestamp: 1_784_310_000_001,
    };

    try {
      const obsolete = await fetch(`${origin}/v1/ingest/not-a-session`, {
        body: JSON.stringify(raw),
        headers: {
          Authorization: `Bearer ${connection.controlToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      expect(obsolete.status).toBe(404);

      const unknown = await fetch(`${origin}/ingest/not-a-session`, {
        body: JSON.stringify(raw),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ code: "SESSION_NOT_FOUND" });

      const unknownMalformed = await fetch(`${origin}/ingest/not-a-session`, {
        body: "{not-json\n",
        headers: { "Content-Type": "application/x-ndjson" },
        method: "POST",
      });
      expect(unknownMalformed.status).toBe(404);
      expect(await unknownMalformed.json()).toEqual({ code: "SESSION_NOT_FOUND" });

      const malformed = await fetch(`${origin}/ingest/%2e%2e%2fnot-a-session`, {
        body: JSON.stringify(raw),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      expect(malformed.status).toBe(404);
    } finally {
      await requestDaemonShutdown(connection);
    }
  });
});
