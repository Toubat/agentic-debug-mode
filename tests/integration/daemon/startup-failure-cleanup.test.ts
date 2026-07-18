import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import { inspectProcess } from "../../../src/native/system";

const temporaryDirectories: string[] = [];
const spawnedChildPids = new Set<number>();

afterEach(async () => {
  // Defensive: never leak an owned 60s child, even if an assertion above threw.
  for (const pid of spawnedChildPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  spawnedChildPids.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function waitForProcessExit(pid: number, timeoutMilliseconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const current = inspectProcess(pid);
    if (!current.exists || current.zombie) {
      return true;
    }
    await Bun.sleep(25);
  }
  const final = inspectProcess(pid);
  return !final.exists || final.zombie;
}

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
    spawnedChildPids.add(pid);

    // retire() issues SIGKILL but does not block until the signal lands; on slow
    // runners the process can still be visible for a beat, so poll before asserting.
    expect(await waitForProcessExit(pid, 3_000)).toBe(true);
  }, 10_000);
});
