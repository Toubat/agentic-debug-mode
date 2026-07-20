# Lightweight probe templates

Status: Proposed

## Summary

Replace the large, language-specific object serializers in native probe templates with small
emitters that accept an expression producing serialized JSON.

The agent remains responsible for choosing safe diagnostic values and excluding secrets. The
background service continues to validate events and redact accepted data before canonical
persistence.

This change preserves the existing session, transport, event, query, and region-marker contracts.
It changes only how probe call sites provide `data`.

## Problem

The current Rust, C++, and C templates embed complete JSON value models, recursive serializers,
secret-key normalization, redaction, depth handling, and collection builders directly into the
instrumented application.

That design has several costs:

- The helper pasted into an application can be hundreds of lines long.
- Rust call sites use `AgentValue` and `adbg!` instead of the application's normal values.
- C++ call sites use `AgentValue` initializer-list heuristics and explicit integer suffixes.
- C call sites allocate an owned object tree through `adbg_*` builder functions.
- Generic helper names can conflict with application symbols.
- Includes, imports, macros, and helpers must be inserted at language-specific legal locations.
- Every language duplicates the same recursive serialization and secret-redaction policy.
- Tests prove isolated fixtures but do not prove insertion into representative application files.

The helper implementation is much larger than the observation call it supports. Instrumentation
should be easy to inspect and remove, and should introduce as little application code as possible.

## Goals

- Keep native helper templates small and dependency-free.
- Preserve structured JSON when the application already has a serializer.
- Support an escaped text fallback when structured serialization is unavailable.
- Preserve the existing five-field event schema.
- Preserve the rule that observation failures never change application behavior.
- Preserve the 64 KiB encoded-event limit.
- Preserve foldable `agent log` regions.
- Continue using HTTP for JavaScript and TypeScript and file append for current native templates.
- Make placement requirements explicit for imports, helpers, and call sites.
- Migrate incrementally, beginning with Rust and C++.

## Non-goals

- Adding an AST-based `instrument` or `uninstrument` command.
- Adding probe SDK packages, crates, or external JSON dependencies.
- Supporting arbitrary application objects without serialization.
- Changing session creation, reset behavior, log storage, query behavior, or daemon lifecycle.
- Changing the language-to-ingest compatibility matrix.
- Guaranteeing delivery when the process crashes or the destination is unavailable.
- Automatically discovering whether a value contains secrets.

## Design decision

### Serialized JSON is the native probe interface

For templates whose language does not provide a standard structured JSON value, the call template
accepts an expression that evaluates to a complete serialized JSON value:

```text
__DATA_JSON_EXPRESSION__
```

The value may represent any valid JSON type:

- object;
- array;
- string;
- number;
- boolean;
- null.

The emitter inserts this value directly after the event envelope's `"data":` key. It does not quote
or reinterpret the serialized value.

For example, an expression returning:

```json
{"queueSize":3,"ready":true}
```

produces:

```json
{
  "hypothesisId": "H1",
  "location": "src/worker.cpp:42",
  "message": "Queue state before pop",
  "data": {"queueSize":3,"ready":true},
  "timestamp": 1784313728231
}
```

The append file contains the event as one newline-terminated record.

### Use the application's serializer when available

The agent should prefer serialization facilities already present in the application.

Rust with `serde_json`:

```rust
// #region agent log
if let Ok(__agent_debug_data) = serde_json::to_string(&serde_json::json!({
    "queueSize": queue.len(),
    "ready": ready,
})) {
    agent_debug_mode::emit(
        "H1",
        &format!("{}:{}", file!(), line!()),
        "Queue state before pop",
        &__agent_debug_data,
    );
}
// #endregion
```

C++ with nlohmann JSON:

```cpp
// #region agent log
agent_debug_mode::emit(
    "H1",
    __FILE__ ":" AGENT_DEBUG_STRINGIFY(__LINE__),
    "Queue state before pop",
    nlohmann::json{
        {"queueSize", queue.size()},
        {"ready", ready},
    }.dump());
// #endregion
```

These are call-site examples, not dependencies added by debug-mode. Templates must not assume that
either library is installed.

### Fall back to an escaped JSON string

When the application has no structured JSON serializer, the helper exposes one small utility that
encodes text as a JSON string value:

```text
agent_debug_mode::json_string(text)
```

The agent may then log a concise textual representation:

```cpp
// #region agent log
std::ostringstream __agent_debug_text;
__agent_debug_text << "queueSize=" << queue.size() << " ready=" << ready;
agent_debug_mode::emit(
    "H1",
    __FILE__ ":" AGENT_DEBUG_STRINGIFY(__LINE__),
    "Queue state before pop",
    agent_debug_mode::json_string(__agent_debug_text.str()));
// #endregion
```

The resulting event's `data` field is a JSON string. Queries can still filter by hypothesis,
location, message, and timestamp, but cannot address fields inside the text.

The fallback does not manually construct an object from dynamic strings. Manually concatenating
unescaped strings into raw JSON is invalid and must not be recommended.

## Secret-handling contract

Probe call sites must not include secrets, credentials, authentication material, or unnecessary
personally identifiable information.

This is an explicit caller contract:

- The template placeholder description tells the agent to supply valid JSON containing no secrets.
- The Agent Skill instructs the agent to choose the smallest diagnostic value needed to test a
  hypothesis.
- Native helpers do not scan keys or redact values before transport.
- The background service still validates and redacts accepted JSON before writing canonical
  evidence.

For file ingestion, the session's `incoming.ndjson` file temporarily contains the caller-provided
event before daemon normalization. Daemon redaction therefore remains defense-in-depth, not
permission to send secrets.

This decision intentionally removes the client-side secret normalization and redaction code that
accounts for much of the current helper size.

## Template interface changes

Extend the template metadata so callers can distinguish native values from serialized JSON:

```typescript
export type ProbeDataEncoding = "native-json-value" | "serialized-json";

export interface ProbeTemplates {
  language: TemplateLanguage;
  ingest: IngestMethod;
  dataEncoding: ProbeDataEncoding;
  helperTemplate: string;
  callTemplate: string;
  placeholders: Record<string, string>;
  placement: {
    helper: "file-start" | "top-level";
    call: "statement";
  };
}
```

Initial assignments:

- JavaScript and TypeScript use `native-json-value`.
- Rust, C++, and C use `serialized-json` after migration.
- Other languages retain their current behavior until migrated.

During the incremental migration, a language may continue using
`__DATA_EXPRESSION__`. A language switches atomically to `__DATA_JSON_EXPRESSION__` when its helper,
call template, fixture, and tests are updated together.

The serialized-JSON placeholder description is:

```text
Replace with an expression that returns one complete valid JSON value containing no secrets.
Use the application's serializer when available; otherwise pass
agent_debug_mode::json_string(text).
```

## Lightweight helper responsibilities

The native helper performs only these operations:

1. Escape the constant `hypothesisId`, `location`, and `message` strings.
2. Accept a caller-provided serialized JSON value.
3. Add a Unix epoch timestamp in milliseconds.
4. Construct one newline-terminated event.
5. Reject an encoded event larger than 65,536 bytes.
6. Append the complete event to `__APPEND_PATH__`.
7. Swallow serialization-envelope and write failures so the observation cannot affect the
   application.

The helper does not:

- model arbitrary JSON values;
- recursively traverse data;
- detect cycles;
- enforce a nesting-depth limit;
- normalize secret-key names;
- redact values;
- allocate an intermediate object tree;
- inspect application types through reflection.

### Raw JSON handling

The emitter treats the data argument as raw JSON. It must not surround the argument with quotes.

The helper may reject an empty data string immediately. Full JSON syntax validation remains in the
daemon because implementing a parser in every source language would recreate the boilerplate this
design removes.

Malformed data therefore has the same outcome as any invalid event:

- the application continues;
- no accepted event appears in canonical evidence;
- ingestion diagnostics identify the rejected record.

### File append

Native helpers should open the append path with restrictive permissions where the language and
platform APIs permit it. POSIX implementations should use append mode and a single write operation
for each encoded event.

Cross-process append behavior must be verified for Rust, C++, and C. A helper must not claim atomic
record delivery solely because a high-level append stream was used.

## Placement contract

`helperTemplate` is not valid at an arbitrary source location.

- C and C++ preprocessor definitions and includes belong at file start, before declarations.
- Rust helper items belong at module scope.
- Calls belong in statement position.

The new `placement` metadata makes these requirements machine-readable and visible in CLI output.
The Agent Skill must instruct the agent to insert the helper once at the required location and each
call in its own `agent log` region.

Symbols should use a language-appropriate private namespace or distinctive prefix. C++ helpers
should live under an `agent_debug_mode` namespace. Rust helpers should live in an
`agent_debug_mode` module. The migration must remove generic global names such as `AgentValue` and
`AgentKind`.

## Migration sequence

### 1. Update the shared template contract

Modify:

- `src/probes/render.ts`;
- `src/commands/template.ts` if output serialization needs the new metadata;
- `src/cli/pretty-renderer.ts` to display data encoding and placement;
- `tests/contract/template-renderers.test.ts`.

Add `dataEncoding` and `placement` without changing any language implementation. Existing
renderers initially declare metadata matching their current behavior.

### 2. Migrate Rust

Modify:

- `src/probes/rust.ts`;
- `tests/fixtures/languages/rust-file.rs`;
- Rust entries in `tests/e2e/languages/live-probes.test.ts`.

Delete:

- `AgentValue`;
- `From` implementations;
- `adbg!`;
- recursive value serialization;
- depth handling;
- secret-key normalization and redaction.

Keep:

- JSON string escaping for envelope metadata and text fallback;
- timestamp generation;
- size enforcement;
- secure append;
- failure isolation.

### 3. Migrate C++

Modify:

- `src/probes/cpp.ts`;
- `tests/fixtures/languages/cpp-file.cpp`;
- C++ entries in `tests/e2e/languages/live-probes.test.ts`.

Delete:

- `AgentKind`;
- `AgentValue`;
- initializer-list object detection;
- recursive value serialization;
- depth handling;
- secret-key normalization and redaction.

Place remaining helper symbols in `agent_debug_mode`.

### 4. Migrate C

Modify:

- `src/probes/c.ts`;
- `tests/fixtures/languages/c-file.c`;
- C entries in `tests/e2e/languages/live-probes.test.ts`.

Delete the allocated `AgentValue` tree, variadic object builders, recursive serializer, depth
handling, and secret-redaction implementation. Retain only bounded envelope construction, string
escaping, timestamping, and append.

### 5. Evaluate the remaining languages

Measure each helper after Rust, C++, and C are complete. Migrate another language only when raw JSON
meaningfully reduces its helper and call complexity. Languages with safe, standard JSON facilities
may retain native structured values.

Do not force every language through the serialized-JSON interface solely for uniformity.

### 6. Update agent-facing documentation

Modify:

- `DESIGN.md`;
- `skills/agentic-debug-mode/SKILL.md`;
- `skills/agentic-debug-mode/REFERENCE.md`;
- `skills/agentic-debug-mode/EXAMPLES.md`;
- `specs/building-a-debug-mode-agent.md`.

Document:

- the raw-JSON placeholder contract;
- the escaped-text fallback;
- the caller's no-secrets responsibility;
- placement metadata;
- per-language region markers;
- `application/x-ndjson` as the actual HTTP content type.

## Test strategy

### Contract tests

For every migrated serialized-JSON template, assert:

- `dataEncoding` is `serialized-json`;
- placement metadata is correct;
- `callTemplate` contains `__DATA_JSON_EXPRESSION__`;
- the prior `__DATA_EXPRESSION__` placeholder is absent;
- the helper does not contain prior value-model symbols;
- the helper contains the 65,536-byte cap;
- helper and call templates contain the correct region markers.

### Runtime tests

Run each migrated template with its real compiler or runtime and verify:

1. A serialized object is accepted and remains structured in canonical evidence.
2. Serialized arrays, strings, numbers, booleans, and null are accepted.
3. `agent_debug_mode::json_string` safely handles quotes, backslashes, control characters, and
   newlines.
4. Malformed raw JSON does not alter application behavior and is not accepted.
5. Oversize JSON does not alter application behavior and is not emitted.
6. An unavailable append path does not alter application behavior.
7. Multiple processes append complete, independently parseable records.
8. Metadata containing quotes and control characters remains valid JSON.

### Realistic insertion tests

Add fixtures that resemble existing application files rather than empty single-file programs:

- C++ with existing includes, a namespace, and an application type named `AgentValue`;
- Rust with existing imports and nested modules;
- C with system headers included before application declarations.

These tests verify the documented placement contract and symbol isolation.

### Removed tests

For migrated templates, remove tests whose only purpose was exercising the deleted recursive value
model:

- cyclic/depth rejection;
- shared-reference cloning;
- client-side secret-key redaction.

Retain daemon redaction tests independently of probe templates.

## Acceptance criteria

The migration is complete when:

- Rust, C++, and C no longer define custom recursive JSON value models.
- Their call templates accept serialized JSON expressions.
- Their helpers provide safe JSON-string fallback.
- Each generated helper contains no more than 150 nonblank source lines and is at least 60% smaller
  than the helper it replaces.
- Their helpers contain only envelope, timestamp, bound, append, and JSON-string escaping logic.
- Existing structured event queries continue to work when callers provide object or array JSON.
- All failure-isolation tests pass.
- Native concurrent-append tests produce only complete parseable NDJSON lines.
- Realistic insertion fixtures compile.
- Agent-facing documentation accurately describes content types, placement, markers, and secret
  responsibility.

## Rollout and compatibility

This changes generated source templates, not stored event data. Existing sessions and canonical
evidence remain compatible.

Previously inserted helpers continue to work until the agent removes their regions. New template
output uses the lightweight helper. A reset does not require reinstrumentation because append paths
remain stable.

The placeholder rename is intentionally breaking for tools that mechanically substitute current
template output. The CLI's template result exposes the placeholder map, so consumers should use
that map instead of assuming placeholder names.

If a migrated language exposes unacceptable integration or concurrency failures, revert that
language to its previous renderer without reverting the shared `dataEncoding` and `placement`
metadata.
