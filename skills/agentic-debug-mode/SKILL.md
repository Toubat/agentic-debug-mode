---
name: agentic-debug-mode
description: Diagnoses bugs, regressions, race conditions, and unexpected behavior with runtime evidence. Use when a root cause has not yet been proven.
---

# Debugging with Runtime Evidence

## Core rule

Source code creates hypotheses. Runtime evidence confirms or rejects them.

Do not implement a bug fix before collecting runtime evidence that identifies the cause.

## Resolve the CLI

Run `debug-mode --version`.

If the command is unavailable, use the first supported installation channel allowed by the
host's package-installation policy:

1. macOS with Homebrew: `brew install agentic-debug-mode`
2. npm: `npm install --global agentic-debug-mode`
3. Bun: `bun install --global agentic-debug-mode`
4. Zero-install fallback: use `npx --yes agentic-debug-mode@latest` as the command prefix

Never use an unverified `curl | sh`, request elevated privileges, or edit shell startup files.
Verify the command again after installation. Stop and report the error if no supported channel
works.

Use pretty output for evidence. Use `--json` for generated templates and exact
machine-readable fields.

## Start a session

1. State expected behavior, actual behavior, and the shortest reproduction.
2. Form three to five precise, falsifiable hypotheses named `H1`, `H2`, and so on.
3. Run:

   `debug-mode start --workspace <project-root> --language <language> --run-id baseline --hypothesis H1 --hypothesis H2 --json`

Repeat `--hypothesis` for every declared hypothesis.

Stop if `ok` is false, `data.daemon.status` is not `running`, or either generated template is
absent. Retain `scope.sessionId`; pass `--session <session-id>` to every subsequent command.
Never guess a latest session. Recover one with:

`debug-mode sessions --workspace <project-root> --json`

Insert `data.instrumentation.helperTemplate` once per runtime boundary. Copy
`data.instrumentation.callTemplate` for each observation and replace only placeholders listed
in `data.instrumentation.replace`. Treat helper transport and embedded session configuration as
opaque.

To obtain another template for an existing run:

`debug-mode probe --session <session-id> --run-id <run-id> --language <language> --json`

## Probe boundaries and data

Preserve all opening and closing markers in generated `agent log` regions. Keep the helper in
its own region and one logical observation in each call region. Never place production behavior
inside a probe region or instrument generated files whose syntax does not support the markers.

Use a constant `message`; put changing observations in `data`. Do not record credentials,
tokens, cookies, authorization headers, private keys, full request bodies, or unrelated personal
data. Do not await a probe or change its failure handling.

Prefer the minimum probes that distinguish the hypotheses:

- function entry with sanitized parameters;
- state before and after a critical operation;
- branch selection;
- state mutation;
- caught error type and non-sensitive metadata;
- function exit or emitted event.

## Reproduce and read evidence

Clear only the selected run before reproduction:

`debug-mode clear --session <session-id> --run-id baseline --json`

Ask the user to reproduce and include any restart or rebuild instructions.

Use only `debug-mode logs`, `debug-mode query`, and `debug-mode status` to read runtime
evidence. Never use native file-reading tools, shell commands, `tail`, `sed`, `awk`, direct
`jq`/`jaq`, or ad hoc scripts to inspect Debug Mode evidence.

Start with a bounded pretty result:

`debug-mode logs --session <session-id> --run-id baseline --limit 100`

Use embedded jaq for filtering or projection:

`debug-mode query --session <session-id> --run-id baseline 'select(.message | test("timeout|deadline"; "i"))'`

Add `--slurp` explicitly for whole-run operations such as `sort_by`, `group_by`, and
aggregation. Follow returned pagination commands because they preserve scope and snapshot state.

For every result:

1. Read warnings first.
2. Verify the displayed session and run.
3. Inspect completeness and statistics.
4. Follow corrective hints.

If `logs` or `query` reports malformed records, run:

`debug-mode status --session <session-id> --run-id <run-id>`

Fix the emitting probe identified by each diagnostic, clear the affected run, and reproduce.
Never edit persisted evidence.

## Classify and iterate

Classify every hypothesis and cite event IDs or sequence numbers:

- `CONFIRMED`: events directly demonstrate the causal path.
- `REJECTED`: events contradict the hypothesis.
- `INCONCLUSIVE`: expected evidence is absent or ambiguous.

Missing events can mean an unexecuted path, failed delivery, stale code, or failed reproduction.
Check status and add a generated control probe before rejecting a hypothesis. If none is
confirmed, form new hypotheses in different subsystems and repeat.

Remove speculative changes made for rejected hypotheses. Implement only the smallest fix
supported by confirmed evidence.

## Verify the fix

Keep probes during the fix and verification. Leave the baseline helper and calls unchanged.
Create a distinct verification run:

`debug-mode run begin --session <session-id> --run-id post-fix --json`

Clear `post-fix`, reproduce again, and repeat the same evidence query. Verification must show
both that the incorrect path or state no longer occurs and that the expected output or invariant
does occur.

Remove complete `agent log` regions only after post-fix evidence succeeds and the user confirms
the behavior. Then stop the session:

`debug-mode stop --session <session-id> --json`

Do not manage the underlying daemon or telemetry storage directly.
