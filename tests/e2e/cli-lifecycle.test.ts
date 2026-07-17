import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../../src/cli/output-schema";

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

function extractSessionId(stdout: string): string {
  const match = /Session ([a-zA-Z0-9_-]+)/.exec(stdout);
  expect(match?.[1]).toBeTruthy();
  return match?.[1] ?? "";
}

describe("CLI lifecycle", () => {
  test("creates, resets, lists, cleans, and transparently restarts a session", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);

    const created = await runCli(home, ["create"]);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(created.stdout).toContain("SESSION CREATED");
    const sessionId = extractSessionId(created.stdout);

    const createdJson = await runCli(home, ["create", "--json"]);
    expect(createdJson.exitCode, createdJson.stderr).toBe(0);
    const createOutput = JSON.parse(createdJson.stdout) as CommandResult<{
      appendPath: string;
      ingestUrl: string;
      sessionId: string;
    }>;
    expect(createOutput.data).toEqual({
      appendPath: expect.stringContaining("incoming.ndjson"),
      ingestUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1\/ingest\//),
      sessionId: expect.any(String),
    });

    const reset = await runCli(home, ["reset", "--session", sessionId]);
    expect(reset.exitCode, reset.stderr).toBe(0);
    expect(reset.stdout).toContain("Sequence reset to 1");

    const listed = await runCli(home, ["sessions"]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(sessionId);

    const stopped = await runCli(home, ["stop"]);
    expect(stopped.exitCode, stopped.stderr).toBe(0);

    const statusAfterRestart = await runCli(home, ["status", "--session", sessionId]);
    expect(statusAfterRestart.exitCode, statusAfterRestart.stderr).toBe(0);

    const cleaned = await runCli(home, ["clean", "--session", sessionId]);
    expect(cleaned.exitCode, cleaned.stderr).toBe(0);

    const missing = await runCli(home, ["status", "--session", sessionId, "--json"]);
    expect(missing.exitCode).toBe(5);
    expect(missing.stderr).toContain('"code":"SESSION_NOT_FOUND"');

    await runCli(home, ["stop"]);
  }, 30_000);

  test("unknown explicit sessions return SESSION_NOT_FOUND", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const unknownSessionId = "00000000-0000-4000-8000-000000000000";

    for (const command of ["reset", "clean"]) {
      const result = await runCli(home, [command, "--session", unknownSessionId, "--json"]);
      expect(result.exitCode).toBe(5);
      expect(result.stderr).toContain('"code":"SESSION_NOT_FOUND"');
    }

    await runCli(home, ["stop"]);
  });

  test("rejects noncanonical session path segments without touching the real session", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const created = await runCli(home, ["create"]);
    const sessionId = extractSessionId(created.stdout);
    const invalidSessionIds = [
      `x/../${sessionId}`,
      `x%2F..%2F${sessionId}`,
      `%2e%2e%2f${sessionId}`,
    ];

    for (const command of ["reset", "clean"]) {
      for (const invalidSessionId of invalidSessionIds) {
        const rejected = await runCli(home, [command, "--session", invalidSessionId, "--json"]);
        expect(rejected.exitCode).toBe(2);
        expect(rejected.stderr).toContain('"code":"INVALID_ARGUMENTS"');

        const preserved = await runCli(home, ["status", "--session", sessionId]);
        expect(preserved.exitCode, preserved.stderr).toBe(0);
      }
    }

    const reset = await runCli(home, ["reset", "--session", sessionId]);
    expect(reset.exitCode, reset.stderr).toBe(0);
    const clean = await runCli(home, ["clean", "--session", sessionId]);
    expect(clean.exitCode, clean.stderr).toBe(0);
    await runCli(home, ["stop"]);
  });

  test("help and version do not start the hidden service", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);

    for (const args of [["--help"], ["--version"], ["template", "--help"]]) {
      const result = await runCli(home, args);
      expect(result.exitCode, result.stderr).toBe(0);
    }

    const stateFile = join(home, ".agent-debug-mode", "daemon.json");
    expect(await Bun.file(stateFile).exists()).toBe(false);
  });
});
