import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../../src/cli/daemon-client";
import { ensureDaemon } from "../../../src/cli/daemon-manager";
import type { DaemonMetadata } from "../../../src/daemon/protocol";

const temporaryDirectories: string[] = [];
const root = join(import.meta.dir, "..", "..", "..");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function startContender(home: string): Promise<DaemonMetadata> {
  const child = Bun.spawn([process.execPath, join(root, "src", "cli.ts"), "__ensure-daemon"], {
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
  return JSON.parse(stdout) as DaemonMetadata;
}

describe("cross-process daemon startup", () => {
  test("twenty CLI processes converge on one authoritative daemon", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);

    const metadata = await Promise.all(Array.from({ length: 20 }, () => startContender(home)));
    expect(new Set(metadata.map((item) => item.pid)).size).toBe(1);
    expect(new Set(metadata.map((item) => item.nonce)).size).toBe(1);
    expect(new Set(metadata.map((item) => item.port)).size).toBe(1);

    await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
  }, 30_000);
});
