import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../../../src/cli/output-schema";
import type { ProbeTemplates } from "../../../src/probes/render";

const root = join(import.meta.dir, "..", "..", "..");
const executable = join(
  root,
  "dist",
  process.platform === "win32" ? "debug-mode.exe" : "debug-mode",
);
const temporaryDirectories: string[] = [];
const requireRuntimes = process.env.REQUIRE_TEMPLATE_RUNTIMES === "1";
const sourceSecrets = [
  "source-api-secret",
  "source-refresh-secret",
  "source-client-secret",
  "source-credentials-secret",
  "source-password-secret",
] as const;

interface TemplateOutput extends ProbeTemplates {
  eventSchema: Record<string, string>;
}

interface Fixture {
  callData: string;
  command: (fixturePath: string) => string[];
  file: string;
  ingest: "file" | "http";
  language: string;
  runtime: string | null;
  setup?: (workspace: string) => Promise<void>;
}

const fixtures: Fixture[] = [
  {
    callData:
      '{ value: 42, userPassword: "source-password-secret", "Client Secret": "source-client-secret", nested: { apiKey: "source-api-secret", items: [{ "refresh-token": "source-refresh-secret" }, { credentials: "source-credentials-secret" }] } }',
    command: (path) => [Bun.which("node") ?? "", path],
    file: "javascript-http.mjs",
    ingest: "http",
    language: "javascript",
    runtime: Bun.which("node"),
  },
  {
    callData:
      '{ value: 42, userPassword: "source-password-secret", "Client Secret": "source-client-secret", nested: { apiKey: "source-api-secret", items: [{ "refresh-token": "source-refresh-secret" }, { credentials: "source-credentials-secret" }] } }',
    command: (path) => [process.execPath, path],
    file: "typescript-http.ts",
    ingest: "http",
    language: "typescript",
    runtime: process.execPath,
  },
  {
    callData:
      '{"value": 42, "userPassword": "source-password-secret", "Client Secret": "source-client-secret", "nested": {"apiKey": "source-api-secret", "items": [{"refresh-token": "source-refresh-secret"}, {"credentials": "source-credentials-secret"}]}}',
    command: (path) => [Bun.which("python3") ?? "", path],
    file: "python-file.py",
    ingest: "file",
    language: "python",
    runtime: Bun.which("python3"),
  },
  {
    callData:
      'map[string]any{"value": 42, "userPassword": "source-password-secret", "Client Secret": "source-client-secret", "nested": map[string]any{"apiKey": "source-api-secret", "items": []any{map[string]string{"refresh-token": "source-refresh-secret"}, map[string]string{"credentials": "source-credentials-secret"}}}}',
    command: (path) => [Bun.which("go") ?? "", "run", path],
    file: "go-file.go",
    ingest: "file",
    language: "go",
    runtime: Bun.which("go"),
  },
  {
    callData:
      '{ "value" => 42, "userPassword" => "source-password-secret", "Client Secret" => "source-client-secret", "nested" => { "apiKey" => "source-api-secret", "items" => [{ "refresh-token" => "source-refresh-secret" }, { "credentials" => "source-credentials-secret" }] } }',
    command: (path) => [Bun.which("ruby") ?? "", path],
    file: "ruby-file.rb",
    ingest: "file",
    language: "ruby",
    runtime: Bun.which("ruby"),
  },
  {
    callData:
      '["value" => 42, "userPassword" => "source-password-secret", "Client Secret" => "source-client-secret", "nested" => ["apiKey" => "source-api-secret", "items" => [["refresh-token" => "source-refresh-secret"], ["credentials" => "source-credentials-secret"]]]]',
    command: (path) => [Bun.which("php") ?? "", path],
    file: "php-file.php",
    ingest: "file",
    language: "php",
    runtime: Bun.which("php"),
  },
  {
    callData:
      '@{ value = 42; userPassword = "source-password-secret"; "Client Secret" = "source-client-secret"; nested = @{ apiKey = "source-api-secret"; items = @(@{ "refresh-token" = "source-refresh-secret" }, @{ credentials = "source-credentials-secret" }) } }',
    command: (path) => [Bun.which("pwsh") ?? "", "-File", path],
    file: "powershell-file.ps1",
    ingest: "file",
    language: "powershell",
    runtime: Bun.which("pwsh"),
  },
  {
    callData:
      'new Dictionary<string, object?> { ["value"] = 42, ["userPassword"] = "source-password-secret", ["Client Secret"] = "source-client-secret", ["nested"] = new Dictionary<string, object?> { ["apiKey"] = "source-api-secret", ["items"] = new object?[] { new Dictionary<string, object?> { ["refresh-token"] = "source-refresh-secret" }, new Dictionary<string, object?> { ["credentials"] = "source-credentials-secret" } } } }',
    command: (path) => [Bun.which("dotnet") ?? "", "run", "--project", join(path, "..")],
    file: "Program.cs",
    ingest: "file",
    language: "csharp",
    runtime: Bun.which("dotnet"),
    setup: async (workspace) => {
      const version = await run([Bun.which("dotnet") ?? "", "--version"]);
      expect(version.exitCode, version.stderr).toBe(0);
      const major = Number.parseInt(version.stdout, 10);
      expect(Number.isSafeInteger(major)).toBe(true);
      await writeFile(
        join(workspace, "template-runtime.csproj"),
        `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net${major}.0</TargetFramework><ImplicitUsings>disable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>`,
      );
    },
  },
  {
    callData:
      '["value": 42, "userPassword": "source-password-secret", "Client Secret": "source-client-secret", "nested": ["apiKey": "source-api-secret", "items": [["refresh-token": "source-refresh-secret"], ["credentials": "source-credentials-secret"]]]]',
    command: (path) => [Bun.which("swift") ?? "", path],
    file: "swift-file.swift",
    ingest: "file",
    language: "swift",
    runtime: process.platform === "darwin" ? Bun.which("swift") : null,
  },
];

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

function startCaptureProxy(destination: string) {
  const bodies: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      bodies.push(body);
      const forwarded = await fetch(destination, {
        body,
        headers: { "Content-Type": "application/x-ndjson" },
        method: "POST",
      });
      await forwarded.arrayBuffer();
      return new Response("captured-response-body");
    },
  });
  return {
    bodies,
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${server.port}/capture`,
  };
}

async function createSession(home: string) {
  const result = await runCli(home, ["create", "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as CommandResult<{
    appendPath: string;
    ingestUrl: string;
    sessionId: string;
  }>;
}

async function render(home: string, fixture: Fixture) {
  const result = await runCli(home, [
    "template",
    "--language",
    fixture.language,
    "--ingest",
    fixture.ingest,
    "--json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as CommandResult<TemplateOutput>;
}

function materialize(
  source: string,
  template: TemplateOutput,
  fixture: Fixture,
  target: string,
  callCount = 1,
): string {
  const values: Record<string, string> = {
    __APPEND_PATH__: target,
    __DATA_EXPRESSION__: fixture.callData,
    __HYPOTHESIS_ID__: "H-live",
    __INGEST_URL__: target,
    __LOCATION__: `${fixture.file}:1`,
    __MESSAGE__: "Live fixture observed",
  };
  let helper = template.helperTemplate;
  let call = template.callTemplate;
  for (const placeholder of Object.keys(template.placeholders)) {
    const value = values[placeholder];
    if (value === undefined) {
      throw new Error(`No fixture value for ${placeholder}`);
    }
    if (placeholder === "__INGEST_URL__" || placeholder === "__APPEND_PATH__") {
      helper = helper.replaceAll(placeholder, value);
    } else {
      call = call.replaceAll(placeholder, value);
    }
  }
  call = Array.from({ length: callCount }, () => call).join("\n");
  return source
    .replace("/* __HELPER_TEMPLATE__ */", helper)
    .replace("/* __CALL_TEMPLATE__ */", call)
    .replace("__HELPER_TEMPLATE__", helper)
    .replace("__CALL_TEMPLATE__", call);
}

async function awaitRecords(home: string, sessionId: string, expectedCount: number) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await runCli(home, [
      "logs",
      "--session",
      sessionId,
      "--limit",
      String(expectedCount),
      "--json",
    ]);
    if (result.exitCode === 0) {
      const output = JSON.parse(result.stdout) as CommandResult<{
        records: Array<Record<string, unknown>>;
      }>;
      if (output.data.records.length === expectedCount) {
        return output.data.records;
      }
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${expectedCount} fixture events`);
}

beforeAll(async () => {
  const built = await run([process.execPath, "run", "build"]);
  expect(built.exitCode, built.stderr).toBe(0);
});

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("live language templates", () => {
  for (const fixture of fixtures.filter(
    (candidate) => candidate.language !== "swift" || process.platform === "darwin",
  )) {
    const unavailable = fixture.runtime === null;
    const runtimeTest = unavailable && !requireRuntimes ? test.skip : test;

    runtimeTest(
      `${fixture.language} emits the exact accepted event through ${fixture.ingest}`,
      async () => {
        expect(fixture.runtime, `${fixture.language} runtime must be installed`).not.toBeNull();
        const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
        const workspace = await mkdtemp(join(tmpdir(), `debug-mode-${fixture.language}-`));
        temporaryDirectories.push(home, workspace);
        let capture: ReturnType<typeof startCaptureProxy> | undefined;

        try {
          const created = await createSession(home);
          const rendered = await render(home, fixture);
          const source = await readFile(
            join(root, "tests", "fixtures", "languages", fixture.file),
            "utf8",
          );
          await fixture.setup?.(workspace);
          const fixturePath = join(workspace, fixture.file);
          if (fixture.ingest === "http") {
            capture = startCaptureProxy(created.data.ingestUrl);
          }
          const target = capture?.url ?? created.data.appendPath.replaceAll("\\", "\\\\");
          await writeFile(fixturePath, materialize(source, rendered.data, fixture, target));

          const startedAt = Date.now();
          const executed = await run(fixture.command(fixturePath));
          const finishedAt = Date.now();
          expect(executed.exitCode, executed.stderr).toBe(0);
          const raw = capture
            ? capture.bodies.join("")
            : await readFile(created.data.appendPath, "utf8");
          for (const secret of sourceSecrets) {
            expect(raw).not.toContain(secret);
          }
          expect(raw).toContain("[REDACTED]");

          const [event] = await awaitRecords(home, created.data.sessionId, 1);
          expect(event).toMatchObject({
            data: {
              "Client Secret": "[REDACTED]",
              nested: {
                apiKey: "[REDACTED]",
                items: [{ "refresh-token": "[REDACTED]" }, { credentials: "[REDACTED]" }],
              },
              userPassword: "[REDACTED]",
              value: 42,
            },
            hypothesisId: "H-live",
            location: `${fixture.file}:1`,
            message: "Live fixture observed",
          });
          const timestamp = event?.timestamp;
          expect(Number.isSafeInteger(timestamp)).toBe(true);
          expect(timestamp).toBeGreaterThanOrEqual(startedAt);
          expect(timestamp).toBeLessThanOrEqual(finishedAt);
          const status = await runCli(home, [
            "status",
            "--session",
            created.data.sessionId,
            "--json",
          ]);
          expect(status.exitCode, status.stderr).toBe(0);
          expect(JSON.parse(status.stdout)).toMatchObject({
            statistics: {
              eventCount: 1,
            },
          });
        } finally {
          capture?.stop();
          await runCli(home, ["stop", "--json"]);
        }
      },
      30_000,
    );

    runtimeTest(
      `${fixture.language} preserves application behavior when delivery fails`,
      async () => {
        expect(fixture.runtime, `${fixture.language} runtime must be installed`).not.toBeNull();
        const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
        const workspace = await mkdtemp(join(tmpdir(), `debug-mode-${fixture.language}-failure-`));
        temporaryDirectories.push(home, workspace);
        const rendered = await render(home, fixture);
        const source = await readFile(
          join(root, "tests", "fixtures", "languages", fixture.file),
          "utf8",
        );
        await fixture.setup?.(workspace);
        const fixturePath = join(workspace, fixture.file);
        const unavailableTarget =
          fixture.ingest === "http"
            ? "http://127.0.0.1:1/ingest/00000000-0000-4000-8000-000000000000"
            : join(workspace, "missing", "incoming.ndjson").replaceAll("\\", "\\\\");
        await writeFile(
          fixturePath,
          materialize(source, rendered.data, fixture, unavailableTarget),
        );

        const executed = await run(fixture.command(fixturePath));
        expect(executed.exitCode, executed.stderr).toBe(0);
        expect(`${executed.stdout}\n${executed.stderr}`).toContain("application-completed");
      },
      30_000,
    );
  }

  for (const language of ["javascript", "typescript"]) {
    test(`${language} cleans up response bodies under sustained HTTP emission`, async () => {
      const fixture = fixtures.find((candidate) => candidate.language === language);
      if (!fixture) {
        throw new Error(`Missing ${language} fixture`);
      }
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), `debug-mode-${language}-volume-`));
      temporaryDirectories.push(home, workspace);
      const created = await createSession(home);
      const capture = startCaptureProxy(created.data.ingestUrl);

      try {
        const rendered = await render(home, fixture);
        const fixtureSource = (
          await readFile(join(root, "tests", "fixtures", "languages", fixture.file), "utf8")
        )
          .replace("setTimeout(resolve, 200)", "setTimeout(resolve, 2_000)")
          .replace("Bun.sleep(200)", "Bun.sleep(2_000)");
        const instrumentation =
          language === "typescript"
            ? [
                "const __agentRealFetch = globalThis.fetch;",
                "let __agentCleanupCount = 0;",
                "globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {",
                "  const response = await __agentRealFetch(...args);",
                "  return {",
                "    body: response.body === null ? null : {",
                "      cancel: () => {",
                "        __agentCleanupCount += 1;",
                "        return response.body?.cancel();",
                "      },",
                "    },",
                "  } as Response;",
                "}) as typeof fetch;",
              ].join("\n")
            : [
                "const __agentRealFetch = globalThis.fetch;",
                "let __agentCleanupCount = 0;",
                "globalThis.fetch = async (...args) => {",
                "  const response = await __agentRealFetch(...args);",
                "  return {",
                "    body: response.body === null ? null : {",
                "      cancel: () => {",
                "        __agentCleanupCount += 1;",
                "        return response.body?.cancel();",
                "      },",
                "    },",
                "  };",
                "};",
              ].join("\n");
        const source = `${instrumentation}\n${fixtureSource}\nconsole.log("cleanup-count:" + __agentCleanupCount);`;
        const fixturePath = join(workspace, fixture.file);
        await writeFile(fixturePath, materialize(source, rendered.data, fixture, capture.url, 200));

        const executed = await run(fixture.command(fixturePath));
        expect(executed.exitCode, executed.stderr).toBe(0);
        expect(executed.stdout).toContain("cleanup-count:200");
        expect(capture.bodies).toHaveLength(200);
        for (const body of capture.bodies) {
          for (const secret of sourceSecrets) {
            expect(body).not.toContain(secret);
          }
        }
        expect(await awaitRecords(home, created.data.sessionId, 200)).toHaveLength(200);
      } finally {
        capture.stop();
        await runCli(home, ["stop", "--json"]);
      }
    }, 30_000);
  }

  if (process.platform === "darwin") {
    const swift = fixtures.find((fixture) => fixture.language === "swift");
    const swiftRuntimeTest = swift?.runtime === null && !requireRuntimes ? test.skip : test;

    swiftRuntimeTest(
      "Swift concurrent emitters preserve every complete appended line",
      async () => {
        if (!swift) {
          throw new Error("Missing Swift fixture");
        }
        expect(swift.runtime, "Swift runtime must be installed").not.toBeNull();
        const swiftc = Bun.which("swiftc");
        expect(swiftc, "swiftc must be installed").not.toBeNull();
        const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
        const workspace = await mkdtemp(join(tmpdir(), "debug-mode-swift-concurrent-"));
        temporaryDirectories.push(home, workspace);
        const rendered = await render(home, swift);
        const source = await readFile(
          join(root, "tests", "fixtures", "languages", swift.file),
          "utf8",
        );
        const appendPath = join(workspace, "concurrent.ndjson");
        const fixturePath = join(workspace, swift.file);
        const executablePath = join(workspace, "swift-emitter");
        await writeFile(fixturePath, materialize(source, rendered.data, swift, appendPath));
        const compiled = await run([swiftc ?? "", fixturePath, "-o", executablePath]);
        expect(compiled.exitCode, compiled.stderr).toBe(0);

        const executions = await Promise.all(
          Array.from({ length: 32 }, () => run([executablePath])),
        );
        for (const execution of executions) {
          expect(execution.exitCode, execution.stderr).toBe(0);
        }
        const contents = await readFile(appendPath, "utf8");
        expect(contents.endsWith("\n")).toBe(true);
        const lines = contents.split("\n").filter(Boolean);
        expect(lines).toHaveLength(32);
        for (const line of lines) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      },
      30_000,
    );
  }
});
