import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../src/cli/daemon-client";
import { ensureDaemon } from "../../src/cli/daemon-manager";
import type { CommandResult } from "../../src/cli/output-schema";
import { parseCli } from "../../src/cli/program";
import { queryCommand } from "../../src/commands/query";
import { DiagnosticStore } from "../../src/daemon/diagnostic-store";
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
      const output = await queryCommand(parsed.command, parsed.json);
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

  test("invalidates complete query cursors after reset and preserves continuation hints", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const started = await runCli(home, ["create", "--json"]);
    const sessionId = (JSON.parse(started.stdout) as CommandResult).scope.sessionId ?? "";
    const persistence = await Persistence.open(home);
    const events = new EventStore(persistence);
    for (const [index, id] of ["first", "second", "third"].entries()) {
      await events.append(sessionId, {
        data: { index },
        hypothesisId: "H1",
        id,
        location: `src/query.ts:${index + 1}`,
        message: id,
        receivedAt: index + 1,
        sequence: index + 1,
        timestamp: index + 1,
      });
    }

    try {
      const firstPage = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--limit",
        "1",
        "--timeout-ms",
        "345",
        "--json",
        ".id",
      ]);
      expect(firstPage.exitCode, firstPage.stderr).toBe(0);
      const output = JSON.parse(firstPage.stdout) as CommandResult<{
        pagination: { nextCursor?: string };
      }>;
      const nextCommand = output.hints.find((hint) => hint.action === "next-page")?.command ?? "";
      expect(nextCommand).toContain("--limit 1");
      expect(nextCommand).toContain("--timeout-ms 345");
      expect(nextCommand).toContain("--json");

      const secondPage = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--cursor",
        output.data.pagination.nextCursor ?? "",
        "--json",
      ]);
      expect(secondPage.exitCode, secondPage.stderr).toBe(0);
      const secondOutput = JSON.parse(secondPage.stdout) as CommandResult<{
        pagination: { nextCursor?: string };
      }>;
      const continuedCommand =
        secondOutput.hints.find((hint) => hint.action === "next-page")?.command ?? "";
      expect(continuedCommand).toContain("--limit 1");
      expect(continuedCommand).toContain("--timeout-ms 345");
      expect(continuedCommand).toContain("--json");

      const reset = await runCli(home, ["reset", "--session", sessionId, "--json"]);
      expect(reset.exitCode, reset.stderr).toBe(0);
      const continued = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--cursor",
        secondOutput.data.pagination.nextCursor ?? "",
        "--json",
      ]);
      expect(continued.exitCode).toBe(1);
      expect(continued.stderr).toContain("CURSOR_STALE");
    } finally {
      await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
    }
  });

  test("omits --json from continuation hints unless explicitly requested", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const started = await runCli(home, ["create", "--json"]);
    const sessionId = (JSON.parse(started.stdout) as CommandResult).scope.sessionId ?? "";
    const persistence = await Persistence.open(home);
    const events = new EventStore(persistence);
    for (const [index, id] of ["first", "second"].entries()) {
      await events.append(sessionId, {
        data: { index },
        hypothesisId: "H1",
        id,
        location: `src/query.ts:${index + 1}`,
        message: id,
        receivedAt: index + 1,
        sequence: index + 1,
        timestamp: index + 1,
      });
    }

    try {
      const page = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--limit",
        "1",
        "--timeout-ms",
        "456",
        ".id",
      ]);
      expect(page.exitCode, page.stderr).toBe(0);
      expect(page.stdout).toContain("--limit 1");
      expect(page.stdout).toContain("--timeout-ms 456");
      expect(page.stdout).not.toContain("--json");
    } finally {
      await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
    }
  });

  test("reports redaction warnings alongside malformed-record guidance", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const started = await runCli(home, ["create", "--json"]);
    const sessionId = (JSON.parse(started.stdout) as CommandResult).scope.sessionId ?? "";
    const persistence = await Persistence.open(home);
    await new DiagnosticStore(persistence).append(sessionId, [
      {
        diagnosticId: "malformed",
        message: "invalid record",
        observedAt: 1,
        reason: "INVALID_JSON",
        recoverable: {},
        redactedPreview: "{}",
        suggestedAction: "fix emitter",
      },
      {
        diagnosticId: "redacted",
        message: "secret removed",
        observedAt: 2,
        reason: "SECRET_REDACTED",
        recoverable: {},
        redactedPreview: "{}",
        suggestedAction: "remove secret",
      },
    ]);

    try {
      const query = await runCli(home, ["query", "--session", sessionId, "--json", "."]);
      expect(query.exitCode, query.stderr).toBe(0);
      const output = JSON.parse(query.stdout) as CommandResult;
      expect(output.warnings.map((warning) => warning.code)).toEqual([
        "MALFORMED_RECORDS",
        "SECRET_REDACTED",
      ]);
      expect(output.hints.some((hint) => hint.action === "status")).toBe(true);
    } finally {
      await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
    }
  });

  test("maps malformed canonical evidence to the typed evidence exit", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
    temporaryDirectories.push(home);
    const started = await runCli(home, ["create", "--json"]);
    const sessionId = (JSON.parse(started.stdout) as CommandResult).scope.sessionId ?? "";
    const persistence = await Persistence.open(home);
    const daemon = await ensureDaemon({ homeDirectory: home });
    await writeFile(persistence.sessionFile(sessionId, "events.ndjson"), "{not-json}\n");

    try {
      const query = await runCli(home, ["query", "--session", sessionId, "--json", "."]);
      expect(query.exitCode, query.stderr).toBe(6);
      expect(query.stderr).toContain("EVIDENCE_MALFORMED");
    } finally {
      await requestDaemonShutdown(daemon).catch(() => undefined);
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

      const slurpPage = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--slurp",
        "--limit",
        "1",
        "--json",
        ".[] | .id",
      ]);
      expect(slurpPage.exitCode, slurpPage.stderr).toBe(0);
      const slurpPageOutput = JSON.parse(slurpPage.stdout) as CommandResult<{
        pagination: { nextCursor?: string };
        rows: unknown[];
      }>;
      expect(slurpPageOutput.data.rows).toEqual(["later"]);
      const slurpNextCommand =
        slurpPageOutput.hints.find((hint) => hint.action === "next-page")?.command ?? "";
      expect(slurpNextCommand).toContain("--slurp");
      expect(slurpNextCommand).toContain("--limit 1");
      expect(slurpNextCommand).toContain("--timeout-ms 2000");
      expect(slurpNextCommand).toContain("--json");
      const slurpCursor = slurpPageOutput.data.pagination.nextCursor ?? "";
      const cursorPayload = JSON.parse(
        Buffer.from(slurpCursor.split(".")[0] ?? "", "base64url").toString("utf8"),
      ) as { continuation?: { kind?: string; spoolId?: string } };
      expect(cursorPayload.continuation?.kind).toBe("spool");
      expect(cursorPayload.continuation?.spoolId).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(cursorPayload)).not.toContain(home);
      expect(JSON.stringify(cursorPayload)).not.toContain(".ndjson");

      const continuedSlurp = await runCli(home, [
        "query",
        "--session",
        sessionId,
        "--cursor",
        slurpCursor,
        "--json",
      ]);
      expect(continuedSlurp.exitCode, continuedSlurp.stderr).toBe(0);
      expect(
        (JSON.parse(continuedSlurp.stdout) as CommandResult<{ rows: unknown[] }>).data.rows,
      ).toEqual(["earlier"]);

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
        "reduce range(0; 10000000) as $i (0; . + $i)",
      ]);
      expect(timedOut.exitCode).toBe(1);
      expect(timedOut.stderr).toContain("QUERY_RESOURCE_EXHAUSTED");
      expect(timedOut.stderr).toContain("execution timeout");
    } finally {
      await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
    }
  }, 15_000);
});
