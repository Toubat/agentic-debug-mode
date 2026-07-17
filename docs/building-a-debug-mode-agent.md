# Building an Agent with Debug Mode

This guide describes the compiled CLI, Agent Skill, probe format, and runtime infrastructure needed to build an AI coding agent that debugs from runtime evidence instead of guessing from source code.

The design has two independent parts:

1. **Installable Agent Skill** — enforces the evidence-first workflow and tells the agent how to use one command: `debug-mode`.
2. **Standalone CLI and daemon** — creates isolated sessions, generates language-specific probes, ingests events, stores NDJSON, and exposes filtered evidence.

The agent does not use MCP and does not manage the HTTP server, ports, tokens, PID files, or log paths itself. Those are private implementation details behind the CLI. A strong skill cannot compensate for unreliable telemetry, and a reliable CLI cannot make an agent follow a disciplined debugging loop.

## 1. Required behavior

A Debug Mode agent follows this state machine:

1. Understand expected behavior, actual behavior, and reproduction steps.
2. Generate three to five falsifiable hypotheses.
3. Insert one CLI-generated helper per runtime, then add the minimum lightweight probe calls that evaluate all hypotheses in parallel.
4. Clear only the current session's log.
5. Ask the user to reproduce the issue.
6. Read the resulting log and mark every hypothesis `CONFIRMED`, `REJECTED`, or `INCONCLUSIVE`, citing event evidence.
7. Make only the change supported by runtime evidence.
8. Keep the helper and all probe calls in place and repeat the reproduction with a new `runId`.
9. Compare baseline and post-fix evidence.
10. Remove helper and probe-call regions only after the evidence proves the fix and the user confirms the behavior.

The agent must not jump from code inspection to a fix. Source inspection creates hypotheses; runtime evidence decides among them.

## 2. Agent-facing CLI contract

`debug-mode` is the only Debug Mode-specific interface exposed to the agent. Pretty text is the primary output for agents and humans viewing evidence. Every agent-facing command also supports `--json` for programmatic consumers, writes diagnostics to stderr, and uses stable exit codes.

### 2.1 Ordinary coding tools

| Capability           | Why it is needed                                                        |
| -------------------- | ----------------------------------------------------------------------- |
| Read file            | Inspect application code                                                |
| Search files/content | Locate execution paths and existing logging conventions                 |
| Edit/apply patch     | Insert and later remove bounded probe regions                           |
| Run command          | Invoke `debug-mode` and run the application                             |
| Ask user             | Gate reproduction and cleanup when the agent cannot perform them safely |
| Read diagnostics     | Detect syntax or type errors introduced by instrumentation              |

The agent must not delete, truncate, or read the raw log file directly. Session isolation belongs to the CLI.

### 2.2 Command availability and installation

The skill begins with:

```bash
debug-mode --version
```

If the command is unavailable, the skill selects a supported installation channel, follows the host's approval policy for package installation, installs it, and runs `debug-mode --version` again. It must never continue with an unverified installation.

Proposed published names:

| Channel        | Command                                                | Notes                                                                     |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| Homebrew       | `brew install agentic-debug-mode`                      | Preferred on macOS when Homebrew exists                                   |
| npm global     | `npm install --global agentic-debug-mode`              | Cross-platform persistent installation                                    |
| Bun global     | `bun install --global agentic-debug-mode`              | Same npm package; Bun is needed only for installation                     |
| npx            | `npx --yes agentic-debug-mode@latest <command>`        | Zero-install fallback; resolve this as the command prefix for the session |
| Direct release | Download the matching signed/checksummed release asset | For managed environments and future package-manager integrations          |

The package scope and Homebrew tap above are proposed names and must be replaced if publication uses different coordinates. The executable name should remain `debug-mode` so the skill contract stays stable.

Do not silently execute `curl | sh`, elevate privileges, or modify shell startup files. When installation requires those actions, show the user the supported command instead.

### 2.3 Commands

#### Shared result envelope

Every command produces the same semantic result with two renderers. The default renderer is intentionally optimized for an agent or human reading terminal output:

1. warnings and abnormal conditions;
2. command summary and statistics;
3. command-specific data;
4. actionable hints and safe follow-up commands.

Warnings that do not make the returned data untrustworthy keep exit code `0`. A condition that prevents a trustworthy result returns a nonzero exit code. Commands must never silently omit malformed evidence, fallback execution, truncation, or partial progress.

The generic `--json` shape is:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "partial": false,
  "command": "logs",
  "scope": {
    "sessionId": "4ca86a",
    "runId": "baseline",
    "hypothesisIds": ["H1", "H2"],
    "hypothesisFilter": null
  },
  "warnings": [],
  "statistics": {},
  "data": {},
  "hints": []
}
```

The default output uses aligned headings, indentation, compact tables, localized timestamps, readable counts, and copyable commands. It avoids decorative noise, ANSI color when output is not a TTY, and wide tables that wrap unpredictably. Warnings appear before evidence; statistics and scope are visually distinct; records use stable labels; hints appear last.

With `--json`, each warning has a stable `code` and readable `message`. Each hint has an `action`, a readable `message`, and, when applicable, a complete executable `command`. JSON consumers use these fields directly. The pretty renderer and JSON renderer must be generated from the same typed result rather than implementing separate command behavior.

Set `partial` to `true` when the command returns usable but incomplete data, such as a timed-out query with partial progress. The scope echoes the resolved session and run so an agent can verify that it is analyzing the intended evidence. Read commands also report their execution mode and duration.

#### `debug-mode start`

Ensures the daemon is healthy, creates or resumes the workspace session, resets the active run when requested, and returns two language-specific templates: one helper definition and one lightweight probe call.

```bash
debug-mode start \
  --workspace "$PWD" \
  --language typescript \
  --run-id baseline \
  --hypothesis H1 \
  --hypothesis H2 \
  --json
```

Example output:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "partial": false,
  "command": "start",
  "scope": {
    "sessionId": "4ca86a",
    "runId": "baseline",
    "hypothesisIds": ["H1", "H2"]
  },
  "warnings": [],
  "statistics": {},
  "data": {
    "workspace": "/absolute/project/path",
    "instrumentation": {
      "language": "typescript",
      "runtime": "node",
      "transport": "http",
      "helperTemplate": "// #region agent log\nfunction debugEmit(event) { /* session-scoped fetch implementation */ }\n// #endregion",
      "callTemplate": "// #region agent log\ndebugEmit({ hypothesisId: \"__HYPOTHESIS_ID__\", location: \"__LOCATION__\", message: \"__MESSAGE__\", data: __DATA_EXPRESSION__ });\n// #endregion",
      "replace": ["__HYPOTHESIS_ID__", "__LOCATION__", "__MESSAGE__", "__DATA_EXPRESSION__"]
    },
    "daemon": {
      "status": "running"
    },
    "capabilities": {
      "liveEvents": true,
      "ui": false
    }
  },
  "hints": []
}
```

The agent inserts `data.instrumentation.helperTemplate` once per runtime boundary, then creates every observation from `data.instrumentation.callTemplate`. It treats helper transport code as opaque and replaces only the declared call placeholders. The helper owns endpoint or log-path configuration, session fields, serialization, payload limits, and failure suppression.

If a project contains another language or runtime, call `start` again with `--language` and `--runtime`, or use `debug-mode probe --language <language> --runtime <runtime> --json`.

`start` should be idempotent. Repeated calls must not create duplicate daemons.

The first `start` for a run declares its expected hypothesis IDs with repeated `--hypothesis` flags. `run begin` accepts the same flags for later reproductions and inherits the previous run's list only when none are supplied. This declaration lets the CLI distinguish a valid event associated with an undeclared or mistyped hypothesis ID from malformed JSON.

#### `debug-mode probe`

Returns another helper/call template pair for the current session without changing daemon or run state:

```bash
debug-mode probe --language python --json
```

#### `debug-mode clear`

Clears only the active session and run:

```bash
debug-mode clear --workspace "$PWD" --session 4ca86a --run-id baseline --json
```

The command verifies the workspace-to-session mapping. It does not accept an arbitrary path or glob.

#### `debug-mode logs`

Returns validated, filtered evidence:

```bash
debug-mode logs \
  --workspace "$PWD" \
  --session 4ca86a \
  --run-id baseline \
  --offset 0 \
  --limit 100
```

Without `--hypothesis`, `logs` includes every hypothesis in the run. Repeat `--hypothesis <id>` to view one or more declared hypotheses. The scope shown in the header and every generated pagination command must preserve the selected set.

`--offset` defaults to `0` and `--limit` defaults to `100`. An explicit positive limit is not silently clamped. The result includes:

- `totalRecords`, `validRecords`, `malformedRecords`, and `returnedRecords`;
- counts grouped by declared hypothesis and a separate undeclared-ID count;
- the requested offset and limit;
- `hasPrevious`, `hasNext`, `previousOffset`, and `nextOffset`;
- a snapshot watermark that keeps subsequent offset pages stable while new events arrive;
- complete previous/next commands in `hints`, preserving workspace, session, run, filters, limit, output mode, and snapshot.

`logs` warns when malformed records exist but does not duplicate every diagnostic. Its warning and hint tell the agent to run `debug-mode status` for the complete malformed-record list and corrective guidance.

With `--json`, the same logs result is:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "partial": false,
  "command": "logs",
  "scope": {
    "sessionId": "4ca86a",
    "runId": "baseline",
    "hypothesisIds": ["H1", "H2"],
    "hypothesisFilter": null
  },
  "warnings": [
    {
      "code": "MALFORMED_RECORDS",
      "message": "3 malformed records were excluded; run debug-mode status for diagnostics."
    }
  ],
  "statistics": {
    "totalRecords": 12500,
    "validRecords": 12497,
    "malformedRecords": 3,
    "returnedRecords": 100,
    "recordsByHypothesis": {
      "H1": 7000,
      "H2": 5497
    },
    "undeclaredHypothesisRecords": 0,
    "durationMs": 14
  },
  "data": {
    "records": [],
    "pagination": {
      "offset": 100,
      "limit": 100,
      "hasPrevious": true,
      "hasNext": true,
      "previousOffset": 0,
      "nextOffset": 200,
      "snapshot": "opaque-snapshot"
    },
    "mode": "streaming"
  },
  "hints": [
    {
      "action": "previous-page",
      "message": "Read the previous 100 records.",
      "command": "debug-mode logs --workspace /absolute/project/path --session 4ca86a --run-id baseline --offset 0 --limit 100 --snapshot opaque-snapshot --json"
    },
    {
      "action": "next-page",
      "message": "Read the next 100 records.",
      "command": "debug-mode logs --workspace /absolute/project/path --session 4ca86a --run-id baseline --offset 200 --limit 100 --snapshot opaque-snapshot --json"
    },
    {
      "action": "inspect-malformed",
      "message": "Inspect all malformed-record diagnostics and corrective actions.",
      "command": "debug-mode status --workspace /absolute/project/path --session 4ca86a --run-id baseline --json"
    }
  ]
}
```

The primary pretty output uses a normalized table. Fields guaranteed to be identical by command scope appear once in the header; every varying event field appears in each row. The guide shows two rows, while the actual command renders every returned record.

```text
WARNING  3 malformed records were excluded.
         Run `debug-mode status --session 4ca86a --run-id baseline`
         before drawing conclusions from this evidence.

LOGS     Schema 1  •  Session 4ca86a  •  Run baseline
         Hypotheses H1, H2 (all)
         Showing valid records 101–200 of 12,497

SUMMARY  Total 12,500  •  Valid 12,497  •  Malformed 3  •  Returned 100
         H1 7,000  •  H2 5,497  •  Undeclared 0

SEQ   ID                    HYP  TIMESTAMP      RECEIVED_AT    LOCATION          MESSAGE                    DATA
1042  evt_01J0CACHE1042     H1   1784313728231  1784313728237  src/cache.ts:84   Cache lookup completed     {"cacheKey":"cart:42","hit":false,"durationMs":18}
1043  evt_01J0CACHE1043     H2   1784313728247  1784313728251  src/cache.ts:91   Cache fallback selected    {"fallback":"database","attempt":1,"queued":true}

Previous  debug-mode logs --session 4ca86a --run-id baseline --offset 0 --limit 100 --snapshot opaque-snapshot
Next      debug-mode logs --session 4ca86a --run-id baseline --offset 200 --limit 100 --snapshot opaque-snapshot
Status    debug-mode status --session 4ca86a --run-id baseline
```

An event whose `hypothesisId` is not declared for the run remains structurally valid, but it is abnormal evidence. `logs` and `query` emit an `UNDECLARED_HYPOTHESIS_ID` warning, show the unexpected IDs and counts, and direct the agent to `status`. `status` lists the affected event IDs and locations and prompts the agent to correct the mistyped probe or deliberately declare the hypothesis in a new run before reproducing. It never silently merges an unknown ID into an expected hypothesis.

`logs` never drops event fields. The scope header represents `schemaVersion`, `sessionId`, and `runId`; each row represents `sequence`, `id`, `hypothesisId`, `timestamp`, `receivedAt`, `location`, `message`, and the complete bounded `data` value. This factoring is lossless because one logs command is scoped to one schema, session, and run.

`data` uses compact JSON for token efficiency. The renderer never truncates a value. When a row exceeds the terminal width, it wraps the overflowing cell onto an indented continuation line while preserving the full content. Only `query` may omit fields, and only when the supplied jaq program explicitly projects a smaller value.

Omit an unavailable previous or next hint instead of returning an unusable command. When `--json` is present, return the same complete records in `data.records` and preserve `--json` in generated hints.

`--follow --jsonl` may stream events for humans or long-running agent operations, but finite reads are the default. Streaming mode emits an initial metadata record, event records, and final summary record so warnings and totals remain machine-readable.

#### `debug-mode query`

Queries large sessions without exposing the NDJSON file to the agent:

```bash
debug-mode query \
  --workspace "$PWD" \
  --session 4ca86a \
  --run-id baseline \
  'select(
     .hypothesisId == "H1"
     and .data.durationMs >= 100
     and (.message | test("cache (miss|expired)"; "i"))
   )
   | {sequence, timestamp, location, message, durationMs: .data.durationMs}' \
  --limit 100
```

The positional argument is a `jaq` program. The CLI embeds the Rust `jaq-core`, `jaq-std`, and `jaq-json` libraries through `napi-rs`; it does not execute a system `jq` or `jaq` binary and does not maintain a custom jq-inspired parser.

```text
debug-mode query [scope options] '<jaq program>' [--slurp] [--limit <n>]
```

Use normal jaq expressions for `select`, projection, comparison, boolean logic, string operations, regex functions such as `test`, array operations, sorting, grouping, and aggregation. Compatibility is defined by the pinned jaq crates, not by an independently documented subset. The CLI does not register filesystem, environment, module-loading, or process-execution functions, so a query can transform only the supplied event values.

Every structured envelope field is queryable and selectable:

```text
.schemaVersion
.sessionId
.runId
.hypothesisId
.id
.sequence
.timestamp
.receivedAt
.location
.message
.data.<scalar-key>
```

The CLI scopes `.sessionId` to the resolved workspace session before evaluating the user filter. Dynamic `.data` paths are queryable when their values are string, number, boolean, or null.

Filters can combine any fields:

```bash
debug-mode query \
  --session 4ca86a \
  --run-id baseline \
  'select(
     .hypothesisId == "H2"
     and (.location | test("^src/payments/"))
     and (.message | contains("timeout"))
     and .data.durationMs >= 100
   )'
```

Without `--slurp`, each valid NDJSON event is passed independently to the compiled program. This is the default because filtering and projection remain streaming and memory-bounded.

```bash
debug-mode query \
  --session 4ca86a \
  --run-id baseline \
  'select(.hypothesisId == "H2") | {timestamp, location, message}' \
  --limit 100
```

`--slurp` collects all valid records in the scoped session and run into one array before executing jaq. It is required for operations across records, including `sort_by`, `group_by`, and whole-run aggregation:

```bash
debug-mode query \
  --session 4ca86a \
  --run-id baseline \
  --slurp \
  'sort_by([.timestamp, .sequence])
   | .[]
   | {sequence, timestamp, location, message}' \
  --limit 100
```

```bash
debug-mode query \
  --session 4ca86a \
  --run-id baseline \
  --slurp \
  'group_by(.hypothesisId)
   | map({
       hypothesisId: .[0].hypothesisId,
       count: length,
       averageDurationMs: (map(.data.durationMs) | add / length)
     })
   | sort_by(-.count)
   | .[]'
```

The CLI never enables slurp implicitly. If a collection operation such as `sort_by` receives an individual event, return `COLLECTION_REQUIRED` and suggest the same command with `--slurp`. Slurp mode reports the estimated input size before results in pretty output and returns a structured resource error if the machine cannot complete it. `.timestamp` is event-observed time; `.receivedAt` is daemon receipt time; `.sequence` is the stable tie-breaker.

With `--json`, query responses include:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "partial": false,
  "command": "query",
  "scope": {
    "sessionId": "4ca86a",
    "runId": "baseline"
  },
  "warnings": [],
  "statistics": {
    "totalRecords": 12500,
    "validRecords": 12497,
    "malformedRecords": 3,
    "scannedRecords": 12500,
    "producedValues": 231,
    "returnedRecords": 100,
    "durationMs": 27
  },
  "data": {
    "rows": [],
    "pagination": {
      "hasNext": true,
      "nextCursor": "opaque-cursor"
    },
    "mode": "streaming",
    "slurp": false
  },
  "hints": [
    {
      "action": "next-page",
      "message": "Continue the same query.",
      "command": "debug-mode query --session 4ca86a --run-id baseline --cursor opaque-cursor --json"
    }
  ]
}
```

The primary pretty query output follows the same warning → scope → statistics → results → hints layout as `logs`, but it must not assume the fixed event schema after jaq transforms a value. Rendering is shape-aware:

- a stream of objects with identical keys and scalar values renders as a compact table;
- a stream of strings, numbers, booleans, or null renders as an indexed `VALUE` table;
- arrays, nested objects, heterogeneous object shapes, and mixed value types render as numbered pretty-JSON values;
- no output renders an explicit `No values produced` message;
- `--json` returns the exact typed jaq output values without display coercion.

The decision algorithm operates on the complete returned page, after `--limit` and cursor boundaries are applied:

1. If every value is an object, every object has the same exact key set, and every cell is string, number, boolean, or null, use an object table.
2. Otherwise, if every value is string, number, boolean, or null, use an indexed `VALUE` table. Quote strings as JSON so `"1"` remains distinguishable from `1`.
3. Otherwise, use numbered pretty-JSON values.
4. Empty output uses the explicit empty state.

This is deterministic and lossless; terminal width affects wrapping, never format eligibility or value truncation. Key order does not need to match, but key presence does: an absent key and a present key whose value is null are different shapes.

The native query layer computes this shape summary while producing the bounded page. It may spool serialized page values to a private temporary buffer before rendering, so it can inspect the whole page without constructing an unbounded Node/Bun array. A larger explicit limit is still honored when resources permit; exhaustion returns the documented structured resource error rather than changing formats midway.

The renderer never implicitly flattens an array, stringifies a nested value to make a table fit, unions unrelated object keys, or drops null/missing distinctions. A user who wants tabular output can make the jaq program emit homogeneous flat objects, for example:

```bash
debug-mode query \
  --session 4ca86a \
  --run-id baseline \
  'select(.hypothesisId == "H1")
   | {sequence, timestamp, location, message, durationMs: .data.durationMs}'
```

```text
RESULTS  2 values

SEQUENCE  TIMESTAMP      LOCATION         MESSAGE           DURATION_MS
1042      1784313728231  src/cache.ts:84  Cache completed   18
1051      1784313729104  src/cache.ts:84  Cache completed   27
```

A scalar-producing program uses an indexed value table:

```bash
debug-mode query \
  --session 4ca86a \
  --run-id baseline \
  'select(.hypothesisId == "H1") | .data.durationMs'
```

```text
RESULTS  3 values

INDEX  VALUE
1      18
2      27
3      null
```

A nested object remains structured:

```bash
debug-mode query \
  --session 4ca86a \
  --run-id baseline \
  'select(.sequence == 1042) | {source: {location, hypothesisId}, payload: .data}'
```

```text
RESULT 1 OF 1
{
  "source": {
    "location": "src/cache.ts:84",
    "hypothesisId": "H1"
  },
  "payload": {
    "cacheKey": "cart:42",
    "hit": false,
    "durationMs": 18
  }
}
```

An array is preserved as one array value rather than being flattened into rows:

```bash
debug-mode query \
  --session 4ca86a \
  --run-id baseline \
  --slurp \
  'map(.location) | unique'
```

```text
RESULT 1 OF 1
[
  "src/cache.ts:84",
  "src/cache.ts:91"
]
```

The actual next-page hint repeats the scoped jaq program and options, or uses an opaque cursor that securely retains them. Query warnings summarize malformed records and direct the agent to `status`; `status` owns the complete diagnostic list.

Use `--cursor <opaque-cursor>` for query pagination. Do not expose line-number pagination or encourage requests such as “read the 1000th line”; line positions are unstable and require unnecessary parsing.

#### `debug-mode status`

`status` reports CLI, daemon, session, run, ingestion, query-engine, and evidence health. Unlike `logs` and `query`, it returns complete diagnostics for malformed records and structurally valid records with undeclared hypothesis IDs. A malformed record is not assigned an event `sequence`; status does not pretend that physical NDJSON lines and accepted-event sequence numbers are equivalent.

The primary pretty output makes the required action unmistakable:

```text
WARNING  3 malformed records require investigation.

STATUS   Session 4ca86a  •  Run baseline
         Daemon healthy  •  Ingestion degraded  •  Query engine ready

EVIDENCE Total 12,500  •  Valid 12,497  •  Malformed 3

MALFORMED RECORDS

  malformed_01  INVALID_JSON
  Source         src/cache.ts:84  •  Hypothesis H2
  Problem        Unexpected token after the data field.
  Preview        {"runId":"baseline", ...
  Fix            Inspect the generated probe for unsafe manual serialization.

ACTION   Fix every listed probe or helper, then clear and reproduce this run.
         Never edit the evidence file.

Clear    debug-mode clear --session 4ca86a --run-id baseline
```

With `--json`, the same status result is:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "partial": false,
  "command": "status",
  "scope": {
    "sessionId": "4ca86a",
    "runId": "baseline"
  },
  "warnings": [
    {
      "code": "MALFORMED_RECORDS",
      "message": "3 malformed records require investigation before drawing conclusions."
    }
  ],
  "statistics": {
    "totalRecords": 12500,
    "validRecords": 12497,
    "malformedRecords": 3
  },
  "data": {
    "daemon": {
      "status": "running"
    },
    "ingestion": {
      "status": "degraded"
    },
    "queryEngine": {
      "status": "ready",
      "implementation": "jaq"
    },
    "malformedRecords": [
      {
        "diagnosticId": "malformed_01",
        "reason": "INVALID_JSON",
        "message": "Unexpected token after the data field.",
        "observedAt": 1784313600000,
        "recoverable": {
          "runId": "baseline",
          "hypothesisId": "H2",
          "location": "src/cache.ts:84"
        },
        "redactedPreview": "{\"runId\":\"baseline\", ...",
        "suggestedAction": "Inspect the generated probe at src/cache.ts:84 for unsafe manual serialization, correct it, clear this run, and reproduce."
      }
    ]
  },
  "hints": [
    {
      "action": "fix-malformed-ingestion",
      "message": "Fix the listed probe or helper sources; never edit the evidence file. Then clear and reproduce the affected run.",
      "command": "debug-mode clear --workspace /absolute/project/path --session 4ca86a --run-id baseline --json"
    }
  ]
}
```

Malformed diagnostics contain a stable diagnostic ID, reason, readable parser or schema message, observation time, safely recoverable event fields, a bounded redacted preview, and a specific suggested action. They do not expose the evidence path, physical line number, byte offset, secrets, or an arbitrary raw record. If no source location is recoverable, the action tells the agent to inspect the CLI-generated helper for the affected language and run a control probe.

Undeclared-hypothesis diagnostics contain the unexpected ID, count, affected event IDs and locations, and declared IDs for comparison. They instruct the agent to correct the probe when the ID is a typo, or declare the new hypothesis on a new run. The existing run's declaration is immutable so evidence is not reclassified after collection.

Text mode prints all malformed and undeclared-hypothesis diagnostics before the remaining health summary, then explicitly prompts the agent to fix the emitting helper or probe, clear the affected run, and reproduce. It must never suggest repairing, deleting, or manually reading the NDJSON file.

#### Other lifecycle commands

| Command                                                                                          | Purpose                                                            |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `debug-mode run begin --session 4ca86a --run-id post-fix --hypothesis H1 --hypothesis H2 --json` | Start a distinct verification run and declare its hypotheses       |
| `debug-mode clean --session 4ca86a --json`                                                       | Remove the current session's persisted evidence after confirmation |
| `debug-mode stop --session 4ca86a --json`                                                        | Close the session; stop the daemon only when no sessions need it   |
| `debug-mode daemon stop --json`                                                                  | Explicit human/admin shutdown of the user daemon                   |
| `debug-mode ui --workspace "$PWD"`                                                               | Future command that opens or prints the local UI URL               |

Commands should use semantic exit codes:

| Exit | Meaning                                   |
| ---- | ----------------------------------------- |
| `0`  | Success                                   |
| `2`  | Invalid arguments or unsupported language |
| `3`  | CLI/daemon version incompatibility        |
| `4`  | Daemon unavailable or failed to start     |
| `5`  | Session not found or workspace mismatch   |
| `6`  | Evidence malformed or unreadable          |

### 2.4 Session selection

`debug-mode start --json` returns the authoritative session ID. The Agent Skill retains it and passes `--session <id>` to every subsequent `clear`, `logs`, `query`, `run`, `status`, `clean`, and `stop` command.

```bash
debug-mode query \
  --session 4ca86a \
  --run-id baseline \
  'select(.hypothesisId == "H1")'
```

The CLI may infer a session from `--workspace` only when exactly one matching session exists. It must never select a global “latest session.”

If multiple sessions match and `--session` is absent, return an error without reading evidence. Pretty mode lists the candidates and prints `Re-run with --session <id>`. With `--json`, return:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "SESSION_AMBIGUOUS",
    "message": "Multiple debug sessions match this workspace",
    "candidates": [
      { "id": "4ca86a", "runId": "baseline" },
      { "id": "91bd20", "runId": "post-fix" }
    ],
    "hint": "Re-run with --session <id>"
  }
}
```

`debug-mode sessions --workspace "$PWD" --json` lists sessions when the caller needs to recover context. The CLI verifies that an explicit session belongs to the resolved workspace and current user before executing the command.

### 2.5 Pretty output and JSON output

Pretty output is the primary interface for agents and humans reading `logs`, `query`, and `status`. It is stable enough to scan, but callers must follow its labels and suggested commands rather than scrape it as an undocumented wire format.

`--json` is the versioned automation API for integrations, scripts, and cases where an agent must copy exact generated templates or consume large structured values. Every JSON response includes `schemaVersion`, `ok`, and either a typed result or a structured error with `code`, `message`, and optional recovery guidance.

## 3. Compiled binary and distribution

The CLI and daemon are two modes of the same Bun-compiled executable:

```bash
bun build --compile src/cli.ts --outfile dist/debug-mode
```

Each target directly requires its matching `napi-rs` `.node` addon at build time. Bun embeds directly required N-API addons into compiled executables, so the installed artifact remains one standalone `debug-mode` binary rather than a binary plus a native sidecar. Build the Rust addon for the same OS and architecture before compiling each Bun target.

Release automation cross-compiles and tests at least:

| Platform            | Bun target         |
| ------------------- | ------------------ |
| macOS Apple Silicon | `bun-darwin-arm64` |
| macOS Intel         | `bun-darwin-x64`   |
| Linux ARM64         | `bun-linux-arm64`  |
| Linux x64           | `bun-linux-x64`    |
| Windows x64         | `bun-windows-x64`  |

Use baseline x64 targets when broad older-CPU compatibility matters. A compiled user does not need Bun installed.

### 3.1 Release artifacts

GitHub Releases should be the canonical artifact source:

```text
debug-mode-v1.2.3-darwin-arm64.tar.gz
debug-mode-v1.2.3-darwin-x64.tar.gz
debug-mode-v1.2.3-linux-arm64.tar.gz
debug-mode-v1.2.3-linux-x64.tar.gz
debug-mode-v1.2.3-windows-x64.zip
checksums.txt
checksums.txt.sig
```

Pin the Bun version in CI, generate SHA-256 checksums, sign releases, produce an SBOM, and test each artifact on its target OS before publication.

### 3.2 npm and npx

Publish the npm meta-package as `agentic-debug-mode`. Its `bin` entry is a launcher that selects an OS/architecture-specific optional package containing the compiled executable and forwards arguments and signals to it.

The launcher is packaging glue; the actual CLI and daemon remain the Bun-compiled binary. Keep the launcher dependency-free and fail with a precise unsupported-platform or missing-optional-package message. Do not download an executable at runtime without integrity verification.

This supports:

```bash
npx --yes agentic-debug-mode@latest start --language typescript --json
npm install --global agentic-debug-mode
bun install --global agentic-debug-mode
```

### 3.3 Homebrew and other package managers

The Homebrew formula downloads the matching release archive and verifies its checksum. It must not build from TypeScript or require Bun on the user's machine.

Other platform packages—Scoop or WinGet on Windows, and deb/rpm repositories on Linux—should consume the same release artifacts. Keeping one artifact pipeline prevents package-manager builds from behaving differently.

### 3.4 Version compatibility

The CLI owns daemon upgrades. On each command it compares CLI and daemon protocol versions:

- compatible version: reuse the daemon;
- older compatible daemon: request graceful restart;
- incompatible daemon: stop it through the authenticated control channel and start the current executable in daemon mode;
- active sessions that cannot migrate safely: return exit `3` with recovery guidance.

The Agent Skill should never reason about this lifecycle.

### 3.5 Publishing through the Skills ecosystem

The CLI and skill have separate distribution paths:

- `npx agentic-debug-mode` runs the compiled CLI from npm.
- `npx skills add <owner>/debug-mode --skill agentic-debug-mode` installs the skill from a public Git repository.

The skill is not another npm package. Store it at:

```text
skills/agentic-debug-mode/SKILL.md
```

Users can inspect and install it with:

```bash
npx skills add <owner>/debug-mode --list
npx skills add <owner>/debug-mode --skill agentic-debug-mode --agent cursor --global
```

Use `--agent '*'` for all detected agents, omit `--global` for project scope, and add `--yes` for non-interactive installation. Public GitHub installations report the discovered skill path to the Skills ecosystem, enabling directory discovery and install counts.

## 4. Event contract

Use one JSON object per line:

```json
{
  "schemaVersion": 1,
  "sessionId": "4ca86a",
  "runId": "baseline",
  "hypothesisId": "H2",
  "id": "evt_01J...",
  "timestamp": 1784310000123,
  "location": "src/cart.ts:84",
  "message": "Discount branch selected",
  "data": { "ruleCount": 2, "subtotal": 9000 }
}
```

### Required fields

| Field           | Meaning                                                       |
| --------------- | ------------------------------------------------------------- |
| `schemaVersion` | Event schema version, initially `1`                           |
| `sessionId`     | Routes and isolates the event                                 |
| `runId`         | Distinguishes reproductions such as `baseline` and `post-fix` |
| `hypothesisId`  | Links a probe to one declared hypothesis                      |
| `timestamp`     | Unix epoch milliseconds                                       |
| `location`      | Stable source location, preferably `path:line`                |
| `message`       | Short, constant event description                             |
| `data`          | Structured, redacted observations                             |

`id` is recommended for deduplication. The collector may add it when a client does not.

### Data rules

- Use a native JSON serializer. Never build JSON through string interpolation.
- Keep `message` constant and put changing values in `data`.
- Log identifiers only when they are synthetic or redacted.
- Never log passwords, tokens, cookies, authorization headers, private keys, full request bodies, or unrelated personal data.
- Bound strings, arrays, and object depth. Debug logging must not become a data-exfiltration path.
- A failed probe must not change application control flow. Best-effort delivery is appropriate; silent loss should still be observable through missing expected events.

## 5. Probe region separators

The separators are a source-editing contract, not part of NDJSON. They make instrumentation:

- visually distinct;
- foldable where the editor supports regions;
- mechanically removable after verification;
- auditable, because cleanup can target complete blocks rather than individual lines.

The marker requirement belongs in the `SKILL.md`. If it appears only in an implementation or cleanup script, the agent may emit unbounded probes that cannot be removed safely.

Use the canonical label `agent log`. Examples:

```typescript
// #region agent log
void fetch(ingestUrl, {
  /* probe request */
}).catch(() => {});
// #endregion
```

```python
# region agent log
_append_debug_event({...})
# endregion
```

The exact spelling must match the cleanup parser. Do not claim that every editor folds every marker; searchability and deterministic removal are the portable guarantees.

### Marker matrix

| Language/file type                    | Open                         | Close                 |
| ------------------------------------- | ---------------------------- | --------------------- |
| JavaScript, TypeScript, JSX, TSX      | `// #region agent log`       | `// #endregion`       |
| Go, Rust, Java, Kotlin, Swift, C, C++ | `// #region agent log`       | `// #endregion`       |
| C#                                    | `#region agent log`          | `#endregion`          |
| Python                                | `# region agent log`         | `# endregion`         |
| Ruby, shell, YAML, TOML               | `# region agent log`         | `# endregion`         |
| PowerShell                            | `#region agent log`          | `#endregion`          |
| HTML, XML, Vue/Svelte template        | `<!-- #region agent log -->` | `<!-- #endregion -->` |
| CSS, SCSS, Less                       | `/* #region agent log */`    | `/* #endregion */`    |
| SQL, Lua, Haskell                     | `-- #region agent log`       | `-- #endregion`       |
| PHP                                   | `// #region agent log`       | `// #endregion`       |

Generated files and formats that do not safely permit comments should not be instrumented directly. Probe the code that produces or consumes them.

## 6. Probe renderer internals

The CLI chooses transport by **runtime reachability**, not merely by programming language. This section specifies the renderer behind `debug-mode start` and `debug-mode probe`; it is not operational knowledge the Agent Skill must reproduce.

| Runtime                                                  | Preferred transport                                             | Reason                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| Browser, extension page, WebView, service worker         | HTTP `fetch` to loopback or same-origin relay                   | No filesystem access                                           |
| JavaScript/TypeScript in Node, Bun, or Deno              | HTTP `fetch` by default                                         | One consistent JS/TS probe shape across client and server      |
| Local Python, Go, Rust, Java, .NET, Ruby, PHP, Swift CLI | Direct NDJSON append                                            | No collector dependency; standard file APIs                    |
| Highly concurrent local service on the same filesystem   | Direct NDJSON append through one helper                         | No process spawn; one bounded append per event                 |
| Container, VM, SSH host, mobile device                   | Reachable collector or existing telemetry channel               | Its filesystem and `localhost` are not the developer host's    |
| Serverless/edge runtime                                  | Existing structured logs or remote-safe collector               | Local files and loopback are ephemeral or unavailable          |
| SQL/stored procedure                                     | Instrument the calling application or approved database logging | Arbitrary file/network access is usually unsafe or unavailable |
| WebAssembly                                              | Host-provided HTTP/log function                                 | WASM capabilities come from the host                           |

Cursor-style Debug Mode commonly uses `fetch` for JavaScript and TypeScript even when filesystem access exists. This gives the renderer one predictable template and lets the daemon enforce session IDs, payload limits, and NDJSON formatting.

For other local languages, direct append is the default. It avoids process creation, dependencies, and network setup. HTTP remains preferable when the runtime cannot access the session path or does not share the developer host's filesystem.

Every renderer returns:

1. `helperTemplate` — inserted once per runtime boundary. It owns transport, session configuration, serialization, limits, and failure suppression.
2. `callTemplate` — inserted once per observation and containing only hypothesis, location, message, and safe scalar data.

Both templates include their own `agent log` region markers. The agent must not reconstruct transport code from this reference.

## 7. JavaScript and TypeScript: HTTP ingestion

`debug-mode start --language typescript --json` returns this transport as a ready-to-adapt template. In browser-delivered code, the generated endpoint and capability are session-scoped temporary instrumentation; they must not become permanent application configuration.

```typescript
// #region agent log
void fetch("http://127.0.0.1:7284/ingest/<session-key>", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Debug-Session-Id": "4ca86a",
  },
  body: JSON.stringify({
    schemaVersion: 1,
    sessionId: "4ca86a",
    runId: "baseline",
    hypothesisId: "H1",
    location: "src/cart.ts:84",
    message: "Before discount calculation",
    data: { itemCount: items.length, subtotal },
    timestamp: Date.now(),
  }),
}).catch(() => {});
// #endregion
```

Important details:

- Use `void fetch(...)` or otherwise intentionally discard the promise when the probe must not delay application behavior.
- Do not use `await` solely for a debug probe; it changes timing and can hide a race.
- Keep the collector on loopback. Configure CORS narrowly.
- If Content Security Policy blocks loopback requests, use a development same-origin proxy or an existing application logging endpoint designed for local debugging.
- For Node versions without global `fetch`, use the runtime's standard HTTP client or direct append. Do not add a production dependency only for temporary probes.

## 8. Direct append contract

For direct file ingestion, generate one helper function before adding probe calls. The helper should:

1. Open the exact session log in append mode, preferably once per application process.
2. Accept only scalar `data` values: string, integer, float, boolean, or null.
3. Serialize the complete event with the language's standard JSON library.
4. Add exactly one newline.
5. Bound the encoded record size.
6. Perform one append write for the complete record.
7. Swallow probe-only serialization and I/O errors.
8. Close the descriptor when the process exits.

Do not open a subprocess, create a thread, or create a queue for this helper. A typical event costs one JSON serialization and one append write.

Append mode avoids writers overwriting earlier bytes. A single bounded write is reliable for ordinary local debugging but does not provide a universal cross-process atomicity guarantee on every filesystem. Use HTTP for network filesystems, remote runtimes, or records that cannot fit in one bounded write.

The snippets below are renderer implementation references. CLI output must wrap the transport in a reusable helper and return lightweight call sites separately.

### Python

```python
# region agent log
import atexit
import json
import os
import time

_debug_fd = os.open(DEBUG_LOG_PATH, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
atexit.register(os.close, _debug_fd)


def debug_emit(
    hypothesis_id: str,
    location: str,
    message: str,
    data: dict[str, str | int | float | bool | None],
) -> None:
    try:
        if any(not isinstance(key, str) for key in data):
            return
        if any(
            value is not None and not isinstance(value, (str, int, float, bool))
            for value in data.values()
        ):
            return

        payload = json.dumps(
            {
                "schemaVersion": 1,
                "sessionId": DEBUG_SESSION_ID,
                "runId": DEBUG_RUN_ID,
                "hypothesisId": hypothesis_id,
                "location": location,
                "message": message,
                "data": data,
                "timestamp": int(time.time() * 1000),
            },
            allow_nan=False,
            separators=(",", ":"),
        ).encode() + b"\n"

        if len(payload) <= 16_384:
            os.write(_debug_fd, payload)
    except (OSError, TypeError, ValueError):
        pass
# endregion
```

The call template remains small:

```python
# region agent log
debug_emit(
    "H1",
    "app/cart.py:42",
    "Before discount calculation",
    {"itemCount": len(items), "subtotal": subtotal},
)
# endregion
```

### Go

```go
event := map[string]any{
	"schemaVersion": 1,
	"sessionId": "4ca86a",
	"runId": "baseline",
	"hypothesisId": "H1",
	"location": "cart/cart.go:57",
	"message": "Before discount calculation",
	"data": map[string]any{"itemCount": len(items), "subtotal": subtotal},
	"timestamp": time.Now().UnixMilli(),
}
if encoded, err := json.Marshal(event); err == nil {
	if log, err := os.OpenFile(debugLogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
		_, _ = log.Write(append(encoded, '\n'))
		_ = log.Close()
	}
}
```

Imports belong at the top of the file: `encoding/json`, `os`, and `time`.

### Rust

Use the project's JSON serializer, normally `serde_json`, and `std::fs::OpenOptions`:

```rust
let event = serde_json::json!({
    "schemaVersion": 1,
    "sessionId": "4ca86a",
    "runId": "baseline",
    "hypothesisId": "H1",
    "location": "src/cart.rs:61",
    "message": "Before discount calculation",
    "data": {"itemCount": items.len(), "subtotal": subtotal},
    "timestamp": SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default(),
});
if let (Ok(mut log), Ok(mut line)) = (
    OpenOptions::new().create(true).append(true).open(debug_log_path),
    serde_json::to_vec(&event),
) {
    line.push(b'\n');
    let _ = log.write_all(&line);
}
```

Put `OpenOptions`, `Write`, `SystemTime`, and `UNIX_EPOCH` imports at module scope.

### Java

Java's standard library does not include a general JSON serializer. Reuse the application's Jackson, Gson, or JSON-P dependency rather than hand-escaping JSON. With Jackson:

```java
Map<String, Object> event = Map.of(
    "schemaVersion", 1,
    "sessionId", "4ca86a",
    "runId", "baseline",
    "hypothesisId", "H1",
    "location", "src/main/java/Cart.java:73",
    "message", "Before discount calculation",
    "data", Map.of("itemCount", items.size(), "subtotal", subtotal),
    "timestamp", System.currentTimeMillis()
);
try {
    String line = objectMapper.writeValueAsString(event) + System.lineSeparator();
    Files.writeString(debugLogPath, line, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
} catch (IOException ignored) {
}
```

### Kotlin

Use the serializer already present in the project: `kotlinx.serialization`, Jackson, Gson, or Moshi. On the JVM, append the serialized line with `Files.writeString(..., CREATE, APPEND)` as in Java. Do not introduce a second JSON stack for temporary instrumentation.

### C# and other .NET languages

```csharp
var payload = new {
    schemaVersion = 1,
    sessionId = "4ca86a",
    runId = "baseline",
    hypothesisId = "H1",
    location = "Cart.cs:49",
    message = "Before discount calculation",
    data = new { itemCount = items.Count, subtotal },
    timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
};
try {
    File.AppendAllText(debugLogPath, JsonSerializer.Serialize(payload) + Environment.NewLine);
} catch (IOException) {
}
```

Use `System.Text.Json`; imports belong at the top of the file.

### C and C++

Neither language has a standard JSON serializer. Reuse the project's JSON library. Serialize the whole event first, append `\n`, then open with `O_WRONLY | O_CREAT | O_APPEND` and issue one `write` call. Use restrictive file permissions such as `0600`.

Do not use `printf` with manually escaped values. If the project has no JSON library, HTTP to the collector may be safer than adding temporary serialization code.

### Ruby

```ruby
event = {
  schemaVersion: 1,
  sessionId: "4ca86a",
  runId: "baseline",
  hypothesisId: "H1",
  location: "lib/cart.rb:38",
  message: "Before discount calculation",
  data: { itemCount: items.length, subtotal: subtotal },
  timestamp: (Time.now.to_f * 1000).to_i
}
begin
  File.open(debug_log_path, "a", 0o600) { |log| log.write(JSON.generate(event) + "\n") }
rescue SystemCallError
end
```

Require `json` at the top of the file.

### PHP

```php
$event = [
    'schemaVersion' => 1,
    'sessionId' => '4ca86a',
    'runId' => 'baseline',
    'hypothesisId' => 'H1',
    'location' => 'src/Cart.php:41',
    'message' => 'Before discount calculation',
    'data' => ['itemCount' => count($items), 'subtotal' => $subtotal],
    'timestamp' => (int) floor(microtime(true) * 1000),
];
@file_put_contents(
    $debugLogPath,
    json_encode($event, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . PHP_EOL,
    FILE_APPEND | LOCK_EX
);
```

Catch `JsonException` if the surrounding code does not already handle it.

### Swift

Use an `Encodable` event and `JSONEncoder`, append a newline to the encoded `Data`, then write with `FileHandle(forWritingTo:)` after seeking to the end. `FileHandle` does not provide a portable multi-process append guarantee; prefer HTTP or OS logging for concurrent applications.

On iOS, the developer machine's `127.0.0.1` is not the device's loopback. Use a reachable development host, simulator-specific routing, an app-owned file that can be retrieved, or existing telemetry.

### Shell

Use `jq` to serialize values safely:

```bash
jq -cn \
  --arg sessionId "4ca86a" \
  --arg runId "baseline" \
  --arg hypothesisId "H1" \
  --arg location "scripts/reprice.sh:27" \
  --arg message "Before discount calculation" \
  --argjson subtotal "$subtotal" \
  '{schemaVersion:1,$sessionId,$runId,$hypothesisId,$location,$message,data:{subtotal:$subtotal},timestamp:(now*1000|floor)}' \
  >> "$DEBUG_LOG_PATH" 2>/dev/null || true
```

Do not interpolate arbitrary values into a handwritten JSON string.

### PowerShell

```powershell
$event = @{
    schemaVersion = 1
    sessionId = "4ca86a"
    runId = "baseline"
    hypothesisId = "H1"
    location = "scripts/Reprice.ps1:31"
    message = "Before discount calculation"
    data = @{ subtotal = $subtotal }
    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}
try {
    ($event | ConvertTo-Json -Compress -Depth 6) |
        Add-Content -LiteralPath $debugLogPath -Encoding utf8
} catch {
}
```

### Lua

Lua has no standard JSON encoder. Reuse `cjson`, `dkjson`, or the host application's encoder, then append the encoded value and `\n` with `io.open(path, "a")`. For embedded Lua, prefer the host application's logging callback.

### SQL and stored procedures

There is no portable, safe direct-append recipe. File APIs and outbound HTTP are database-specific and often privileged. Prefer, in order:

1. Probe the application immediately before and after the query.
2. Add a temporary query tag or correlation ID and inspect approved database logs.
3. Insert into a dedicated temporary debug table with bounded, non-sensitive columns when the user authorizes database mutation.
4. Use a database-specific notice facility such as PostgreSQL `RAISE NOTICE` only when its output is capturable.

Do not enable privileged file or network extensions merely to support an agent probe.

## 9. Daemon architecture

`debug-mode start` spawns the same executable in an internal daemon mode when no compatible daemon is healthy. With Bun, the CLI can use a detached `Bun.spawn` and the daemon can use `Bun.serve`.

The daemon is user-scoped and multiplexes workspace sessions. A single process makes port ownership, upgrades, live viewing, and a future UI simpler than one server per project.

```text
Agent
  │ pretty commands by default; JSON on request
  ▼
debug-mode CLI
  │ authenticated local control API
  ▼
user-scoped daemon
  ├── session registry
  ├── probe template renderer
  ├── HTTP ingestion
  ├── NDJSON persistence
  ├── malformed-record diagnostics
  ├── napi-rs bridge
  ├── embedded jaq query service
  └── live event bus ──► future browser UI
```

### 9.1 Process and state ownership

Store daemon state in the platform user-data directory, not the repository:

```text
<user-data>/debug-mode/
├── daemon.json        # PID, port, protocol version, startup nonce
├── control.token      # user-only permissions
└── sessions/
    └── <session-id>/
        ├── session.json
        ├── runs.json
        └── events.ndjson
```

`runs.json` stores immutable run metadata, including declared hypothesis IDs. It contains no raw evidence.

`daemon.json` is not proof that the process is alive. The CLI must authenticate to a health/control endpoint and verify PID identity, protocol version, and startup nonce before reusing or stopping a process.

Workspace paths are canonicalized and mapped to session IDs. Commands accept workspace/session identifiers, never arbitrary evidence-file paths.

### 9.2 HTTP ingestion

The daemon should:

- bind to `127.0.0.1` or `::1` by default and use an OS-assigned port;
- use an unguessable per-session capability in generated probes;
- require and verify session routing;
- accept JSON and optionally NDJSON;
- enforce a small request-body limit and bounded field sizes;
- redact or reject known secret-shaped keys;
- classify an undeclared `hypothesisId` as abnormal without treating otherwise valid JSON as malformed;
- append one normalized NDJSON line per accepted event;
- assign monotonic receipt sequence numbers;
- return quickly, preferably `202 Accepted`;
- never expose the control token in probe templates;
- never be exposed as a production endpoint.

For browser probes, CORS should allow only required development origins. `Access-Control-Allow-Origin: *` is inappropriate when the collector accepts sensitive local events.

### 9.3 Direct-append observation

Local-language helpers write directly to the session NDJSON file, so the daemon must observe active files as well as HTTP ingestion. Track a byte offset per session, parse newly completed lines, validate the event schema, assign receipt metadata, and publish accepted records to the same internal event bus used by HTTP.

Incomplete trailing lines remain buffered until completed. Malformed records and undeclared hypothesis IDs are summarized by `debug-mode logs` and `debug-mode query`, then fully diagnosed by `debug-mode status`; neither condition is silently treated as trustworthy evidence. This keeps the future UI transport-independent.

### 9.4 Internal APIs

Reserve versioned routes from the beginning:

```text
POST /v1/ingest/<session-capability>   Probe ingestion
GET  /v1/control/health               Authenticated CLI health
POST /v1/control/sessions             Create/resume session
POST /v1/control/sessions/:id/clear   Clear active run
GET  /v1/control/sessions/:id/events  Query evidence
POST /v1/control/sessions/:id/query   Execute an embedded jaq program
GET  /v1/events/:sessionId            SSE live event stream
GET  /ui/*                            Optional static UI
```

The CLI is the supported public control interface. Internal HTTP routes may change within a compatible protocol version and should not appear in `SKILL.md`.

### 9.5 Optional real-time UI

Design the first daemon around an internal event bus even if no UI ships initially. After validating and persisting an event, publish it to subscribers. An SSE endpoint is sufficient for an initial read-only UI; WebSocket can be added later if interactive controls require bidirectional messages.

The future UI can provide:

- live event arrival by session and run;
- filtering by hypothesis, location, and message;
- baseline versus post-fix comparison;
- malformed or dropped-event diagnostics;
- daemon/session health;
- safe export of redacted evidence.

Keep UI assets and handlers in a separate module compiled into the binary. `data.capabilities.ui` tells the CLI and agent whether the feature exists. Adding the UI must not change `start`, `clear`, `logs`, or `stop`.

## 10. Query engine for large logs

NDJSON remains the portable source of truth. The query engine deliberately avoids a custom parser, SQL translation layer, and SQLite index. The schema is fixed and jaq already provides the required filtering, projection, regex, sorting, grouping, and aggregation semantics.

### 10.1 Embedded jaq

The platform-specific package contains a Rust `napi-rs` addon using `jaq-core`, `jaq-std`, and `jaq-json`. Bun loads the addon; the CLI resolves the private session source and calls one narrow native operation:

```text
query_ndjson(source, jaq_program, slurp, limit, cursor, timeout) -> QueryResult
```

The Rust implementation:

1. compiles the jaq program once;
2. reads only the resolved session and run;
3. parses NDJSON incrementally and records malformed diagnostics;
4. evaluates each valid event independently in streaming mode;
5. or builds one array and evaluates once in explicit slurp mode;
6. stops after the requested output limit or returns an opaque continuation cursor;
7. returns values, statistics, warnings, and resource errors to the Bun renderer.

The agent never receives the source path. The implementation uses the library API and never spawns a `jq` or `jaq` process. Pin compatible crate versions and treat jaq behavior as the query-language contract.

### 10.2 Streaming and slurp modes

Streaming mode is the default and keeps memory bounded by processing one event at a time. It is appropriate for `select`, projection, field comparison, string and regex matching, and transformations whose result depends on one event.

Slurp mode is explicit because it loads every valid record in the selected session and run into one array. It enables `sort_by`, `group_by`, `map`, `reduce`, and whole-run aggregates. The CLI never guesses that a program requires slurp and never retries automatically with it. A type error caused by a collection operation in streaming mode becomes `COLLECTION_REQUIRED` with a copyable `--slurp` command.

`--limit` defaults to `100`. An explicit positive limit may request any output count and is never silently clamped. The limit bounds returned jaq values, not input records scanned. If disk, memory, timeout, or operating-system constraints prevent completion, return a structured resource error with scanned, valid, malformed, produced, and returned counts.

### 10.3 Safety and continuation

The embedded environment supplies only the jaq core, standard, and JSON definitions needed to transform provided values. It does not expose host paths, environment variables, module search paths, network operations, or process execution.

Apply execution controls at the host boundary:

- bound program and regex source length;
- use a configurable timeout or cancellation budget;
- preserve the event contract's bounded fields;
- stream output serialization instead of building an unbounded Node array;
- redact malformed previews before returning them;
- keep session and workspace resolution outside Rust;
- return compile and runtime errors with jaq source spans and a corrective hint.

For streaming queries, an opaque cursor contains authenticated session/run identity, the source snapshot watermark, source byte position, output ordinal, program hash, and limit. It reveals no physical path. Slurp queries may page the produced result, but each continuation remains tied to the same source snapshot and program hash.

### 10.4 Malformed-record diagnostics

Malformed records do not receive accepted-event sequence numbers. The daemon persists a compact private diagnostic record containing a diagnostic ID, run, observation time, reason, safely recoverable fields, redacted preview, and private source offset. `logs` and `query` report malformed counts; `status` returns every agent-safe diagnostic and tells the agent to fix the emitter and reproduce.

### 10.5 Agent isolation

Raw evidence paths are internal. The agent uses:

- `debug-mode logs` for small bounded reads;
- `debug-mode query` for filtering, projection, grouping, aggregation, ordering, and pagination;
- `debug-mode status` to diagnose query-engine health and inspect every malformed-record diagnostic with corrective guidance.

The skill explicitly forbids native file readers, shell commands, `tail`, `sed`, `awk`, direct `jq`/`jaq` processes, and ad hoc scripts for reading Debug Mode evidence. This protects the context window, keeps malformed-record handling consistent, and prevents accidental access to another session.

## 11. A complete `SKILL.md`

The following skill is intentionally operational. It knows only the CLI contract. Language transport, daemon startup, raw paths, ports, and authentication remain CLI implementation details.

```markdown
---
name: agentic-debug-mode
description: Use when diagnosing a bug, regression, race condition, unexpected state, or behavior whose root cause has not been proven with runtime evidence
---

# Debugging with Runtime Evidence

## Core rule

Source code creates hypotheses. Runtime evidence confirms or rejects them.

Do not implement a bug fix before collecting runtime evidence that identifies the cause.

## Resolve the CLI

Run `debug-mode --version`.

If `debug-mode` is unavailable, install the published CLI using the first
supported channel available in the environment, subject to the host's package
installation approval policy:

1. Homebrew on macOS: `brew install agentic-debug-mode`
2. npm: `npm install --global agentic-debug-mode`
3. Bun: `bun install --global agentic-debug-mode`
4. Zero-install fallback: use
   `npx --yes agentic-debug-mode@latest` as the command prefix

Never use an unverified `curl | sh`, request elevated privileges, or edit shell
startup files. After installation, run `debug-mode --version` again. Stop and
report the installation error if no supported command works.

Use pretty output for evidence-viewing commands. Use `--json` when a command
returns exact generated templates or when a programmatic integration requires
the versioned JSON contract.

## Start the session

Run:

`debug-mode start --workspace <project-root> --language <language> --run-id baseline --hypothesis H1 --hypothesis H2 --json`

Repeat `--hypothesis` for every hypothesis declared for the run.

The command starts or reuses the daemon, creates the session, and returns
language-specific `data.instrumentation.helperTemplate` and
`data.instrumentation.callTemplate`. Stop if `ok` is false,
`data.daemon.status` is not `running`, or either template is absent.

Retain the returned `scope.sessionId`. Pass `--session <scope.sessionId>` to every
subsequent Debug Mode command. Never rely on a global latest session; if context
is lost, recover it with `debug-mode sessions --workspace <project-root> --json`.

Insert `helperTemplate` once per runtime boundary. Treat its transport code as
opaque. For every observation, copy `callTemplate` and replace only the
placeholders listed in `data.instrumentation.replace`. Preserve session fields,
serialization, payload limits, failure handling, and region markers exactly.

For another language, run:

`debug-mode probe --language <language> --json`

Do not start, inspect, or stop the underlying HTTP server directly. Do not
manually read, truncate, delete, or write Debug Mode files outside the returned
helper.

## Evidence access

Use only `debug-mode logs`, `debug-mode query`, and `debug-mode status` to read
runtime evidence.

Never use native file-reading tools, shell commands, `tail`, `sed`, `awk`, or
ad hoc scripts to inspect Debug Mode NDJSON. Never request a specific physical
line number.

Use pretty output by default: `debug-mode logs --limit 100` for a small bounded
sample, `debug-mode query` for filtering or transformation, and
`debug-mode status` for health and malformed diagnostics. Use `--json` only
when exact machine-readable fields or generated templates are needed.

For every pretty result, read warnings first, verify the displayed session and
run, inspect statistics, and follow the copyable commands printed under the
result. Follow returned pagination hints instead of reconstructing commands
because the CLI preserves the jaq program, scope, and snapshot state. In JSON
mode, the equivalent fields are `warnings`, `partial`, `scope`, `statistics`,
and `hints`.

If `logs` or `query` reports malformed records, run `debug-mode status` with
the same workspace, session, and run. Review every returned malformed-record
diagnostic. Fix the emitting probe or generated helper indicated by the
diagnostic, never the evidence file. Clear the affected run and reproduce
before using its evidence to confirm or reject a hypothesis.

Query uses an embedded jaq program, for example:

`debug-mode query --session <session-id> --run-id <run-id> 'select(.message | test("timeout|deadline"; "i"))'`

Use `--slurp` explicitly for operations across records such as `sort_by` and
`group_by`. Do not invoke `jq` or `jaq` directly; the CLI owns session
selection, source isolation, execution limits, pagination, and malformed-record
handling.

## Workflow

1. State expected behavior, actual behavior, and the shortest reproduction.
2. Generate three to five precise, falsifiable hypotheses labeled `H1`, `H2`, etc.
3. Start the run with every hypothesis ID declared, then obtain the
   CLI-generated helper/call templates for each instrumented runtime.
4. Insert one helper per runtime boundary before adding any probe calls.
5. Add one to ten lightweight probe calls that evaluate all hypotheses in parallel.
6. Replace only declared call-template placeholders. Map every probe to a
   `hypothesisId`.
7. Run `debug-mode clear --workspace <project-root> --session <session-id> --run-id baseline --json`.
8. Ask the user to reproduce, including required restart instructions.
9. Read a bounded result with `debug-mode logs`, or use `debug-mode query` when
   the session requires filtering, grouping, aggregation, or pagination.
10. Inspect result warnings, completeness, scope, statistics, and hints. If any
    malformed records exist, run `debug-mode status`, fix the listed emitters,
    clear the affected run, and reproduce before classifying evidence.
11. Classify every hypothesis:

- `CONFIRMED` — events directly demonstrate the proposed causal path.
- `REJECTED` — events contradict the hypothesis.
- `INCONCLUSIVE` — expected evidence is absent or ambiguous.

12. Cite event IDs, sequence numbers, or returned entry indexes for every classification.
13. If none is confirmed, form new hypotheses from different subsystems and add probes.
14. Implement only the smallest fix supported by confirmed evidence.
15. Keep the helper and every existing probe call unchanged for verification.
16. Run `debug-mode run begin --session <session-id> --run-id post-fix --json`,
    then `debug-mode clear --session <session-id> --run-id post-fix --json`.
17. Reproduce again and read the post-fix evidence through `debug-mode logs` or
    the same `debug-mode query` used for baseline.
18. Compare baseline and post-fix evidence.
19. Remove helper and probe-call regions only after post-fix evidence succeeds
    and the user confirms the behavior.
20. Run `debug-mode stop --workspace <project-root> --session <session-id> --json`. Delete persisted evidence with `debug-mode clean --session <session-id>` only when requested.

When a hypothesis is rejected, remove speculative code changes made for it. Do not accumulate defensive changes without evidence.

## Probe event

The generated template emits:

`schemaVersion`, `sessionId`, `runId`, `hypothesisId`, `timestamp`,
`location`, `message`, and `data`.

Use a constant `message`; put observed values in `data`. Never put secrets,
credentials, tokens, cookies, authorization headers, private keys, full request
bodies, or unrelated personal data into placeholders.

## Mandatory probe boundaries

The returned helper and every call template contain complete `agent log`
regions. Preserve all opening and closing markers. Keep the helper in its own
region and one logical observation per call region.

Do not place production behavior inside a probe region. Do not instrument
generated files or files in which the returned markers are invalid.

## Helper transport

Use the transport selected by the CLI:

- Browser, Node.js, Bun, and Deno helpers use non-blocking HTTP.
- Local non-JavaScript helpers append bounded NDJSON records directly to the
  exact session path.
- Remote, sandboxed, serverless, and non-shared-filesystem runtimes use a
  reachable HTTP or existing telemetry transport.

Do not replace a returned helper with subprocess creation, threads, queues, or
custom serialization. Local append helpers should keep one append descriptor
per process where the language makes that simple, accept scalar `data` only,
and perform one bounded write per event.

## Probe placement

Prefer the minimum set covering:

- function entry and sanitized parameters;
- state immediately before a critical operation;
- result immediately after it;
- branch selection;
- state mutation;
- caught error type and non-sensitive metadata;
- function exit or emitted event.

Do not use artificial delays, sleeps, or timeouts as a fix. Do not `await` a
probe or otherwise modify returned transport behavior.

## Evidence standard

A matching error message alone does not prove causality. A confirmed hypothesis
must connect the incorrect input/state, the executed branch or operation, and
the incorrect output/state when those stages are relevant.

Missing expected events may indicate an unexecuted path, failed delivery, stale
code, or a failed reproduction. Check `debug-mode status` and add a
CLI-generated control probe before rejecting the business-logic hypothesis.

## Verification and cleanup

Use distinct `runId` values such as `baseline` and `post-fix`. Verification must
show both:

1. the previously incorrect state or path no longer occurs; and
2. the expected output or invariant now occurs.

Keep probes during the fix and verification. After success and user
confirmation, remove complete region blocks and stop the session through the
CLI. Never manage daemon processes or evidence files directly.
```

## 12. Why the skill alone is insufficient

The skill controls agent judgment, while the CLI and daemon enforce mechanical safety:

- `clear` rejects another workspace or session instead of accepting a path.
- the daemon validates capabilities, session IDs, payload sizes, and fields;
- the probe renderer returns balanced language-valid regions;
- every command surfaces warnings before its result and provides structured corrective hints;
- `logs` and `query` summarize malformed records instead of silently dropping them;
- `status` reports every malformed-record diagnostic and directs the agent to fix the emitter rather than the evidence file;
- `query` runs a pinned embedded jaq implementation without exposing files, processes, or network access;
- streaming mode keeps ordinary filtering bounded, while explicit slurp mode reports resource failures instead of silently returning incomplete results;
- daemon control authenticates ownership before stopping a process;
- `clean` is scoped to one resolved session;
- a source scanner can reject unbalanced `agent log` markers.

Prompt instructions are best for forming hypotheses, choosing probe locations, evaluating evidence, and deciding whether a fix is proven. The CLI is best for lifecycle, isolation, transport, persistence, and query safety.

## 13. Failure modes to design for

### Empty log

Do not conclude that the instrumented path did not run until a control event proves delivery works. Check `debug-mode status`, stale builds, service-worker caches, and whether the reproduced runtime can execute the returned probe. The agent should not diagnose internal ports or raw paths.

### Malformed or interleaved NDJSON

`debug-mode logs` and `debug-mode query` must warn and report malformed counts. `debug-mode status` must return every bounded, redacted diagnostic and prompt the agent to fix the emitting helper or probe, clear the affected run, and reproduce. The daemon should serialize concurrent ingestion. Do not ask the model to infer merged JSON records or modify the evidence file.

### Probe changes behavior

Look for added `await`, locks, synchronous network I/O, large serialization, or logging of lazy objects. A probe in a race-sensitive path should be non-blocking and minimal.

### Stale instrumentation

Include `sessionId`, `runId`, and `location` in every generated template. Rebuild or restart the affected app. Run `debug-mode clear` immediately before each reproduction.

### Secret leakage

Prefer allowlisted scalar fields over whole-object logging. Redaction in the collector is defense in depth, not permission for probes to send secrets.

### Cleanup damages code

Require balanced, language-valid region markers. Preview the cleanup diff. Never remove text between unmatched or nested markers automatically.

### Missing or broken CLI

Test command-not-found, unsupported platform, disabled package scripts, unavailable registry, checksum mismatch, and a successful install whose binary is not on `PATH`. The skill must verify the command and stop cleanly when installation cannot be completed.

### Stale daemon

Test dead PID files, PID reuse, incompatible protocol versions, half-written state, and a daemon from an older binary. The CLI must recover or return structured guidance without asking the agent to manipulate processes.

### Expensive jaq program or slurp

Compile the program once and enforce cancellation at the Rust host boundary. Streaming programs must not accumulate the whole source. Slurp is never implicit; report input size, timeout, memory, and partial-progress diagnostics without silently returning incomplete results.

## 14. Testing the agent and CLI

Test the skill, compiled CLI, daemon, and distribution packages as a system.

1. **Premature-fix test** — present an obvious-looking bug and verify the agent instruments before editing behavior.
2. **Competing-hypotheses test** — ensure probes distinguish three plausible causes in one run.
3. **Empty-log test** — verify the agent checks delivery with a control probe.
4. **Rejected-hypothesis test** — verify speculative changes are removed.
5. **Race test** — verify probes do not add `await`, sleep, or blocking I/O.
6. **Secret test** — provide token-shaped fields and verify they are not logged.
7. **Session-isolation test** — run two agents and ensure neither clears the other's log.
8. **Post-fix test** — verify probes remain until before/after evidence is analyzed.
9. **Cleanup test** — verify only balanced agent-log regions are removed.
10. **Remote-runtime test** — ensure the agent does not assume the host's file path or loopback address is reachable.
11. **Install test** — verify Homebrew, npm global, Bun global, and npx resolve the same CLI version.
12. **Artifact test** — execute every Bun-compiled target on its target OS without Bun installed.
13. **Daemon reuse test** — concurrent `start` commands create one compatible daemon and isolated sessions.
14. **Upgrade test** — a newer CLI safely replaces an older idle daemon.
15. **Template test** — each supported language template parses/compiles after placeholder replacement and contains balanced markers.
16. **Future UI contract test** — event subscribers receive the same normalized records returned by `logs`.
17. **jaq compatibility test** — filtering, projection, regex, definitions, sorting, grouping, compile errors, and runtime errors match the pinned jaq behavior.
18. **Large-log test** — streaming filters remain memory-bounded on multi-gigabyte NDJSON; slurp either completes within its declared budget or returns an explicit resource error.
19. **Native-addon test** — every platform package loads the `napi-rs` addon from the Bun-compiled CLI and executes the same Rust query suite.
20. **Pagination test** — opaque cursors produce stable, non-overlapping pages while new events arrive.
21. **Shared-output test** — every JSON command returns warnings, completeness, scope, statistics, data, and hints; pretty `logs` renders every event field and complete bounded `data`, with warnings first and actionable commands last.
22. **Log-offset test** — limits, offsets, snapshots, and generated previous/next commands preserve all scope and filter arguments without overlaps while ingestion continues.
23. **Malformed-status test** — logs and query summarize corruption, while status returns every redacted diagnostic and instructs the agent to fix the emitter and reproduce.
24. **Hypothesis-scope test** — unfiltered logs show all declared hypotheses, repeated filters preserve the selected set, and undeclared IDs produce diagnostics without being merged or treated as malformed.
25. **Query-rendering test** — homogeneous flat objects and scalar streams use tables; arrays, nested or heterogeneous objects, mixed types, null-versus-missing keys, reordered keys, and empty streams select formats deterministically while preserving exact jaq semantics.

Keep the jaq engine's core test suite in Rust. Cover streaming and slurp input, zero/one/many outputs per record, malformed NDJSON, jq-compatible regex and transformations, compile/runtime source spans, cancellation, output limits without clamping, cursor continuation, redaction, and property-based tests that arbitrary input cannot access host capabilities. TypeScript tests cover only argument mapping and pretty/JSON rendering across the `napi-rs` boundary.

Use pressure scenarios when testing the skill: tell the agent the fix is urgent, the cause looks obvious, or instrumentation is inconvenient. A useful Debug Mode skill must preserve the evidence gate under those pressures.

## 15. Recommended package layout

Keep the installable skill separate from the Bun CLI source and platform packages:

```text
debug-mode/
├── src/
│   ├── cli/
│   │   ├── commands/
│   │   ├── output-schema.ts
│   │   └── pretty-renderer.ts
│   ├── daemon/
│   │   ├── control-api.ts
│   │   ├── ingest-api.ts
│   │   ├── event-bus.ts
│   │   ├── persistence.ts
│   │   └── session-registry.ts
│   ├── probes/
│   │   ├── renderers/
│   │   └── markers.ts
│   └── ui/                 # optional; no dependency from CLI contracts
├── native/
│   └── query/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── engine.rs
│           └── diagnostics.rs
├── packages/
│   ├── npm-launcher/
│   └── platform-binaries/
├── packaging/
│   ├── homebrew/
│   └── release/
├── skills/
│   └── agentic-debug-mode/
│       └── SKILL.md
└── tests/
    ├── contract/
    ├── integration/
    └── distribution/
```

The skill is installable independently in an agent's skills directory. It contains the evidence workflow, command installation fallback, and stable CLI commands. It does not contain ports, HTTP routes, PID files, direct log paths, or language transport implementations.

The renderer is the source of truth for language-specific probe code and region markers. The daemon is the source of truth for session isolation and evidence persistence. The versioned CLI JSON schema is the only contract shared with the skill.
