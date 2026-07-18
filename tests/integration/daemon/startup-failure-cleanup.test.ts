import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { inspectProcess } from "../../../src/native/system";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("daemon startup failure cleanup", () => {
  test("retires an owned child that never publishes readiness", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const pidPath = join(home, "stuck-child.pid");
    const script = `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); await Bun.sleep(60_000);`;

    await expect(
      ensureDaemon({
        homeDirectory: home,
        testHooks: {
          command: [process.execPath, "-e", script],
          startupTimeoutMilliseconds: 100,
        },
      }),
    ).rejects.toThrow("startup deadline");

    const pid = Number(await readFile(pidPath, "utf8"));
    expect(inspectProcess(pid).exists).toBe(false);
  }, 5_000);
});
