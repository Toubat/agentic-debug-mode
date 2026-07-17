import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../../../package.json";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { getOrCreateControlToken } from "../../../src/daemon/auth";
import { Persistence } from "../../../src/daemon/persistence";
import {
  DAEMON_HOST,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_SCHEMA_VERSION,
  type DaemonConnection,
} from "../../../src/daemon/protocol";
import { writeDaemonState } from "../../../src/daemon/state-file";
import { inspectProcess } from "../../../src/native/system";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("stale daemon process recovery", () => {
  test("terminates only a process whose native identity matches stale state", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    await getOrCreateControlToken(persistence.stateRoot);
    const stale = Bun.spawn(
      [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
      {
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      },
    );
    await Bun.sleep(50);
    const identity = inspectProcess(stale.pid);
    await writeDaemonState(persistence.stateRoot, {
      binaryVersion: packageJson.version,
      host: DAEMON_HOST,
      nonce: "stale-daemon",
      pid: stale.pid,
      port: 65_534,
      processIdentity: {
        executable: identity.executable,
        startTime: identity.startTime,
      },
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      schemaVersion: DAEMON_SCHEMA_VERSION,
      startedAt: Date.now() - 60_000,
    });

    let connection: DaemonConnection | undefined;
    try {
      connection = await ensureDaemon({ homeDirectory: home });
      const deadline = Date.now() + 2_000;
      while (inspectProcess(stale.pid).exists && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(inspectProcess(stale.pid).exists).toBe(false);
    } finally {
      if (connection) {
        await requestDaemonShutdown(connection);
      }
      if (inspectProcess(stale.pid).exists) {
        stale.kill();
      }
    }
  }, 10_000);
});
