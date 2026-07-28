---
name: swamp
description: >
  Swamp CLI — create and run models, build and validate workflows, query and
  manage data, store and retrieve vault secrets, develop and publish extensions,
  initialize repos, run reports, file issues, and troubleshoot errors. Triggers
  on swamp commands (swamp model, swamp workflow, swamp vault, swamp data),
  extension development, repo setup, or diagnostic questions. Do NOT use for
  getting started / onboarding (use swamp-getting-started), pull requests, git
  operations, worktree management, cron/agent scheduling, or general coding
  tasks unrelated to swamp.
---

# Swamp

## Core Concepts

- **Models** — typed resource definitions exposing methods (create, stop,
  destroy, sync).
- **Data** — versioned state snapshots produced by method runs; referenced via
  CEL expressions.
- **Workflows** — declarative DAGs chaining model methods with guard expressions
  for idempotent execution and assert steps for validation.
- **Vaults** — secret storage referenced by models at runtime.
- **Extensions** — TypeScript packages adding model types, vault backends,
  datastores, and reports.
- **Grants** — authorization rules for swamp serve access control.
- **Serve** — exposes the repo over the network with TLS and authentication.

## Routing Table

Route to the right guide based on what the user needs.

| User intent                                                  | Guide                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Models — create, run, edit, delete, search types             | [references/model/guide.md](references/model/guide.md)                         |
| Workflows — create, run, validate, DAG, history              | [references/workflow/guide.md](references/workflow/guide.md)                   |
| Data — list, query, versions, GC, delete                     | [references/data/guide.md](references/data/guide.md)                           |
| Vaults — create, store/read secrets, expressions             | [references/vault/guide.md](references/vault/guide.md)                         |
| Reports — run, configure, view, filter                       | [references/report/guide.md](references/report/guide.md)                       |
| Repository — init, upgrade, datastores, sources              | [references/repo/guide.md](references/repo/guide.md)                           |
| Extensions — create models/vaults/drivers/datastores/reports | [references/extension/guide.md](references/extension/guide.md)                 |
| Publishing — push extensions to registry, deprecate          | [references/extension-publish/guide.md](references/extension-publish/guide.md) |
| Issues — file bugs, features, security reports               | [references/issue/guide.md](references/issue/guide.md)                         |
| Run tracking — active runs, stale detection, diagnostics     | [references/model/guide.md](references/model/guide.md)                         |
| Architecture — which primitive to use, design trade-offs     | [references/architecture/guide.md](references/architecture/guide.md)           |
| Sharing — promote solo repo to team, datastore + vault setup | [references/share/guide.md](references/share/guide.md)                         |
| Serve — auth, grants, access control, tokens, OAuth          | [references/serve/guide.md](references/serve/guide.md)                         |
| Troubleshooting — errors, health checks, diagnostics         | [references/troubleshooting/guide.md](references/troubleshooting/guide.md)     |

## Common Commands

```bash
# Models
swamp model create <type> <name>               # create a model definition
swamp model @<type> method run <method> <name> # run a method on a model
swamp model get <name> --json                  # inspect current model state
swamp model type search [query]                # find available model types
swamp model list                               # list all models in the repo

# Data
swamp data list <name>                         # list data versions for a model
swamp data query <name> '<CEL predicate>'      # query data with CEL expressions
swamp data get <name>                          # get latest data snapshot

# Workflows
swamp workflow create <name>                   # create a new workflow
swamp workflow validate <name>                 # validate DAG before running
swamp workflow run <name>                      # execute a workflow
swamp workflow run <name> --input key=value    # execute with inputs
swamp workflow resume <name>                   # resume a suspended workflow
swamp workflow resume <name> --from <step>     # re-enter failed run at step
swamp workflow history search --json           # search run history

# Run tracking
swamp run history                              # recent runs (last 24h)
swamp run history --active                     # what's running right now?
swamp run doctor                               # diagnose stale/orphaned runs
swamp run doctor --fix                         # auto-reap stale runs

# Vaults, Reports, Extensions
swamp vault create <type> <name>               # create a vault for secrets
swamp report run <name>                        # run a report
swamp extension init <name>                    # scaffold a new extension
```

## Workflow

1. **Route** — match intent to a guide in the routing table.
2. **Load** — read the guide; load its `reference.md` if needed, deeper
   `references/` only when the guide says to.
3. **Validate** — before running any workflow: `swamp workflow validate <name>`.
   Before destructive methods (delete, stop, destroy):
   `swamp model get <name> --json` to confirm the target exists and is in the
   expected state. Proceed only when validation passes.
4. **Execute** — run the command.
5. **On failure** — load
   [references/troubleshooting/guide.md](references/troubleshooting/guide.md)
   and diagnose before retrying or changing definitions.

## Rules

1. **Use the routing table, not memory.** Don't answer from cached knowledge
   about swamp commands — always load the current guide.
2. **Consult the architecture guide for design decisions.** Before choosing
   between primitives (model vs. workflow vs. extension vs. report) or
   explaining a design trade-off, load
   [references/architecture/guide.md](references/architecture/guide.md) and cite
   the design doc you relied on.
3. **Use swamp commands, don't go around them.** Query data with
   `swamp data query`, not by grepping `.swamp/` files. Interact with resources
   through model methods, not raw CLI tools when a model type already wraps the
   API — check with `swamp model type search`. Composing with `--json` output
   (e.g. piping through `jq`) is fine — the anti-pattern is bypassing swamp
   entirely.
