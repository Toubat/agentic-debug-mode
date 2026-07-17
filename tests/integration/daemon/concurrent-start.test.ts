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

describe("daemon startup supervisor", () => {
  test("twenty simultaneous callers reuse one verified daemon on an OS-assigned port", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);

    const connections = await Promise.all(
      Array.from({ length: 20 }, () => ensureDaemon({ homeDirectory: home })),
    );
    const connection = connections[0];
    expect(connection).toBeDefined();

    try {
      expect(new Set(connections.map((item) => item.pid)).size).toBe(1);
      expect(new Set(connections.map((item) => item.nonce)).size).toBe(1);
      expect(new Set(connections.map((item) => item.port)).size).toBe(1);
      expect(connection?.port).toBeGreaterThan(0);
      expect(connection?.processIdentity.startTime).toBeGreaterThan(0);
      expect(connection?.processIdentity.executable).toBeTruthy();
    } finally {
      if (connection) {
        await requestDaemonShutdown(connection);
      }
    }
  }, 30_000);
});
