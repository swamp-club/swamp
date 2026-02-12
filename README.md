<p align="center">
  <img src="logo.png" alt="swamp logo" width="200">
</p>

# swamp

AI Native Automation, built for agents.

Swamp gives AI agents (and humans) a structured way to manage infrastructure,
run automation workflows, and track the data they produce — all stored as plain
YAML in a Git repository.

> **Open Alpha** — Swamp is under active development. Expect breaking changes,
> rough edges, and rapid iteration. We're here to support you — file
> [bug reports and feature requests](https://github.com/systeminit/swamp/issues)
> and we'll take care of the rest. Have fun with it.

## Getting Started

### Install

Download the latest binary for your platform:

**macOS (Apple Silicon):**

```bash
curl -fsSL "$(gh release view --repo systeminit/swamp --json assets --jq '.assets[] | select(.name == "swamp-darwin-aarch64") | .url')" -o swamp
chmod +x swamp && sudo mv swamp /usr/local/bin/
```

Or grab it directly from the
[latest release](https://github.com/systeminit/swamp/releases/latest).

Binaries are available for macOS (Apple Silicon, Intel) and Linux (x86_64,
aarch64).

### Quick Start

```bash
# Initialize a swamp repo in the current directory
swamp repo init

# Create a model definition
swamp model create command/shell my-server-check

# Edit the definition to configure it
# (the file path is printed by the create command)
swamp model edit my-server-check

# Validate your definition
swamp model validate my-server-check

# Run a method
swamp model method run my-server-check execute

# See what data was produced
swamp model output search my-server-check
```

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

## Core Concepts

- **Models** — Typed representations of external systems (cloud resources, CLI
  tools, APIs). Each model type defines metadata, attributes, methods, and
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

## Using Swamp with AI Agents

Swamp is designed to be driven by AI agents. We currently ship
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) skills that teach
Claude how to work with swamp — search for models, create definitions, run
workflows, manage vaults, and more.

The skills live in `.claude/skills/` and are bundled into the swamp binary. Run
`swamp` inside a Claude Code session and Claude will discover them
automatically.

While Claude Code is our primary supported agent today, the patterns are
transferable to any AI agent or automation platform. The skills are plain
markdown — read them, adapt them, bring them to your preferred tools.

### User-Defined Models

Extend swamp with custom TypeScript models. Place them in `extensions/models/`
(or configure via `SWAMP_MODELS_DIR` or `.swamp.yaml`).

See the [extension model guide](.claude/skills/swamp-extension-model/SKILL.md)
for details.

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

Only employees of System Initiative, Inc. contribute code to Swamp. We welcome
bug reports and feature requests — see [CONTRIBUTING.md](CONTRIBUTING.md) for
details.

## License

Swamp is licensed under the [GNU Affero General Public License v3.0](COPYING)
with the [Swamp Extension and Definition Exception](COPYING-EXCEPTION). See
[COPYRIGHT](COPYRIGHT) and [CONTRIBUTING.md](CONTRIBUTING.md) for details.
