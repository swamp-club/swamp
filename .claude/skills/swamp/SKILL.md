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

Route to the right guide based on what the user needs.

## Routing Table

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
swamp model @<type> method run <method> <name> --input key=value
swamp workflow create <name>
swamp vault create <type> <name>
swamp data query <name> '<CEL predicate>'
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
