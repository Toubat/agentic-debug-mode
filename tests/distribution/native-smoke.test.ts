import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { retryOnWindowsLock } from "../../src/platform/windows-lock-retry";

const root = join(import.meta.dir, "..", "..");
const executableName = process.platform === "win32" ? "debug-mode.exe" : "debug-mode";
const executable = join(root, "dist", executableName);

async function run(command: string[], env?: Record<string, string | undefined>) {
  const processHandle = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("standalone native addon distribution", () => {
  beforeAll(async () => {
    const result = await run(["bun", "run", "build:binary"]);
    expect(result.exitCode, result.stderr).toBe(0);
    if (process.platform !== "win32") {
      await chmod(executable, 0o755);
    }
  }, 120_000);

  afterAll(async () => {
    // Windows keeps the just-executed standalone exe locked briefly after exit,
    // so removing dist can transiently fail with EBUSY/EPERM; retry until released.
    await retryOnWindowsLock(() => rm(join(root, "dist"), { force: true, recursive: true }));
  });

  test("embeds both N-API addons and runs without Bun on PATH", async () => {
    const systemPath =
      process.platform === "win32"
        ? dirname(process.execPath)
        : ["/usr/bin", "/bin"].join(delimiter);
    const result = await run([executable, "__native-smoke"], { PATH: systemPath });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      process: {
        exists: true,
        pid: expect.any(Number),
      },
      query: [{ embedded: true }],
      termination: {
        reason: "invalid-identity",
        terminated: false,
      },
    });
  });
});
