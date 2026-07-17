import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import type { CommandResult } from "../../../src/cli/output-schema";

const temporaryDirectories: string[] = [];
const root = join(import.meta.dir, "..", "..", "..");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createSession(home: string): Promise<string> {
  const child = Bun.spawn([process.execPath, join(root, "src", "cli.ts"), "create", "--json"], {
    cwd: root,
    env: { ...process.env, AGENT_DEBUG_MODE_HOME_OVERRIDE: home },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  const result = JSON.parse(stdout) as CommandResult<{ sessionId: string }>;
  return result.data.sessionId;
}

describe("cross-process daemon startup", () => {
  test("twenty create callers use one hidden service and create isolated sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);

    const sessionIds = await Promise.all(Array.from({ length: 20 }, () => createSession(home)));
    expect(new Set(sessionIds).size).toBe(20);

    const connection = await ensureDaemon({ homeDirectory: home });
    expect(connection.port).toBeGreaterThan(0);
    await requestDaemonShutdown(connection);
  }, 30_000);
});
