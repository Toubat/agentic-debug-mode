import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { Persistence } from "../../../src/daemon/persistence";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("incomplete startup lock recovery", () => {
  test("removes a lock directory whose owner metadata was never published", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const persistence = await Persistence.open(home);
    await mkdir(join(persistence.stateRoot, "startup.lock"), { mode: 0o700 });
    await Bun.sleep(300);

    const connection = await ensureDaemon({ homeDirectory: home });

    expect(connection.port).toBeGreaterThan(0);
    await requestDaemonShutdown(connection);
  }, 5_000);
});
