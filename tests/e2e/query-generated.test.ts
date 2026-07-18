import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDaemonShutdown } from "../../src/cli/daemon-client";
import { ensureDaemon } from "../../src/cli/daemon-manager";
import type { CommandResult } from "../../src/cli/output-schema";
import { DiagnosticStore } from "../../src/daemon/diagnostic-store";
import { EventStore } from "../../src/daemon/event-store";
import { Persistence } from "../../src/daemon/persistence";
import type { NormalizedEvent } from "../../src/domain/event";
import {
  configuredSeeds,
  GENERATED_QUERY_CASES,
  type GeneratedEvent,
  type GeneratedQueryCase,
  generateEvents,
} from "./query-generated-fixtures";

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

async function createGeneratedSession(
  home: string,
  seed: number,
  count = 12,
): Promise<{ events: GeneratedEvent[]; sessionId: string }> {
  const created = await runCli(home, ["create", "--json"]);
  if (created.exitCode !== 0) {
    throw new Error(`seed=${seed} create failed: ${created.stderr}`);
  }
  const sessionId = (JSON.parse(created.stdout) as CommandResult).scope.sessionId ?? "";
  const persistence = await Persistence.open(home);
  const store = new EventStore(persistence);
  const events = generateEvents(seed, count);
  for (const event of events) {
    await store.append(sessionId, event as unknown as NormalizedEvent);
  }
  return { events, sessionId };
}

async function collectQueryPages(
  home: string,
  sessionId: string,
  queryCase: GeneratedQueryCase,
): Promise<unknown[]> {
  const firstArgs = [
    "query",
    "--session",
    sessionId,
    "--limit",
    String(queryCase.limit),
    "--timeout-ms",
    "5000",
    ...(queryCase.slurp ? ["--slurp"] : []),
    "--json",
    queryCase.program,
  ];
  const rows: unknown[] = [];
  let result = await runCli(home, firstArgs);
  let pageCount = 0;
  while (true) {
    pageCount += 1;
    if (result.exitCode !== 0) {
      throw new Error(`CLI query failed: ${result.stderr}`);
    }
    const output = JSON.parse(result.stdout) as CommandResult<{
      pagination: { hasNext: boolean; nextCursor?: string };
      rows: unknown[];
    }>;
    rows.push(...output.data.rows);
    if (!output.data.pagination.hasNext) {
      return rows;
    }
    if (pageCount > 20 || !output.data.pagination.nextCursor) {
      throw new Error("Query pagination did not terminate with a valid cursor");
    }
    result = await runCli(home, [
      "query",
      "--session",
      sessionId,
      "--cursor",
      output.data.pagination.nextCursor,
      "--json",
    ]);
  }
}

function assertGeneratedResult(
  seed: number,
  queryCase: GeneratedQueryCase,
  events: GeneratedEvent[],
  actual: unknown[],
): void {
  const expected = queryCase.expected(events);
  try {
    expect(actual).toEqual(expected);
  } catch (error) {
    const context = events.slice(0, 4).map((event) => ({
      data: event.data,
      hypothesisId: event.hypothesisId,
      id: event.id,
      location: event.location,
      message: event.message,
      sequence: event.sequence,
      timestamp: event.timestamp,
    }));
    throw new Error(
      [
        `Generated query mismatch. Replay with DEBUG_MODE_QUERY_FUZZ_SEED=${seed}.`,
        `case=${queryCase.name}`,
        `program=${queryCase.program}`,
        `recordContext=${JSON.stringify(context)}`,
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    );
  }
}

function normalizeHumanOutput(output: string, sessionId: string): string {
  return output
    .replaceAll(sessionId, "<SESSION_ID>")
    .replace(/durationMs\s+[0-9.]+/g, "durationMs        <DURATION_MS>")
    .replace(/--cursor \S+/g, "--cursor <CURSOR>")
    .trimEnd();
}

describe("generated native query properties", () => {
  for (const seed of configuredSeeds()) {
    test(`matches independent ground truth across seed ${seed}`, async () => {
      const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-generated-query-"));
      temporaryDirectories.push(home);
      const { events, sessionId } = await createGeneratedSession(home, seed);

      try {
        for (const queryCase of GENERATED_QUERY_CASES) {
          let actual: unknown[];
          try {
            actual = await collectQueryPages(home, sessionId, queryCase);
          } catch (error) {
            throw new Error(
              [
                `Generated query execution failed. Replay with DEBUG_MODE_QUERY_FUZZ_SEED=${seed}.`,
                `case=${queryCase.name}`,
                `program=${queryCase.program}`,
                error instanceof Error ? error.message : String(error),
              ].join("\n"),
            );
          }
          assertGeneratedResult(seed, queryCase, events, actual);
        }
      } finally {
        await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
      }
    }, 20_000);
  }

  test("snapshots representative human-readable query shapes", async () => {
    const seed = 0x51a9e;
    const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-query-snapshot-"));
    temporaryDirectories.push(home);
    const { sessionId } = await createGeneratedSession(home, seed, 4);
    const persistence = await Persistence.open(home);
    await new DiagnosticStore(persistence).append(sessionId, [
      {
        diagnosticId: "snapshot-malformed",
        message: "Synthetic malformed input was excluded.",
        observedAt: 1,
        reason: "INVALID_JSON",
        recoverable: {},
        redactedPreview: "{}",
        suggestedAction: "Fix the synthetic emitter.",
      },
      {
        diagnosticId: "snapshot-redacted",
        message: "A fictitious credential-shaped value was removed.",
        observedAt: 2,
        reason: "SECRET_REDACTED",
        recoverable: {},
        redactedPreview: "{}",
        suggestedAction: "Keep fictitious credentials out of evidence.",
      },
    ]);

    try {
      const cases = [
        {
          args: ["--limit", "2", "{id, hypothesisId}"],
          name: "homogeneous objects with warnings, statistics, and hints",
        },
        { args: [".data.text"], name: "scalar table" },
        { args: [".data.nested, .data.tags"], name: "nested and heterogeneous JSON" },
        { args: ["select(false)"], name: "empty results" },
      ];
      const snapshots: Record<string, string> = {};
      for (const snapshotCase of cases) {
        const result = await runCli(home, ["query", "--session", sessionId, ...snapshotCase.args]);
        expect(result.exitCode, result.stderr).toBe(0);
        snapshots[snapshotCase.name] = normalizeHumanOutput(result.stdout, sessionId);
      }

      expect(
        Object.entries(snapshots)
          .map(([name, output]) => `=== ${name} ===\n${output}`)
          .join("\n\n"),
      ).toMatchSnapshot();
    } finally {
      await requestDaemonShutdown(await ensureDaemon({ homeDirectory: home }));
    }
  }, 10_000);
});
