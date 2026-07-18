# Debug Mode worked examples

Two end-to-end investigations that follow [SKILL.md](SKILL.md). Both reuse one session across reset
cycles and read evidence only through `logs`, `query`, and `status`. `<id>` is the Session ID from
`debug-mode create`.

## Example 1 — TypeScript cache returns stale prices (HTTP)

**Symptom.** A repricing endpoint sometimes returns an old subtotal. Expected: fresh price after a
cart change. Hypotheses: `H1` cache key collision, `H2` cache read happens before the write
completes, `H3` discount branch skipped.

### Set up

```bash
debug-mode create
debug-mode template --language typescript --ingest http
```

Insert the helper once in the repricing module, then one call region per hypothesis, each in its own
`// #region agent log` … `// #endregion` block, replacing the ingest placeholder with the Ingest
URL:

```ts
// #region agent log
__agentDebugEmit({
  hypothesisId: "H2",
  location: "src/cache.ts:84",
  message: "Cache read resolved",
  data: { cacheKey, hit, writeInFlight },
});
// #endregion
```

### Reproduce and read

```bash
debug-mode reset --session <id>
# run the reproduction yourself:
npm test -- reprice
debug-mode logs --session <id> --limit 100
```

Narrow to the suspicious path:

```bash
debug-mode query --session <id> 'select(.hypothesisId == "H2" and .data.writeInFlight == true)'
```

Events show `hit: true` while `writeInFlight: true` — the read races the write. `H2` **CONFIRMED**,
`H1` and `H3` **REJECTED** (no key collisions, discount branch present).

### Fix and verify

Await the write before the read. Keep every observation in place. Record the baseline (races
present), apply the fix, then:

```bash
debug-mode reset --session <id>
npm test -- reprice
debug-mode query --session <id> 'select(.data.writeInFlight == true and .data.hit == true)'
```

Post-fix evidence returns no rows (race gone) and a follow-up query confirms fresh subtotals. Only
now remove the `agent log` regions, then:

```bash
debug-mode stop
```

## Example 2 — Python worker drops tasks under load (file)

**Symptom.** A queue worker occasionally finishes without processing a task. Hypotheses: `H1` task
filtered out by a stale predicate, `H2` exception swallowed mid-batch.

```bash
debug-mode create
debug-mode template --language python --ingest file
```

Insert the file helper once, replacing the append-path placeholder with the Append Path, then a call
region per hypothesis using `# region agent log` … `# endregion`:

```python
# region agent log
__agent_debug_emit(
    "H2",
    "app/worker.py:132",
    "Batch item handled",
    {"taskId": task.id, "status": status, "caught": caught_type},
)
# endregion
```

Reproduce and inspect:

```bash
debug-mode reset --session <id>
python -m worker --once
debug-mode logs --session <id> --limit 100
debug-mode query --session <id> --slurp \
  'group_by(.data.status) | map({status: .[0].data.status, count: length})'
```

The grouping shows a cluster of `caught: "KeyError"` items with `status: "skipped"`. `H2`
**CONFIRMED**. If a batch produced no events for expected tasks, that silence is `INCONCLUSIVE`, not
proof — add a control observation at the loop entry and reproduce again.

If `logs` warns about malformed records, inspect all of them and fix the emitting observation:

```bash
debug-mode status --session <id>
```

After the fix, `reset`, reproduce, and re-run the grouping query. When the skipped cluster is gone
and expected tasks appear, remove the regions and `debug-mode stop`.

## Recovering a lost session

If you no longer have the Session ID:

```bash
debug-mode sessions
```

Pick the right one from the list and continue with `--session <id>`. To delete an investigation
entirely when the user asks:

```bash
debug-mode clean --session <id>
```
