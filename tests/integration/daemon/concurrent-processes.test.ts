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

async function createSession(home: string, caller: number): Promise<string> {
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
  if (exitCode !== 0) {
    throw new Error(
      `caller ${caller} exited ${exitCode}\nstdout: ${stdout.trim()}\nstderr: ${stderr.trim()}`,
    );
  }
  const result = JSON.parse(stdout) as CommandResult<{ sessionId: string }>;
  return result.data.sessionId;
}

describe("cross-process daemon startup", () => {
  test("twenty create callers use one hidden service and create isolated sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, (_, caller) => createSession(home, caller)),
    );
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/20 create callers failed:\n${failures
          .map((failure) => String(failure.reason))
          .join("\n---\n")}`,
      );
    }
    const sessionIds = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<string>).value);
    expect(new Set(sessionIds).size).toBe(20);

    const connection = await ensureDaemon({ homeDirectory: home });
    expect(connection.port).toBeGreaterThan(0);
    await requestDaemonShutdown(connection);
  }, 30_000);
});
