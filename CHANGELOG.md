# agentic-debug-mode

## 0.2.3

### Patch Changes

- 3b1689f: `logs` now emits a `verify-ingest` hint when a session has zero evidence and no diagnostics: an unexecuted path or failed run is one cause, a stale probe endpoint after a service restart is the other — the hint points at `reset`, which prints the current Ingest URL and Append Path.

## 0.2.2

### Patch Changes

- fa95260: `stop` no longer reports success while an alive-but-unresponsive service process survives. After a failed shutdown request it now retries the health probe, verifies the recorded process identity, and terminates the wedged process (graceful, then forced) before reporting stopped.

## 0.2.1

### Patch Changes

- d90b57e: Token-lean logs table: drop the ID and RECEIVED columns and render TIME as a compact
  `HH:MM:SS.mmm` clock with the UTC date printed once as a header. The `id` and `receivedAt` fields
  stay in storage, `--json`, and `query` output; only the high-volume pretty table is slimmed to
  lower the token cost agents pay when reading logs.

## 0.2.0

### Minor Changes

- 99ccbe3: Automate releases with Changesets: merging a changeset opens a Version Packages PR that, once
  merged, tags the release and dispatches the native build and npm/Homebrew publish pipeline.
