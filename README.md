<p align="center">
  <img src="banner.png" alt="Swamp — AI Automation for Hackers">
</p>

# Swamp

AI Native Automation, built for agents - Welcome to the Swamp.

Swamp is a CLI that supercharges AI agents to create operational workflows that
are reviewable, shareable, and accurate. Built for agents, there to empower
humans. All the data lives in the `.swamp/` (the swamp).

> **Open Alpha** — Swamp is under active development. Expect breaking changes,
> rough edges, and rapid iteration. We're here to support you — file
> [bug reports and feature requests](https://github.com/systeminit/swamp/issues)
> and we'll take care of the rest. Have fun with it.

## Getting Started

```bash
curl -fsSL https://swamp.club/install.sh | sh
```

### Quick Start

```bash
swamp repo init
```

Start Claude Code in the repo and tell it what you want to do. Just ask:

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

## License

Swamp is licensed under the [GNU Affero General Public License v3.0](COPYING)
with the [Swamp Extension and Definition Exception](COPYING-EXCEPTION). See
[COPYRIGHT](COPYRIGHT) and [CONTRIBUTING.md](CONTRIBUTING.md) for details.
