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

- **Models** — typed definitions of resources (an EC2 instance, a DNS record, a
  GitHub repo). Each exposes **methods** (create, start, stop, destroy, sync)
  that operate on the real resource.
- **Data** — versioned state snapshots produced by method runs; other models
  reference them via CEL expressions.
- **Workflows** — declarative DAGs chaining model methods, wiring step outputs
  into step inputs.
- **Vaults** — secret storage (API keys, tokens) that models reference at
  runtime.
- **Extensions** — TypeScript packages adding model types, vault backends,
  datastores, and report generators; published to a registry.
- **Reports** — summaries of data across models for observability.

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
| Troubleshooting — errors, health checks, diagnostics         | [references/troubleshooting/guide.md](references/troubleshooting/guide.md)     |

## Common Commands

```bash
# Models
swamp model @<type> create <name>              # create a model definition
swamp model @<type> method run <method> <name> # run a method on a model
swamp model get <name> --json                  # inspect current model state
swamp model search @<type>                     # find available model types
swamp model list                               # list all models in the repo

# Data
swamp data list <name>                         # list data versions for a model
swamp data query <name> '<CEL predicate>'      # query data with CEL expressions
swamp data get <name>                          # get latest data snapshot

# Workflows
swamp workflow create <name>                   # create a new workflow
swamp workflow run <name>                      # execute a workflow
swamp workflow validate <name>                 # validate DAG before running
swamp workflow history <name>                  # view past workflow runs

# Vaults, Reports, Extensions
swamp vault create <type> <name>               # create a vault for secrets
swamp report run <name>                        # run a report
swamp extension init <name>                    # scaffold a new extension
```

## Rules

1. **Always load the guide first.** Before answering any swamp question, read
   the matching guide from the table above.
2. **Load deeper references as needed.** Each guide references additional files
   in its `references/` subdirectory — load those when the guide tells you to.
3. **Load multiple guides when needed.** If the question spans topics (e.g.
   running a model in a workflow), load both relevant guides.
4. **Use the routing table, not memory.** Don't answer from cached knowledge
   about swamp commands — always load the current guide.
5. **Validate before acting.** Run `swamp workflow validate <name>` before
   `workflow run`, and inspect with `swamp model get <name> --json` to verify
   resource IDs before destructive methods (delete, stop, destroy). Proceed only
   when validation passes and the target is confirmed.
6. **On failure, route to troubleshooting.** If validation reports errors, a
   method run fails, or any command errors unexpectedly, load
   [references/troubleshooting/guide.md](references/troubleshooting/guide.md)
   and diagnose before retrying or changing the definition.
