# Building an Agent with Debug Mode

This guide describes the compiled CLI, Agent Skill, probe format, and runtime infrastructure behind
an AI coding agent that debugs from runtime evidence instead of guessing from source code. It is the
ground-truth companion to [`DESIGN.md`](../DESIGN.md); the two must agree.

The design has two independent parts:

1. **Installable Agent Skill** — enforces the evidence-first workflow and teaches the agent one
   command: `debug-mode`.
2. **Standalone CLI and background service** — creates isolated sessions, generates
   language-specific probes, ingests events, stores NDJSON, and exposes filtered evidence.

The agent does not use MCP and does not manage the HTTP server, ports, or state files. Those are
private implementation details behind the CLI. A strong skill cannot compensate for unreliable
telemetry, and a reliable CLI cannot make an agent follow a disciplined loop.

## 1. Required behavior

A Debug Mode agent runs one investigation as one **session** and repeats this loop:

1. Understand expected behavior, actual behavior, and the shortest reproduction.
2. Form three to five falsifiable hypotheses, labeled `H1`, `H2`, … The agent owns this list; the
   framework never registers, declares, or validates it.
3. Insert one CLI-generated helper per runtime, then the minimum observations that evaluate the
   hypotheses.
4. Reset the session.
5. Reproduce with available tools; ask the user only for interactions the agent cannot perform.
6. Read evidence and mark each hypothesis `CONFIRMED`, `REJECTED`, or `INCONCLUSIVE`, citing events.
7. Make only the change the confirmed evidence supports.
8. Keep all observations in place, reset, and reproduce again.
9. Compare baseline and post-fix evidence within the same session.
10. Remove observation regions only after the evidence proves the fix and the user confirms.

There is no separate run concept and no persisted baseline/post-fix pair — baseline conclusions live
in the agent's own context across reset cycles.

## 2. Agent-facing CLI contract

`debug-mode` is the only Debug Mode-specific interface exposed to the agent. Pretty text is the
primary output for agents and humans. Every command also supports `--json` for external programmatic
consumers, writes diagnostics to stderr, and uses stable exit codes.

Every session-scoped command requires an explicit `--session <id>`. The CLI never selects a session.

### 2.1 Shared result envelope

Every command produces one semantic result with two renderers. The default pretty renderer orders:

1. warnings and abnormal conditions;
2. command summary and session scope;
3. statistics;
4. command-specific records or results;
5. actionable hints and safe follow-up commands.

Warnings that do not make the data untrustworthy keep exit code `0`. A condition that prevents a
trustworthy result returns a nonzero exit code. Commands never silently omit malformed evidence,
fallback execution, or truncation.

The `--json` envelope is:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "partial": false,
  "command": "logs",
  "scope": { "sessionId": "…", "hypothesisFilter": null },
  "warnings": [],
  "statistics": {},
  "data": {},
  "hints": []
}
```

Errors return `{ "schemaVersion": 1, "ok": false, "error": { "code", "message", "hint" } }`. The
pretty and JSON renderers are generated from the same typed result.

### 2.2 Command availability and installation

The skill begins with `debug-mode --version`. If the command is missing, it selects a supported
channel under the host's approval policy, installs, and verifies again. It never continues with an
unverified installation.

| Channel        | Command                                            | Notes                                      |
| -------------- | -------------------------------------------------- | ------------------------------------------ |
| npm global     | `npm install --global agentic-debug-mode`          | Cross-platform persistent install          |
| Bun global     | `bun install --global agentic-debug-mode`          | Same package; Bun only for installation    |
| npx            | `npx --yes agentic-debug-mode@latest <command>`    | Zero-install fallback command prefix       |
| Homebrew       | Official tap command after the tap is published    | Only when the tap coordinate is documented |
| Direct release | Download the matching signed/checksummed asset     | Managed environments                       |

The executable name stays `debug-mode`. Do not run `curl | sh`, elevate privileges, or edit shell
startup files.

### 2.3 Commands

#### `debug-mode create`

Creates a new session and returns its **Session ID**, **Ingest URL**, and **Append Path**. Takes no
language, run, or hypothesis options.

```text
SESSION CREATED
Session <id>

Ingest URL   http://127.0.0.1:<port>/ingest/<id>
Append Path  ~/.agent-debug-mode/sessions/<id>/incoming.ndjson
```

The session is in the Ingest URL path; it is not a token. HTTP ingestion needs no header and no
duplicated session field in the body.

#### `debug-mode template --language <language> --ingest <http|file>`

Returns a session-independent helper and call template plus placeholders and the event schema.
Pretty output has four sections:

```text
HELPER TEMPLATE
<exact source>

CALL TEMPLATE
<exact source>

PLACEHOLDERS
<names and meanings>

EVENT SCHEMA
hypothesisId  string
location      string
message       string
data          bounded JSON value
timestamp     Unix epoch milliseconds
```

HTTP templates use an ingest-URL placeholder; file templates use an append-path placeholder. The
advertised, end-to-end-tested combinations are:

- JavaScript + HTTP
- TypeScript + HTTP
- Python + file
- Go + file
- Ruby + file
- PHP + file
- PowerShell + file
- C# + file
- Swift + file
- Rust + file
- C++ + file
- C + file
- Java + file
- Kotlin + file

Other languages are not advertised until a safe serializer contract is defined.

#### `debug-mode reset --session <id>`

Clears events, diagnostics, and sequence state while preserving the session ID, append path, and
inserted observations. Sequence restarts at `1`, old cursors become invalid, and the response
returns the currently valid Ingest URL and Append Path.

#### `debug-mode logs --session <id>`

Returns bounded, validated records with `--limit`/`--offset` pagination, repeatable read-only
`--hypothesis` filtering, statistics, warnings, and complete continuation commands. `logs` renders
every event's full `data` value and every observed hypothesis label without repeating invariant
scope fields in each row.

#### `debug-mode query --session <id> '<jaq program>'`

Runs an embedded jaq program (`jaq-core`, `jaq-std`, `jaq-json` via napi-rs) over the session
evidence. Streaming is the default; collection operations require explicit `--slurp`. Opaque cursors
retain the query scope without exposing a path. Homogeneous flat objects render as a compact table;
scalars as an indexed value table; nested or heterogeneous values as pretty JSON.

#### `debug-mode status --session <id>`

Returns evidence health and every bounded, redacted malformed-record diagnostic: a stable ID,
reason, message, recoverable fields, redacted preview, and suggested fix. It never exposes the
evidence path, byte offsets, or secrets, and never reports service implementation details.

#### `debug-mode sessions [--all]`

Lists sessions created today, newest first, at most 20 (`sessionId`, `createdAt`, `eventCount`).
`--all` includes older sessions. Never selects a session.

#### `debug-mode clean --session <id>`

Permanently removes `~/.agent-debug-mode/sessions/<id>/`: evidence, diagnostics, and metadata.

#### `debug-mode stop`

Immediately stops the background service without deleting sessions. The next data command restarts
it transparently.

#### Exit codes

| Exit | Meaning                                   |
| ---- | ----------------------------------------- |
| `0`  | Success                                   |
| `2`  | Invalid arguments or unsupported language |
| `3`  | Version incompatibility                   |
| `4`  | Background service unavailable            |
| `5`  | Session not found                         |
| `6`  | Evidence malformed or unreadable          |

## 3. Event contract

### Probe event

HTTP and file helpers emit exactly five fields:

```json
{
  "hypothesisId": "H1",
  "location": "src/cache.ts:84",
  "message": "Cache lookup completed",
  "data": { "cacheKey": "cart:42", "hit": false },
  "timestamp": 1784313728231
}
```

| Field          | Meaning                                        |
| -------------- | ---------------------------------------------- |
| `hypothesisId` | Agent-generated label for one hypothesis       |
| `location`     | Stable source location, preferably `path:line` |
| `message`      | Constant observation description               |
| `data`         | Bounded JSON containing the changing values    |
| `timestamp`    | Observation time in Unix epoch milliseconds    |

The body carries no `sessionId`, run identifier, or per-record `schemaVersion`.

### Stored event

Ingestion adds `id`, `sequence` (accepted order within the current reset cycle), and `receivedAt`
(receipt time in Unix epoch milliseconds). When timestamps tie, `sequence` is the stable
tie-breaker. The schema version is stored once in session metadata.

### Data rules

- Use a native JSON serializer; never build JSON by string interpolation.
- Keep `message` constant; put changing values in `data`.
- Never record passwords, tokens, cookies, authorization headers, private keys, full request
  bodies, or unrelated personal data. Secrets are redacted before canonical persistence.
- Bound strings, arrays, and object depth. A failed observation must never change control flow.

## 4. Ingestion

### HTTP

```text
POST /ingest/<sessionId>
Content-Type: application/json
```

The loopback route determines the session. There is no separate token, header, or session field in
the body.

### File

The helper appends bounded, newline-terminated JSON records to the returned append path using the
language's standard JSON and file APIs, never spawning the CLI per event. The background service
observes complete lines, validates and redacts them, and appends normalized records to the canonical
evidence record. Incomplete trailing lines stay buffered.

## 5. Probe region markers

Observation regions are a source-editing contract, not part of NDJSON. They make instrumentation
visually distinct, foldable, mechanically removable, and auditable as complete blocks.

| Language/file type                | Open                   | Close           |
| --------------------------------- | ---------------------- | --------------- |
| JavaScript, TypeScript, Go, Swift, Rust, C++, C, Java, Kotlin | `// #region agent log` | `// #endregion` |
| C#, PowerShell                    | `#region agent log`    | `#endregion`    |
| Python, Ruby                      | `# region agent log`   | `# endregion`   |
| PHP                               | `// #region agent log` | `// #endregion` |

Generated files whose syntax cannot hold the markers should not be instrumented directly; probe the
code that produces them.

## 6. Distribution

The CLI and background service are two modes of one Bun-compiled executable, each directly requiring
its matching napi-rs `.node` addon so the installed artifact is a single `debug-mode` binary.
Release automation cross-compiles and tests macOS arm64/x64, Linux arm64/x64, and Windows x64, with
pinned Bun, SHA-256 checksums, signatures, and an SBOM.

- `npm install --global agentic-debug-mode` and `npx --yes agentic-debug-mode@latest` run the
  compiled CLI from npm.
- `npx skills add <owner>/debug-mode --skill agentic-debug-mode` installs the skill from a public
  Git repository. The skill lives at `skills/agentic-debug-mode/SKILL.md` with supporting
  `REFERENCE.md` and `EXAMPLES.md`.

The Homebrew formula downloads the matching release archive and verifies its checksum; it does not
build from source or require Bun on the user's machine.

## 7. Background service lifecycle

Every data command checks whether the background service is healthy, starts or replaces it when
needed, and then performs the operation. The service binds loopback on an available port, shuts down
immediately on `debug-mode stop`, shuts down after 30 minutes of inactivity, and restarts
transparently on the next command. The Agent Skill never reasons about this lifecycle.

## 8. Isolation and reset safety

- Session IDs are random UUIDs, each with an isolated subdirectory and evidence lifecycle.
- `reset`, `logs`, `query`, `status`, and `clean` require an explicit session ID.
- Reset increments a private evidence epoch used only to invalidate old cursors.
- State directories and files reject symbolic-link redirection.
- Secrets are redacted before canonical persistence.

## 9. Verification requirements

- Commander help and parse errors have contract tests.
- Every public command has pretty-output and JSON contract tests.
- Create/reset/clean/session isolation have lifecycle tests.
- Concurrent CLI processes converge on one healthy background service.
- Idle shutdown and transparent restart have deterministic tests with an injected clock.
- HTTP and file ingestion share schema-validation and redaction tests.
- Every advertised language/ingest combination has a live end-to-end test.
- Reset invalidates old cursors and restarts sequence numbering.
- Large logs and queries remain memory-bounded.

## 10. Agent Skill

The installable skill lives at `skills/agentic-debug-mode/SKILL.md`, with `REFERENCE.md` (the full
command and jaq reference) and `EXAMPLES.md` (worked investigations). The skill uses pretty output,
defines every term before use, never references internal paths or service processes, and never asks
the user to perform an action the agent can perform itself. `--json` appears only in `REFERENCE.md`,
for external integrations.
