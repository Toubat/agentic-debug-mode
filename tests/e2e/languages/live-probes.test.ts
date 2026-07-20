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
  // A sequence of argv steps run in order without a shell; each step must exit 0
  // before the next runs. Compiled languages use two steps (compile, then run);
  // interpreted languages use one. Avoiding a shell sidesteps cmd.exe quote
  // mangling of compound "&&" command strings on Windows.
  command: (fixturePath: string) => string[][];
  // How the call site supplies `data`. native-json-value templates redact and
  // serialize client-side; serialized-json templates pass raw caller JSON that
  // the daemon redacts. The cycle/shared-reference cases only apply to the
  // client-side value model, so they are omitted for serialized-json fixtures.
  dataEncoding: "native-json-value" | "serialized-json";
  cycleData?: string;
  cyclePrelude?: string;
  file: string;
  ingest: "file" | "http";
  language: string;
  runtime: string | null;
  setup?: (workspace: string) => Promise<void>;
  sharedData?: string;
  sharedPrelude?: string;
}

const fixtures: Fixture[] = [
  {
    callData:
      '{ value: 42, designToken: "visible-design-token", fortuneCookie: "visible-fortune-cookie", secretSauceName: "visible-secret-sauce", tokenCount: 7, passwordPolicy: "visible-password-policy", password: "source-password-secret", APIKey: "source-api-acronym-secret", APIToken: "source-api-token-secret", IDToken: "source-id-token-secret", OAuthToken: "source-oauth-token-secret", "Client Secret": "source-client-secret", nested: { apiKey: "source-api-secret", items: [{ "refresh-token": "source-refresh-secret" }, { credentials: "source-credentials-secret" }] } }',
    command: (path) => [[Bun.which("node") ?? "", path]],
    cycleData: "__agentCycle",
    cyclePrelude: "const __agentCycle = {}; __agentCycle.self = __agentCycle;",
    dataEncoding: "native-json-value",
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
    command: (path) => [[process.execPath, path]],
    cycleData: "__agentCycle",
    cyclePrelude:
      "const __agentCycle: Record<string, unknown> = {}; __agentCycle.self = __agentCycle;",
    dataEncoding: "native-json-value",
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
    command: (path) => [[Bun.which("python3") ?? "", path]],
    cycleData: "__agent_cycle",
    cyclePrelude: '__agent_cycle = {}; __agent_cycle["self"] = __agent_cycle',
    dataEncoding: "native-json-value",
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
    command: (path) => [[Bun.which("go") ?? "", "run", path]],
    cycleData: "__agentCycle",
    cyclePrelude: '__agentCycle := map[string]any{}; __agentCycle["self"] = __agentCycle',
    dataEncoding: "native-json-value",
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
    command: (path) => [[Bun.which("ruby") ?? "", path]],
    cycleData: "__agent_cycle",
    cyclePrelude: '__agent_cycle = {}; __agent_cycle["self"] = __agent_cycle',
    dataEncoding: "native-json-value",
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
    command: (path) => [[Bun.which("php") ?? "", path]],
    cycleData: "$__agentCycle",
    cyclePrelude: '$__agentCycle = []; $__agentCycle["self"] = &$__agentCycle;',
    dataEncoding: "native-json-value",
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
    command: (path) => [[Bun.which("pwsh") ?? "", "-File", path]],
    cycleData: "$__agentCycle",
    cyclePrelude: "$__agentCycle = @{}; $__agentCycle.self = $__agentCycle",
    dataEncoding: "native-json-value",
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
    command: (path) => [[Bun.which("dotnet") ?? "", "run", "--project", join(path, "..")]],
    cycleData: "__agentCycle",
    cyclePrelude:
      'var __agentCycle = new Dictionary<string, object?>(); __agentCycle["self"] = __agentCycle;',
    dataEncoding: "native-json-value",
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
    command: (path) => [[Bun.which("swift") ?? "", path]],
    cycleData: "__agentCycle",
    cyclePrelude: 'let __agentCycle = NSMutableDictionary(); __agentCycle["self"] = __agentCycle',
    dataEncoding: "native-json-value",
    file: "swift-file.swift",
    ingest: "file",
    language: "swift",
    runtime: process.platform === "darwin" ? Bun.which("swift") : null,
    sharedData: '["left": __agentShared, "right": __agentShared]',
    sharedPrelude: 'let __agentShared: [String: Any] = ["APIKey": "source-shared-secret"]',
  },
  {
    // Serialized-json call sites hand the emitter one complete raw JSON value.
    // The fixture emits the policy matrix verbatim (secrets included) as a raw
    // string literal; the daemon performs redaction, so canonical evidence still
    // equals canonicalPolicyData.
    callData:
      'r#"{"value":42,"designToken":"visible-design-token","fortuneCookie":"visible-fortune-cookie","secretSauceName":"visible-secret-sauce","tokenCount":7,"passwordPolicy":"visible-password-policy","password":"source-password-secret","APIKey":"source-api-acronym-secret","APIToken":"source-api-token-secret","IDToken":"source-id-token-secret","OAuthToken":"source-oauth-token-secret","Client Secret":"source-client-secret","nested":{"apiKey":"source-api-secret","items":[{"refresh-token":"source-refresh-secret"},{"credentials":"source-credentials-secret"}]}}"#',
    command: (path) => {
      const rustc = Bun.which("rustc") ?? "";
      const binary = path.replace(/\.rs$/, process.platform === "win32" ? ".exe" : ".out");
      return [[rustc, "-A", "warnings", path, "-o", binary], [binary]];
    },
    dataEncoding: "serialized-json",
    file: "rust-file.rs",
    ingest: "file",
    language: "rust",
    runtime: Bun.which("rustc"),
  },
  {
    // Serialized-json call sites hand the emitter one complete raw JSON value.
    // The fixture emits the policy matrix verbatim (secrets included) as a raw
    // string literal; the daemon performs redaction, so canonical evidence still
    // equals canonicalPolicyData.
    callData:
      'R"({"value":42,"designToken":"visible-design-token","fortuneCookie":"visible-fortune-cookie","secretSauceName":"visible-secret-sauce","tokenCount":7,"passwordPolicy":"visible-password-policy","password":"source-password-secret","APIKey":"source-api-acronym-secret","APIToken":"source-api-token-secret","IDToken":"source-id-token-secret","OAuthToken":"source-oauth-token-secret","Client Secret":"source-client-secret","nested":{"apiKey":"source-api-secret","items":[{"refresh-token":"source-refresh-secret"},{"credentials":"source-credentials-secret"}]}})"',
    command: (path) => {
      const compiler = Bun.which("clang++") ?? Bun.which("g++") ?? "";
      const binary = path.replace(/\.cpp$/, process.platform === "win32" ? ".exe" : ".out");
      return [[compiler, "-std=c++17", path, "-o", binary], [binary]];
    },
    dataEncoding: "serialized-json",
    file: "cpp-file.cpp",
    ingest: "file",
    language: "cpp",
    runtime: Bun.which("clang++") ?? Bun.which("g++"),
  },
  {
    // Serialized-json call sites hand the emitter one complete raw JSON value. C
    // has no raw-string literals, so the policy matrix (secrets included) is an
    // escaped C string literal — the double JSON.stringify of policyInput yields
    // exactly `"{\"value\":42,...}"`. The daemon performs redaction, so canonical
    // evidence still equals canonicalPolicyData.
    callData: JSON.stringify(JSON.stringify(policyInput)),
    command: (path) => {
      const compiler = Bun.which("clang") ?? Bun.which("gcc") ?? "";
      const binary = path.replace(/\.c$/, process.platform === "win32" ? ".exe" : ".out");
      return [[compiler, "-std=c99", path, "-o", binary], [binary]];
    },
    dataEncoding: "serialized-json",
    file: "c-file.c",
    ingest: "file",
    language: "c",
    runtime: Bun.which("clang") ?? Bun.which("gcc"),
  },
  {
    callData:
      'java.util.Map.ofEntries(java.util.Map.entry("value", 42), java.util.Map.entry("designToken", "visible-design-token"), java.util.Map.entry("fortuneCookie", "visible-fortune-cookie"), java.util.Map.entry("secretSauceName", "visible-secret-sauce"), java.util.Map.entry("tokenCount", 7), java.util.Map.entry("passwordPolicy", "visible-password-policy"), java.util.Map.entry("password", "source-password-secret"), java.util.Map.entry("APIKey", "source-api-acronym-secret"), java.util.Map.entry("APIToken", "source-api-token-secret"), java.util.Map.entry("IDToken", "source-id-token-secret"), java.util.Map.entry("OAuthToken", "source-oauth-token-secret"), java.util.Map.entry("Client Secret", "source-client-secret"), java.util.Map.entry("nested", java.util.Map.ofEntries(java.util.Map.entry("apiKey", "source-api-secret"), java.util.Map.entry("items", java.util.List.of(java.util.Map.of("refresh-token", "source-refresh-secret"), java.util.Map.of("credentials", "source-credentials-secret"))))))',
    command: (path) => [[Bun.which("java") ?? "", path]],
    cycleData: "__agentCycle",
    cyclePrelude:
      'java.util.Map<String, Object> __agentCycle = new java.util.LinkedHashMap<>(); __agentCycle.put("self", __agentCycle);',
    dataEncoding: "native-json-value",
    file: "java-file.java",
    ingest: "file",
    language: "java",
    runtime: Bun.which("java"),
    sharedData: 'java.util.Map.of("left", __agentShared, "right", __agentShared)',
    sharedPrelude:
      'java.util.Map<String, Object> __agentShared = new java.util.LinkedHashMap<>(); __agentShared.put("APIKey", "source-shared-secret");',
  },
  {
    callData:
      'mapOf("value" to 42, "designToken" to "visible-design-token", "fortuneCookie" to "visible-fortune-cookie", "secretSauceName" to "visible-secret-sauce", "tokenCount" to 7, "passwordPolicy" to "visible-password-policy", "password" to "source-password-secret", "APIKey" to "source-api-acronym-secret", "APIToken" to "source-api-token-secret", "IDToken" to "source-id-token-secret", "OAuthToken" to "source-oauth-token-secret", "Client Secret" to "source-client-secret", "nested" to mapOf("apiKey" to "source-api-secret", "items" to listOf(mapOf("refresh-token" to "source-refresh-secret"), mapOf("credentials" to "source-credentials-secret"))))',
    command: (path) => {
      const kotlinc = Bun.which("kotlinc") ?? "";
      const java = Bun.which("java") ?? "";
      const jar = path.replace(/\.kt$/, ".jar");
      // On Windows kotlinc resolves to kotlinc.bat, which cmd.exe must interpret;
      // passing the batch path and its arguments as separate argv elements lets
      // Bun quote each one correctly instead of mangling a compound string.
      const compile =
        process.platform === "win32"
          ? ["cmd", "/c", kotlinc, "-include-runtime", "-d", jar, path]
          : [kotlinc, "-include-runtime", "-d", jar, path];
      return [compile, [java, "-jar", jar]];
    },
    cycleData: "__agentCycle",
    cyclePrelude:
      'val __agentCycle = java.util.LinkedHashMap<String, Any>(); __agentCycle.put("self", __agentCycle)',
    dataEncoding: "native-json-value",
    file: "kotlin-file.kt",
    ingest: "file",
    language: "kotlin",
    runtime:
      Bun.which("kotlinc") !== null && Bun.which("java") !== null ? Bun.which("kotlinc") : null,
    sharedData: 'mapOf("left" to __agentShared, "right" to __agentShared)',
    sharedPrelude:
      'val __agentShared = java.util.LinkedHashMap<String, Any>(); __agentShared.put("APIKey", "source-shared-secret")',
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

// Runs argv steps in order, concatenating their output. Stops at the first step
// that exits non-zero and returns its exit code, so a failed compile surfaces
// the compiler's stderr and the run step never executes.
async function runSteps(steps: string[][], env: Record<string, string | undefined> = process.env) {
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  for (const step of steps) {
    const result = await run(step, env);
    stdout += result.stdout;
    stderr += result.stderr;
    exitCode = result.exitCode;
    if (exitCode !== 0) {
      break;
    }
  }
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
    __DATA_JSON_EXPRESSION__: dataExpression,
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
          const executed = await runSteps(fixture.command(fixturePath));
          const finishedAt = Date.now();
          expect(executed.exitCode, executed.stderr).toBe(0);
          const raw = capture
            ? capture.bodies.join("")
            : await readFile(created.data.appendPath, "utf8");
          const [rawLine] = raw.trim().split("\n");
          const rawEvent = JSON.parse(rawLine ?? "") as { data: unknown };
          if (fixture.dataEncoding === "native-json-value") {
            // The client redacts before transport, so no secret ever reaches the
            // incoming record and its data already equals canonical evidence.
            for (const secret of sourceSecrets) {
              expect(raw).not.toContain(secret);
            }
            expect(raw).toContain("[REDACTED]");
            expect(rawEvent.data).toEqual(canonicalPolicyData);
          } else {
            // Serialized-json callers write raw JSON; the daemon redacts. The
            // pre-normalization incoming record therefore carries the caller text
            // verbatim (spec: Secret-handling contract).
            expect(rawEvent.data).toEqual(policyInput);
          }

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
      180_000,
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

        const executed = await runSteps(fixture.command(fixturePath));
        expect(executed.exitCode, executed.stderr).toBe(0);
        expect(`${executed.stdout}\n${executed.stderr}`).toContain("application-completed");
      },
      180_000,
    );

    // The cycle and shared-reference cases exercise the client-side value model,
    // which only native-json-value templates carry. Serialized-json templates
    // delegate value modeling to the caller, so these cases do not apply.
    if (fixture.dataEncoding === "native-json-value") {
      const { cycleData, cyclePrelude, sharedData, sharedPrelude } = fixture;
      if (
        cycleData === undefined ||
        cyclePrelude === undefined ||
        sharedData === undefined ||
        sharedPrelude === undefined
      ) {
        throw new Error(`${fixture.language} is missing value-model fixture data`);
      }
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
              materialize(source, rendered.data, fixture, target, 1, cycleData, cyclePrelude),
            );
            const executed = await runSteps(fixture.command(fixturePath));
            expect(executed.exitCode, executed.stderr).toBe(0);
            expect(`${executed.stdout}\n${executed.stderr}`).toContain("application-completed");
            await Bun.sleep(200);
            expect(capture?.bodies ?? []).toHaveLength(0);
            const raw =
              fixture.ingest === "file"
                ? await readFile(created.data.appendPath, "utf8").catch(() => "")
                : "";
            expect(raw).toBe("");
            const logs = await runCli(home, [
              "logs",
              "--session",
              created.data.sessionId,
              "--json",
            ]);
            expect(logs.exitCode, logs.stderr).toBe(0);
            expect(JSON.parse(logs.stdout)).toMatchObject({
              statistics: { totalRecords: 0 },
            });
          } finally {
            capture?.stop();
            await runCli(home, ["stop", "--json"]);
          }
        },
        180_000,
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
              materialize(source, rendered.data, fixture, target, 1, sharedData, sharedPrelude),
            );
            const executed = await runSteps(fixture.command(fixturePath));
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
        180_000,
      );
    }
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

        const executed = await runSteps(fixture.command(fixturePath));
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

  // Per-language custom-object coverage: C# and PowerShell exercise value types
  // (structs) so the redactor inspects their members instead of treating them as
  // atomic; Java has no value types, so it exercises the reflection path over a
  // plain object's public fields — the only case that reaches the reflection
  // branch, since the shared policy matrix uses maps and lists throughout.
  const valueTypeCases: Record<
    string,
    { dataExpression: string; prelude: string; extraTypes?: string }
  > = {
    csharp: {
      dataExpression: "__agentValue",
      prelude: [
        "var __agentValue = new AgentCustomValue",
        "{",
        '    APIKey = "source-value-api-secret",',
        '    designToken = "visible-value-design-token",',
        '    Nested = new Dictionary<string, object?> { ["OAuthToken"] = "source-value-oauth-secret" },',
        "};",
      ].join("\n"),
      extraTypes: [
        "internal struct AgentCustomValue",
        "{",
        "    public string APIKey { get; init; }",
        "    public Dictionary<string, object?> Nested;",
        "    public string designToken;",
        "}",
      ].join("\n"),
    },
    java: {
      dataExpression: "__agentValue",
      prelude: [
        "AgentCustomValue __agentValue = new AgentCustomValue();",
        '__agentValue.APIKey = "source-value-api-secret";',
        '__agentValue.designToken = "visible-value-design-token";',
        '__agentValue.Nested = java.util.Map.of("OAuthToken", "source-value-oauth-secret");',
      ].join("\n"),
      extraTypes: [
        "static class AgentCustomValue {",
        "    public String APIKey;",
        "    public Object Nested;",
        "    public String designToken;",
        "}",
      ].join("\n"),
    },
    kotlin: {
      dataExpression: "__agentValue",
      prelude: [
        "val __agentValue = AgentCustomValue()",
        '__agentValue.APIKey = "source-value-api-secret"',
        '__agentValue.designToken = "visible-value-design-token"',
        '__agentValue.Nested = java.util.Map.of("OAuthToken", "source-value-oauth-secret")',
      ].join("\n"),
      extraTypes: [
        "class AgentCustomValue {",
        '    @JvmField var APIKey: String = ""',
        '    @JvmField var Nested: Any = ""',
        '    @JvmField var designToken: String = ""',
        "}",
      ].join("\n"),
    },
    powershell: {
      dataExpression: "$__agentValue",
      prelude: [
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
      ].join("\n"),
    },
  };

  for (const language of ["csharp", "powershell", "java", "kotlin"]) {
    const fixture = fixtures.find((candidate) => candidate.language === language);
    const unavailable = fixture?.runtime === null;
    const runtimeTest = unavailable && !requireRuntimes ? test.skip : test;
    const valueTypeCase = valueTypeCases[language];

    runtimeTest(
      `${language} redacts custom value-type members`,
      async () => {
        if (!fixture) {
          throw new Error(`Missing ${language} fixture`);
        }
        if (!valueTypeCase) {
          throw new Error(`Missing ${language} value-type case`);
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
        if (valueTypeCase.extraTypes) {
          source = source.replace("/* __EXTRA_TYPES__ */", valueTypeCase.extraTypes);
        }
        await writeFile(
          fixturePath,
          materialize(
            source,
            rendered.data,
            fixture,
            created.data.appendPath.replaceAll("\\", "\\\\"),
            1,
            valueTypeCase.dataExpression,
            valueTypeCase.prelude,
          ),
        );

        try {
          const executed = await runSteps(fixture.command(fixturePath));
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
      180_000,
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
      180_000,
    );
  }
});

// Serialized-JSON runtime coverage specific to Rust: the caller supplies raw
// JSON, so these exercise the emitter's raw-value passthrough, the json_string
// fallback, size/validity bounds, concurrency, and realistic insertion.
describe("rust serialized-JSON template", () => {
  const rust = fixtures.find((candidate) => candidate.language === "rust");
  if (!rust) {
    throw new Error("Missing rust fixture");
  }
  const rustFixture = rust;
  const rustRuntimeTest = rustFixture.runtime === null && !requireRuntimes ? test.skip : test;

  // Compiles the rendered helper plus a bespoke main body appending to
  // appendPath, then runs it. Returns the process result.
  async function compileAndRun(
    home: string,
    workspace: string,
    fileName: string,
    body: string,
    appendPath: string,
  ) {
    const rendered = await render(home, rustFixture);
    const helper = rendered.data.helperTemplate.replaceAll(
      "__APPEND_PATH__",
      appendPath.replaceAll("\\", "\\\\"),
    );
    const source = `${helper}\n\nfn main() {\n${body}\n    println!("application-completed");\n}\n`;
    const fixturePath = join(workspace, fileName);
    await writeFile(fixturePath, source);
    return runSteps(rustFixture.command(fixturePath));
  }

  rustRuntimeTest(
    "accepts serialized arrays, strings, numbers, booleans, and null",
    async () => {
      expect(rustFixture.runtime, "rust runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-rust-types-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "types.ndjson");
      const body = [
        '    agent_debug_mode::emit("H", "loc:1", "array", r#"[1,2,3]"#);',
        '    agent_debug_mode::emit("H", "loc:2", "string", &agent_debug_mode::json_string("plain text"));',
        '    agent_debug_mode::emit("H", "loc:3", "number", r#"42"#);',
        '    agent_debug_mode::emit("H", "loc:4", "boolean", r#"true"#);',
        '    agent_debug_mode::emit("H", "loc:5", "null", r#"null"#);',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "rust-types.rs", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      const lines = (await readFile(appendPath, "utf8")).trim().split("\n");
      const data = lines.map((line) => (JSON.parse(line) as { data: unknown }).data);
      expect(data).toEqual([[1, 2, 3], "plain text", 42, true, null]);
    },
    180_000,
  );

  rustRuntimeTest(
    "json_string escapes quotes, backslashes, control characters, and newlines",
    async () => {
      expect(rustFixture.runtime, "rust runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-rust-escape-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "escape.ndjson");
      // Build the tricky text from char codes so the Rust source needs no
      // escaping: a, quote, backslash, newline, tab, U+0001, z.
      const body = [
        "    let mut tricky = String::new();",
        "    tricky.push('a');",
        "    tricky.push(char::from(34u8));",
        "    tricky.push(char::from(92u8));",
        "    tricky.push(char::from(10u8));",
        "    tricky.push(char::from(9u8));",
        "    tricky.push(char::from(1u8));",
        "    tricky.push('z');",
        '    agent_debug_mode::emit("H", "loc", "escape", &agent_debug_mode::json_string(&tricky));',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "rust-escape.rs", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      const [line] = (await readFile(appendPath, "utf8")).trim().split("\n");
      const event = JSON.parse(line ?? "") as { data: unknown };
      expect(event.data).toBe(`a"\\\n\tz`);
    },
    180_000,
  );

  rustRuntimeTest(
    "records malformed raw JSON as rejected without affecting the application",
    async () => {
      expect(rustFixture.runtime, "rust runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-rust-malformed-"));
      temporaryDirectories.push(home, workspace);
      const created = await createSession(home);
      try {
        const body = '    agent_debug_mode::emit("H", "loc:7", "broken", r#"{"broken":"#);';
        const result = await compileAndRun(
          home,
          workspace,
          "rust-malformed.rs",
          body,
          created.data.appendPath,
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain("application-completed");
        // The daemon needs a moment to observe the incoming line and classify it.
        let diagnostics: unknown[] = [];
        for (let attempt = 0; attempt < 80 && diagnostics.length === 0; attempt += 1) {
          const status = await runCli(home, [
            "status",
            "--session",
            created.data.sessionId,
            "--json",
          ]);
          if (status.exitCode === 0) {
            const parsed = JSON.parse(status.stdout) as { data: { diagnostics?: unknown[] } };
            diagnostics = parsed.data.diagnostics ?? [];
          }
          if (diagnostics.length === 0) {
            await Bun.sleep(50);
          }
        }
        expect(diagnostics.length).toBeGreaterThan(0);
        const logs = await runCli(home, ["logs", "--session", created.data.sessionId, "--json"]);
        expect(logs.exitCode, logs.stderr).toBe(0);
        // The malformed record is counted but not accepted: no valid record is
        // ingested, and the daemon flags exactly one malformed record.
        expect(JSON.parse(logs.stdout)).toMatchObject({
          statistics: { malformedRecords: 1, validRecords: 0 },
        });
      } finally {
        await runCli(home, ["stop", "--json"]);
      }
    },
    180_000,
  );

  rustRuntimeTest(
    "drops an oversize event without affecting the application",
    async () => {
      expect(rustFixture.runtime, "rust runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-rust-oversize-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "oversize.ndjson");
      const body = [
        '    let big = format!("[{}0]", "0,".repeat(40000));',
        '    agent_debug_mode::emit("H", "loc", "oversize", &big);',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "rust-oversize.rs", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("application-completed");
      const raw = await readFile(appendPath, "utf8").catch(() => "");
      expect(raw).toBe("");
    },
    180_000,
  );

  rustRuntimeTest(
    "concurrent emitters append complete, independently parseable records",
    async () => {
      expect(rustFixture.runtime, "rust runtime must be installed").not.toBeNull();
      const rustc = Bun.which("rustc");
      expect(rustc, "rustc must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-rust-concurrent-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "concurrent.ndjson");
      const rendered = await render(home, rustFixture);
      const helper = rendered.data.helperTemplate.replaceAll(
        "__APPEND_PATH__",
        appendPath.replaceAll("\\", "\\\\"),
      );
      const source = `${helper}\n\nfn main() {\n    agent_debug_mode::emit("H", "loc", "concurrent", r#"{"n":1}"#);\n}\n`;
      const fixturePath = join(workspace, "rust-concurrent.rs");
      const binary = join(
        workspace,
        process.platform === "win32" ? "rust-concurrent.exe" : "rust-concurrent.out",
      );
      await writeFile(fixturePath, source);
      const compiled = await run([rustc ?? "", "-A", "warnings", fixturePath, "-o", binary]);
      expect(compiled.exitCode, compiled.stderr).toBe(0);
      const executions = await Promise.all(Array.from({ length: 32 }, () => run([binary])));
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
    180_000,
  );

  rustRuntimeTest(
    "keeps metadata containing quotes and control characters valid",
    async () => {
      expect(rustFixture.runtime, "rust runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-rust-metadata-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "metadata.ndjson");
      const body = [
        "    let mut hid = String::new();",
        "    hid.push('H');",
        "    hid.push(char::from(34u8));",
        "    hid.push(char::from(10u8));",
        "    let mut msg = String::new();",
        "    msg.push(char::from(9u8));",
        '    msg.push_str("msg");',
        "    msg.push(char::from(92u8));",
        '    agent_debug_mode::emit(&hid, "loc", &msg, r#"{"ok":true}"#);',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "rust-metadata.rs", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      const [line] = (await readFile(appendPath, "utf8")).trim().split("\n");
      const event = JSON.parse(line ?? "") as {
        hypothesisId: string;
        message: string;
        data: unknown;
      };
      expect(event.hypothesisId).toBe(`H"\n`);
      expect(event.message).toBe(`\tmsg\\`);
      expect(event.data).toEqual({ ok: true });
    },
    180_000,
  );

  rustRuntimeTest(
    "compiles when the helper is inserted into a realistic Rust file",
    async () => {
      expect(rustFixture.runtime, "rust runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-rust-realistic-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "realistic.ndjson");
      const rendered = await render(home, rustFixture);
      const source = await readFile(
        join(root, "tests", "fixtures", "languages", "rust-realistic.rs"),
        "utf8",
      );
      const materialized = materialize(
        source,
        rendered.data,
        rustFixture,
        appendPath.replaceAll("\\", "\\\\"),
        1,
        "&agent_debug_mode::json_string(&value.label)",
      );
      const fixturePath = join(workspace, "rust-realistic.rs");
      await writeFile(fixturePath, materialized);
      const result = await runSteps(rustFixture.command(fixturePath));
      expect(result.exitCode, result.stderr).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("application-completed");
      const [line] = (await readFile(appendPath, "utf8")).trim().split("\n");
      expect((JSON.parse(line ?? "") as { data: unknown }).data).toBe("inner-module");
    },
    180_000,
  );
});

// Serialized-JSON runtime coverage specific to C++: the caller supplies raw
// JSON, so these exercise the emitter's raw-value passthrough, the json_string
// fallback, size/validity bounds, concurrency, and realistic insertion.
describe("cpp serialized-JSON template", () => {
  const cpp = fixtures.find((candidate) => candidate.language === "cpp");
  if (!cpp) {
    throw new Error("Missing cpp fixture");
  }
  const cppFixture = cpp;
  const cppRuntimeTest = cppFixture.runtime === null && !requireRuntimes ? test.skip : test;

  // Compiles the rendered helper plus a bespoke main body appending to
  // appendPath, then runs it. Returns the process result.
  async function compileAndRun(
    home: string,
    workspace: string,
    fileName: string,
    body: string,
    appendPath: string,
  ) {
    const rendered = await render(home, cppFixture);
    const helper = rendered.data.helperTemplate.replaceAll(
      "__APPEND_PATH__",
      appendPath.replaceAll("\\", "\\\\"),
    );
    const source = `${helper}\n\n#include <iostream>\n#include <string>\n\nint main() {\n${body}\n    std::cout << "application-completed" << std::endl;\n    return 0;\n}\n`;
    const fixturePath = join(workspace, fileName);
    await writeFile(fixturePath, source);
    return runSteps(cppFixture.command(fixturePath));
  }

  cppRuntimeTest(
    "accepts serialized arrays, strings, numbers, booleans, and null",
    async () => {
      expect(cppFixture.runtime, "cpp runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-cpp-types-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "types.ndjson");
      const body = [
        '    agent_debug_mode::emit("H", "loc:1", "array", R"([1,2,3])");',
        '    agent_debug_mode::emit("H", "loc:2", "string", agent_debug_mode::json_string("plain text"));',
        '    agent_debug_mode::emit("H", "loc:3", "number", R"(42)");',
        '    agent_debug_mode::emit("H", "loc:4", "boolean", R"(true)");',
        '    agent_debug_mode::emit("H", "loc:5", "null", R"(null)");',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "cpp-types.cpp", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      const lines = (await readFile(appendPath, "utf8")).trim().split("\n");
      const data = lines.map((line) => (JSON.parse(line) as { data: unknown }).data);
      expect(data).toEqual([[1, 2, 3], "plain text", 42, true, null]);
    },
    180_000,
  );

  cppRuntimeTest(
    "json_string escapes quotes, backslashes, control characters, and newlines",
    async () => {
      expect(cppFixture.runtime, "cpp runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-cpp-escape-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "escape.ndjson");
      // Build the tricky text from char codes so the C++ source needs no
      // escaping: a, quote, backslash, newline, tab, U+0001, z.
      const body = [
        "    std::string tricky;",
        "    tricky.push_back('a');",
        "    tricky.push_back(static_cast<char>(34));",
        "    tricky.push_back(static_cast<char>(92));",
        "    tricky.push_back(static_cast<char>(10));",
        "    tricky.push_back(static_cast<char>(9));",
        "    tricky.push_back(static_cast<char>(1));",
        "    tricky.push_back('z');",
        '    agent_debug_mode::emit("H", "loc", "escape", agent_debug_mode::json_string(tricky));',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "cpp-escape.cpp", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      const [line] = (await readFile(appendPath, "utf8")).trim().split("\n");
      const event = JSON.parse(line ?? "") as { data: unknown };
      const expected = `a"\\\n\t${String.fromCharCode(1)}z`;
      expect(event.data).toBe(expected);
    },
    180_000,
  );

  cppRuntimeTest(
    "records malformed raw JSON as rejected without affecting the application",
    async () => {
      expect(cppFixture.runtime, "cpp runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-cpp-malformed-"));
      temporaryDirectories.push(home, workspace);
      const created = await createSession(home);
      try {
        const body = '    agent_debug_mode::emit("H", "loc:7", "broken", R"({"broken":)");';
        const result = await compileAndRun(
          home,
          workspace,
          "cpp-malformed.cpp",
          body,
          created.data.appendPath,
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain("application-completed");
        // The daemon needs a moment to observe the incoming line and classify it.
        let diagnostics: unknown[] = [];
        for (let attempt = 0; attempt < 80 && diagnostics.length === 0; attempt += 1) {
          const status = await runCli(home, [
            "status",
            "--session",
            created.data.sessionId,
            "--json",
          ]);
          if (status.exitCode === 0) {
            const parsed = JSON.parse(status.stdout) as { data: { diagnostics?: unknown[] } };
            diagnostics = parsed.data.diagnostics ?? [];
          }
          if (diagnostics.length === 0) {
            await Bun.sleep(50);
          }
        }
        expect(diagnostics.length).toBeGreaterThan(0);
        const logs = await runCli(home, ["logs", "--session", created.data.sessionId, "--json"]);
        expect(logs.exitCode, logs.stderr).toBe(0);
        // The malformed record is counted but not accepted: no valid record is
        // ingested, and the daemon flags exactly one malformed record.
        expect(JSON.parse(logs.stdout)).toMatchObject({
          statistics: { malformedRecords: 1, validRecords: 0 },
        });
      } finally {
        await runCli(home, ["stop", "--json"]);
      }
    },
    180_000,
  );

  cppRuntimeTest(
    "drops an oversize event without affecting the application",
    async () => {
      expect(cppFixture.runtime, "cpp runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-cpp-oversize-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "oversize.ndjson");
      const body = [
        '    std::string big = "[";',
        "    for (int i = 0; i < 40000; i += 1) {",
        '        big += "0,";',
        "    }",
        '    big += "0]";',
        '    agent_debug_mode::emit("H", "loc", "oversize", big);',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "cpp-oversize.cpp", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("application-completed");
      const raw = await readFile(appendPath, "utf8").catch(() => "");
      expect(raw).toBe("");
    },
    180_000,
  );

  cppRuntimeTest(
    "concurrent emitters append complete, independently parseable records",
    async () => {
      expect(cppFixture.runtime, "cpp runtime must be installed").not.toBeNull();
      const compiler = Bun.which("clang++") ?? Bun.which("g++");
      expect(compiler, "a C++ compiler must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-cpp-concurrent-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "concurrent.ndjson");
      const rendered = await render(home, cppFixture);
      const helper = rendered.data.helperTemplate.replaceAll(
        "__APPEND_PATH__",
        appendPath.replaceAll("\\", "\\\\"),
      );
      const source = `${helper}\n\nint main() {\n    agent_debug_mode::emit("H", "loc", "concurrent", R"({"n":1})");\n    return 0;\n}\n`;
      const fixturePath = join(workspace, "cpp-concurrent.cpp");
      const binary = join(
        workspace,
        process.platform === "win32" ? "cpp-concurrent.exe" : "cpp-concurrent.out",
      );
      await writeFile(fixturePath, source);
      const compiled = await run([compiler ?? "", "-std=c++17", fixturePath, "-o", binary]);
      expect(compiled.exitCode, compiled.stderr).toBe(0);
      const executions = await Promise.all(Array.from({ length: 32 }, () => run([binary])));
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
    180_000,
  );

  cppRuntimeTest(
    "keeps metadata containing quotes and control characters valid",
    async () => {
      expect(cppFixture.runtime, "cpp runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-cpp-metadata-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "metadata.ndjson");
      const body = [
        "    std::string hid;",
        "    hid.push_back('H');",
        "    hid.push_back(static_cast<char>(34));",
        "    hid.push_back(static_cast<char>(10));",
        "    std::string msg;",
        "    msg.push_back(static_cast<char>(9));",
        '    msg += "msg";',
        "    msg.push_back(static_cast<char>(92));",
        '    agent_debug_mode::emit(hid, "loc", msg, R"({"ok":true})");',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "cpp-metadata.cpp", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      const [line] = (await readFile(appendPath, "utf8")).trim().split("\n");
      const event = JSON.parse(line ?? "") as {
        hypothesisId: string;
        message: string;
        data: unknown;
      };
      expect(event.hypothesisId).toBe(`H"\n`);
      expect(event.message).toBe(`\tmsg\\`);
      expect(event.data).toEqual({ ok: true });
    },
    180_000,
  );

  cppRuntimeTest(
    "compiles when the helper is inserted into a realistic C++ file",
    async () => {
      expect(cppFixture.runtime, "cpp runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-cpp-realistic-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "realistic.ndjson");
      const rendered = await render(home, cppFixture);
      const source = await readFile(
        join(root, "tests", "fixtures", "languages", "cpp-realistic.cpp"),
        "utf8",
      );
      const materialized = materialize(
        source,
        rendered.data,
        cppFixture,
        appendPath.replaceAll("\\", "\\\\"),
        1,
        "agent_debug_mode::json_string(value.label)",
      );
      const fixturePath = join(workspace, "cpp-realistic.cpp");
      await writeFile(fixturePath, materialized);
      const result = await runSteps(cppFixture.command(fixturePath));
      expect(result.exitCode, result.stderr).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("application-completed");
      const [line] = (await readFile(appendPath, "utf8")).trim().split("\n");
      expect((JSON.parse(line ?? "") as { data: unknown }).data).toBe("inner-module");
    },
    180_000,
  );
});

// Serialized-JSON runtime coverage specific to C: the caller supplies raw JSON,
// so these exercise the emitter's raw-value passthrough, the json_string
// fallback, size/validity bounds, concurrency, and realistic insertion.
describe("c serialized-JSON template", () => {
  const c = fixtures.find((candidate) => candidate.language === "c");
  if (!c) {
    throw new Error("Missing c fixture");
  }
  const cFixture = c;
  const cRuntimeTest = cFixture.runtime === null && !requireRuntimes ? test.skip : test;

  // Compiles the rendered helper plus a bespoke main body appending to
  // appendPath, then runs it. Returns the process result.
  async function compileAndRun(
    home: string,
    workspace: string,
    fileName: string,
    body: string,
    appendPath: string,
  ) {
    const rendered = await render(home, cFixture);
    const helper = rendered.data.helperTemplate.replaceAll(
      "__APPEND_PATH__",
      appendPath.replaceAll("\\", "\\\\"),
    );
    const source = `${helper}\n\nint main(void) {\n${body}\n    printf("application-completed\\n");\n    return 0;\n}\n`;
    const fixturePath = join(workspace, fileName);
    await writeFile(fixturePath, source);
    return runSteps(cFixture.command(fixturePath));
  }

  cRuntimeTest(
    "accepts serialized arrays, strings, numbers, booleans, and null",
    async () => {
      expect(cFixture.runtime, "c runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-c-types-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "types.ndjson");
      const body = [
        '    agent_debug_emit("H", "loc:1", "array", "[1,2,3]");',
        '    agent_debug_emit("H", "loc:2", "string", agent_debug_json_string("plain text"));',
        '    agent_debug_emit("H", "loc:3", "number", "42");',
        '    agent_debug_emit("H", "loc:4", "boolean", "true");',
        '    agent_debug_emit("H", "loc:5", "null", "null");',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "c-types.c", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      const lines = (await readFile(appendPath, "utf8")).trim().split("\n");
      const data = lines.map((line) => (JSON.parse(line) as { data: unknown }).data);
      expect(data).toEqual([[1, 2, 3], "plain text", 42, true, null]);
    },
    180_000,
  );

  cRuntimeTest(
    "json_string escapes quotes, backslashes, control characters, and newlines",
    async () => {
      expect(cFixture.runtime, "c runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-c-escape-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "escape.ndjson");
      // Build the tricky text from char codes so the C source needs no escaping:
      // a, quote, backslash, newline, tab, U+0001, z.
      const body = [
        "    char tricky[8];",
        "    tricky[0] = 'a';",
        "    tricky[1] = (char)34;",
        "    tricky[2] = (char)92;",
        "    tricky[3] = (char)10;",
        "    tricky[4] = (char)9;",
        "    tricky[5] = (char)1;",
        "    tricky[6] = 'z';",
        "    tricky[7] = 0;",
        '    agent_debug_emit("H", "loc", "escape", agent_debug_json_string(tricky));',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "c-escape.c", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      const [line] = (await readFile(appendPath, "utf8")).trim().split("\n");
      const event = JSON.parse(line ?? "") as { data: unknown };
      const expected = `a"\\\n\t${String.fromCharCode(1)}z`;
      expect(event.data).toBe(expected);
    },
    180_000,
  );

  cRuntimeTest(
    "records malformed raw JSON as rejected without affecting the application",
    async () => {
      expect(cFixture.runtime, "c runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-c-malformed-"));
      temporaryDirectories.push(home, workspace);
      const created = await createSession(home);
      try {
        const body = '    agent_debug_emit("H", "loc:7", "broken", "{\\"broken\\":");';
        const result = await compileAndRun(
          home,
          workspace,
          "c-malformed.c",
          body,
          created.data.appendPath,
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain("application-completed");
        // The daemon needs a moment to observe the incoming line and classify it.
        let diagnostics: unknown[] = [];
        for (let attempt = 0; attempt < 80 && diagnostics.length === 0; attempt += 1) {
          const status = await runCli(home, [
            "status",
            "--session",
            created.data.sessionId,
            "--json",
          ]);
          if (status.exitCode === 0) {
            const parsed = JSON.parse(status.stdout) as { data: { diagnostics?: unknown[] } };
            diagnostics = parsed.data.diagnostics ?? [];
          }
          if (diagnostics.length === 0) {
            await Bun.sleep(50);
          }
        }
        expect(diagnostics.length).toBeGreaterThan(0);
        const logs = await runCli(home, ["logs", "--session", created.data.sessionId, "--json"]);
        expect(logs.exitCode, logs.stderr).toBe(0);
        // The malformed record is counted but not accepted: no valid record is
        // ingested, and the daemon flags exactly one malformed record.
        expect(JSON.parse(logs.stdout)).toMatchObject({
          statistics: { malformedRecords: 1, validRecords: 0 },
        });
      } finally {
        await runCli(home, ["stop", "--json"]);
      }
    },
    180_000,
  );

  cRuntimeTest(
    "drops an oversize event without affecting the application",
    async () => {
      expect(cFixture.runtime, "c runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-c-oversize-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "oversize.ndjson");
      const body = [
        "    static char big[90002];",
        "    size_t bi = 0;",
        "    big[bi] = '[';",
        "    bi += 1;",
        "    for (int i = 0; i < 40000; i += 1) {",
        "        big[bi] = '0';",
        "        bi += 1;",
        "        big[bi] = ',';",
        "        bi += 1;",
        "    }",
        "    big[bi] = '0';",
        "    bi += 1;",
        "    big[bi] = ']';",
        "    bi += 1;",
        "    big[bi] = 0;",
        '    agent_debug_emit("H", "loc", "oversize", big);',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "c-oversize.c", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("application-completed");
      const raw = await readFile(appendPath, "utf8").catch(() => "");
      expect(raw).toBe("");
    },
    180_000,
  );

  cRuntimeTest(
    "concurrent emitters append complete, independently parseable records",
    async () => {
      expect(cFixture.runtime, "c runtime must be installed").not.toBeNull();
      const compiler = Bun.which("clang") ?? Bun.which("gcc");
      expect(compiler, "a C compiler must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-c-concurrent-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "concurrent.ndjson");
      const rendered = await render(home, cFixture);
      const helper = rendered.data.helperTemplate.replaceAll(
        "__APPEND_PATH__",
        appendPath.replaceAll("\\", "\\\\"),
      );
      const source = `${helper}\n\nint main(void) {\n    agent_debug_emit("H", "loc", "concurrent", "{\\"n\\":1}");\n    return 0;\n}\n`;
      const fixturePath = join(workspace, "c-concurrent.c");
      const binary = join(
        workspace,
        process.platform === "win32" ? "c-concurrent.exe" : "c-concurrent.out",
      );
      await writeFile(fixturePath, source);
      const compiled = await run([compiler ?? "", "-std=c99", fixturePath, "-o", binary]);
      expect(compiled.exitCode, compiled.stderr).toBe(0);
      const executions = await Promise.all(Array.from({ length: 32 }, () => run([binary])));
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
    180_000,
  );

  cRuntimeTest(
    "keeps metadata containing quotes and control characters valid",
    async () => {
      expect(cFixture.runtime, "c runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-c-metadata-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "metadata.ndjson");
      const body = [
        "    char hid[4];",
        "    hid[0] = 'H';",
        "    hid[1] = (char)34;",
        "    hid[2] = (char)10;",
        "    hid[3] = 0;",
        "    char msg[6];",
        "    msg[0] = (char)9;",
        "    msg[1] = 'm';",
        "    msg[2] = 's';",
        "    msg[3] = 'g';",
        "    msg[4] = (char)92;",
        "    msg[5] = 0;",
        '    agent_debug_emit(hid, "loc", msg, "{\\"ok\\":true}");',
      ].join("\n");
      const result = await compileAndRun(home, workspace, "c-metadata.c", body, appendPath);
      expect(result.exitCode, result.stderr).toBe(0);
      const [line] = (await readFile(appendPath, "utf8")).trim().split("\n");
      const event = JSON.parse(line ?? "") as {
        hypothesisId: string;
        message: string;
        data: unknown;
      };
      expect(event.hypothesisId).toBe(`H"\n`);
      expect(event.message).toBe(`\tmsg\\`);
      expect(event.data).toEqual({ ok: true });
    },
    180_000,
  );

  cRuntimeTest(
    "compiles when the helper is inserted into a realistic C file",
    async () => {
      expect(cFixture.runtime, "c runtime must be installed").not.toBeNull();
      const home = await mkdtemp(join(tmpdir(), "debug-mode-home-"));
      const workspace = await mkdtemp(join(tmpdir(), "debug-mode-c-realistic-"));
      temporaryDirectories.push(home, workspace);
      const appendPath = join(workspace, "realistic.ndjson");
      const rendered = await render(home, cFixture);
      const source = await readFile(
        join(root, "tests", "fixtures", "languages", "c-realistic.c"),
        "utf8",
      );
      const materialized = materialize(
        source,
        rendered.data,
        cFixture,
        appendPath.replaceAll("\\", "\\\\"),
        1,
        "agent_debug_json_string(value.label)",
      );
      const fixturePath = join(workspace, "c-realistic.c");
      await writeFile(fixturePath, materialized);
      const result = await runSteps(cFixture.command(fixturePath));
      expect(result.exitCode, result.stderr).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("application-completed");
      const [line] = (await readFile(appendPath, "utf8")).trim().split("\n");
      expect((JSON.parse(line ?? "") as { data: unknown }).data).toBe("inner-module");
    },
    180_000,
  );
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
