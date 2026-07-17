import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../src/cli/daemon-client";
import { ensureDaemon } from "../../src/cli/daemon-manager";
import type { CommandResult } from "../../src/cli/output-schema";
import { parseCli } from "../../src/cli/program";
import { queryCommand } from "../../src/commands/query";
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
  test("executes normal queries in-process without spawning a worker", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const started = await runCli(home, ["create", "--json"]);
    const startOutput = JSON.parse(started.stdout) as CommandResult;
    const sessionId = startOutput.scope.sessionId ?? "";
    const persistence = await Persistence.open(home);
    const events = new EventStore(persistence);
    await events.append(sessionId, {
      data: { index: 1 },
      hypothesisId: "H1",
      id: "direct",
      location: "src/query.ts:1",
      message: "Direct",
      receivedAt: 1,
      sequence: 1,
      timestamp: 1,
    });

    const daemon = await ensureDaemon({ homeDirectory: home });
    const parsed = await parseCli(["query", "--session", sessionId, "--json", ".id"]);
    if ("helpText" in parsed || parsed.command.kind !== "query") {
      throw new Error("Expected a parsed query command");
    }
    const originalSpawn = Bun.spawn;
    const spawnedCommands: string[][] = [];
    Bun.spawn = ((command: Parameters<typeof Bun.spawn>[0], options?: unknown) => {
      spawnedCommands.push(Array.from(command, String));
      return originalSpawn(command, options as never);
    }) as typeof Bun.spawn;
    const previousHome = process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE;
    process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE = home;
    try {
      const output = await queryCommand(parsed.command);
      expect(output.ok).toBe(true);
      if (output.ok) {
        expect((output.data as { rows: unknown[] }).rows).toEqual(["direct"]);
      }
      expect(spawnedCommands).toEqual([]);
    } finally {
      Bun.spawn = originalSpawn;
      if (previousHome === undefined) {
        delete process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE;
      } else {
        process.env.AGENT_DEBUG_MODE_HOME_OVERRIDE = previousHome;
      }
      await requestDaemonShutdown(daemon);
    }
  });

  test("preserves typed session errors for query identifiers", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const unknownSessionId = "00000000-0000-4000-8000-000000000000";

    try {
      const unknown = await runCli(home, ["query", "--session", unknownSessionId, "--json", "."]);
      expect(unknown.exitCode).toBe(5);
      expect(unknown.stderr).toContain("SESSION_NOT_FOUND");

      const invalid = await runCli(home, [
        "query",
        "--session",
        `x/../${unknownSessionId}`,
        "--json",
        ".",
      ]);
      expect(invalid.exitCode).toBe(2);
      expect(invalid.stderr).toContain("INVALID_ARGUMENTS");
    } finally {
      await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
    }
  });

  test("supports per-event streaming and explicit slurp semantics", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const started = await runCli(home, ["create", "--json"]);
    const startOutput = JSON.parse(started.stdout) as CommandResult;
    const sessionId = startOutput.scope.sessionId ?? "";
    const persistence = await Persistence.open(home);
    const events = new EventStore(persistence);
    await events.append(sessionId, {
      data: { index: 2 },
      hypothesisId: "H1",
      id: "later",
      location: "src/query.ts:2",
      message: "Later",
      receivedAt: 2,
      sequence: 2,
      timestamp: 2,
    });
    await events.append(sessionId, {
      data: { index: 1 },
      hypothesisId: "H1",
      id: "earlier",
      location: "src/query.ts:1",
      message: "Earlier",
      receivedAt: 1,
      sequence: 1,
      timestamp: 1,
    });

    try {
      const streaming = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--json",
        "select(.data.index > 1) | {id, value: .data.index}",
      ]);
      expect(streaming.exitCode, streaming.stderr).toBe(0);
      expect(
        (JSON.parse(streaming.stdout) as CommandResult<{ rows: unknown[] }>).data.rows,
      ).toEqual([{ id: "later", value: 2 }]);

      const slurped = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--slurp",
        "--json",
        "sort_by(.timestamp) | map(.id)",
      ]);
      expect(slurped.exitCode, slurped.stderr).toBe(0);
      expect((JSON.parse(slurped.stdout) as CommandResult<{ rows: unknown[] }>).data.rows).toEqual([
        ["earlier", "later"],
      ]);

      const firstPage = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--limit",
        "1",
        "--json",
        ".id",
      ]);
      expect(firstPage.exitCode, firstPage.stderr).toBe(0);
      const firstPageOutput = JSON.parse(firstPage.stdout) as CommandResult<{
        pagination: { hasNext: boolean; nextCursor?: string };
        rows: unknown[];
      }>;
      expect(firstPageOutput.data.rows).toEqual(["later"]);
      expect(firstPageOutput.data.pagination.hasNext).toBe(true);
      expect(firstPageOutput.statistics).toMatchObject({
        producedValues: 2,
        returnedRecords: 1,
      });

      const secondPage = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--cursor",
        firstPageOutput.data.pagination.nextCursor ?? "",
        "--json",
      ]);
      expect(secondPage.exitCode, secondPage.stderr).toBe(0);
      expect(
        (
          JSON.parse(secondPage.stdout) as CommandResult<{
            mode: string;
            pagination: { hasNext: boolean };
            rows: unknown[];
            slurp: boolean;
          }>
        ).data,
      ).toEqual({
        mode: "streaming",
        pagination: { hasNext: false },
        rows: ["earlier"],
        slurp: false,
      });

      const collectionRequired = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--json",
        "sort_by(.timestamp)",
      ]);
      expect(collectionRequired.exitCode).toBe(2);
      expect(collectionRequired.stderr).toContain("COLLECTION_REQUIRED");
      expect(collectionRequired.stderr).toContain("--slurp");

      const timedOut = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--timeout-ms",
        "100",
        "--json",
        "recurse(.)",
      ]);
      expect(timedOut.exitCode).toBe(1);
      expect(timedOut.stderr).toContain("QUERY_RESOURCE_EXHAUSTED");
      expect(timedOut.stderr).toContain("execution timeout");
    } finally {
      await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
    }
  }, 15_000);
});
