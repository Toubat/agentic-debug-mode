# Agentic Debug Mode Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current workspace/run-oriented CLI with the session-only interface defined in `DESIGN.md`, backed by Commander.js, transparent service lifecycle management, bounded evidence access, and tested language templates.

**Architecture:** A random UUID identifies one reusable debugging session. `create` allocates its isolated state, `reset` clears one evidence cycle, and every scoped command requires the session ID. A hidden loopback service auto-starts for data commands and stops explicitly or after 30 idle minutes; templates remain session-independent and bind only to the ingest URL or append path returned by `create`/`reset`.

**Tech Stack:** Bun 1.3.14, TypeScript, Commander.js, Rust with napi-rs and jaq, Biome, Bun test.

## Global Constraints

- Follow TDD: add one failing behavioral test, observe the expected failure, implement the minimum behavior, and rerun the focused test.
- Keep imports at module scope.
- TypeScript switches over unions and enums require an exhaustive `never` default.
- Use pretty output for the Agent Skill; retain `--json` only for external integrations.
- Do not expose daemon, port, PID, lock, token, capability, or internal JSON-field terminology in the Agent Skill.
- Do not add workspace, run, declared-hypothesis, `--follow`, `--jsonl`, or UI behavior.
- Every session-scoped command requires an explicit session ID.
- Every advertised language/ingest pair requires a real-runtime live E2E test.
- End each task with Biome, typecheck, focused tests, a commit, and a push attempt.
- Do not include Cursor as a commit co-author.

---

### Task 1: Replace workspace/run domain contracts with session/reset contracts

**Files:**
- Modify: `src/domain/session.ts`
- Modify: `src/domain/event.ts`
- Modify: `src/domain/diagnostic.ts`
- Delete: `src/domain/run.ts`
- Delete: `src/daemon/run-registry.ts`
- Delete: `tests/contract/run.test.ts`
- Delete: `tests/unit/persistence/run-registry.test.ts`
- Create: `tests/contract/session-model.test.ts`

**Interfaces:**
- Produces:

```typescript
export interface Session {
  readonly id: string;
  readonly createdAt: number;
  readonly eventSchemaVersion: 1;
  readonly evidenceEpoch: string;
}

export interface ProbeEvent {
  hypothesisId: string;
  timestamp: number;
  location: string;
  message: string;
  data: JsonValue;
}

export interface NormalizedEvent extends ProbeEvent {
  id: string;
  sequence: number;
  receivedAt: number;
}
```

- Removes: `workspace`, `activeRunId`, `ingestCapability`, session status, `sessionId`, `runId`, and per-event `schemaVersion`.

- [ ] **Step 1: Write the failing domain contract**

```typescript
import { describe, expect, test } from "bun:test";
import type { NormalizedEvent, ProbeEvent } from "../../src/domain/event";
import type { Session } from "../../src/domain/session";

describe("session-only domain", () => {
  test("contains no workspace, run, status, or duplicated session event fields", () => {
    const session: Session = {
      createdAt: 1_784_310_000_000,
      eventSchemaVersion: 1,
      evidenceEpoch: "epoch-1",
      id: "session-1",
    };
    const probe: ProbeEvent = {
      data: { value: 42 },
      hypothesisId: "H1",
      location: "src/example.ts:1",
      message: "Observed value",
      timestamp: 1_784_310_000_001,
    };
    const stored: NormalizedEvent = {
      ...probe,
      id: "evt_1",
      receivedAt: 1_784_310_000_002,
      sequence: 1,
    };

    expect(session).not.toHaveProperty("workspace");
    expect(session).not.toHaveProperty("activeRunId");
    expect(probe).not.toHaveProperty("sessionId");
    expect(probe).not.toHaveProperty("runId");
    expect(stored.sequence).toBe(1);
  });
});
```

- [ ] **Step 2: Run the focused test**

Run: `bun test tests/contract/session-model.test.ts`

Expected: FAIL because the current interfaces require workspace/run fields.

- [ ] **Step 3: Replace the domain interfaces and remove run files**

Use the exact interfaces in this task. Keep `JsonValue` recursive and bounded by validation rather
than narrowing the TypeScript type.

- [ ] **Step 4: Run domain and type checks**

Run: `bun test tests/contract/session-model.test.ts && bun run typecheck`

Expected: the new contract passes; typecheck identifies every remaining run/workspace consumer for
subsequent tasks.

- [ ] **Step 5: Commit and push**

```bash
git add src/domain tests/contract/session-model.test.ts
git add -u src/daemon/run-registry.ts tests/contract/run.test.ts tests/unit/persistence/run-registry.test.ts
git commit -m "refactor: define session-only evidence model"
git push -u origin HEAD
```

### Task 2: Implement session creation, reset, listing, and deletion persistence

**Files:**
- Modify: `src/daemon/session-registry.ts`
- Modify: `src/daemon/event-store.ts`
- Modify: `src/daemon/diagnostic-store.ts`
- Modify: `src/daemon/sequence.ts`
- Modify: `src/daemon/persistence.ts`
- Delete: `src/platform/workspace.ts`
- Delete: `src/commands/workspace.ts`
- Delete: `tests/unit/persistence/workspace.test.ts`
- Rewrite: `tests/unit/persistence/session-isolation.test.ts`
- Create: `tests/unit/persistence/session-reset.test.ts`
- Modify: `tests/unit/persistence/event-store.test.ts`

**Interfaces:**
- Consumes: `Session`, `ProbeEvent`, and `NormalizedEvent` from Task 1.
- Produces:

```typescript
export interface SessionSummary {
  id: string;
  createdAt: number;
  eventCount: number;
}

export class SessionRegistry {
  create(createdAt?: number): Promise<Session>;
  get(sessionId: string): Promise<Session | undefined>;
  list(options: { all: boolean; now?: Date; limit?: number }): Promise<SessionSummary[]>;
  reset(sessionId: string): Promise<Session>;
  remove(sessionId: string): Promise<boolean>;
  incomingPath(sessionId: string): string;
}
```

- `reset` atomically clears `events.ndjson`, `diagnostics.ndjson`, `incoming.ndjson`, and cursor
  metadata; assigns a new random `evidenceEpoch`; and resets sequence initialization.

- [ ] **Step 1: Write failing reset and today-list tests**

```typescript
test("reset preserves session identity and replaces the evidence epoch", async () => {
  const session = await registry.create(1_784_310_000_000);
  await events.append(eventFor(session.id, 1));

  const reset = await registry.reset(session.id);

  expect(reset.id).toBe(session.id);
  expect(reset.evidenceEpoch).not.toBe(session.evidenceEpoch);
  expect(await events.read(session.id)).toEqual([]);
  expect(await sequence.next(session.id)).toBe(1);
});

test("default listing returns at most twenty sessions created today", async () => {
  const today = new Date(2026, 6, 17, 12);
  await registry.create(new Date(2026, 6, 16, 23).valueOf());
  for (let index = 0; index < 25; index += 1) {
    await registry.create(new Date(2026, 6, 17, 1, index).valueOf());
  }

  const listed = await registry.list({ all: false, now: today });

  expect(listed).toHaveLength(20);
  expect(listed.every((item) => new Date(item.createdAt).getDate() === 17)).toBe(true);
  expect(listed[0]?.createdAt).toBeGreaterThan(listed[19]?.createdAt ?? 0);
});

test("reset and removal refuse session files redirected through symbolic links", async () => {
  const session = await registry.create();
  await replaceWithExternalSymlink(persistence.sessionFile(session.id, "events.ndjson"));

  await expect(registry.reset(session.id)).rejects.toThrow("symbolic link");
  await expect(registry.remove(session.id)).rejects.toThrow("symbolic link");
});
```

- [ ] **Step 2: Run focused persistence tests**

Run: `bun test tests/unit/persistence/session-reset.test.ts tests/unit/persistence/session-isolation.test.ts`

Expected: FAIL because reset/today listing do not exist and session creation still requires a
workspace/run.

- [ ] **Step 3: Implement atomic reset**

Serialize reset with event/diagnostic writes for that session. Use `writeTextAtomic` for each
cleared NDJSON file, `writeJsonAtomic` for the new session metadata and cursor `{ offset: 0 }`, and
add `EventSequence.reset(sessionId)` to discard its cached counter. Before reset or recursive
removal, validate the session directory and every owned state file with `lstat`; reject any symbolic
link rather than following it.

- [ ] **Step 4: Implement local-calendar-day listing**

Compute local midnight with:

```typescript
const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).valueOf();
```

Filter on `createdAt`, sort descending, and apply `limit ?? 20` unless `all` is true.

- [ ] **Step 5: Run focused tests, Biome, and typecheck**

Run: `bun test tests/unit/persistence && bun run check && bun run typecheck`

Expected: persistence tests pass; typecheck failures are limited to commands/APIs removed in later
tasks.

- [ ] **Step 6: Commit and push**

```bash
git add src/daemon src/platform tests/unit/persistence
git commit -m "feat: add reusable session reset lifecycle"
git push
```

### Task 3: Replace the custom parser with Commander.js and the new command surface

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `src/cli/program.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/dispatch.ts`
- Delete: `src/cli/parse-args.ts`
- Delete: `src/commands/options.ts`
- Delete: `tests/contract/parse-args.test.ts`
- Rewrite: `tests/contract/dispatch.test.ts`
- Create: `tests/contract/help.test.ts`

**Interfaces:**
- Produces:

```typescript
export interface CliInvocation {
  json: boolean;
  command:
    | { kind: "create" }
    | { kind: "template"; language: string; ingest: "http" | "file" }
    | { kind: "reset"; sessionId: string }
    | { kind: "logs"; sessionId: string; hypotheses: string[]; offset: number; limit: number; snapshot?: string }
    | { kind: "query"; sessionId: string; program?: string; cursor?: string; slurp: boolean; limit: number; timeoutMs: number }
    | { kind: "status"; sessionId: string }
    | { kind: "sessions"; all: boolean }
    | { kind: "clean"; sessionId: string }
    | { kind: "stop" };
}

export function parseCli(argv: string[]): Promise<CliInvocation | { helpText: string }>;
```

- [ ] **Step 1: Add Commander through the package manager**

Run: `bun add commander`

Expected: `package.json` and `bun.lock` record the latest compatible Commander release.

- [ ] **Step 2: Write failing help and strict-option tests**

```typescript
test("--help lists only the redesigned public commands", async () => {
  const result = await parseCli(["--help"]);
  expect("helpText" in result ? result.helpText : "").toContain("create");
  expect("helpText" in result ? result.helpText : "").toContain("template");
  expect("helpText" in result ? result.helpText : "").not.toContain("run begin");
  expect("helpText" in result ? result.helpText : "").not.toContain("daemon stop");
});

test("rejects removed and unknown options", async () => {
  await expect(parseCli(["logs", "--session", "s1", "--follow"])).rejects.toMatchObject({
    exitCode: 2,
  });
  await expect(parseCli(["create", "--workspace", "."])).rejects.toMatchObject({
    exitCode: 2,
  });
});
```

- [ ] **Step 3: Run the contract tests**

Run: `bun test tests/contract/help.test.ts tests/contract/dispatch.test.ts`

Expected: FAIL because `parseCli` and real help are absent.

- [ ] **Step 4: Build the Commander program**

Use top-level `import { Command, InvalidArgumentError, Option } from "commander"`. Configure:

```typescript
program
  .name("debug-mode")
  .description("Collect and query structured runtime evidence")
  .version(packageJson.version)
  .showHelpAfterError()
  .exitOverride();
```

Define exactly: `create`, `template`, `reset`, `logs`, `query`, `status`, `sessions`, `clean`,
and `stop`. Use a collector parser for repeated `--hypothesis` filters on `logs` only:

```typescript
const collect = (value: string, previous: string[]): string[] => [...previous, value];
```

Capture Commander output with `configureOutput` so help remains pretty and parse failures map to
semantic exit `2` without Commander terminating the process.

- [ ] **Step 5: Delete the custom parser and removed dispatch paths**

Remove `start`, `probe`, `run begin`, `clear`, and `daemon stop` dispatch. Keep internal
`__daemon` and native smoke paths outside Commander.

- [ ] **Step 6: Run contracts and standalone CLI help**

Run:

```bash
bun test tests/contract/help.test.ts tests/contract/dispatch.test.ts
bun src/cli.ts --help
bun src/cli.ts template --help
```

Expected: tests pass; both help commands exit `0`; unknown flags exit `2`.

- [ ] **Step 7: Commit and push**

```bash
git add package.json bun.lock src/cli.ts src/cli src/commands tests/contract
git commit -m "feat: replace CLI parser with Commander"
git push
```

### Task 4: Implement create/reset/clean/sessions/stop APIs and commands

**Files:**
- Create: `src/commands/create.ts`
- Create: `src/commands/reset.ts`
- Rewrite: `src/commands/sessions.ts`
- Modify: `src/commands/clean.ts`
- Modify: `src/commands/stop.ts`
- Delete: `src/commands/start.ts`
- Delete: `src/commands/clear.ts`
- Delete: `src/commands/run.ts`
- Delete: `src/commands/daemon-stop.ts`
- Modify: `src/daemon/control-api.ts`
- Modify: `src/cli/daemon-client.ts`
- Rewrite: `tests/integration/ingestion/control-lifecycle.test.ts`
- Rewrite: `tests/e2e/cli-lifecycle.test.ts`

**Interfaces:**
- `create` response data:

```typescript
{
  sessionId: string;
  ingestUrl: string;
  appendPath: string;
}
```

- `reset` returns the same shape with the current daemon port.
- `stop` stops only the hidden service.

- [ ] **Step 1: Write a failing public lifecycle E2E**

```typescript
test("creates, resets, lists, cleans, and transparently restarts a session", async () => {
  const created = await runCli(home, ["create"]);
  expect(created.exitCode).toBe(0);
  expect(created.stdout).toContain("SESSION CREATED");
  const sessionId = extractSessionId(created.stdout);

  const reset = await runCli(home, ["reset", "--session", sessionId]);
  expect(reset.exitCode).toBe(0);
  expect(reset.stdout).toContain("Sequence reset to 1");

  const listed = await runCli(home, ["sessions"]);
  expect(listed.stdout).toContain(sessionId);

  const stopped = await runCli(home, ["stop"]);
  expect(stopped.exitCode).toBe(0);

  const statusAfterRestart = await runCli(home, ["status", "--session", sessionId]);
  expect(statusAfterRestart.exitCode).toBe(0);

  const cleaned = await runCli(home, ["clean", "--session", sessionId]);
  expect(cleaned.exitCode).toBe(0);
});
```

- [ ] **Step 2: Run the lifecycle E2E**

Run: `bun test tests/e2e/cli-lifecycle.test.ts`

Expected: FAIL on unknown `create`/`reset` and old stop semantics.

- [ ] **Step 3: Implement control endpoints**

Use these authenticated internal routes:

```text
POST   /v1/control/sessions
POST   /v1/control/sessions/:id/reset
GET    /v1/control/sessions?all=false
DELETE /v1/control/sessions/:id
POST   /v1/control/shutdown
```

Return `404 SESSION_NOT_FOUND` for an unknown explicit session. Do not return empty evidence as
success.

- [ ] **Step 4: Implement command handlers and pretty output**

Every data handler calls `ensureDaemon()` itself or through one shared executor. `template`,
`--help`, and `--version` remain static and do not start the service.

- [ ] **Step 5: Run lifecycle and daemon concurrency tests**

Run:

```bash
bun test tests/e2e/cli-lifecycle.test.ts
bun test tests/integration/daemon
```

Expected: all pass; twenty concurrent `create` callers use one hidden service while creating
twenty isolated sessions.

- [ ] **Step 6: Commit and push**

```bash
git add src/commands src/daemon/control-api.ts src/cli/daemon-client.ts tests/e2e tests/integration/ingestion/control-lifecycle.test.ts
git add -u src/commands
git commit -m "feat: add session-only CLI lifecycle"
git push
```

### Task 5: Replace ingestion routing and event normalization

**Files:**
- Modify: `src/daemon/ingest-api.ts`
- Modify: `src/daemon/direct-append-observer.ts`
- Modify: `src/domain/event-validation.ts`
- Modify: `src/daemon/event-store.ts`
- Modify: `src/domain/redaction.ts`
- Rewrite: `tests/integration/ingestion/http-ingestion.test.ts`
- Rewrite: `tests/integration/ingestion/direct-append.test.ts`
- Modify: `tests/integration/ingestion/diagnostics.test.ts`
- Modify: `tests/integration/ingestion/mixed-stress.test.ts`

**Interfaces:**
- HTTP route: `POST /ingest/:sessionId`.
- Probe body: `{ hypothesisId, location, message, data, timestamp }`.
- Stored body: probe fields plus `{ id, sequence, receivedAt }`.

- [ ] **Step 1: Write failing schema-equivalence tests**

```typescript
const raw = {
  data: { value: 42 },
  hypothesisId: "H1",
  location: "src/example.ts:1",
  message: "Observed value",
  timestamp: 1_784_310_000_001,
};

expect(await post(`/ingest/${session.id}`, raw)).toHaveStatus(202);
expect(await appendAndObserve(session.id, raw)).toBe("accepted");
expect(await events.read(session.id)).toEqual([
  expect.objectContaining({
    ...raw,
    id: expect.stringMatching(/^evt_/),
    receivedAt: expect.any(Number),
    sequence: 1,
  }),
]);
```

Also assert the persisted JSON contains none of `sessionId`, `runId`, or `schemaVersion`.

- [ ] **Step 2: Run ingestion tests**

Run: `bun test tests/integration/ingestion`

Expected: FAIL because current routes use ingest capabilities and validation requires
session/run/schema fields.

- [ ] **Step 3: Normalize by route/path scope**

`IngestionService.ingest(sessionId, value)` resolves the session, validates only the five probe
fields, redacts `data`, assigns ID/sequence/receipt time, and appends. Unknown sessions return
`not-found`.

- [ ] **Step 4: Remove declared-hypothesis diagnostics**

Delete `UNDECLARED_HYPOTHESIS_ID` from `DiagnosticReason` and remove all registry checks. Keep
malformed schema and secret-redaction diagnostics. Diagnostics created for accepted events always
belong to the route-resolved session.

- [ ] **Step 5: Verify stress, reset, and redaction**

Run:

```bash
bun test tests/integration/ingestion
bun test tests/unit/redaction.test.ts tests/unit/persistence/session-reset.test.ts
```

Expected: HTTP and file inputs produce equivalent canonical events; concurrent accepted events
have unique monotonic sequences; reset restarts at `1`.

- [ ] **Step 6: Commit and push**

```bash
git add src/daemon src/domain tests/integration/ingestion tests/unit
git commit -m "feat: simplify session-scoped ingestion schema"
git push
```

### Task 6: Make logs/query/status session-only, bounded, and reset-safe

**Files:**
- Modify: `src/commands/logs.ts`
- Modify: `src/commands/query.ts`
- Modify: `src/commands/status.ts`
- Modify: `src/cli/snapshot-cursor.ts`
- Delete the obsolete subprocess query runner.
- Modify: `src/native/query.ts`
- Modify: `native/query/src/lib.rs`
- Modify: `tests/unit/cursor.test.ts`
- Rewrite: `tests/e2e/query.test.ts`
- Modify: `tests/contract/result-rendering.test.ts`
- Create: `tests/e2e/unknown-session.test.ts`

**Interfaces:**
- All scope types contain only `sessionId` and optional hypothesis filters.
- Cursor payloads contain `sessionId`, `evidenceEpoch`, snapshot watermark, page position, and
  complete query options.
- Native streaming continuation contains a source byte offset and output ordinal; it does not
  reevaluate earlier input.

- [ ] **Step 1: Write failing unknown-session and reset-cursor tests**

```typescript
test("unknown sessions fail instead of returning empty trustworthy evidence", async () => {
  for (const command of ["logs", "status"]) {
    const result = await runCli(home, [command, "--session", "missing"]);
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("SESSION_NOT_FOUND");
  }
});

test("reset invalidates an earlier evidence cursor", async () => {
  const first = await firstLogsPage(sessionId);
  await reset(sessionId);
  const continued = await logsWithSnapshot(sessionId, first.snapshot);
  expect(continued.error.code).toBe("CURSOR_STALE");
});
```

- [ ] **Step 2: Run focused E2E tests**

Run: `bun test tests/e2e/unknown-session.test.ts tests/e2e/query.test.ts`

Expected: FAIL because unknown runs/sessions currently return empty results and cursor payloads
lack the reset epoch.

- [ ] **Step 3: Remove run/workspace fields and preserve continuation commands**

Every generated hint repeats `--session`, filters, limit, cursor/snapshot, slurp, timeout, and
`--json` only when the caller explicitly requested JSON. No hint includes workspace/run.
Logs sort by `timestamp` ascending and use `sequence` as the deterministic tie-breaker. A caller may
request any non-negative safe-integer limit; defaults protect accidental large output, but there is
no arbitrary configured maximum.

- [ ] **Step 4: Implement streaming log pages**

Use `createReadStream` plus `readline.createInterface` to count/filter while retaining only the
requested page. Stream diagnostics for summary counts; only `status` materializes the complete
bounded diagnostic list.

- [ ] **Step 5: Implement native byte-position continuation**

Change the Rust page result to:

```rust
struct QueryPage {
    results: Vec<String>,
    scanned_records: u64,
    produced_values: u64,
    returned_records: u64,
    next_byte_offset: Option<u64>,
    next_output_ordinal: Option<u64>,
}
```

In streaming mode stop evaluation after `limit + 1` page outputs and retain the byte offset before
the next input. Do not evaluate records beyond the lookahead. Slurp mode may read the snapshot once
and spool bounded serialized output pages under the private temp directory; cursors reference the
spool ID plus epoch, never a physical path.

- [ ] **Step 6: Return typed resource and evidence errors**

Map malformed canonical evidence to `EVIDENCE_MALFORMED`/exit `6`; timeout or spool exhaustion to
`QUERY_RESOURCE_EXHAUSTED`/exit `1`; a collection operator without slurp to
`COLLECTION_REQUIRED`/exit `2`.

- [ ] **Step 7: Run Rust, cursor, rendering, and E2E tests**

Run:

```bash
cargo test -p agentic-debug-mode-query
bun run build:native
bun test tests/unit/cursor.test.ts tests/contract/result-rendering.test.ts tests/e2e/query.test.ts tests/e2e/unknown-session.test.ts
```

Expected: all pass; a runtime error after the first page cannot fail that earlier page; reset
rejects old cursors.

- [ ] **Step 8: Commit and push**

```bash
git add native/query src/native src/commands src/cli tests/unit/cursor.test.ts tests/contract/result-rendering.test.ts tests/e2e
git commit -m "feat: add bounded session evidence queries"
git push
```

### Task 7: Add idle shutdown without exposing service management

**Files:**
- Create: `src/daemon/activity.ts`
- Modify: `src/daemon/server.ts`
- Modify: `src/daemon/main.ts`
- Modify: `src/daemon/ingest-api.ts`
- Modify: `src/daemon/direct-append-observer.ts`
- Modify: `src/cli/daemon-manager.ts`
- Create: `tests/integration/daemon/idle-shutdown.test.ts`
- Modify: `tests/integration/daemon/concurrent-start.test.ts`
- Modify: `tests/integration/daemon/startup-failure-cleanup.test.ts`

**Interfaces:**

```typescript
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export class ActivityTracker {
  touch(): void;
  acquireLease(): () => void;
  stop(): void;
}
```

- [ ] **Step 1: Write a failing deterministic idle test**

```typescript
test("stops after thirty idle minutes and restarts on the next command", async () => {
  const clock = new FakeClock();
  const first = await ensureDaemon({ clock, homeDirectory: home });

  clock.advance(29 * 60_000);
  expect(await readDaemonHealth(first)).toBeDefined();

  clock.advance(60_001);
  expect(await readDaemonHealth(first)).toBeUndefined();

  const second = await ensureDaemon({ clock, homeDirectory: home });
  expect(second.pid).not.toBe(first.pid);
});
```

- [ ] **Step 2: Run the idle test**

Run: `bun test tests/integration/daemon/idle-shutdown.test.ts`

Expected: FAIL because there is no activity tracker or idle shutdown.

- [ ] **Step 3: Implement activity tracking**

Use `30 * 60_000` milliseconds. Touch on every control request, accepted/rejected HTTP ingestion,
and observed complete file record. SSE acquires a lease on connection and releases it on cancel.
An active lease prevents idle shutdown.

- [ ] **Step 4: Preserve transparent startup and owned-child cleanup**

All data handlers use `ensureDaemon`; static template/help/version paths do not. Keep startup lock,
nonce health verification, stale-process identity verification, and failure-path child retirement.
Scope ready-candidate adoption to a dead original lock owner.

- [ ] **Step 5: Run daemon tests repeatedly**

Run:

```bash
bun test tests/integration/daemon
bun test tests/integration/daemon/concurrent-processes.test.ts --rerun-each 10
```

Expected: all runs pass with no leaked `__daemon` child.

- [ ] **Step 6: Commit and push**

```bash
git add src/daemon src/cli/daemon-manager.ts tests/integration/daemon
git commit -m "feat: stop hidden service after idle timeout"
git push
```

### Task 8: Implement session-independent templates and nine live-tested languages

**Files:**
- Rewrite: `src/probes/render.ts`
- Rewrite: `src/probes/javascript.ts`
- Rewrite: `src/probes/typescript.ts`
- Rewrite: `src/probes/python.ts`
- Create: `src/probes/go.ts`
- Create: `src/probes/ruby.ts`
- Create: `src/probes/php.ts`
- Create: `src/probes/powershell.ts`
- Create: `src/probes/csharp.ts`
- Create: `src/probes/swift.ts`
- Replace: `src/commands/probe.ts` with `src/commands/template.ts`
- Rewrite: `tests/contract/probe-renderers.test.ts` as `tests/contract/template-renderers.test.ts`
- Add fixtures under: `tests/fixtures/languages/`
- Rewrite: `tests/e2e/languages/live-probes.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

```typescript
export type TemplateLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "go"
  | "ruby"
  | "php"
  | "powershell"
  | "csharp"
  | "swift";

export type IngestMethod = "http" | "file";

export interface ProbeTemplates {
  language: TemplateLanguage;
  ingest: IngestMethod;
  helperTemplate: string;
  callTemplate: string;
  placeholders: Record<string, string>;
}

export function renderTemplate(language: string, ingest: string): ProbeTemplates;
```

- [ ] **Step 1: Write failing support-matrix tests**

```typescript
const supported = [
  ["javascript", "http"],
  ["typescript", "http"],
  ["python", "file"],
  ["go", "file"],
  ["ruby", "file"],
  ["php", "file"],
  ["powershell", "file"],
  ["csharp", "file"],
  ["swift", "file"],
] as const;

for (const [language, ingest] of supported) {
  test(`${language} + ${ingest} is session-independent`, () => {
    const template = renderTemplate(language, ingest);
    expect(template.helperTemplate).not.toContain("sessionId");
    expect(template.helperTemplate).not.toContain("runId");
    expect(template.helperTemplate).toContain(
      ingest === "http" ? "__INGEST_URL__" : "__APPEND_PATH__",
    );
  });
}
```

- [ ] **Step 2: Run renderer contracts**

Run: `bun test tests/contract/template-renderers.test.ts`

Expected: FAIL because only JavaScript/TypeScript/Python and session-bound contexts exist.

- [ ] **Step 3: Implement the exact support matrix**

Reject every unlisted language/method pair with `UNSUPPORTED_TEMPLATE`. All imports/requires/usings
belong at file/module scope in generated code. Helpers must suppress their own serialization,
open, and delivery failures and write one bounded record.

- [ ] **Step 4: Add real-runtime fixtures**

Each fixture replaces only the documented target and call placeholders, emits one event, and
allows the test to verify it through `debug-mode logs --session <id>`.

Use:

```text
node
bun
python3
go run
ruby
php
pwsh
dotnet run
swift
```

Skip locally only when a runtime is absent. CI installs every runtime and therefore skips none.

- [ ] **Step 5: Add CI toolchains**

Use maintained setup actions for Go, Ruby, .NET, PHP, and PowerShell; run Swift tests on macOS.
Pin action revisions according to repository release policy.

- [ ] **Step 6: Run template contracts and available live runtimes**

Run:

```bash
bun test tests/contract/template-renderers.test.ts
bun test tests/e2e/languages
```

Expected: all installed runtimes pass, and no generated template changes application behavior when
its target is unavailable.

- [ ] **Step 7: Commit and push**

```bash
git add src/probes src/commands/template.ts tests/contract tests/e2e/languages tests/fixtures/languages .github/workflows/ci.yml
git add -u src/commands/probe.ts
git commit -m "feat: add portable evidence templates"
git push
```

### Task 9: Rewrite pretty output, Agent Skill, and ground-truth documentation

**Files:**
- Modify: `src/cli/pretty-renderer.ts`
- Modify: `src/cli/output-schema.ts`
- Rewrite: `skills/agentic-debug-mode/SKILL.md`
- Rewrite: `docs/building-a-debug-mode-agent.md`
- Modify: `README.md`
- Modify: `tests/contract/result-rendering.test.ts`
- Rewrite: `tests/skill/skill-contract.test.ts`

**Interfaces:**
- Pretty `template` sections: helper, call, placeholders, event schema.
- Pretty evidence order: warnings, session scope, statistics, records/results, actionable hints.
- Skill commands: create, template, reset, logs, query, status, sessions when recovering an ID,
  clean only on explicit deletion request, and stop at completion.

- [ ] **Step 1: Write failing pretty and skill contracts**

```typescript
test("template output explains exact source without JSON field paths", () => {
  const rendered = renderPretty(templateResult);
  expect(rendered).toContain("HELPER TEMPLATE");
  expect(rendered).toContain("CALL TEMPLATE");
  expect(rendered).toContain("PLACEHOLDERS");
  expect(rendered).toContain("timestamp  Unix epoch milliseconds");
});

test("skill uses the session-only pretty workflow", () => {
  expect(skill).toContain("debug-mode create");
  expect(skill).toContain("debug-mode reset --session");
  expect(skill).toContain("debug-mode template --language");
  expect(skill).not.toContain("--json");
  expect(skill).not.toContain("--workspace");
  expect(skill).not.toContain("--run-id");
  expect(skill).not.toContain("data.instrumentation");
  expect(skill).not.toContain("daemon");
});

for (const command of [
  "create",
  "template",
  "reset",
  "logs",
  "query",
  "status",
  "sessions",
  "clean",
  "stop",
]) {
  test(`${command} has pretty and JSON contracts`, () => {
    expect(renderFixture(command, false)).toMatchSnapshot(`${command}-pretty`);
    expect(JSON.parse(renderFixture(command, true))).toMatchObject({
      command,
      ok: expect.any(Boolean),
      schemaVersion: 1,
    });
  });
}
```

- [ ] **Step 2: Run rendering and skill contracts**

Run: `bun test tests/contract/result-rendering.test.ts tests/skill/skill-contract.test.ts`

Expected: FAIL on old JSON paths, workspace/run commands, and generic nested template rendering.

- [ ] **Step 3: Rewrite pretty output and skill**

Define every term before first use. The skill states:

```text
Do not ask the user to perform an action you can execute with available tools.
Run available CLI commands, tests, and HTTP requests yourself.
```

It includes the exact five-field probe schema and states that `timestamp` and `receivedAt` are Unix
epoch milliseconds.

For `logs`, render every event's full `data` value and every observed hypothesis ID without
repeating invariant scope fields in each row. For `query`, render homogeneous scalar/object results
as a compact table and nested or heterogeneous values as pretty JSON. Warnings and fundamental
statistics always precede records/results.

- [ ] **Step 4: Make docs and README match `DESIGN.md`**

Remove every old command, run/workspace/hypothesis-registration concept, capability/token term, and
unimplemented option. Document only the nine tested language/method pairs.

- [ ] **Step 5: Run documentation contracts and discrepancy scans**

Run:

```bash
bun test tests/contract/result-rendering.test.ts tests/skill/skill-contract.test.ts
rg 'debug-mode (start|probe|clear|daemon stop)|--workspace|--run-id|data\\.instrumentation|UNDECLARED_HYPOTHESIS' README.md docs skills src tests
```

Expected: tests pass; ripgrep returns only explicit removed-interface migration notes in
`DESIGN.md`.

- [ ] **Step 6: Commit and push**

```bash
git add src/cli skills README.md docs tests/contract tests/skill
git commit -m "docs: align Agent Skill with session-only workflow"
git push
```

### Task 10: Harden release workflow and complete end-to-end verification

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `packaging/homebrew/agentic-debug-mode.rb`
- Modify: `tests/distribution/package-layout.test.ts`
- Modify: `package.json`
- Remove temporary debug instrumentation from:
  - `src/commands/start.ts` if not already deleted
  - `src/cli/dispatch.ts`
  - `src/cli/pretty-renderer.ts`
  - `src/probes/render.ts`

**Interfaces:**
- Build jobs: `contents: read`, no OIDC.
- Publish job: `contents: write`, `id-token: write`.
- Root, launcher, platform-package, tag, and rendered Homebrew versions must match.

- [ ] **Step 1: Write failing release-layout assertions**

```typescript
expect(release).toContain("build:\n    permissions:\n      contents: read");
expect(release).toContain("publish:\n    permissions:\n      contents: write\n      id-token: write");
expect(release).toContain("require('./package.json').version");
expect(release).toContain("checksums.txt");
expect(release).toContain("agentic-debug-mode.spdx.json");
expect(release).toContain("cosign sign-blob");
```

- [ ] **Step 2: Run distribution contracts**

Run: `bun test tests/distribution/package-layout.test.ts`

Expected: FAIL because permissions are workflow-wide and root/formula version validation is
incomplete.

- [ ] **Step 3: Scope permissions and synchronize versions**

Move permissions under each job. Render Homebrew `version` from `${GITHUB_REF_NAME#v}` together
with checksums. Pin third-party actions to audited commit SHAs. Publish platform packages only
after every target build succeeds to avoid partial releases.

- [ ] **Step 4: Remove temporary debugging instrumentation**

Only after all redesigned behavior has passed post-change E2E verification, remove the temporary
`agent log` regions targeting the Cursor-provided debug endpoint. Do not remove generated-template
region markers.

- [ ] **Step 5: Run the complete verification matrix twice**

Run:

```bash
bun run check
bun run typecheck
cargo test --workspace
bun run build
bun run test
bun run test
```

Expected: every command exits `0`; both full test runs pass without leaked daemon processes,
skipped CI language runtimes, warnings, or formatting changes.

- [ ] **Step 6: Inspect final repository state**

Run:

```bash
git status --short
git diff --check
ps -axo pid,ppid,state,command | rg 'debug-mode.*__daemon' || true
```

Expected: only intended tracked changes before commit, no whitespace errors, and no leaked test
daemon.

- [ ] **Step 7: Commit and push**

```bash
git add .github packaging package.json src tests
git commit -m "chore: harden release and verification pipeline"
git push
```
