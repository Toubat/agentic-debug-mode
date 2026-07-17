import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../../../src/cli/output-schema";

const root = join(import.meta.dir, "..", "..", "..");
const executable = join(
  root,
  "dist",
  process.platform === "win32" ? "debug-mode.exe" : "debug-mode",
);
const temporaryDirectories: string[] = [];

interface Instrumentation {
  callTemplate: string;
  helperTemplate: string;
  language: string;
  transport: string;
}

async function run(command: string[], env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn(command, {
    cwd: root,
    env,
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

async function runCli(home: string, args: string[]) {
  return run([executable, ...args], {
    ...process.env,
    AGENT_DEBUG_MODE_HOME_OVERRIDE: home,
  });
}

async function start(home: string, workspace: string, language: string) {
  const result = await runCli(home, [
    "start",
    "--workspace",
    workspace,
    "--language",
    language,
    "--run-id",
    "baseline",
    "--hypothesis",
    "H1",
    "--json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as CommandResult<{
    instrumentation: Instrumentation;
  }>;
}

function materialize(template: string, instrumentation: Instrumentation): string {
  const call = instrumentation.callTemplate
    .replaceAll("__HYPOTHESIS_ID__", "H1")
    .replaceAll("__LOCATION__", "fixture:1")
    .replaceAll("__MESSAGE__", "Live fixture observed")
    .replaceAll("__DATA_EXPRESSION__", '{"value": 42}');
  return template
    .replace("/* __HELPER_TEMPLATE__ */", instrumentation.helperTemplate)
    .replace("/* __CALL_TEMPLATE__ */", call)
    .replace("# __HELPER_TEMPLATE__", instrumentation.helperTemplate)
    .replace("# __CALL_TEMPLATE__", call);
}

async function awaitEvent(home: string, sessionId: string): Promise<CommandResult> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await runCli(home, [
      "logs",
      "--session",
      sessionId,
      "--run-id",
      "baseline",
      "--json",
    ]);
    if (result.exitCode === 0) {
      const output = JSON.parse(result.stdout) as CommandResult;
      if (Number(output.statistics.totalRecords) === 1) {
        return output;
      }
    }
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for the fixture event");
}

beforeAll(async () => {
  const built = await run([process.execPath, "run", "build:binary"]);
  expect(built.exitCode, built.stderr).toBe(0);
});

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("live language probes", () => {
  for (const fixture of [
    { command: Bun.which("node"), file: "javascript-http.mjs", language: "javascript" },
    { command: process.execPath, file: "typescript-http.ts", language: "typescript" },
    { command: Bun.which("python3"), file: "python-direct.py", language: "python" },
  ]) {
    test.skipIf(fixture.command === null)(
      `${fixture.language} ingests through its generated transport`,
      async () => {
        const home = await mkdtemp(join(tmpdir(), "agent-debug-mode-home-"));
        const workspace = await mkdtemp(join(tmpdir(), `agent-debug-mode-${fixture.language}-`));
        temporaryDirectories.push(home, workspace);

        try {
          const started = await start(home, workspace, fixture.language);
          const source = await readFile(
            join(root, "tests", "fixtures", "languages", fixture.file),
            {
              encoding: "utf8",
            },
          );
          const fixturePath = join(workspace, fixture.file);
          await writeFile(fixturePath, materialize(source, started.data.instrumentation));

          const executed = await run([fixture.command ?? "", fixturePath]);
          expect(executed.exitCode, executed.stderr).toBe(0);
          const evidence = await awaitEvent(home, started.scope.sessionId ?? "");
          expect(evidence.statistics.totalRecords).toBe(1);
          expect(JSON.stringify(evidence.data)).toContain("Live fixture observed");
        } finally {
          await runCli(home, ["daemon", "stop", "--json"]);
        }
      },
      20_000,
    );
  }
});
