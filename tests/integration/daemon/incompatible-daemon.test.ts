import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { getOrCreateControlToken } from "../../../src/daemon/auth";
import { Persistence } from "../../../src/daemon/persistence";
import {
  DAEMON_HOST,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_SCHEMA_VERSION,
  type DaemonConnection,
  type DaemonMetadata,
} from "../../../src/daemon/protocol";
import { writeDaemonState } from "../../../src/daemon/state-file";
import { inspectProcess } from "../../../src/native/system";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("daemon version recovery", () => {
  test("gracefully replaces an authenticated incompatible idle daemon", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const token = await getOrCreateControlToken(persistence.stateRoot);
    const identity = inspectProcess(process.pid);
    let shutdownCalled = false;
    let metadata: DaemonMetadata;
    const incompatible = Bun.serve({
      hostname: DAEMON_HOST,
      port: 0,
      fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${token}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const path = new URL(request.url).pathname;
        if (path === "/v1/control/health") {
          return Response.json({ ...metadata, activeSessions: 0 });
        }
        if (path === "/v1/control/shutdown" && request.method === "POST") {
          shutdownCalled = true;
          setTimeout(() => incompatible.stop(true), 10);
          return Response.json({ accepted: true }, { status: 202 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const incompatiblePort = incompatible.port;
    if (incompatiblePort === undefined) {
      incompatible.stop(true);
      throw new Error("Incompatible test daemon did not bind a port");
    }
    metadata = {
      binaryVersion: "0.0.0-incompatible",
      host: DAEMON_HOST,
      nonce: "incompatible",
      pid: process.pid,
      port: incompatiblePort,
      processIdentity: {
        executable: identity.executable,
        startTime: identity.startTime,
      },
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      schemaVersion: DAEMON_SCHEMA_VERSION,
      startedAt: Date.now(),
    };
    await writeDaemonState(persistence.stateRoot, metadata);

    let replacement: DaemonConnection | undefined;
    try {
      replacement = await ensureDaemon({ homeDirectory: home });
      expect(shutdownCalled).toBe(true);
      expect(replacement.nonce).not.toBe(metadata.nonce);
    } finally {
      incompatible.stop(true);
      if (replacement) {
        await requestDaemonShutdown(replacement);
      }
    }
  }, 10_000);
});
