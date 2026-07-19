# agentic-debug-mode

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
