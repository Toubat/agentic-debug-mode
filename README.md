# agentic-debug-mode

`agentic-debug-mode` is an evidence-first debugging CLI and installable Agent Skill. It gives
coding agents isolated debug sessions, generated runtime probes, bounded log reads, embedded jaq
queries, and a repeatable reset-and-reproduce workflow.

The CLI is a standalone executable compiled with Bun. A background service starts on demand and
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

Create one session for the investigation and get a language template:

```bash
debug-mode create
debug-mode template --language typescript --ingest http
```

Insert the returned helper once and copy the returned call template for each observation. Keep all
`agent log` region markers. Then reset the session and reproduce the bug yourself:

```bash
debug-mode reset --session <session-id>
```

Read a bounded result:

```bash
debug-mode logs --session <session-id> --limit 100
```

Filter or transform evidence with embedded jaq:

```bash
debug-mode query --session <session-id> 'select(.message | test("timeout|deadline"; "i"))'
```

Use `--slurp` for operations across the complete record stream:

```bash
debug-mode query --session <session-id> --slurp \
  'group_by(.hypothesisId) | map({hypothesisId: .[0].hypothesisId, count: length})'
```

Apply the fix, `reset` and reproduce again, and compare evidence. Remove the regions and
`debug-mode stop` once the post-fix evidence proves the fix.

## Supported probes

Advertised, end-to-end-tested language and transport pairs:

- JavaScript + HTTP, TypeScript + HTTP;
- Python, Go, Ruby, PHP, PowerShell, C#, and Swift + direct NDJSON append.

Each renderer is exercised through the compiled CLI, its real language runtime, and the public
`template` and `logs` commands.

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
[`specs/building-a-debug-mode-agent.md`](specs/building-a-debug-mode-agent.md).

## Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets):

1. Alongside a change, record the intended version bump:

   ```bash
   bun changeset
   ```

   Choose `patch`, `minor`, or `major`, write a one-line summary, and commit the generated file in
   `.changeset/`.

2. When the change lands on `main`, the `Changesets` workflow opens (or updates) a **Version
   Packages** pull request that consumes the pending changesets, bumps the root version, and — via
   the `version` script — propagates that version into the npm launcher and platform packages.

3. Merging the Version Packages PR tags the release (`vX.Y.Z`) and dispatches the `Release`
   workflow, which builds the native binaries and publishes the npm packages and Homebrew formula.

No manual tagging or extra secrets are required.

