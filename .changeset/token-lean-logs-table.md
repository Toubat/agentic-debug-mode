---
"agentic-debug-mode": patch
---

Token-lean logs table: drop the ID and RECEIVED columns and render TIME as a compact
`HH:MM:SS.mmm` clock with the UTC date printed once as a header. The `id` and `receivedAt` fields
stay in storage, `--json`, and `query` output; only the high-volume pretty table is slimmed to
lower the token cost agents pay when reading logs.
