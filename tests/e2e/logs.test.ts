import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../src/cli/daemon-client";
import { ensureDaemon } from "../../src/cli/daemon-manager";
import type { CommandResult } from "../../src/cli/output-schema";
import { EventStore } from "../../src/daemon/event-store";
import { Persistence } from "../../src/daemon/persistence";

const root = join(import.meta.dir, "../..");
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

test("logs sorts by timestamp and sequence and reset invalidates its snapshot", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-logs-"));
  temporaryDirectories.push(home);
  const created = await runCli(home, ["create", "--json"]);
  const sessionId = (JSON.parse(created.stdout) as CommandResult).scope.sessionId ?? "";
  const persistence = await Persistence.open(home);
  const events = new EventStore(persistence);
  const timestamps = [3, 1, 1, 2];
  for (const [index, timestamp] of timestamps.entries()) {
    await events.append(sessionId, {
      data: { index },
      hypothesisId: index % 2 === 0 ? "H1" : "H2",
      id: `event-${index + 1}`,
      location: `src/logs.ts:${index + 1}`,
      message: `event ${index + 1}`,
      receivedAt: index + 1,
      sequence: index + 1,
      timestamp,
    });
  }

  try {
    const first = await runCli(home, ["logs", "--session", sessionId, "--limit", "2", "--json"]);
    expect(first.exitCode, first.stderr).toBe(0);
    const output = JSON.parse(first.stdout) as CommandResult<{
      pagination: { snapshot: string };
      records: Array<{ id: string }>;
    }>;
    expect(output.data.records.map((event) => event.id)).toEqual(["event-2", "event-3"]);

    const reset = await runCli(home, ["reset", "--session", sessionId, "--json"]);
    expect(reset.exitCode, reset.stderr).toBe(0);
    const continued = await runCli(home, [
      "logs",
      "--session",
      sessionId,
      "--offset",
      "2",
      "--snapshot",
      output.data.pagination.snapshot,
      "--json",
    ]);
    expect(continued.exitCode).toBe(1);
    expect(continued.stderr).toContain("CURSOR_STALE");
  } finally {
    await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
  }
});
