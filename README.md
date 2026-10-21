<p align="center">
  <img src="banner.png" alt="Swamp — The right way to build with AI">
</p>

# Swamp

The right way to build with AI.

Build AI systems from repeatable behaviors, rather than token-hungry
agent-centric designs. Swamp is a CLI that teaches your AI agent to break a
problem down into reusable behaviors and connect them into workflows you can
review, share and run again. By default the data lives in `.swamp/` (the swamp).

Why it's better:

- **Use your favorite harness** — Claude Code, Cursor, Codex, OpenCode, Kiro and
  more.
- **Connect to any API** — start from thousands of existing extensions or write
  your own.
- **Store and query your data** — versioned, with a lifetime you control.
- **Keep secrets safe** — credentials come from vaults, are injected only when
  needed and are redacted from the output.
- **See exactly what happened every time** — every run is recorded.

Come join the [swamp party on discord](https://discord.gg/swamp-club).

## Getting Started

Swamp runs on macOS and Linux (x86_64 and arm64) and on Windows (x86_64).

On macOS and Linux:

```bash
curl -fsSL https://swamp-club.com/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://swamp-club.com/install.ps1 | iex
```

The Windows installer puts swamp in `C:\Program Files\swamp` and adds it to the
system PATH when run as administrator, and otherwise in `%LOCALAPPDATA%\swamp`
with the user PATH.

### Quick Start

```bash
swamp start
```

`swamp start` opens your browser. Sign in to Swamp Club (this creates your
swamp-club.com account if you don't have one yet — swamp needs one to run), pick
a workspace, describe what you want automated, and choose an AI agent found on
your machine. Swamp opens the agent in a new terminal window, already working on
your task. Press Ctrl-C in the terminal to stop `swamp start`.

New workspaces are created under `~/.swamp/workspaces/`
(`$SWAMP_HOME/workspaces/` when `SWAMP_HOME` is set), and you can import an
existing swamp repo where it already is. A workspace keeps every task you give
it, each with its own brief in `tasks/`, listed newest first with when it was
created. Coming back to a workspace lets you open any task, relaunch its agent,
open another agent, or start a new task. `swamp start status` lists your
workspaces and the agents on your PATH. `swamp workspace` manages them from the
terminal: `create`, `import`, `list`, `get` and `remove`. Removing a workspace
takes it off the list and keeps its folder.

To use swamp inside an existing project instead, sign in, initialize the project
as a repository and start your agent there:

```bash
swamp auth login                   # skip if swamp start already signed you in
swamp repo init                    # Claude Code (default)
swamp repo init --tool cursor      # Cursor
swamp repo init --tool opencode    # OpenCode
swamp repo init --tool codex       # Codex
```

For CI and daemons, see the
[Swamp Account Requirement](https://swamp-club.com/manual/reference/swamp-account-requirement).

Start your AI agent in the repo and tell it what you want to do. Just ask:

- _"Manage my EC2 fleet — inventory every instance across all regions and flag
  anything without a cost-center tag"_
- _"Set up a workflow to check my bare metal Minecraft servers are online and
  under 80% memory"_
- _"Audit our DNS records and compare them against what's actually running"_
- _"Build a workflow that rotates database credentials and stores them in the
  vault"_

The agent will create behaviors, wire them into workflows, and run them — all
reviewable in the repo before anything touches production.

## Learn More

You can
[learn more about swamp by reading the manual](https://swamp-club.com/manual).
[How Swamp Works](https://swamp-club.com/manual/explanation/how-swamp-works) is
the best place to start - it provides an overview of the entire system.

## Core Concepts

- **Behaviors** — Reusable, composable units that break problems into
  manageable, scalable components. A behavior type (a cloud resource, a CLI
  tool, an API) declares its arguments and methods; a behavior definition is a
  YAML file that configures one, with CEL expressions for dynamic values and
  references to other behaviors. Behaviors used to be called models, and
  `swamp model` still works as the old name for `swamp behavior`.
- **Workflows** — Connected sequences of behaviors that run in order, such as
  fetch-alert → inspect-cluster → triage → route-to-slack. Steps run across
  parallel jobs with dependency ordering and trigger conditions.
- **Extensions** — Ready-made integrations connecting to APIs, databases and
  services. Pull them from the registry or write your own.
- **Vaults** — Secure credential storage that injects secrets only when they're
  needed and redacts them from output. Definitions reference them through CEL
  expressions.
- **Datastore** — Structured data storage with versioning, indexing and lifetime
  management. Every method run produces immutable, versioned data (resources,
  logs, files), labelled with tags that flow from definitions and can be
  overridden at runtime with `--tag`.

Definitions, workflows and vaults are files in your Git repository, under
`models/`, `workflows/` and `vaults/`. Runtime data goes to the datastore, which
is the `.swamp/` directory unless you configure another one (see
[Datastores](#datastores)).

### Local Execution

Swamp runs entirely on your machine. It picks up the environment variables from
the shell you run it in — your AWS credentials, SSH keys, kubeconfig, whatever
the task needs. No credentials leave your laptop unless a behavior explicitly
calls an external API.

---

### Update

Swamp can update itself in place:

```bash
swamp update
```

### Shell Completions

Tab-completion for commands, behavior names, and workflow names:

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

```powershell
# PowerShell (Windows PowerShell 5.1 and PowerShell 7) — add to $PROFILE
swamp completions powershell | Out-String | Invoke-Expression
```

Completions are directory-dependent — they return names from the current
directory's swamp repository.

## Using Swamp with AI Agents

Swamp ships first-class skills for nine AI coding tools:

| Tool                                                                                                         | Init flag            | Skills dir        | Instructions file               |
| ------------------------------------------------------------------------------------------------------------ | -------------------- | ----------------- | ------------------------------- |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code)                                                | _(default)_          | `.claude/skills/` | `CLAUDE.md`                     |
| [Cursor](https://cursor.com)                                                                                 | `--tool cursor`      | `.cursor/skills/` | `.cursor/rules/swamp.mdc`       |
| [OpenCode](https://opencode.ai)                                                                              | `--tool opencode`    | `.agents/skills/` | `AGENTS.md`                     |
| [Codex](https://openai.com/codex)                                                                            | `--tool codex`       | `.agents/skills/` | `AGENTS.md`                     |
| [Kiro](https://kiro.dev)                                                                                     | `--tool kiro`        | `.kiro/skills/`   | `.kiro/steering/swamp-rules.md` |
| [Amp](https://ampcode.com)                                                                                   | `--tool amp`         | `.agents/skills/` | `AGENTS.md`                     |
| [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) | `--tool copilot`     | `.agents/skills/` | `AGENTS.md`                     |
| [Pi](https://pi.dev)                                                                                         | `--tool pi`          | `.agents/skills/` | `AGENTS.md`                     |
| [Antigravity](https://antigravity.google)                                                                    | `--tool antigravity` | `.agents/skills/` | `AGENTS.md`                     |

The skills are bundled into the swamp binary and written into the appropriate
directory so your agent discovers them automatically. Each skill teaches the
agent how to work with swamp — search for behaviors, create definitions, run
workflows, manage vaults, and more.

Claude Code reads `AGENTS.md` only when there is no `CLAUDE.md`, so in a repo
that has its own `AGENTS.md` and no `CLAUDE.md` (or whose `CLAUDE.md` is a
symlink), swamp writes its instructions to `.claude/rules/swamp.md` instead.
Repeat `--tool` to set up several tools at once, and define a tool swamp doesn't
know with `swamp agent setup`.

You can switch tools later or run multiple tools side-by-side — each tool's
skills directory is independent and gitignored:

```bash
swamp repo upgrade --tool cursor
```

### User-Defined Behaviors

Extend Swamp with custom TypeScript behaviors. Place them in
`extensions/behaviors/` or `extensions/models/`, or choose another directory
with `SWAMP_BEHAVIORS_DIR` (or its old name `SWAMP_MODELS_DIR`) or `modelsDir`
in `.swamp.yaml`. `extensions/behaviors/` is only read while the default
directory is in use.

See the swamp skill in your skills directory (e.g.
`.claude/skills/swamp/SKILL.md` for Claude Code) for details.

## Developer Guide

### Prerequisites

- [Deno](https://deno.land/), at the version pinned in `.tool-versions`

`.tool-versions` is the single source of truth for the toolchain — CI, the
Docker image, and the runtime embedded in released binaries all derive from it.
Deno has no native per-project version pinning, so the recommended setup is
[mise](https://mise.jdx.dev/), which reads `.tool-versions` and switches
versions on `cd`:

```bash
mise install    # installs the pinned Deno
```

mise is optional — `deno upgrade --version <pinned version>` works too. What is
_not_ optional is that `deno` resolves on a plain, non-login shell's `PATH`. The
verification workflows invoke a bare `deno` through `command/shell` steps that
get no shell activation hook, so a mise setup that only activates in interactive
shells will fail them with exit 127. Confirm with:

```bash
which deno
```

To change the Deno version, edit `.tool-versions` and update the `Dockerfile` to
match — `integration/toolchain_pins_rules_test.ts` fails if they drift.

### Commands

```bash
deno run dev          # Run the CLI from source
deno run test         # Run the test suite
deno check            # Type-check
deno lint             # Lint
deno fmt              # Format
deno run compile      # Compile the binary
```

### License Compliance

`deno run sbom` generates a [CycloneDX](https://cyclonedx.org/) SBOM of every
npm and JSR dependency for license-compliance scanning. See
[scripts/README.md](scripts/README.md) for details on the generator, license
resolution, and scanning with FOSSA.

### Contributing

Swamp uses an **issue-driven contribution model**. We don't accept pull requests
from external contributors — fork PRs are automatically closed. This isn't about
gatekeeping; it's about supply chain security in the age of AI-generated code.
When AI agents can produce large, plausible-looking changes, the only way to
maintain quality and security is to tightly control the inputs to the
development process.

**Here's how it works:**

1. **You file an issue** —
   [bug reports and feature requests](https://swamp-club.com/lab) are very
   welcome. Be as detailed as you like.
2. **We triage it** — A maintainer triages the issue locally using Claude,
   confirms bugs by tracing through the codebase, and generates a detailed
   implementation plan. Plans are revised interactively until the approach is
   solid.
3. **We build it** — Elder Swamp Club engineers (with AI agents under our direct
   control) implement the plan, with full test coverage and code review.
4. **You get credit** — We're happy to include you as a co-author on any PR
   generated from your request.

This means you get the feature you asked for, maintained over time, without
having to worry about keeping a fork in sync. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full details.

## Datastores

By default, swamp stores all runtime data (behavior data, workflow runs,
outputs, audit logs, etc.) in the local `.swamp/` directory. You can configure a
different datastore backend to share state across machines or centralise data.

### Default (local filesystem)

When you run `swamp repo init`, the datastore is `.swamp/` inside the repo. No
extra configuration needed.

### Setting up an external filesystem datastore

Move runtime data to a directory outside the repo (e.g. a shared NFS mount):

```bash
swamp datastore setup filesystem --path /mnt/shared/swamp-data
```

This migrates existing `.swamp/` runtime data to the new path and updates
`.swamp.yaml`. A file-based lock prevents concurrent access from multiple
processes.

### Setting up an S3 datastore

Store runtime data in S3 for team collaboration using the `@swamp/s3-datastore`
extension:

```bash
swamp datastore setup extension @swamp/s3-datastore \
  --config '{"bucket":"my-swamp-bucket","prefix":"my-project","region":"us-east-1"}'
```

This pushes existing local data to S3 and updates `.swamp.yaml`. Subsequent
commands automatically pull changes before execution and push changes after. A
distributed lock (S3 conditional writes) prevents concurrent access.

Use `--skip-migration` on either setup command to skip the initial data
migration.

### Migrating between datastores

Run `swamp datastore setup` again with the new backend. For example, to move
from a filesystem datastore to S3:

```bash
swamp datastore setup extension @swamp/s3-datastore \
  --config '{"bucket":"my-bucket","region":"us-east-1"}'
```

Or from S3 back to local filesystem:

```bash
swamp datastore setup filesystem --path /path/to/data
```

Each setup command migrates existing data to the new backend.

### Checking datastore status

```bash
swamp datastore status        # Shows type, health, and config
swamp datastore sync          # Manual bidirectional sync (S3 only)
swamp datastore sync --pull   # Pull-only from S3
swamp datastore sync --push   # Push-only to S3
```

### Stuck locks

If a process crashes without releasing the datastore lock, subsequent commands
will wait up to 60 seconds before timing out (locks auto-expire after 30
seconds). To inspect or force-release a stuck lock:

```bash
swamp datastore lock status           # Show who holds the lock
swamp datastore lock release --force  # Force-release the lock
```

### Environment variable override

For CI/CD, override the datastore without modifying `.swamp.yaml`:

```bash
export SWAMP_DATASTORE=s3:my-bucket/my-prefix
export SWAMP_DATASTORE=filesystem:/tmp/swamp-data
```

## Repository Directory

Every command runs against a swamp repository. By default this is the current
working directory. Pass `--repo-dir` to point at a different repo per
invocation, or set `SWAMP_REPO_DIR` to persist the override across a shell
session or CI job:

```bash
swamp behavior search --repo-dir /path/to/repo
export SWAMP_REPO_DIR=/path/to/repo
swamp behavior search
```

Priority order (highest to lowest): `--repo-dir` flag → `SWAMP_REPO_DIR` env var
→ current working directory.

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

## Tracing

Swamp has native OpenTelemetry tracing for diagnosing slow or failing
operations. Tracing is opt-in and has zero overhead when disabled.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to enable both signals through a shared
collector, or configure a signal-specific endpoint:

```bash
# Send traces to a local Jaeger instance
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 swamp workflow run my-workflow

# Quick debug: print spans to stderr (no collector needed)
OTEL_TRACES_EXPORTER=console swamp workflow run my-workflow
```

Traces capture the full execution hierarchy — CLI command, workflow, job, step,
and method — with automatic context propagation to in-process extensions and
remote workers (including containerized ones) via `TRACEPARENT`.

### Logs

When a generic or logs-specific OTLP endpoint is configured, swamp also emits
its structured log lines as native OpenTelemetry **log records** over OTLP. Each
record is stamped with the active `trace_id`/`span_id`, so logs correlate with
the spans they belong to and are filterable by trace, service, and severity in
the backend — no need to read a local log file. This is most useful for
long-running `swamp serve` daemons. Secrets registered for a run are redacted
from log bodies and attributes before they leave the process, just as they are
in the persisted per-run log files.

Opt out with `OTEL_LOGS_EXPORTER=none` (traces stay on). For high-volume
`swamp serve`, set `OTEL_BLRP_USE=1` to batch log exports instead of sending one
request per line.

```bash
# Export both traces and correlated logs to a collector
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 swamp serve

# Traces only — disable the logs signal
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_LOGS_EXPORTER=none swamp serve
```

### Local development

Run Jaeger for a local trace UI:

```bash
docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
```

Then open `http://localhost:16686` and search for the `swamp` service.

### Configuration

| Variable                              | Purpose                                   | Default                |
| ------------------------------------- | ----------------------------------------- | ---------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | Shared collector base URL                 | _(none)_               |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | Complete traces URL; overrides shared URL | shared + `/v1/traces`  |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`    | Complete logs URL; overrides shared URL   | shared + `/v1/logs`    |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Complete future metrics URL               | shared + `/v1/metrics` |
| `OTEL_EXPORTER_OTLP_HEADERS`          | Shared headers (`key=val,key=val`)        | _(none)_               |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`   | Trace headers; replace shared headers     | shared headers         |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS`     | Log headers; replace shared headers       | shared headers         |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS`  | Future metrics headers; replace shared    | shared headers         |
| `OTEL_TRACES_EXPORTER`                | `otlp`, `console`, or `none`              | `otlp`                 |
| `OTEL_LOGS_EXPORTER`                  | `otlp`, `console` (stderr), or `none`     | `otlp`                 |
| `OTEL_SERVICE_NAME`                   | Service name for traces and logs          | `swamp`                |
| `OTEL_BLRP_USE`                       | Batch log exports (`1` to enable)         | _(per-record)_         |

Signal-specific endpoint values are complete URLs and take precedence over the
shared base URL. Signal-specific headers replace, rather than merge with, the
shared headers. Empty signal-specific values fall back to the shared setting.
The metrics variables establish the same configuration contract for future
native metrics support; swamp currently emits traces and logs only.

For a backend such as Axiom that routes each signal to a different dataset:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.axiom.co/v1/traces
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer TOKEN,X-Axiom-Dataset=swamp-traces"
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://api.axiom.co/v1/logs
export OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer TOKEN,X-Axiom-Dataset=swamp-logs"

# Reserved for future native metrics export
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://api.axiom.co/v1/metrics
export OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer TOKEN,X-Axiom-Metrics-Dataset=swamp-metrics"
```

## Telemetry

Swamp collects anonymous usage telemetry to help us understand which commands
are used, how long they take, and what errors occur. Command words and the names
you pass — behavior, workflow, vault and type names, ids and search queries —
are sent as typed. Filesystem paths, option and input values, secrets, access
groups and principals, and `data query` predicates are redacted before
transmission, and paths in error messages are replaced with `<PATH>`.

Telemetry is **user-global** — events are spooled to a single directory
regardless of which repository (if any) you are working in:

```
~/.config/swamp/telemetry/
```

The path is XDG-aware: if `$XDG_CONFIG_HOME` is set, the spool lives at
`$XDG_CONFIG_HOME/swamp/telemetry/` instead. Setting `$SWAMP_HOME` overrides
both (`$SWAMP_HOME/config/telemetry/`).

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

Note that positional arguments containing user data (behavior names, file paths,
queries) are replaced with `<REDACTED>`. Only categorical values defined by
swamp itself (like behavior types) are recorded. Option values are never
recorded — only the option keys.

`swamp behavior` and `swamp behaviour` commands are recorded in their
`swamp model` form, so `swamp behavior run my-model deploy` is recorded as
`swamp model method run my-model deploy`. The word you typed is kept in
`commandSpelling` (`behavior`, `behaviour` or `model`). Commands outside these
groups have no `commandSpelling`.

### Viewing Telemetry Stats

`swamp telemetry stats` reads the user-global spool and summarizes recent
activity. It does not require a repository context:

```bash
swamp telemetry stats           # last 2 days (default)
swamp telemetry stats --days 7  # last 7 days
```

### Disabling Telemetry

Every opt-out below disables telemetry on its own. If any of them applies,
nothing is recorded or sent, and no other setting can turn telemetry back on.

| Opt-out                                          | Scope                                 |
| ------------------------------------------------ | ------------------------------------- |
| `swamp config set telemetry.collection disabled` | You, for every run, in any repository |
| `.swamp.yaml`: `telemetryDisabled: true`         | Everyone running swamp in that repo   |
| `SWAMP_NO_TELEMETRY=1`                           | Every run in that environment         |
| `DO_NOT_TRACK=1`                                 | Every run in that environment         |
| `--no-telemetry`                                 | That one invocation                   |

For the two environment variables, any value other than `0`, `false`, or empty
disables telemetry.

The user-level setting is the one to use to opt out everywhere:

```bash
swamp config set telemetry.collection disabled
swamp config get telemetry.collection   # disabled
```

It is stored in `~/.config/swamp/telemetry.yaml` (XDG-aware, like the spool). A
file written by hand with `disabled: true` has the same effect. A running
`swamp serve` daemon reads it at startup, so restart the daemon after changing
it.

A repository-scoped command pointed at a repository with `--repo-dir` or
`SWAMP_REPO_DIR` records nothing when no `.swamp.yaml` is found there — that
repository's own opt-out and endpoint are unknown.

Each event is sent only to the telemetry endpoint in effect when it was
recorded. Events from a repository that sets `telemetryEndpoint` in
`.swamp.yaml` stay in the spool until a run that resolves the same endpoint
sends them; a run outside that repository never sends them to the default
endpoint. Events recorded by a version of swamp before this routing existed
carry no endpoint and are sent by the next run that flushes, wherever it sends
to.

### Migrating from Repo-Local Telemetry

Older versions of swamp stored telemetry in `.swamp/telemetry/` inside each
repository. Running `swamp repo upgrade` automatically migrates unflushed
entries from the legacy repo-local spool to the user-global spool. Repositories
that have telemetry disabled (`telemetryDisabled: true` in `.swamp.yaml`) are
skipped. The old `.swamp/telemetry/` directory is left in place but is no longer
used.

## License

Swamp is licensed under the [GNU Affero General Public License v3.0](COPYING)
with the [Swamp Extension and Definition Exception](COPYING-EXCEPTION). No
rights are granted for use of our
[trademarks outside our explicit policy](./TRADEMARKS.md) See
[COPYRIGHT](COPYRIGHT), [CONTRIBUTING.md](CONTRIBUTING.md) and
[Open Source FAQ](./OSS-FAQ.md) for details.
