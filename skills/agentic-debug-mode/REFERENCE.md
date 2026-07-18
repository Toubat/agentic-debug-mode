# Debug Mode CLI reference

Complete command, option, and query reference for `debug-mode`. The Agent Skill in
[SKILL.md](SKILL.md) covers the normal workflow; this file is the exhaustive lookup. All local
state lives under `~/.agent-debug-mode/`.

Pretty text is the default and the interface the Agent Skill uses. `--json` is documented here only
for **external programmatic integrations** (scripts, CI, dashboards). Agents should not use it in
the normal workflow.

## Commands

### `debug-mode create`

Creates a new session and prints its **Session ID**, **Ingest URL**, and **Append Path**. Takes no
language, run, or hypothesis options.

### `debug-mode template --language <language> --ingest <http|file>`

Prints a session-independent **helper template**, **call template**, **placeholders**, and **event
schema** for one language and transport. Templates never take `--session`.

| Language     | `--language` value          | Ingest |
| ------------ | --------------------------- | ------ |
| JavaScript   | `javascript` (`js`)         | `http` |
| TypeScript   | `typescript` (`ts`)         | `http` |
| Python       | `python` (`py`)             | `file` |
| Go           | `go` (`golang`)             | `file` |
| Ruby         | `ruby` (`rb`)               | `file` |
| PHP          | `php`                       | `file` |
| PowerShell   | `powershell` (`pwsh`)       | `file` |
| C#           | `csharp` (`cs`, `c#`)       | `file` |
| Swift        | `swift`                     | `file` |

HTTP templates use an ingest-URL placeholder; file templates use an append-path placeholder. Other
languages are unsupported until a safe serializer contract is defined.

### `debug-mode reset --session <id>`

Clears events, diagnostics, and sequence state for the session while preserving the session ID,
append path, and inserted observations. Sequence restarts at `1`; old log and query cursors become
invalid; the response returns the currently valid Ingest URL and Append Path.

### `debug-mode logs --session <id> [options]`

Returns bounded, validated records with statistics, warnings, and continuation commands.

| Option                | Meaning                                             |
| --------------------- | --------------------------------------------------- |
| `--limit <n>`         | Maximum records to return (default `100`).          |
| `--offset <n>`        | Starting offset (default `0`).                      |
| `--hypothesis <id>`   | Repeatable read-only filter over observed labels.   |
| `--snapshot <cursor>` | Opaque cursor that keeps paging stable across runs. |

`--hypothesis` filters labels already present in evidence; it never registers or validates a
hypothesis. Follow the printed continuation commands rather than composing offsets by hand.

### `debug-mode query --session <id> '<jaq program>' [options]`

Runs an embedded jaq program over the session evidence.

| Option              | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `--slurp`           | Collect all records into one array first (needed for `sort_by`, `group_by`, aggregation). |
| `--limit <n>`       | Maximum produced values to return.                             |
| `--timeout-ms <n>`  | Query time budget.                                             |
| `--cursor <cursor>` | Opaque cursor that continues the same query and scope.         |

Streaming is the default and stays memory-bounded. A collection operation run without `--slurp`
returns a `COLLECTION_REQUIRED` error suggesting the same command with `--slurp`.

### `debug-mode status --session <id>`

Returns evidence health and **every** malformed-record diagnostic: a stable ID, reason, readable
message, recoverable fields, a bounded redacted preview, and a suggested fix. It never exposes the
evidence path, byte offsets, or secrets. Fix each emitting observation, `reset`, and reproduce.

### `debug-mode sessions [--all]`

Lists sessions created today, newest first (at most 20). `--all` includes older sessions. Never
selects a session.

### `debug-mode clean --session <id>`

Permanently removes `~/.agent-debug-mode/sessions/<id>/`: evidence, diagnostics, and metadata.

### `debug-mode stop`

Immediately stops the background service without deleting sessions. The next data command restarts
it transparently.

### `debug-mode --help`, `debug-mode <command> --help`, `debug-mode --version`

Real generated help and version output.

## jaq query cookbook

Each event exposes `hypothesisId`, `location`, `message`, `data`, `timestamp`, plus the stored
`id`, `sequence`, and `receivedAt`. Dynamic `.data.<key>` paths are queryable when scalar.

```bash
# Filter by field and threshold
debug-mode query --session <id> 'select(.hypothesisId == "H2" and .data.durationMs >= 100)'

# Regex over a message (case-insensitive)
debug-mode query --session <id> 'select(.message | test("cache (miss|expired)"; "i"))'

# Nested data access
debug-mode query --session <id> 'select(.data.user.id == "u1")'

# Projection to a flat object (renders as a table)
debug-mode query --session <id> '{seq: .sequence, loc: .location, ms: .data.durationMs}'

# Sorting (needs --slurp)
debug-mode query --session <id> --slurp 'sort_by([.timestamp, .sequence]) | .[]'

# Grouping and aggregation (needs --slurp)
debug-mode query --session <id> --slurp \
  'group_by(.hypothesisId)
   | map({hypothesisId: .[0].hypothesisId, count: length,
          avgMs: (map(.data.durationMs) | add / length)})'
```

Homogeneous flat objects render as a compact table; scalars render as an indexed value table;
nested or mixed shapes render as pretty JSON. The renderer never truncates or flattens values.

## Exit codes

| Exit | Meaning                              |
| ---- | ------------------------------------ |
| `0`  | Success                              |
| `2`  | Invalid arguments or unsupported language |
| `3`  | Version incompatibility              |
| `4`  | Background service unavailable       |
| `5`  | Session not found                    |
| `6`  | Evidence malformed or unreadable     |

## `--json` for external integrations

Adding `--json` to any command returns the same result as a versioned envelope for non-agent
consumers:

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

Errors return `{ "schemaVersion": 1, "ok": false, "error": { "code", "message", "hint" } }`. Use
these fields directly; do not scrape pretty text.
