---
audience: everyone
last-verified: 2026-08-28 @ 3d5955a9
---

# Architecture

Swamp is an AI-native automation tool. An agent or a person describes an
external system as a **model** and runs its methods to produce versioned
**data**. Methods are wired together into **workflows**, credentials live in
**vaults**, and model types are packaged as **extensions**. A team that wants to
share all of this runs a long-lived **serve** instance.

Those six are the primitives. Every other subsystem exists to make one of them
work. This page walks through them in order and links to the doc that owns each
part. See [README.md](./README.md) for the rule and the index.

## The story, top down

**It starts with a model.** A model has two parts. The _type_ is TypeScript that
talks to something: a shell, AWS, any API. The _definition_ is a YAML file in
`models/` that sets up the type with arguments, inputs and tags. Running a
method on a definition is the basic unit of work in swamp. →
[primitives/models.md](./primitives/models.md). Its enablers are
[expressions](./enablers/expressions.md) (the `${{ }}` CEL syntax any definition
can use) and [inputs](./enablers/inputs.md) (JSON-Schema parameters and how
`--input` reaches them).

**A method run produces data.** Each artifact is addressed by
`(type, model, name, version)`. It never changes once written; a new write adds
a new version. A SQLite catalog indexes it so CEL and the CLI can query it.
Definitions are tracked in git; data lives in the datastore and never is. →
[primitives/data.md](./primitives/data.md). Its enablers are
[data-query](./enablers/data-query.md) (queries and the catalog) and
[datastores](./enablers/datastores.md) (local `.swamp/`, filesystem or S3
backends, sync and locking).

**Workflows wire methods together.** A workflow is a DAG of jobs and steps.
Steps read each other's data through expressions and can fan out with
`forEach`. A step can pause for a human (`manual_approval`), and a workflow can
run on a schedule or from a webhook. →
[primitives/workflows.md](./primitives/workflows.md).
[run-tracker](./enablers/run-tracker.md) records runs so they can be observed,
and [reports](./enablers/reports.md) analyse them afterwards.

**Secrets are never written into YAML.** A definition refers to
`${{ vault.get(...) }}`. The value is fetched at the last moment, handed to the
method as a sentinel, and scrubbed from every saved log and data file. Fields a
type marks `sensitive` are moved into a vault when written. →
[primitives/vaults.md](./primitives/vaults.md). The `doctor secrets` and
`doctor vaults` checks are covered in
[doctor-secrets](./enablers/doctor-secrets.md) and
[doctor-vaults](./enablers/doctor-vaults.md).

**Types are shared as extensions.** An extension packages model types, plus
vault, datastore and report providers, under a `@collective/name` with a CalVer
version. Extensions are published to the swamp-club registry and pulled into
each repo at `.swamp/pulled-extensions/`, or `.swamp/config/pulled-extensions/`
when the datastore manages config (`src/infrastructure/persistence/paths.ts`).
Only the first-party `swamp` collective is trusted by default. →
[primitives/extensions.md](./primitives/extensions.md).

**Serve lets a team share everything.** `swamp serve` is the same binary
opening one listener on one port. Each request, whether a workflow run, a data
query or a vault read, is authenticated (token or OAuth), checked against
grants, and then runs the same application-layer use case the CLI would run
locally. Runs keep going if the client disconnects. Several instances
coordinate only through a shared control-plane store. Steps that need a
particular machine are sent to enrolled workers. → [primitives/serve.md](./primitives/serve.md), with
[remote-execution](./enablers/remote-execution.md) (workers, leases, runners,
the data plane).

## Where all of this lives

A swamp repo is a git repository with a `.swamp.yaml` marker →
[surfaces/repo.md](./surfaces/repo.md). It keeps source of truth apart from
runtime data:

- **Source of truth, tracked in git**: `models/{type}/{name}.yaml`,
  `workflows/workflow-{name}.yaml`, `vaults/{type}/{id}.yaml`, `grants/`. These
  are what an agent edits and a reviewer reads.
- **Runtime data, in the datastore**: the `.swamp/` directory by default, or a
  filesystem path or S3 through a datastore extension. This holds versioned data
  and its catalog, method outputs, workflow runs, `run_tracker.db`, the local
  vault, the extension catalog, pulled extensions and the audit log.
- **Per user**: `~/.config/swamp/` holds swamp-club and serve credentials, the
  anonymous identity and the telemetry spool. `~/.swamp/` (or `SWAMP_HOME`)
  holds installed binaries and downloaded source
  (`src/infrastructure/persistence/paths.ts`, `getSwampDataDir`).

The main way in is an AI agent. `swamp repo init --tool <agent>`
installs swamp's skills into the agent's global skill directory and registers
per-repo hooks so the agent's commands are audited
(`src/domain/repo/repo_service.ts`) →
[surfaces/agent-interface.md](./surfaces/agent-interface.md).

## One binary, four runtime roles

`swamp` compiles to a single Deno binary. `scripts/compile.ts` also embeds a
second Deno runtime for bundling extensions, the bundled skills, and the
dashboard build (only if `packages/dashboard/dist` exists at compile time). The
subcommand decides the role:

| Role                     | Runs as                                              | Owns                                                                                             |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **swamp CLI**            | `swamp <command>` — every user and agent interaction | Nothing durable; writes the repo datastore and `~/.config/swamp`                                 |
| **swamp serve**          | `swamp serve` — one `Deno.serve` listener            | Per-instance registries in memory; the shared datastore, control-plane keys, `.swamp/serve.yaml` |
| **swamp worker connect** | outbound only, no repo                               | A machine id and a content-addressed bundle cache                                                |
| **dispatch runner**      | `swamp worker exec-dispatch`, one child per dispatch | A scratch directory; reaches serve over the HTTP data plane                                      |

The CLI and serve are two front ends over the same application layer.
`src/libswamp` has one async-generator use case per verb, and both
`src/cli/commands` and `src/serve/handlers` consume them. That is why nearly
every read and run command works the same with `--server`
(`withRemoteOptions(` in `src/cli/commands`).

The dependency rule is `cli → libswamp → domain ← infrastructure`, never the
reverse. `integration/ddd_layer_rules_test.ts` enforces it for new code and
pins a list of existing `domain → infrastructure` and `serve → cli` imports so
no new ones appear → [contributing/libswamp.md](../contributing/libswamp.md).

Two things new engineers tend to learn the hard way:

- Serve instances never talk to each other. HA works only through shared
  control-plane keys, with no gossip and no leader.
- Cron scheduling runs inside serve. The launchd/systemd units only keep
  processes alive.

## What swamp deliberately does not do

It runs no MCP server, never calls an LLM API, and knows nothing about CI
platforms. Agents drive swamp; swamp does not host one. Subsystems that are
real code but neither a primitive nor an enabler (telemetry, tracing,
self-update, issues, quests) get one line each in
[operations.md](./operations.md).
