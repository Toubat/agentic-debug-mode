# agentic-debug-mode

`agentic-debug-mode` is an evidence-first debugging CLI and installable Agent Skill. It gives
coding agents isolated debug sessions, generated runtime probes, bounded log reads, embedded jaq
queries, and a repeatable baseline/post-fix workflow.

The CLI is a standalone executable compiled with Bun. A user-scoped daemon starts on demand and
stores all local state under `~/.agent-debug-mode/`.

## Install the CLI

Run without a global install:

```bash
npx --yes agentic-debug-mode@latest --version
```

Or install the npm launcher:

```bash
npm install --global agentic-debug-mode
debug-mode --version
```

The npm launcher installs one optional platform package and delegates to its standalone binary.
Release artifacts are also published for:

- macOS arm64 and x64;
- Linux arm64 and x64;
- Windows x64.

The Homebrew formula is generated with release checksums and attached to each GitHub release.

## Install the skill

The skill is agent-neutral. The Skills CLI's `--agent` option chooses its installation location;
it does not require a different workflow for each agent.

```bash
npx skills add Toubat/debug-mode --list
npx skills add Toubat/debug-mode --skill agentic-debug-mode --agent '*' --global
```

Omit `--global` for a project-scoped install.

## Quick start

Start a baseline run with explicit hypotheses:

```bash
debug-mode start \
  --workspace "$PWD" \
  --language typescript \
  --run-id baseline \
  --hypothesis H1 \
  --hypothesis H2 \
  --json
```

Insert the returned helper once and copy the returned call template for each observation. Keep
all generated `agent log` region markers.

After reproducing the bug, read a bounded result:

```bash
debug-mode logs \
  --session <session-id> \
  --run-id baseline \
  --limit 100
```

Filter or transform evidence with embedded jaq:

```bash
debug-mode query \
  --session <session-id> \
  --run-id baseline \
  'select(.message | test("timeout|deadline"; "i"))'
```

Use `--slurp` for operations across the complete selected record stream:

```bash
debug-mode query \
  --session <session-id> \
  --run-id baseline \
  --slurp \
  'group_by(.hypothesisId) | map({hypothesisId: .[0].hypothesisId, count: length})'
```

## Supported probes

- JavaScript: non-blocking loopback HTTP;
- TypeScript: non-blocking loopback HTTP;
- Python: bounded direct NDJSON append.

Each advertised renderer is exercised through a compiled CLI, its real language runtime, and the
public `start` and `logs` commands.

## Development

Requirements:

- Bun 1.3.14;
- Rust 1.91;
- Node.js and Python 3 for live language fixtures.

```bash
bun install --frozen-lockfile
bun run check
bun run typecheck
bun run test
bun run build
```

Biome is the formatter and linter. `bun run test` serializes resource-sensitive daemon stress
tests, then runs language and standalone-distribution suites independently.

The full architecture and contracts are documented in
[`docs/building-a-debug-mode-agent.md`](docs/building-a-debug-mode-agent.md).

