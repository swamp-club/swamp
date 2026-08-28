---
audience: everyone
last-verified: 2026-08-28 @ ce0ca66b
---

# Architecture

Swamp is an AI-native automation tool. An agent (or a person) describes an
external system as a **model**, runs its methods to produce versioned **data**,
wires methods into **workflows**, keeps credentials in **vaults**, packages
model types as **extensions**, and — when a team needs to share all of that —
runs a long-lived **serve** instance that others execute through. Those six
are the primitives; every other subsystem in the codebase exists to make one of
them work. This page is the story that runs across them; each section points
down into the doc that owns the detail, and every doc below points back up to
the primitive it serves. See [README.md](./README.md) for the rule and the
index.

## The story, top down

**A builder starts with a model.** A model has two halves: a _type_ —
TypeScript that knows how to talk to something (a shell, AWS, any API) — and a
_definition_ — a YAML file in `models/` that instantiates the type with
arguments, inputs and tags. Running a method on a definition is the atom of
everything else. → [primitives/models.md](./primitives/models.md), with its
enablers [expressions](./enablers/expressions.md) (the `${{ }}` CEL surface
every definition can use) and [inputs](./enablers/inputs.md) (JSON-Schema
parameters and how `--input` reaches them).

**A method run leaves data behind.** Each artifact is addressed by
`(type, model, name, version)`, is immutable once written, is versioned by
appending, and is indexed in a SQLite catalog so CEL and the CLI can query it.
Definitions are git-tracked; data lives in the datastore and never is. →
[primitives/data.md](./primitives/data.md), with
[data-query](./enablers/data-query.md) (the query surface and the catalog) and
[datastores](./enablers/datastores.md) (local `.swamp/`, filesystem or S3
backends, sync and locking).

**Workflows wire methods together.** A workflow is a DAG of jobs and steps;
steps reference each other's data through expressions, fan out with `forEach`,
can pause for a human (`manual_approval`), and can be triggered on a schedule
or by a webhook. → [primitives/workflows.md](./primitives/workflows.md); the
run ledger that makes runs observable is
[run-tracker](./enablers/run-tracker.md), and post-run analysis is
[reports](./enablers/reports.md).

**Secrets never freeze into YAML.** A definition references
`${{ vault.get(...) }}`; the value is resolved at the last moment, passed to
the method as a sentinel, and scrubbed from every persisted log and data file.
Fields a type marks `sensitive` are diverted into a vault on write. →
[primitives/vaults.md](./primitives/vaults.md); the `doctor secrets` and
`doctor vaults` checks are [doctor-secrets](./enablers/doctor-secrets.md) and
[doctor-vaults](./enablers/doctor-vaults.md).

**Types travel as extensions.** An extension packages model types — and vault,
datastore and report providers — under a `@collective/name` with CalVer
versions, published to the swamp-club registry and pulled per repo into
`.swamp/pulled-extensions/`. Only the first-party `swamp` collective is trusted
by default. → [primitives/extensions.md](./primitives/extensions.md).

**Serve lets a team share all of it.** `swamp serve` is the same binary opening
one listener on one port; every request — a workflow run, a data query, a vault
read — reaches the same application-layer use case the CLI would have run
locally, after token or OAuth authentication and grant evaluation. Runs survive
the client disconnecting; several instances coordinate only through a shared
control-plane store; steps that need a particular machine are dispatched to
enrolled workers. → [primitives/serve.md](./primitives/serve.md), with
[remote-execution](./enablers/remote-execution.md) (workers, leases, runners,
the data plane).

## Where all of this lives

A swamp repo is a git repository with a `.swamp.yaml` marker →
[surfaces/repo.md](./surfaces/repo.md). It separates source of truth from
runtime data:

- **Source of truth, tracked in git** — `models/{type}/{name}.yaml`,
  `workflows/workflow-{name}.yaml`, `vaults/{type}/{id}.yaml`, `grants/`.
  These are what an agent edits and a reviewer reads.
- **Runtime data, in the datastore** — the `.swamp/` directory by default, or
  a filesystem path or S3 through a datastore extension: versioned data and
  its catalog, method outputs, workflow runs, `run_tracker.db`, the local
  vault, the extension catalog, pulled extensions, the audit log.
- **Per user** — `~/.config/swamp/` for swamp-club and serve credentials, the
  anonymous identity and the telemetry spool; `~/.swamp/` for the binary and
  the embedded Deno runtime.

The primary way in is an AI agent: `swamp repo init --tool <agent>` installs
swamp's skills into the agent's skill directory and registers hooks so the
agent's commands are audited →
[surfaces/agent-interface.md](./surfaces/agent-interface.md).

## One binary, four runtime roles

`swamp` compiles to a single Deno binary (`scripts/compile.ts` also embeds a
second Deno runtime for bundling extensions, the bundled skills, and the
dashboard build). The subcommand decides the role:

| Role                     | Runs as                                              | Owns                                                                                             |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **swamp CLI**            | `swamp <command>` — every user and agent interaction | Nothing durable; writes the repo datastore and `~/.config/swamp`                                 |
| **swamp serve**          | `swamp serve` — one `Deno.serve` listener            | Per-instance registries in memory; the shared datastore, control-plane keys, `.swamp/serve.yaml` |
| **swamp worker connect** | outbound only, no repo                               | A machine id and a content-addressed bundle cache                                                |
| **dispatch runner**      | `swamp worker exec-dispatch`, one child per dispatch | A scratch directory; reaches serve over the HTTP data plane                                      |

The CLI and serve are two adapters over the same application layer:
`src/libswamp` holds one async-generator use case per verb, and both
`src/cli/commands` and `src/serve/handlers` consume those streams — which is
why 106 commands work identically with `--server`. The dependency rule
(`cli → libswamp → domain ← infrastructure`, never the reverse) is enforced by
`integration/ddd_layer_rules_test.ts` →
[contributing/libswamp.md](../contributing/libswamp.md).

Two facts a new engineer otherwise learns the hard way: serve instances never
talk to each other (HA is entirely shared control-plane keys — no gossip, no
leader), and cron scheduling runs inside serve, not in the launchd/systemd
units, which only keep processes alive.

## What swamp deliberately does not do

It runs no MCP server, never calls an LLM API, and has no CI-platform
awareness. Swamp is driven _by_ agents; it does not host one. Subsystems that
are real code but neither a primitive nor an enabler of one — telemetry,
tracing, self-update, issues, quests — get one line each in
[operations.md](./operations.md) and nothing more.
