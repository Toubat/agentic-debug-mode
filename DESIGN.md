# Agentic Debug Mode Design

## Goals

Agentic Debug Mode gives an agent a small CLI for collecting and querying structured runtime
evidence. The CLI hides process management, ports, state files, and ingestion internals.

The design optimizes for:

- one explicit session identifier for every operation;
- one reusable evidence lifecycle per debugging investigation;
- agent-readable output by default;
- bounded, structured evidence;
- no framework bookkeeping for hypotheses;
- no user involvement when the agent can perform an action itself.

## Core model

### Session

A session is one debugging investigation and is identified by a random UUID.

```text
707225a6-8e0f-4db4-b64b-e261bd6a861a
```

There is no workspace identity, run identity, active/closed state, or automatically selected
session. Every session-scoped command requires `--session <id>`.

Each session owns one canonical append-only evidence file. A file-ingestion spool may exist as a
private transport buffer, but it is not another evidence source. The daemon normalizes complete
spool records into the canonical evidence file.

### Debugging cycle

The agent repeats this cycle with one session:

1. reset the session;
2. add or retain structured observations;
3. reproduce;
4. read logs, query evidence, and inspect status;
5. classify hypotheses in the agent's own reasoning;
6. change code or observations;
7. reset and reproduce again;
8. repeat until runtime evidence proves the fix.

There is no `run` concept. Baseline conclusions remain in the agent's context; the framework does
not persist separate baseline and post-fix runs.

### Hypotheses

The agent creates and maintains its own list of hypotheses. The framework does not register,
declare, mutate, or validate that list.

Each event carries a free-form `hypothesisId`. The CLI groups and filters observed IDs but never
emits an undeclared-hypothesis diagnostic.

## Public CLI

The CLI uses Commander.js for parsing, validation, nested help, repeatable options, and generated
usage. It does not maintain a custom argument parser.

### `debug-mode create`

Creates a new session. It takes no workspace, language, run, or hypothesis options.

Pretty output returns:

```text
SESSION CREATED
Session ID   707225a6-8e0f-4db4-b64b-e261bd6a861a
Ingest URL   http://127.0.0.1:4319/ingest/707225a6-8e0f-4db4-b64b-e261bd6a861a
Append Path  ~/.agent-debug-mode/sessions/707225a6-8e0f-4db4-b64b-e261bd6a861a/incoming.ndjson
```

The URL path contains the session ID. It is not described as a token or capability. HTTP
ingestion requires no session header and no duplicated session field in the event body.

### `debug-mode template`

Returns a language-specific, session-independent helper and call template.

```bash
debug-mode template --language typescript --ingest http
debug-mode template --language python --ingest file
```

`--ingest http` uses an `__INGEST_URL__` placeholder. `--ingest file` uses an
`__APPEND_PATH__` placeholder. Templates never require `--session`.

Pretty output has explicit sections:

```text
HELPER TEMPLATE
<exact source>

CALL TEMPLATE
<exact source>

PLACEHOLDERS
<names and meanings>

EVENT SCHEMA
<field names, types, and timestamp units>
```

The first supported combinations are:

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

Every advertised combination must pass a live end-to-end test with its real runtime. Java, Kotlin,
and shell are not advertised until a safe serializer contract is defined.

### `debug-mode reset --session <id>`

Clears events, diagnostics, ingestion spool state, and sequence state while preserving the
session ID, append path, and inserted observations.

After reset:

- sequence restarts at `1`;
- old log snapshots and query cursors are invalid;
- the response returns the currently valid ingest URL and append path;
- if a daemon restart changed the HTTP port, the agent updates only `__INGEST_URL__` in the
  helper before reproducing.

### `debug-mode logs --session <id>`

Returns bounded structured records with filtering, offset/limit pagination, statistics, warnings,
and complete continuation commands. Pretty output is primary.

The pretty table is tuned for low token cost, since agents read it most. Its columns are:

```text
SEQ  TIME  HYP  LOCATION  MESSAGE  DATA
```

`SEQ` is the human- and agent-facing record handle. `TIME` renders the compact intra-day clock
(`HH:MM:SS.mmm`); the UTC date is printed once as a `date <YYYY-MM-DD>` header above the table, with
a `-- <YYYY-MM-DD> --` separator row emitted only when records cross into a new UTC day. The
per-record `id` and `receivedAt` are omitted from the pretty table but remain in storage, `--json`,
and `query` results. `DATA` and `HYP` are always shown in full.

### `debug-mode query --session <id> '<jaq program>'`

Runs embedded jaq against the session evidence. Streaming mode is default; collection operations
require explicit `--slurp`. Output limits bound returned values, and tamper-evident opaque cursors
retain the complete query scope without exposing a file path.

### `debug-mode status --session <id>`

Returns all bounded, redacted malformed-ingestion diagnostics and evidence health for the
session. It never reports daemon implementation details to the agent.

### `debug-mode sessions`

By default, lists sessions created during the current local calendar day, newest first, with at
most 20 results.

```text
sessionId
createdAt
eventCount
```

`debug-mode sessions --all` lists historical sessions. The command never selects a session.

### `debug-mode clean --session <id>`

Permanently removes:

```text
~/.agent-debug-mode/sessions/<session-id>/
```

This deletes evidence, diagnostics, ingestion state, cursor metadata, and session metadata.

### `debug-mode stop`

Immediately stops the hidden background service without deleting sessions. The next data command
starts it transparently.

### Help, version, and JSON

`debug-mode --help`, command-specific `--help`, and `debug-mode --version` are real generated
interfaces.

Pretty output is the default for agents and humans. `--json` remains available for external
programmatic integrations, but the Agent Skill does not use it in its normal workflow.

The CLI does not accept unimplemented `--follow`, `--jsonl`, or `ui` behavior.

## Removed interface

The following are removed:

```text
debug-mode start
debug-mode probe
debug-mode run begin
debug-mode clear
debug-mode daemon stop
--workspace
--run-id
--hypothesis
```

Their replacements are `create`, `template`, `reset`, and `stop`.

## Event schema

### Probe event

HTTP and file helpers emit:

```json
{
  "hypothesisId": "H1",
  "location": "src/cache.ts:84",
  "message": "Cache lookup completed",
  "data": {
    "cacheKey": "cart:42",
    "hit": false
  },
  "timestamp": 1784313728231
}
```

Fields:

- `hypothesisId`: agent-generated label for one concrete hypothesis;
- `location`: stable source location, preferably `path:line`;
- `message`: constant observation description;
- `data`: bounded JSON containing changing values;
- `timestamp`: observation time as Unix epoch milliseconds.

The body does not contain `sessionId`, `runId`, or per-record `schemaVersion`.

### Stored event

The daemon adds:

```json
{
  "id": "evt_...",
  "sequence": 1,
  "receivedAt": 1784313728237,
  "hypothesisId": "H1",
  "location": "src/cache.ts:84",
  "message": "Cache lookup completed",
  "data": {
    "cacheKey": "cart:42",
    "hit": false
  },
  "timestamp": 1784313728231
}
```

- `id`: daemon-assigned event identifier;
- `sequence`: accepted-event order within the current reset cycle;
- `receivedAt`: daemon receipt time as Unix epoch milliseconds.

When timestamps are equal, `sequence` is the stable ordering tie-breaker. The event schema version
is stored once in session metadata.

## Ingestion

### HTTP

```text
POST /ingest/<sessionId>
Content-Type: application/json
```

There is no separate token, capability terminology, session header, or session field in the body.
The loopback route determines the session.

### File

The helper appends bounded, newline-terminated JSON records to the returned append path using the
language's standard JSON and file APIs. It never spawns the CLI per event.

The daemon observes complete lines, validates and redacts them, and appends normalized records to
the canonical evidence file. Incomplete trailing lines remain buffered.

## Isolation and reset safety

- Session IDs are random UUIDs.
- Every session has an isolated subdirectory and evidence lifecycle.
- Reset, logs, query, status, and clean require an explicit session ID.
- Reset increments a private evidence epoch used only to invalidate old cursors.
- State directories and files reject symbolic-link redirection.
- Secrets are redacted before canonical persistence.

## Hidden service lifecycle

Every data command:

1. checks whether the hidden service is healthy;
2. starts or replaces it when necessary;
3. performs the requested operation.

The Agent Skill does not mention daemon processes, ports, PID files, locks, or startup recovery.

The service:

- binds loopback on an available port;
- shuts down immediately on `debug-mode stop`;
- shuts down after 30 minutes without CLI, HTTP ingestion, file ingestion, or live-stream
  activity;
- restarts transparently on the next command.

## Agent Skill requirements

The skill:

- explains `create`, `template`, `reset`, evidence reading, verification, clean, and stop in plain
  language;
- includes the exact event schema and timestamp units;
- uses pretty output and never references internal JSON paths such as `data.instrumentation`;
- defines session, hypothesis label, helper template, call template, ingest URL, and append path
  before using those terms;
- never mentions daemon internals;
- never asks the user to perform an action the agent can execute with available tools;
- asks the user only for inaccessible UI/device/account interactions or subjective confirmation,
  after completing every accessible prerequisite itself.

## Verification requirements

- Commander help and parse errors have contract tests.
- Every public command has pretty-output and JSON contract tests.
- Create/reset/clean/session isolation have lifecycle tests.
- Concurrent CLI processes converge on one healthy hidden service.
- Idle shutdown and transparent restart have deterministic tests with an injected clock.
- HTTP and file ingestion share schema-validation and redaction tests.
- Every advertised language/ingest combination has a live end-to-end test.
- Reset invalidates old cursors and restarts sequence numbering.
- Large logs and queries remain memory-bounded.

## Hypothesis filter clarification

The removed `--hypothesis` interface is the old hypothesis-declaration behavior. The repeatable
`logs --hypothesis <id>` option remains a read-only filter over IDs already present in evidence; it
does not register or validate hypotheses.
