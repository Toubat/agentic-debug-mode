import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { Persistence } from "../../../src/daemon/persistence";
import { StartupLock } from "../../../src/daemon/startup-lock";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("daemon startup lock recovery", () => {
  test("breaks an expired lock whose owner process is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    const staleLock = await StartupLock.tryAcquire(persistence.stateRoot, {
      deadline: 0,
      nonce: "stale-lock",
      pid: 4_294_967_295,
    });
    expect(staleLock).toBeDefined();

    const connection = await ensureDaemon({ homeDirectory: home });

    expect(connection.port).toBeGreaterThan(0);
    await requestDaemonShutdown(connection);
  }, 5_000);
});
