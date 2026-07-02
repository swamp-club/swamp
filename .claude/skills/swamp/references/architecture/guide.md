# Architecture Decision Guide

This guide is self-contained — it routes to `design/*.md` and the swamp manual
for depth rather than maintaining its own reference tree.

Use this guide when you need to **choose between swamp primitives** (model,
workflow, report, extension, vault) or **explain a design trade-off** to a
human. For operational how-to on a specific primitive, use the per-primitive
guides instead.

## Decision Tree

```
What does the user need?
│
├── Automate a single external action (API call, CLI command, resource sync)
│   └── Model — see design/models.md
│       ├── Existing type covers it? → swamp model type search / extension search
│       └── No type? → Extension model or command/shell (ad-hoc only)
│
├── Orchestrate multiple actions in sequence or parallel
│   └── Workflow — see design/workflow.md
│       ├── Steps are all model methods? → workflow with model_method steps
│       ├── Mix of models and scripts? → workflow with mixed step types
│       └── Need to nest workflows? → see references/workflow/references/nested-workflows.md
│
├── Analyze or summarize execution results
│   └── Report — see design/reports.md
│       └── Runs automatically after method executions and workflow steps
│
├── Add new capabilities (model types, vault backends, datastores, drivers)
│   └── Extension — see design/extension.md
│       └── Determine which of the 5 extension types fits:
│           model | vault | driver | datastore | report
│
├── Store and retrieve secrets (API keys, tokens, credentials)
│   └── Vault — see design/vaults.md
│       └── Referenced in model definitions via vault.get() expressions
│
└── Query, compare, or inspect runtime state
    └── Data — use the data guide directly (no design doc needed)
        └── Versioned snapshots produced by method runs
```

For a more detailed model-vs-workflow-vs-extension breakdown with scenario-based
examples, see
[../model/references/examples.md](../model/references/examples.md#decision-tree-what-to-build).

## When to Use Each Primitive

| Primitive     | Use when...                                                                                                | Don't use when...                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Model**     | You need a 1:1 representation of an external resource with typed methods (create, sync, destroy)           | You need to chain multiple actions — use a workflow instead                |
| **Workflow**  | You need to orchestrate multiple model methods in a DAG with dependencies, conditions, and parallelism     | It's a single action on a single resource — a model method is enough       |
| **Report**    | You need repeatable analysis of method or workflow output (summaries, drift detection, compliance reports) | You need to take action — reports analyze, they don't mutate               |
| **Extension** | No existing type covers the service/API you want to automate, or you need a custom vault/datastore/driver  | An existing extension or `command/shell` already covers it                 |
| **Vault**     | You need to store and retrieve secrets that model definitions reference at runtime                         | The values aren't sensitive — use model global arguments or inputs instead |
| **Data**      | You need to query, compare versions, or inspect runtime state produced by method runs                      | You need to define or configure — data is output, not input                |

## Conceptual References

When explaining a design trade-off or justifying an architectural choice to a
human, cite the source you relied on:

### Developer-facing (in-repo)

These live in `design/` at the repository root and document internal
architecture decisions:

- `design/high-level.md` — top-level architecture overview (purpose, storage,
  models, workflows)
- `design/models.md` — model type system, IDs, versions, methods, data
- `design/workflow.md` — workflow definitions, jobs, steps, task variants
- `design/reports.md` — post-execution report analysis
- `design/extension.md` — extension packaging and distribution
- `design/vaults.md` — vault secret storage
- `design/datastores.md` — datastore abstraction layer
- `design/repo.md` — repository structure and architecture
- `design/expressions.md` — CEL expression language

### User-facing (swamp manual)

These live in the swamp manual at `swamp-club/swamp-club` under
`content/manual/explanation/` and provide stable, versioned conceptual
overviews:

- `how-swamp-works.md` — how swamp works end-to-end
- `models-types-and-methods.md` — models, types, and methods explained

When answering architectural questions, prefer the user-facing manual docs for
human-facing explanations and the developer-facing design docs for
implementation-level reasoning.

## Source Attribution

When you explain an architectural choice or design trade-off to a human, name
the document you relied on. This is consistent with the skill's "verify, don't
guess" posture — architectural reasoning should be anchored to a canonical
source, not inferred from priors.

Example: "A workflow is the right choice here because you need to orchestrate
three model methods with dependencies between them (see `design/workflow.md` for
how DAG-based step ordering works)."
