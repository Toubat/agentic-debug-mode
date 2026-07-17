import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../src/cli/daemon-client";
import { ensureDaemon } from "../../src/cli/daemon-manager";
import type { CommandResult } from "../../src/cli/output-schema";
import { Persistence } from "../../src/daemon/persistence";
import { SessionRegistry } from "../../src/daemon/session-registry";

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

describe("CLI lifecycle", () => {
  test("start returns a scoped TypeScript helper and lightweight probe call", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);

    try {
      const result = await runCli(home, [
        "start",
        "--workspace",
        "/workspace/project",
        "--language",
        "typescript",
        "--run-id",
        "baseline",
        "--hypothesis",
        "H1",
        "--json",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as CommandResult<{
        instrumentation: {
          callTemplate: string;
          helperTemplate: string;
          language: string;
          replace: string[];
          transport: string;
        };
      }>;
      expect(output.command).toBe("start");
      expect(output.scope.runId).toBe("baseline");
      expect(output.scope.sessionId).toBeTruthy();
      expect(output.data.instrumentation.language).toBe("typescript");
      expect(output.data.instrumentation.transport).toBe("http");
      expect(output.data.instrumentation.helperTemplate).toContain("// #region agent log");
      expect(output.data.instrumentation.helperTemplate).toContain("fetch(");
      expect(output.data.instrumentation.callTemplate).toContain("__HYPOTHESIS_ID__");
      expect(output.data.instrumentation.replace).toEqual([
        "__HYPOTHESIS_ID__",
        "__LOCATION__",
        "__MESSAGE__",
        "__DATA_EXPRESSION__",
      ]);
      expect(result.stdout).not.toContain("controlToken");
    } finally {
      const connection = await ensureDaemon({ homeDirectory: home });
      await requestDaemonShutdown(connection);
    }
  }, 10_000);

  test("repeated start calls resume the same workspace session and run", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const args = [
      "start",
      "--workspace",
      "/workspace/project",
      "--language",
      "typescript",
      "--run-id",
      "baseline",
      "--hypothesis",
      "H1",
      "--json",
    ];

    try {
      const first = JSON.parse((await runCli(home, args)).stdout) as CommandResult;
      const second = JSON.parse((await runCli(home, args)).stdout) as CommandResult;

      expect(second.scope.sessionId).toBe(first.scope.sessionId);
      expect(second.scope.runId).toBe(first.scope.runId);
    } finally {
      await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
    }
  });

  test("logs returns bounded evidence with statistics and pagination hints", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const connection = await ensureDaemon({ homeDirectory: home });

    try {
      const started = JSON.parse(
        (
          await runCli(home, [
            "start",
            "--workspace",
            "/workspace/project",
            "--language",
            "typescript",
            "--run-id",
            "baseline",
            "--hypothesis",
            "H1",
            "--json",
          ])
        ).stdout,
      ) as CommandResult;
      const sessionId = started.scope.sessionId;
      expect(sessionId).toBeTruthy();
      const session = await new SessionRegistry(await Persistence.open(home)).get(sessionId ?? "");
      expect(session).toBeDefined();
      for (const index of [1, 2]) {
        await fetch(`http://${connection.host}:${connection.port}/v1/ingest/${session?.id}`, {
          body: JSON.stringify({
            data: { index },
            hypothesisId: "H1",
            id: `event-${index}`,
            location: `src/example.ts:${index}`,
            message: "Observed",
            timestamp: index,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
      }

      const result = await runCli(home, [
        "logs",
        "--session",
        sessionId ?? "",
        "--run-id",
        "baseline",
        "--offset",
        "0",
        "--limit",
        "1",
        "--json",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as CommandResult<{
        records: unknown[];
      }>;
      expect(output.statistics).toMatchObject({
        returnedRecords: 1,
        totalRecords: 2,
      });
      expect(output.data.records).toHaveLength(1);
      expect(output.hints.map((hint) => hint.action)).toContain("next-page");
    } finally {
      await requestDaemonShutdown(connection);
    }
  });

  test("supports probe, run, status, clear, sessions, and stop commands", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);

    try {
      const started = JSON.parse(
        (
          await runCli(home, [
            "start",
            "--workspace",
            "/workspace/project",
            "--language",
            "typescript",
            "--run-id",
            "baseline",
            "--hypothesis",
            "H1",
            "--json",
          ])
        ).stdout,
      ) as CommandResult;
      const sessionId = started.scope.sessionId ?? "";
      const begun = await runCli(home, [
        "run",
        "begin",
        "--session",
        sessionId,
        "--run-id",
        "fixed",
        "--json",
      ]);
      expect(begun.exitCode, begun.stderr).toBe(0);
      expect((JSON.parse(begun.stdout) as CommandResult).scope).toMatchObject({
        hypothesisIds: ["H1"],
        runId: "fixed",
      });

      const probe = await runCli(home, [
        "probe",
        "--session",
        sessionId,
        "--run-id",
        "fixed",
        "--language",
        "typescript",
        "--json",
      ]);
      expect(probe.exitCode, probe.stderr).toBe(0);
      expect(probe.stdout).toContain("__agentDebugEmit");

      const sessions = await runCli(home, [
        "sessions",
        "--workspace",
        "/workspace/project",
        "--json",
      ]);
      expect(sessions.exitCode, sessions.stderr).toBe(0);
      expect(sessions.stdout).not.toContain("ingestCapability");

      const mismatchedClear = await runCli(home, [
        "clear",
        "--workspace",
        "/workspace/other",
        "--session",
        sessionId,
        "--run-id",
        "fixed",
        "--json",
      ]);
      expect(mismatchedClear.exitCode).toBe(5);
      expect(mismatchedClear.stderr).toContain("does not belong to workspace");

      for (const command of ["status", "clear"]) {
        const result = await runCli(home, [
          command,
          "--session",
          sessionId,
          "--run-id",
          "fixed",
          "--json",
        ]);
        expect(result.exitCode, result.stderr).toBe(0);
      }

      const stopped = await runCli(home, ["stop", "--session", sessionId, "--json"]);
      expect(stopped.exitCode, stopped.stderr).toBe(0);
      expect(stopped.stdout).toContain('"status":"stopped"');

      const cleaned = await runCli(home, ["clean", "--session", sessionId, "--json"]);
      expect(cleaned.exitCode, cleaned.stderr).toBe(0);
      expect(cleaned.stdout).toContain('"removed":true');

      const afterClean = await runCli(home, ["sessions", "--json"]);
      expect(afterClean.exitCode, afterClean.stderr).toBe(0);
      expect(afterClean.stdout).toContain('"sessions":[]');
    } finally {
      const connection = await ensureDaemon({ homeDirectory: home });
      await requestDaemonShutdown(connection);
    }
  });
});
