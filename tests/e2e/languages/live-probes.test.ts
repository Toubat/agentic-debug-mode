import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../../../src/cli/output-schema";
import type { JsonValue } from "../../../src/domain/event";
import { redactSecrets } from "../../../src/domain/redaction";
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
  "source-api-acronym-secret",
  "source-api-token-secret",
  "source-id-token-secret",
  "source-oauth-token-secret",
] as const;
const policyInput: JsonValue = {
  APIKey: "source-api-acronym-secret",
  APIToken: "source-api-token-secret",
  "Client Secret": "source-client-secret",
  IDToken: "source-id-token-secret",
  OAuthToken: "source-oauth-token-secret",
  designToken: "visible-design-token",
  fortuneCookie: "visible-fortune-cookie",
  nested: {
    apiKey: "source-api-secret",
    items: [
      { "refresh-token": "source-refresh-secret" },
      { credentials: "source-credentials-secret" },
    ],
  },
  password: "source-password-secret",
  passwordPolicy: "visible-password-policy",
  secretSauceName: "visible-secret-sauce",
  tokenCount: 7,
  value: 42,
};
const canonicalPolicyData = redactSecrets(policyInput).value;
const sharedPolicyLeaf = { APIKey: "source-shared-secret" };
const sharedPolicyInput: JsonValue = {
  left: sharedPolicyLeaf,
  right: sharedPolicyLeaf,
};
const canonicalSharedPolicyData = redactSecrets(sharedPolicyInput).value;

interface TemplateOutput extends ProbeTemplates {
  eventSchema: Record<string, string>;
}

interface Fixture {
  callData: string;
  command: (fixturePath: string) => string[];
  cycleData: string;
  cyclePrelude: string;
  file: string;
  ingest: "file" | "http";
  language: string;
  runtime: string | null;
  setup?: (workspace: string) => Promise<void>;
  sharedData: string;
  sharedPrelude: string;
}

const fixtures: Fixture[] = [
  {
    callData:
      '{ value: 42, designToken: "visible-design-token", fortuneCookie: "visible-fortune-cookie", secretSauceName: "visible-secret-sauce", tokenCount: 7, passwordPolicy: "visible-password-policy", password: "source-password-secret", APIKey: "source-api-acronym-secret", APIToken: "source-api-token-secret", IDToken: "source-id-token-secret", OAuthToken: "source-oauth-token-secret", "Client Secret": "source-client-secret", nested: { apiKey: "source-api-secret", items: [{ "refresh-token": "source-refresh-secret" }, { credentials: "source-credentials-secret" }] } }',
    command: (path) => [Bun.which("node") ?? "", path],
    cycleData: "__agentCycle",
    cyclePrelude: "const __agentCycle = {}; __agentCycle.self = __agentCycle;",
    file: "javascript-http.mjs",
    ingest: "http",
    language: "javascript",
    runtime: Bun.which("node"),
    sharedData: "{ left: __agentShared, right: __agentShared }",
    sharedPrelude: 'const __agentShared = { APIKey: "source-shared-secret" };',
  },
  {
    callData:
      '{ value: 42, designToken: "visible-design-token", fortuneCookie: "visible-fortune-cookie", secretSauceName: "visible-secret-sauce", tokenCount: 7, passwordPolicy: "visible-password-policy", password: "source-password-secret", APIKey: "source-api-acronym-secret", APIToken: "source-api-token-secret", IDToken: "source-id-token-secret", OAuthToken: "source-oauth-token-secret", "Client Secret": "source-client-secret", nested: { apiKey: "source-api-secret", items: [{ "refresh-token": "source-refresh-secret" }, { credentials: "source-credentials-secret" }] } }',
    command: (path) => [process.execPath, path],
    cycleData: "__agentCycle",
    cyclePrelude:
      "const __agentCycle: Record<string, unknown> = {}; __agentCycle.self = __agentCycle;",
    file: "typescript-http.ts",
    ingest: "http",
    language: "typescript",
    runtime: process.execPath,
    sharedData: "{ left: __agentShared, right: __agentShared }",
    sharedPrelude:
      'const __agentShared: Record<string, unknown> = { APIKey: "source-shared-secret" };',
  },
  {
    callData:
      '{"value": 42, "designToken": "visible-design-token", "fortuneCookie": "visible-fortune-cookie", "secretSauceName": "visible-secret-sauce", "tokenCount": 7, "passwordPolicy": "visible-password-policy", "password": "source-password-secret", "APIKey": "source-api-acronym-secret", "APIToken": "source-api-token-secret", "IDToken": "source-id-token-secret", "OAuthToken": "source-oauth-token-secret", "Client Secret": "source-client-secret", "nested": {"apiKey": "source-api-secret", "items": ({"refresh-token": "source-refresh-secret"}, {"credentials": "source-credentials-secret"})}}',
    command: (path) => [Bun.which("python3") ?? "", path],
    cycleData: "__agent_cycle",
    cyclePrelude: '__agent_cycle = {}; __agent_cycle["self"] = __agent_cycle',
    file: "python-file.py",
    ingest: "file",
    language: "python",
    runtime: Bun.which("python3"),
    sharedData: '{"left": __agent_shared, "right": __agent_shared}',
    sharedPrelude: '__agent_shared = {"APIKey": "source-shared-secret"}',
  },
  {
    callData:
      'map[string]any{"value": 42, "designToken": "visible-design-token", "fortuneCookie": "visible-fortune-cookie", "secretSauceName": "visible-secret-sauce", "tokenCount": 7, "passwordPolicy": "visible-password-policy", "password": "source-password-secret", "APIKey": "source-api-acronym-secret", "APIToken": "source-api-token-secret", "IDToken": "source-id-token-secret", "OAuthToken": "source-oauth-token-secret", "Client Secret": "source-client-secret", "nested": map[string]any{"apiKey": "source-api-secret", "items": []any{map[string]string{"refresh-token": "source-refresh-secret"}, map[string]string{"credentials": "source-credentials-secret"}}}}',
    command: (path) => [Bun.which("go") ?? "", "run", path],
    cycleData: "__agentCycle",
    cyclePrelude: '__agentCycle := map[string]any{}; __agentCycle["self"] = __agentCycle',
    file: "go-file.go",
    ingest: "file",
    language: "go",
    runtime: Bun.which("go"),
    sharedData: 'map[string]any{"left": __agentShared, "right": __agentShared}',
    sharedPrelude: '__agentShared := map[string]any{"APIKey": "source-shared-secret"}',
  },
  {
    callData:
      '{ "value" => 42, "designToken" => "visible-design-token", "fortuneCookie" => "visible-fortune-cookie", "secretSauceName" => "visible-secret-sauce", "tokenCount" => 7, "passwordPolicy" => "visible-password-policy", "password" => "source-password-secret", "APIKey" => "source-api-acronym-secret", "APIToken" => "source-api-token-secret", "IDToken" => "source-id-token-secret", "OAuthToken" => "source-oauth-token-secret", "Client Secret" => "source-client-secret", "nested" => { "apiKey" => "source-api-secret", "items" => [{ "refresh-token" => "source-refresh-secret" }, { "credentials" => "source-credentials-secret" }] } }',
    command: (path) => [Bun.which("ruby") ?? "", path],
    cycleData: "__agent_cycle",
    cyclePrelude: '__agent_cycle = {}; __agent_cycle["self"] = __agent_cycle',
    file: "ruby-file.rb",
    ingest: "file",
    language: "ruby",
    runtime: Bun.which("ruby"),
    sharedData: '{ "left" => __agent_shared, "right" => __agent_shared }',
    sharedPrelude: '__agent_shared = { "APIKey" => "source-shared-secret" }',
  },
  {
    callData:
      '["value" => 42, "designToken" => "visible-design-token", "fortuneCookie" => "visible-fortune-cookie", "secretSauceName" => "visible-secret-sauce", "tokenCount" => 7, "passwordPolicy" => "visible-password-policy", "password" => "source-password-secret", "APIKey" => "source-api-acronym-secret", "APIToken" => "source-api-token-secret", "IDToken" => "source-id-token-secret", "OAuthToken" => "source-oauth-token-secret", "Client Secret" => "source-client-secret", "nested" => ["apiKey" => "source-api-secret", "items" => [["refresh-token" => "source-refresh-secret"], ["credentials" => "source-credentials-secret"]]]]',
    command: (path) => [Bun.which("php") ?? "", path],
    cycleData: "$__agentCycle",
    cyclePrelude: '$__agentCycle = []; $__agentCycle["self"] = &$__agentCycle;',
    file: "php-file.php",
    ingest: "file",
    language: "php",
    runtime: Bun.which("php"),
    sharedData: '["left" => $__agentShared, "right" => $__agentShared]',
    sharedPrelude: '$__agentShared = (object) ["APIKey" => "source-shared-secret"];',
  },
  {
    callData:
      '@{ value = 42; designToken = "visible-design-token"; fortuneCookie = "visible-fortune-cookie"; secretSauceName = "visible-secret-sauce"; tokenCount = 7; passwordPolicy = "visible-password-policy"; password = "source-password-secret"; APIKey = "source-api-acronym-secret"; APIToken = "source-api-token-secret"; IDToken = "source-id-token-secret"; OAuthToken = "source-oauth-token-secret"; "Client Secret" = "source-client-secret"; nested = @{ apiKey = "source-api-secret"; items = @(@{ "refresh-token" = "source-refresh-secret" }, @{ credentials = "source-credentials-secret" }) } }',
    command: (path) => [Bun.which("pwsh") ?? "", "-File", path],
    cycleData: "$__agentCycle",
    cyclePrelude: "$__agentCycle = @{}; $__agentCycle.self = $__agentCycle",
    file: "powershell-file.ps1",
    ingest: "file",
    language: "powershell",
    runtime: Bun.which("pwsh"),
    sharedData: "@{ left = $__agentShared; right = $__agentShared }",
    sharedPrelude: '$__agentShared = @{ APIKey = "source-shared-secret" }',
  },
  {
    callData:
      'new Dictionary<string, object?> { ["value"] = 42, ["designToken"] = "visible-design-token", ["fortuneCookie"] = "visible-fortune-cookie", ["secretSauceName"] = "visible-secret-sauce", ["tokenCount"] = 7, ["passwordPolicy"] = "visible-password-policy", ["password"] = "source-password-secret", ["APIKey"] = "source-api-acronym-secret", ["APIToken"] = "source-api-token-secret", ["IDToken"] = "source-id-token-secret", ["OAuthToken"] = "source-oauth-token-secret", ["Client Secret"] = "source-client-secret", ["nested"] = new Dictionary<string, object?> { ["apiKey"] = "source-api-secret", ["items"] = new object?[] { new Dictionary<string, object?> { ["refresh-token"] = "source-refresh-secret" }, new Dictionary<string, object?> { ["credentials"] = "source-credentials-secret" } } } }',
    command: (path) => [Bun.which("dotnet") ?? "", "run", "--project", join(path, "..")],
    cycleData: "__agentCycle",
    cyclePrelude:
      'var __agentCycle = new Dictionary<string, object?>(); __agentCycle["self"] = __agentCycle;',
    file: "Program.cs",
    ingest: "file",
    language: "csharp",
    runtime: Bun.which("dotnet"),
    sharedData:
      'new Dictionary<string, object?> { ["left"] = __agentShared, ["right"] = __agentShared }',
    sharedPrelude:
      'var __agentShared = new Dictionary<string, object?> { ["APIKey"] = "source-shared-secret" };',
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
      '["value": 42, "designToken": "visible-design-token", "fortuneCookie": "visible-fortune-cookie", "secretSauceName": "visible-secret-sauce", "tokenCount": 7, "passwordPolicy": "visible-password-policy", "password": "source-password-secret", "APIKey": "source-api-acronym-secret", "APIToken": "source-api-token-secret", "IDToken": "source-id-token-secret", "OAuthToken": "source-oauth-token-secret", "Client Secret": "source-client-secret", "nested": ["apiKey": "source-api-secret", "items": [["refresh-token": "source-refresh-secret"], ["credentials": "source-credentials-secret"]]]]',
    command: (path) => [Bun.which("swift") ?? "", path],
    cycleData: "__agentCycle",
    cyclePrelude: 'let __agentCycle = NSMutableDictionary(); __agentCycle["self"] = __agentCycle',
    file: "swift-file.swift",
    ingest: "file",
    language: "swift",
    runtime: process.platform === "darwin" ? Bun.which("swift") : null,
    sharedData: '["left": __agentShared, "right": __agentShared]',
    sharedPrelude: 'let __agentShared: [String: Any] = ["APIKey": "source-shared-secret"]',
  },
  {
    callData:
      'adbg!({ "value": 42i64, "designToken": "visible-design-token", "fortuneCookie": "visible-fortune-cookie", "secretSauceName": "visible-secret-sauce", "tokenCount": 7i64, "passwordPolicy": "visible-password-policy", "password": "source-password-secret", "APIKey": "source-api-acronym-secret", "APIToken": "source-api-token-secret", "IDToken": "source-id-token-secret", "OAuthToken": "source-oauth-token-secret", "Client Secret": "source-client-secret", "nested": { "apiKey": "source-api-secret", "items": [ { "refresh-token": "source-refresh-secret" }, { "credentials": "source-credentials-secret" } ] } })',
    // Rust's AgentValue is an owned tree, so a reference cycle is unrepresentable.
    // The depth-64 cap is the analogous unbounded-structure rejection: a value
    // nested past the cap is dropped without emitting, exactly like a cycle would be.
    command: (path) => {
      const rustc = Bun.which("rustc") ?? "";
      const binary = path.replace(/\.rs$/, process.platform === "win32" ? ".exe" : ".out");
      const script = `"${rustc}" -A warnings "${path}" -o "${binary}" && "${binary}"`;
      return process.platform === "win32" ? ["cmd", "/c", script] : ["sh", "-c", script];
    },
    cycleData: "__agent_cycle",
    cyclePrelude:
      "let mut __agent_cycle = AgentValue::Int(0); let mut __agent_depth = 0; while __agent_depth < 100 { __agent_cycle = AgentValue::Array(vec![__agent_cycle]); __agent_depth += 1; }",
    file: "rust-file.rs",
    ingest: "file",
    language: "rust",
    runtime: Bun.which("rustc"),
    sharedData:
      'AgentValue::Object(vec![("left".to_string(), __agent_shared.clone()), ("right".to_string(), __agent_shared)])',
    sharedPrelude:
      'let __agent_shared = AgentValue::Object(vec![("APIKey".to_string(), AgentValue::from("source-shared-secret"))]);',
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

interface ForwardStats {
  // Forward attempts that threw (ECONNRESET / connection-reuse exhaustion).
  thrown: number;
  // Non-202 daemon responses observed, by status code.
  nonOk: number[];
  // Forwards that never landed a 202 after exhausting retries — true event loss.
  dropped: number;
}

interface CaptureProxyOptions {
  // Forward attempts before giving up (production default is 4).
  maxAttempts?: number;
  // Test hook fired before each forward attempt; throwing simulates a transient
  // socket failure (ECONNRESET / connection-reuse exhaustion) for that attempt.
  beforeForward?: (attempt: number) => void | Promise<void>;
}

function startCaptureProxy(destination: string, options: CaptureProxyOptions = {}) {
  const maxAttempts = options.maxAttempts ?? 4;
  const bodies: string[] = [];
  const forwardStats: ForwardStats = { thrown: 0, nonOk: [], dropped: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      bodies.push(body);
      // Under sustained burst emission an individual forward can fail transiently
      // — the socket resets or a reused connection is exhausted, and Bun's fetch
      // throws. An earlier bare catch swallowed exactly these, silently dropping
      // events so the daemon ingested fewer than were captured. Retry a few times
      // (the daemon dedupes by event id, so re-sends are idempotent) and only give
      // up after exhausting attempts. A forward that never crashes the test
      // process on teardown is still fine because the retries are bounded.
      // Counters make any residual loss observable in the assertion message.
      let delivered = false;
      for (let attempt = 1; attempt <= maxAttempts && !delivered; attempt += 1) {
        try {
          await options.beforeForward?.(attempt);
          const forwarded = await fetch(destination, {
            body,
            headers: { "Content-Type": "application/x-ndjson" },
            method: "POST",
          });
          await forwarded.arrayBuffer();
          if (forwarded.status === 202) {
            delivered = true;
            break;
          }
          forwardStats.nonOk.push(forwarded.status);
        } catch {
          forwardStats.thrown += 1;
        }
        if (attempt < maxAttempts) {
          await Bun.sleep(25 * attempt);
        }
      }
      if (!delivered) {
        forwardStats.dropped += 1;
      }
      return new Response("captured-response-body");
    },
  });
  return {
    bodies,
    forwardStats,
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
  dataExpression = fixture.callData,
  callPrelude = "",
): string {
  const values: Record<string, string> = {
    __APPEND_PATH__: target,
    __DATA_EXPRESSION__: dataExpression,
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
  call = [callPrelude, Array.from({ length: callCount }, () => call).join("\n")]
    .filter(Boolean)
    .join("\n");
  return source
    .replace("/* __HELPER_TEMPLATE__ */", () => helper)
    .replace("/* __CALL_TEMPLATE__ */", () => call)
    .replace("__HELPER_TEMPLATE__", () => helper)
    .replace("__CALL_TEMPLATE__", () => call);
}

async function awaitRecords(home: string, sessionId: string, expectedCount: number) {
  // Slow shared CI runners (macOS especially) ingest a large burst of events
  // steadily but far slower than a dev laptop, so a fixed poll count races the
  // ingestion pipeline. Wait on *progress* instead: keep polling as long as the
  // record count keeps climbing, and only give up after a run of consecutive
  // polls with no progress (a genuine stall). A generous hard cap bounds the
  // pathological case where the daemon never ingests anything.
  const maxStalls = 80;
  const hardDeadline = Date.now() + 110_000;
  let lastCount = 0;
  let stalls = 0;
  while (Date.now() < hardDeadline) {
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
      const count = output.data.records.length;
      if (count === expectedCount) {
        return output.data.records;
      }
      if (count > lastCount) {
        lastCount = count;
        stalls = 0;
      } else {
        stalls += 1;
      }
    } else {
      stalls += 1;
    }
    if (stalls >= maxStalls) {
      break;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${expectedCount} fixture events (last saw ${lastCount})`);
}

beforeAll(async () => {
  const built = await run([process.execPath, "run", "build"]);
  expect(built.exitCode, built.stderr).toBe(0);
}, 120_000);

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
}, 60_000);

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
          const [rawLine] = raw.trim().split("\n");
          const rawEvent = JSON.parse(rawLine ?? "") as { data: unknown };
          expect(rawEvent.data).toEqual(canonicalPolicyData);

          const [event] = await awaitRecords(home, created.data.sessionId, 1);
          expect(event?.data).toEqual(canonicalPolicyData);
          expect(event).toMatchObject({
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
      90_000,
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
      90_000,
    );

    runtimeTest(
      `${fixture.language} rejects cyclic values without emitting`,
      async () => {
        expect(fixture.runtime, `${fixture.language} runtime must be installed`).not.toBeNull();
        const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
        const workspace = await mkdtemp(join(tmpdir(), `debug-mode-${fixture.language}-cycle-`));
        temporaryDirectories.push(home, workspace);
        const created = await createSession(home);
        const rendered = await render(home, fixture);
        const source = await readFile(
          join(root, "tests", "fixtures", "languages", fixture.file),
          "utf8",
        );
        await fixture.setup?.(workspace);
        const fixturePath = join(workspace, fixture.file);
        const capture =
          fixture.ingest === "http" ? startCaptureProxy(created.data.ingestUrl) : undefined;
        const target = capture?.url ?? created.data.appendPath.replaceAll("\\", "\\\\");

        try {
          await writeFile(
            fixturePath,
            materialize(
              source,
              rendered.data,
              fixture,
              target,
              1,
              fixture.cycleData,
              fixture.cyclePrelude,
            ),
          );
          const executed = await run(fixture.command(fixturePath));
          expect(executed.exitCode, executed.stderr).toBe(0);
          expect(`${executed.stdout}\n${executed.stderr}`).toContain("application-completed");
          await Bun.sleep(200);
          expect(capture?.bodies ?? []).toHaveLength(0);
          const raw =
            fixture.ingest === "file"
              ? await readFile(created.data.appendPath, "utf8").catch(() => "")
              : "";
          expect(raw).toBe("");
          const logs = await runCli(home, ["logs", "--session", created.data.sessionId, "--json"]);
          expect(logs.exitCode, logs.stderr).toBe(0);
          expect(JSON.parse(logs.stdout)).toMatchObject({
            statistics: { totalRecords: 0 },
          });
        } finally {
          capture?.stop();
          await runCli(home, ["stop", "--json"]);
        }
      },
      90_000,
    );

    runtimeTest(
      `${fixture.language} accepts shared acyclic references`,
      async () => {
        expect(fixture.runtime, `${fixture.language} runtime must be installed`).not.toBeNull();
        const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
        const workspace = await mkdtemp(join(tmpdir(), `debug-mode-${fixture.language}-shared-`));
        temporaryDirectories.push(home, workspace);
        const created = await createSession(home);
        const rendered = await render(home, fixture);
        const source = await readFile(
          join(root, "tests", "fixtures", "languages", fixture.file),
          "utf8",
        );
        await fixture.setup?.(workspace);
        const fixturePath = join(workspace, fixture.file);
        const capture =
          fixture.ingest === "http" ? startCaptureProxy(created.data.ingestUrl) : undefined;
        const target = capture?.url ?? created.data.appendPath.replaceAll("\\", "\\\\");

        try {
          await writeFile(
            fixturePath,
            materialize(
              source,
              rendered.data,
              fixture,
              target,
              1,
              fixture.sharedData,
              fixture.sharedPrelude,
            ),
          );
          const executed = await run(fixture.command(fixturePath));
          expect(executed.exitCode, executed.stderr).toBe(0);
          const raw = capture
            ? capture.bodies.join("")
            : await readFile(created.data.appendPath, "utf8");
          expect(raw).not.toContain("source-shared-secret");
          const [rawLine] = raw.trim().split("\n");
          const rawEvent = JSON.parse(rawLine ?? "") as { data: unknown };
          expect(rawEvent.data).toEqual(canonicalSharedPolicyData);
          const [event] = await awaitRecords(home, created.data.sessionId, 1);
          expect(event?.data).toEqual(canonicalSharedPolicyData);
        } finally {
          capture?.stop();
          await runCli(home, ["stop", "--json"]);
        }
      },
      90_000,
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
        // The probes emit fire-and-forget requests, so the cleanup callbacks
        // settle asynchronously. Poll for all of them to land instead of racing
        // a fixed sleep, which is unreliable under slow concurrent I/O (Windows).
        const epilogue = [
          "for (let __agentWait = 0; __agentWait < 600 && __agentCleanupCount < 200; __agentWait += 1) {",
          "  await new Promise((resolve) => setTimeout(resolve, 50));",
          "}",
          'console.log("cleanup-count:" + __agentCleanupCount);',
        ].join("\n");
        const source = `${instrumentation}\n${fixtureSource}\n${epilogue}`;
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
        let records: Array<Record<string, unknown>>;
        try {
          records = await awaitRecords(home, created.data.sessionId, 200);
        } catch (error) {
          // Attribute any loss precisely: distinguish transient forward failures
          // the proxy recovered from a genuine drop that starved the daemon.
          throw new Error(
            `${(error as Error).message} | proxy forward stats: ${JSON.stringify(capture.forwardStats)}`,
          );
        }
        expect(records).toHaveLength(200);
      } finally {
        capture.stop();
        await runCli(home, ["stop", "--json"]);
      }
    }, 120_000);
  }

  for (const language of ["csharp", "powershell"]) {
    const fixture = fixtures.find((candidate) => candidate.language === language);
    const unavailable = fixture?.runtime === null;
    const runtimeTest = unavailable && !requireRuntimes ? test.skip : test;

    runtimeTest(
      `${language} redacts custom value-type members`,
      async () => {
        if (!fixture) {
          throw new Error(`Missing ${language} fixture`);
        }
        expect(fixture.runtime, `${language} runtime must be installed`).not.toBeNull();
        const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
        const workspace = await mkdtemp(join(tmpdir(), `debug-mode-${language}-value-type-`));
        temporaryDirectories.push(home, workspace);
        const created = await createSession(home);
        const rendered = await render(home, fixture);
        let source = await readFile(
          join(root, "tests", "fixtures", "languages", fixture.file),
          "utf8",
        );
        await fixture.setup?.(workspace);
        const fixturePath = join(workspace, fixture.file);
        const isCSharp = language === "csharp";
        const prelude = isCSharp
          ? [
              "var __agentValue = new AgentCustomValue",
              "{",
              '    APIKey = "source-value-api-secret",',
              '    designToken = "visible-value-design-token",',
              '    Nested = new Dictionary<string, object?> { ["OAuthToken"] = "source-value-oauth-secret" },',
              "};",
            ].join("\n")
          : [
              "Add-Type -TypeDefinition @'",
              "public struct AgentCustomValue {",
              "    public string APIKey { get; set; }",
              "    public object Nested { get; set; }",
              "    public string designToken;",
              "}",
              "'@",
              "$__agentValue = [AgentCustomValue]::new()",
              '$__agentValue.APIKey = "source-value-api-secret"',
              '$__agentValue.designToken = "visible-value-design-token"',
              '$__agentValue.Nested = @{ OAuthToken = "source-value-oauth-secret" }',
            ].join("\n");
        if (isCSharp) {
          source = source.replace(
            "/* __EXTRA_TYPES__ */",
            [
              "internal struct AgentCustomValue",
              "{",
              "    public string APIKey { get; init; }",
              "    public Dictionary<string, object?> Nested;",
              "    public string designToken;",
              "}",
            ].join("\n"),
          );
        }
        await writeFile(
          fixturePath,
          materialize(
            source,
            rendered.data,
            fixture,
            created.data.appendPath.replaceAll("\\", "\\\\"),
            1,
            isCSharp ? "__agentValue" : "$__agentValue",
            prelude,
          ),
        );

        try {
          const executed = await run(fixture.command(fixturePath));
          expect(executed.exitCode, executed.stderr).toBe(0);
          const raw = await readFile(created.data.appendPath, "utf8");
          expect(raw).not.toContain("source-value-api-secret");
          expect(raw).not.toContain("source-value-oauth-secret");
          expect(raw).toContain("visible-value-design-token");
          const [event] = await awaitRecords(home, created.data.sessionId, 1);
          expect(event).toMatchObject({
            data: {
              APIKey: "[REDACTED]",
              Nested: { OAuthToken: "[REDACTED]" },
              designToken: "visible-value-design-token",
            },
          });
        } finally {
          await runCli(home, ["stop", "--json"]);
        }
      },
      90_000,
    );
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
      90_000,
    );
  }
});

// Fault-injection coverage for the capture proxy's forward retry. This is the
// load-bearing proof that the retry recovers the exact failure CI hit — a
// transient forward failure that the previous bare `catch {}` swallowed, so the
// daemon ingested fewer events than were captured. Uses a lightweight fake
// daemon instead of the full fixture pipeline so it runs fast and deterministic.
describe("capture proxy forward retry", () => {
  function startFakeDaemon(handler: (body: string) => number) {
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.text();
        received.push(body);
        return new Response(null, { status: handler(body) });
      },
    });
    return {
      received,
      stop: () => server.stop(true),
      url: `http://127.0.0.1:${server.port}/ingest`,
    };
  }

  async function post(url: string, body: string) {
    const response = await fetch(url, { body, method: "POST" });
    await response.arrayBuffer();
  }

  test("recovers every event when the first forward attempt throws", async () => {
    const daemon = startFakeDaemon(() => 202);
    // Fail attempt 1 of every forward, exactly the transient failure CI hit.
    const proxy = startCaptureProxy(daemon.url, {
      beforeForward: (attempt) => {
        if (attempt === 1) {
          throw new Error("injected transient forward failure");
        }
      },
    });
    try {
      const count = 40;
      await Promise.all(
        Array.from({ length: count }, (_, index) => post(proxy.url, `{"id":${index}}`)),
      );
      // Retry delivered all of them: no drops, and the daemon saw each event.
      expect(new Set(daemon.received).size).toBe(count);
      expect(proxy.forwardStats.dropped).toBe(0);
      expect(proxy.forwardStats.thrown).toBe(count);
    } finally {
      proxy.stop();
      daemon.stop();
    }
  });

  test("re-sends after a non-2xx response without duplicating ingested events", async () => {
    // The daemon rejects each body once (503), then accepts it (202) — proving
    // the retry re-sends and that a duplicate delivery is idempotent: the count
    // of distinct events stays exact even though the daemon received each twice.
    const seen = new Set<string>();
    const daemon = startFakeDaemon((body) => {
      if (seen.has(body)) {
        return 202;
      }
      seen.add(body);
      return 503;
    });
    const proxy = startCaptureProxy(daemon.url);
    try {
      const count = 40;
      await Promise.all(
        Array.from({ length: count }, (_, index) => post(proxy.url, `{"id":${index}}`)),
      );
      expect(new Set(daemon.received).size).toBe(count);
      expect(daemon.received).toHaveLength(count * 2);
      expect(proxy.forwardStats.nonOk).toHaveLength(count);
      expect(proxy.forwardStats.dropped).toBe(0);
    } finally {
      proxy.stop();
      daemon.stop();
    }
  });

  test("with retries disabled the injected fault drops events and stats attribute it", async () => {
    // RED baseline: attempts=1 is the retry-disabled variant. The same injected
    // fault that the retry recovers above now loses every event, and the
    // ForwardStats counters surface exactly how many — the attribution the
    // sustained test appends to its failure message.
    const daemon = startFakeDaemon(() => 202);
    const proxy = startCaptureProxy(daemon.url, {
      maxAttempts: 1,
      beforeForward: () => {
        throw new Error("injected transient forward failure");
      },
    });
    try {
      const count = 10;
      await Promise.all(
        Array.from({ length: count }, (_, index) => post(proxy.url, `{"id":${index}}`)),
      );
      expect(new Set(daemon.received).size).toBe(0);
      expect(proxy.forwardStats.dropped).toBe(count);
      expect(proxy.forwardStats.thrown).toBe(count);
      // The attribution string the sustained waiter surfaces carries the drop.
      expect(JSON.stringify(proxy.forwardStats)).toContain('"dropped":10');
    } finally {
      proxy.stop();
      daemon.stop();
    }
  });
});
