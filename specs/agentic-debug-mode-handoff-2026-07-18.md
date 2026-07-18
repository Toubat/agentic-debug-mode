# Agentic Debug Mode Handoff

## Current state

Repository: `/Users/toubatbrian/Documents/GitHub/debug-mode`

Branch: `feature/agentic-debug-mode`

The project is an unpublished Bun/TypeScript CLI with Rust N-API modules. It collects structured
runtime evidence into explicit UUID sessions, supports HTTP and direct-file ingestion, and exposes
bounded logs/query/status operations. The user explicitly stopped the session during the last
Task 8 follow-up. Do not start Task 9 automatically without a new instruction.

The configured GitHub remote is inaccessible (`Repository not found`). Milestone commits were made
locally and every required push was attempted.

## Authoritative artifacts

Read these instead of reconstructing decisions from chat:

1. `DESIGN.md`
   - Approved public model, command surface, event schema, ingestion, session/reset behavior,
     service lifecycle, and skill requirements.
2. `docs/superpowers/plans/2026-07-17-agentic-debug-mode-redesign.md`
   - Detailed TDD implementation plan. Tasks 1–8 are the implemented scope; Tasks 9–10 remain.
3. `.superpowers/sdd/progress.md`
   - Durable reviewed-task ledger and the one recorded minor item for final review.
4. `docs/building-a-debug-mode-agent.md`
   - Original ground-truth document. It still has uncommitted edits and must be reconciled in
     Task 9.
5. `.superpowers/sdd/task-5-report.md`
   - Complete ingestion implementation and review evidence.
6. `.superpowers/sdd/task-7-report.md`
   - Idle shutdown/restart implementation and evidence.
7. `.superpowers/sdd/task-8-report.md`
   - Language-template implementation, runtime matrix, safety fixes, and latest local evidence.
8. `.superpowers/sdd/direct-query-report.md`
   - Direct N-API querying, bounded continuation, generated query matrix, reset races, and logs
     external sorting.
9. `skills/agentic-debug-mode/SKILL.md`
   - Current skill is intentionally not final. Task 9 requires a complete rewrite plus
     `REFERENCE.md` and `EXAMPLES.md`.

## Binding design decisions

- No backward-compatibility layer is required because nothing has been published.
- A session is one investigation and is a random UUID. There is no workspace identity, run model,
  active/closed state, or implicit session selection.
- Every session-scoped command requires `--session <id>`.
- Public commands are exactly:
  `create`, `template`, `reset`, `logs`, `query`, `status`, `sessions`, `clean`, `stop`.
- Commander.js owns public parsing/help/version. Internal service entry points stay outside public
  help.
- Pretty output is the normal agent/human interface. `--json` is only for external programmatic
  integrations and must not appear in the skill’s normal workflow.
- Probe input has exactly:
  `hypothesisId`, `location`, `message`, `data`, `timestamp`.
- Stored evidence adds only:
  `id`, `sequence`, `receivedAt`.
- HTTP ingestion is `POST /ingest/<sessionId>`. File ingestion appends complete NDJSON records to
  the session’s returned append path.
- The CLI calls the Rust query binding directly. Do not restore a query subprocess or internal
  query-worker protocol.
- State lives under `~/.agent-debug-mode/` on every OS.
- The hidden service stops after exactly 30 idle minutes, preserves sessions, and transparently
  restarts on the next data command.
- The exact advertised template matrix is:
  JavaScript+HTTP, TypeScript+HTTP, Python+file, Go+file, Ruby+file, PHP+file,
  PowerShell+file, C#+file, Swift+file.
- A tracked contract forbids a specific obsolete compatibility term in filenames and contents.
  Run `tests/contract/tracked-language.test.ts`; do not weaken it.
- Do not include Cursor as a commit co-author.
- Preserve unrelated working-tree edits. Never reset or discard them wholesale.

## Completed reviewed work

The durable ledger records Tasks 1–7 as review-approved.

Major local commits after the redesign:

- `358eff3` session-only evidence domain
- `16d8902` reusable reset/session persistence
- `53f1e31` Commander public CLI
- `d8c24a7` lifecycle commands and fixes
- `142c706` direct N-API bounded query execution
- `57cc370` unified/idempotent ingestion and SSE cleanup
- `4597ecc` idle shutdown and transparent restart
- `8f750b0`, `65f321f` nine-pair templates and live fixtures
- `b1298cb`, `e8e0a9d`, `1fa00a4` template secrecy, cycle safety, and exact helper policy
- `ceeda01` canonical ingestion redaction aligned with helper policy

Task 8 is functionally implemented but was not finally closed in the ledger.

## Exact interruption point

The last reviewer approved canonical/helper redaction behavior but found that the drift-prevention
test was only source-text containment. The required replacement is behavioral:

- Build one shared positive/negative nested-key matrix.
- Compute canonical expected output with `redactSecrets`/`isSensitiveKey`.
- Materialize and execute each of the nine real helper/runtime pairs.
- Capture raw HTTP request JSON or raw `incoming.ndjson`.
- Deep-compare helper-redacted `data` with canonical expected output.
- Local missing runtimes may skip normally; `REQUIRE_TEMPLATE_RUNTIMES=1` must fail missing
  advertised runtimes.
- Remove the weak source-containment assertion.

A Task 8 implementer had begun this final fix and was interrupted on user request. Inspect the
current diff before changing anything. Likely partial files include:

- `tests/contract/template-renderers.test.ts`
- `tests/e2e/languages/live-probes.test.ts`

No final commit or final review for this behavioral parity fix was completed.
The stopped subagent later terminated with `Connection failed repeatedly`; do not trust or infer
completion from its partial working-tree edits.

## Current working tree

At handoff time `git status --short` reported:

```text
 M .github/workflows/release.yml
 M docs/building-a-debug-mode-agent.md
 M docs/superpowers/plans/2026-07-17-agentic-debug-mode-redesign.md
 M skills/agentic-debug-mode/SKILL.md
 M src/cli/pretty-renderer.ts
 M src/commands/status.ts
 M src/platform/permissions.ts
 M src/platform/state-root.ts
 M tests/contract/exit-codes.test.ts
 M tests/contract/template-renderers.test.ts
 M tests/distribution/package-layout.test.ts
 M tests/e2e/languages/live-probes.test.ts
 M tests/skill/skill-contract.test.ts
 M tests/system/npm-install.test.ts
 M tests/unit/persistence/path-safety.test.ts
 M tests/unit/persistence/state-root.test.ts
?? tests/integration/daemon/startup-failure-cleanup.test.ts
?? tests/integration/ingestion/live-events.test.ts
```

Many of these are preserved edits from earlier milestones, not all part of the interrupted Task 8
fix. Inspect per-file diffs and stage narrowly.

## Remaining work

### Finish Task 8 only when authorized/resumed

1. Inspect the interrupted behavioral-parity diff.
2. Complete TDD for real cross-runtime canonical/helper parity.
3. Run available language runtimes and mandatory-runtime CI contracts.
4. Run typecheck, Biome, build, tracked-term contract, and detached committed-tree verification.
5. Commit narrowly and attempt push.
6. Generate a review package and obtain a clean Task 8 review.
7. Mark Task 8 complete in `.superpowers/sdd/progress.md`.

PHP and PowerShell were unavailable locally; CI is configured to install them and fail instead of
skip. Hosted CI has not run because the remote is inaccessible.

### Task 9 — not started

Completely redo the agent skill and documentation. The plan’s Task 9 section is authoritative.

Required high-level outputs:

- Rewrite `skills/agentic-debug-mode/SKILL.md`.
- Add `skills/agentic-debug-mode/REFERENCE.md`.
- Add `skills/agentic-debug-mode/EXAMPLES.md`.
- Rewrite/reconcile `docs/building-a-debug-mode-agent.md` and `README.md`.
- Finish pretty-output contracts for every public command.
- Use skill TDD: run fresh-agent pressure scenarios before and after the rewrite.
- Keep the main skill below 500 lines via one-level-deep progressive disclosure.
- The normal skill workflow must not use `--json` or expose service internals.

### Task 10 — not started

- Scope release permissions by job.
- Synchronize root/tag/launcher/platform/Homebrew versions.
- Verify checksums, signatures, SBOM, and publication ordering.
- Complete repeated full suites, Rust tests, native/binary build, Biome, typecheck, distribution,
  system tests, and final ground-truth audit.
- Remove temporary debug instrumentation only after successful verification.
- Run final whole-branch review and branch-finishing workflow.

### Known final-review item

Consider nesting daemon `onStarted` and synthetic `processMetadata` options under `testHooks`.
Current production callers do not provide them; this was recorded as non-blocking.

### External blocker

The remote currently returns `Repository not found`. Do not spend time investigating unless the
user asks. Continue local commits and report failed push attempts.

## Suggested skills

- `superpowers:subagent-driven-development` — continue task-by-task with implementer and independent
  review gates.
- `superpowers:test-driven-development` — required for code tasks and the interrupted parity test.
- `superpowers:writing-skills` — required before Task 9; use RED/GREEN pressure scenarios.
- Cursor `create-skill` — follow Cursor skill structure, progressive disclosure, and metadata rules.
- `superpowers:verification-before-completion` — required before completion claims.
- `superpowers:requesting-code-review` — final whole-branch review after Tasks 9–10.
- `superpowers:finishing-a-development-branch` — final handoff/merge decision only after all checks.

## Resume procedure

1. Read this file, `DESIGN.md`, the redesign plan, and `.superpowers/sdd/progress.md`.
2. Run `git status --short`, inspect narrow diffs, and preserve all unrelated edits.
3. Confirm the interrupted Task 8 subagent did not leave a running process or staged changes.
4. Do not start Task 9 unless the user explicitly resumes beyond Task 8.
5. When authorized, finish the behavioral parity test, review Task 8, then update the ledger.
