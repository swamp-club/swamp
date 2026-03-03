<p align="center">
  <img src="banner.png" alt="Swamp — AI Automation for Hackers">
</p>

# Swamp

AI Native Automation, built for agents - Welcome to Swamp.

Swamp is a CLI that supercharges AI agents to create operational workflows that
are reviewable, shareable, and accurate. Built for agents, there to empower
humans. All the data lives in the `.swamp/` (the swamp).

> **Open Alpha** — Swamp is under active development. Expect breaking changes,
> rough edges, and rapid iteration. We're here to support you — file
> [bug reports and feature requests](https://github.com/systeminit/swamp/issues)
> and we'll take care of the rest. Have fun with it.

Come join the [swamp party on discord](https://discord.gg/swamp-club).

## Getting Started

```bash
curl -fsSL https://swamp.club/install.sh | sh
```

### Quick Start

```bash
swamp repo init                    # Claude Code (default)
swamp repo init --tool cursor      # Cursor
swamp repo init --tool opencode    # OpenCode
swamp repo init --tool codex       # Codex
```

Start your AI agent in the repo and tell it what you want to do. Just ask:

- _"Manage my EC2 fleet — inventory every instance across all regions and flag
  anything without a cost-center tag"_
- _"Set up a workflow to check my bare metal Minecraft servers are online and
  under 80% memory"_
- _"Audit our DNS records and compare them against what's actually running"_
- _"Build a workflow that rotates database credentials and stores them in the
  vault"_

The agent will create models, wire up workflows, and run them — all reviewable
in `.swamp/` before anything touches production.

## Core Concepts

- **Models** — Typed representations of external systems (cloud resources, CLI
  tools, APIs). Each model type defines metadata, arguments, methods, and
  inputs.
- **Definitions** — YAML files that instantiate a model type with specific
  configuration. Support CEL expressions for dynamic values and cross-model
  references.
- **Workflows** — Orchestrate model method executions across parallel jobs and
  steps, with dependency ordering and trigger conditions.
- **Data** — Versioned, immutable artifacts (resources, logs, files) produced by
  method runs. Searchable by tags.
- **Vaults** — Secure storage for secrets and credentials, referenced in
  definitions via CEL expressions.
- **Tags** — Key-value labels on definitions, workflows, and data. Flow from
  definitions to produced data, overridable at runtime with `--tag`.

Everything lives in a `.swamp/` directory inside a Git repository, with
human-friendly symlink views under `/models/` and `/workflows/`.

### Local Execution

Swamp runs entirely on your machine. It picks up the environment variables from
the shell you run it in — your AWS credentials, SSH keys, kubeconfig, whatever
the task needs. No credentials leave your laptop unless a model explicitly calls
an external API.

---

### Update

Swamp can update itself:

```bash
swamp update
```

### Shell Completions

Tab-completion for commands, model names, and workflow names:

```bash
# Bash — add to ~/.bashrc
eval "$(swamp completions bash)"

# Zsh with oh-my-zsh
mkdir -p ~/.oh-my-zsh/completions
swamp completions zsh > ~/.oh-my-zsh/completions/_swamp
rm -f ~/.zcompdump* && exec zsh

# Zsh without oh-my-zsh — add to ~/.zshrc
eval "$(swamp completions zsh)"

# Fish
swamp completions fish > ~/.config/fish/completions/swamp.fish
```

Completions are directory-dependent — they return names from the current
directory's swamp repository.

## Using Swamp with AI Agents

Swamp ships first-class skills for four AI coding tools:

| Tool                                                          | Init flag         | Skills dir        | Instructions file         |
| ------------------------------------------------------------- | ----------------- | ----------------- | ------------------------- |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | _(default)_       | `.claude/skills/` | `CLAUDE.md`               |
| [Cursor](https://cursor.com)                                  | `--tool cursor`   | `.cursor/skills/` | `.cursor/rules/swamp.mdc` |
| [OpenCode](https://opencode.ai)                               | `--tool opencode` | `.agents/skills/` | `AGENTS.md`               |
| [Codex](https://openai.com/codex)                             | `--tool codex`    | `.agents/skills/` | `AGENTS.md`               |

The skills are bundled into the swamp binary and written into the appropriate
directory so your agent discovers them automatically. Each skill teaches the
agent how to work with swamp — search for models, create definitions, run
workflows, manage vaults, and more.

You can switch tools later or run multiple tools side-by-side — each tool's
skills directory is independent and gitignored:

```bash
swamp repo upgrade --tool cursor
```

### User-Defined Models

Extend Swamp with custom TypeScript models. Place them in `extensions/models/`
(or configure via `SWAMP_MODELS_DIR` or `.swamp.yaml`).

See the extension model skill in your skills directory (e.g.
`.claude/skills/swamp-extension-model/SKILL.md` for Claude Code) for details.

## Developer Guide

### Prerequisites

- [Deno](https://deno.land/) (latest)

### Commands

```bash
deno run dev          # Run the CLI from source
deno run test         # Run the test suite
deno check            # Type-check
deno lint             # Lint
deno fmt              # Format
deno run compile      # Compile the binary
```

### Contributing

Swamp uses an **issue-driven contribution model**. We don't accept pull requests
from external contributors — fork PRs are automatically closed. This isn't about
gatekeeping; it's about supply chain security in the age of AI-generated code.
When AI agents can produce large, plausible-looking changes, the only way to
maintain quality and security is to tightly control the inputs to the
development process.

**Here's how it works:**

1. **You file an issue** —
   [bug reports and feature requests](https://github.com/systeminit/swamp/issues)
   are very welcome. Be as detailed as you like.
2. **We plan it** — A maintainer comments `/plan` on the issue and Claude
   generates a detailed implementation plan, right there in the issue thread.
   Maintainers can iterate on the plan with `/plan-update` and feedback.
3. **We build it** — System Initiative engineers (with AI agents under our
   direct control) implement the plan, with full test coverage and code review.
4. **You get credit** — We're happy to include you as a co-author on any PR
   generated from your request.

This means you get the feature you asked for, maintained over time, without
having to worry about keeping a fork in sync. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full details.

## Log Level

By default, swamp outputs at the `info` level. You can change this once rather
than repeating a flag on every command.

Per-invocation flags (highest priority):

```bash
swamp -q workflow run my-workflow               # error level only
swamp --log-level debug workflow run my-workflow
```

Via environment variable (useful for CI/CD):

```bash
export SWAMP_LOG_LEVEL=warning
swamp workflow run my-workflow
```

Permanently for a repository — add to `.swamp.yaml`:

```yaml
logLevel: error
```

Valid levels: `trace`, `debug`, `info`, `warning`, `error`, `fatal`.

Priority order (highest to lowest): `-q` / `--log-level` flag →
`SWAMP_LOG_LEVEL` env var → `.swamp.yaml` `logLevel` → default (`info`).

## Telemetry

Swamp collects anonymous usage telemetry to help us understand which commands
are used, how long they take, and what errors occur. All user-identifiable
values are redacted before transmission — nothing sensitive is ever sent.

Here is a complete example of a telemetry event:

```json
{
  "event": "cli_invocation",
  "distinct_id": "a3f1b2c4-5678-9abc-def0-1234567890ab",
  "properties": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "invocation": {
      "command": "model",
      "subcommand": "create",
      "args": ["prompt", "<REDACTED>"],
      "optionKeys": ["--force"],
      "globalOptions": ["--json"]
    },
    "result": {
      "status": "success",
      "exitCode": 0
    },
    "startedAt": "2026-02-16T10:00:00.000Z",
    "completedAt": "2026-02-16T10:00:01.234Z",
    "durationMs": 1234,
    "swampVersion": "0.13.0",
    "denoVersion": "2.1.0",
    "platform": "linux"
  }
}
```

Note that positional arguments containing user data (model names, file paths,
queries) are replaced with `<REDACTED>`. Only categorical values defined by
swamp itself (like model types) are recorded. Option values are never recorded —
only the option keys.

### Disabling Telemetry

Per-invocation:

```bash
swamp --no-telemetry workflow run my-workflow
```

Via environment variable (useful for CI/UAT environments):

```bash
export SWAMP_NO_TELEMETRY=1
swamp workflow run my-workflow
```

Permanently for a repository — add to `.swamp.yaml`:

```yaml
telemetryDisabled: true
```

Priority order (highest to lowest): `--no-telemetry` flag → `SWAMP_NO_TELEMETRY`
env var → `.swamp.yaml` `telemetryDisabled: true`.

## License

Swamp is licensed under the [GNU Affero General Public License v3.0](COPYING)
with the [Swamp Extension and Definition Exception](COPYING-EXCEPTION). See
[COPYRIGHT](COPYRIGHT) and [CONTRIBUTING.md](CONTRIBUTING.md) for details.
