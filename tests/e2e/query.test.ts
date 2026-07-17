import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../src/cli/daemon-client";
import { ensureDaemon } from "../../src/cli/daemon-manager";
import type { CommandResult } from "../../src/cli/output-schema";
import { EventStore } from "../../src/daemon/event-store";
import { Persistence } from "../../src/daemon/persistence";

const root = join(import.meta.dir, "..", "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function runCli(home: string, args: string[]) {
  const child = Bun.spawn([process.execPath, join(root, "src", "cli.ts"), ...args], {
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
  return { exitCode, stderr, stdout };
}

describe("jaq query command", () => {
  test("supports per-event streaming and explicit slurp semantics", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const started = await runCli(home, [
      "start",
      "--workspace",
      "/workspace/query",
      "--language",
      "typescript",
      "--run-id",
      "baseline",
      "--hypothesis",
      "H1",
      "--json",
    ]);
    const startOutput = JSON.parse(started.stdout) as CommandResult;
    const sessionId = startOutput.scope.sessionId ?? "";
    const persistence = await Persistence.open(home);
    const events = new EventStore(persistence);
    await events.append({
      data: { index: 2 },
      hypothesisId: "H1",
      id: "later",
      location: "src/query.ts:2",
      message: "Later",
      receivedAt: 2,
      runId: "baseline",
      schemaVersion: 1,
      sequence: 2,
      sessionId,
      timestamp: 2,
    });
    await events.append({
      data: { index: 1 },
      hypothesisId: "H1",
      id: "earlier",
      location: "src/query.ts:1",
      message: "Earlier",
      receivedAt: 1,
      runId: "baseline",
      schemaVersion: 1,
      sequence: 1,
      sessionId,
      timestamp: 1,
    });

    try {
      const streaming = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--run-id",
        "baseline",
        "--json",
        "select(.data.index > 1) | {id, value: .data.index}",
      ]);
      expect(streaming.exitCode, streaming.stderr).toBe(0);
      expect(
        (JSON.parse(streaming.stdout) as CommandResult<{ results: unknown[] }>).data.results,
      ).toEqual([{ id: "later", value: 2 }]);

      const slurped = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--run-id",
        "baseline",
        "--slurp",
        "--json",
        "sort_by(.timestamp) | map(.id)",
      ]);
      expect(slurped.exitCode, slurped.stderr).toBe(0);
      expect(
        (JSON.parse(slurped.stdout) as CommandResult<{ results: unknown[] }>).data.results,
      ).toEqual([["earlier", "later"]]);

      const timedOut = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--run-id",
        "baseline",
        "--timeout-ms",
        "100",
        "--json",
        "recurse(.)",
      ]);
      expect(timedOut.exitCode).toBe(2);
      expect(timedOut.stderr).toContain("execution timeout");
    } finally {
      await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
    }
  }, 15_000);
});
