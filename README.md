# agentic-debug-mode

An installable Agent Skill that stops your coding agent from guessing at bugs. Instead of
patching code based on a plausible-looking source read, the agent instruments the running program,
reproduces the failure, and proves the root cause with runtime evidence before it writes a fix.

Inspired from [Cursor's debug mode](https://cursor.com/blog/debug-mode) and built upon it: the same
hypothesis-driven core, made agent-agnostic (any coding agent that can run a CLI), and extended
with a session-scoped evidence store, hypothesis-tagged probes across nine languages, embedded
structured queries over captured events, at-source secret redaction, and bounded reads that keep
large evidence sets token-cheap.

```
Without the skill                        With the skill
─────────────────                        ──────────────
"This looks like a race condition,       Adds probes → reproduces → reads the
 let me add a lock."                       captured events → "The timeout fires
  → maybe fixes it, maybe not.             before the retry. CONFIRMED." → fixes
                                           the real cause and re-proves it.
```

## Install the skill

```bash
npx skills add Toubat/agentic-debug-mode --skill agentic-debug-mode --agent '*' --global
```

Omit `--global` for a project-scoped install. The skill is agent-neutral — `--agent '*'` installs
it for every agent the [Skills CLI](https://github.com/vercel-labs/skills) supports. To browse
before installing:

```bash
npx skills add Toubat/agentic-debug-mode --list
```

That is the whole setup. The skill installs the supporting CLI for you the first time it needs it.

## What the skill does

When a bug has no proven root cause, the skill drives your agent through an evidence loop rather
than a guessing loop:

- **Create** an isolated debug session for the investigation.
- **Instrument** the suspect code with generated runtime probes tied to a hypothesis.
- **Reproduce** the failure after a clean reset, so the run is repeatable.
- **Read the evidence** through bounded log reads and embedded queries — never by eyeballing raw
  output.
- **Verify** the hypothesis as confirmed, rejected, or inconclusive, then apply the fix and
  re-prove it against fresh evidence.

The core rule it enforces: source code only creates hypotheses; runtime evidence confirms them. No
fix ships before the evidence identifies the cause.

## What's under the hood

The skill is backed by `debug-mode`, a small evidence-collection CLI. It manages debug sessions,
generates language-specific probes, captures probe events, and serves them back through bounded
`logs` and `query` commands so the agent reads exactly what it needs and nothing more. All local
state lives under `~/.agent-debug-mode/`.

You normally never invoke the CLI yourself — the agent runs it. It self-installs on first use, so
no manual step is required. If you prefer it preinstalled:

```bash
npm install --global agentic-debug-mode
debug-mode --version
```

The npm launcher pulls one optional platform package and delegates to a standalone binary compiled
with Bun. Prebuilt binaries ship for macOS (arm64, x64), Linux (arm64, x64), and Windows (x64), and
a Homebrew formula is attached to each GitHub release.

## Supported languages

Each language and its ingest transport is exercised end to end through the compiled CLI and a real
runtime:

| Language   | Transport |
| ---------- | --------- |
| JavaScript | HTTP      |
| TypeScript | HTTP      |
| Python     | file      |
| Go         | file      |
| Ruby       | file      |
| PHP        | file      |
| PowerShell | file      |
| C#         | file      |
| Swift      | file      |
| Rust       | file      |
| C++        | file      |
| C          | file      |
| Java       | file      |

## Development

Requirements: Bun 1.3.14, Rust 1.91, and Node.js plus Python 3 for the live language fixtures.

```bash
bun install --frozen-lockfile
bun run check
bun run typecheck
bun run test
bun run build
```

Biome is the formatter and linter. The full architecture and contracts live in
[`DESIGN.md`](DESIGN.md) and
[`specs/building-a-debug-mode-agent.md`](specs/building-a-debug-mode-agent.md). Releases are
automated with [Changesets](https://github.com/changesets/changesets): record a bump with
`bun changeset`, and merging the generated **Version Packages** PR tags the release and publishes
the npm packages and Homebrew formula.

## License

[MIT](LICENSE)
