# Architecture Decision Guide

This guide is self-contained — it routes to `design/*.md` and the swamp manual
for depth rather than maintaining its own reference tree.

Use this guide when you need to **choose between swamp primitives** (behavior,
workflow, report, extension, vault) or **explain a design trade-off** to a
human. For operational how-to on a specific primitive, use the per-primitive
guides instead.

## Decision Tree

```
What does the user need?
│
├── Automate a single external action (API call, CLI command, resource sync)
│   └── Behavior — see design/primitives/behaviors.md
│       ├── Existing type covers it? → swamp behavior type search / extension search
│       └── No type? → Extension model or command/shell (ad-hoc only)
│
├── Orchestrate multiple actions in sequence or parallel
│   └── Workflow — see design/primitives/workflows.md
│       ├── Steps are all behavior methods? → workflow with behavior steps
│       ├── Mix of behaviors and scripts? → workflow with mixed step types
│       └── Need to nest workflows? → see references/workflow/references/nested-workflows.md
│
├── Analyze or summarize execution results
│   └── Report — see design/enablers/reports.md
│       └── Runs automatically after method executions and workflow steps
│
├── Add new capabilities (behavior types, vault backends, datastores)
│   └── Extension — see design/primitives/extensions.md
│       └── Determine which of the 4 extension types fits:
│           model | vault | datastore | report
│
├── Store and retrieve secrets (API keys, tokens, credentials)
│   └── Vault — see design/primitives/vaults.md
│       └── Referenced in behavior definitions via vault.get() expressions
│
└── Query, compare, or inspect runtime state
    └── Data — use the data guide directly (no design doc needed)
        └── Versioned snapshots produced by method runs
```

For a more detailed behavior-vs-workflow-vs-extension breakdown with
scenario-based examples, see
[../behavior/references/examples.md](../behavior/references/examples.md#decision-tree-what-to-build).

## When to Use Each Primitive

| Primitive     | Use when...                                                                                                | Don't use when...                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Behavior**  | You need a 1:1 representation of an external resource with typed methods (create, sync, destroy)           | You need to chain multiple actions — use a workflow instead                   |
| **Workflow**  | You need to orchestrate multiple methods in a DAG with dependencies, conditions, and parallelism           | It's a single action on a single resource — a method is enough                |
| **Report**    | You need repeatable analysis of method or workflow output (summaries, drift detection, compliance reports) | You need to take action — reports analyze, they don't mutate                  |
| **Extension** | No existing type covers the service/API you want to automate, or you need a custom vault/datastore         | An existing extension or `command/shell` already covers it                    |
| **Vault**     | You need to store and retrieve secrets that behavior definitions reference at runtime                      | The values aren't sensitive — use behavior global arguments or inputs instead |
| **Data**      | You need to query, compare versions, or inspect runtime state produced by method runs                      | You need to define or configure — data is output, not input                   |

## Conceptual References

When explaining a design trade-off or justifying an architectural choice to a
human, cite the source you relied on:

### Developer-facing (in-repo)

These live in `design/` at the repository root and document internal
architecture decisions:

- `design/architecture.md` — top-level architecture overview (purpose, storage,
  behaviors, workflows)
- `design/primitives/behaviors.md` — behavior type system, IDs, versions,
  methods, data
- `design/primitives/workflows.md` — workflow definitions, jobs, steps, task
  variants
- `design/enablers/reports.md` — post-execution report analysis
- `design/primitives/extensions.md` — extension packaging and distribution
- `design/primitives/vaults.md` — vault secret storage
- `design/enablers/datastores.md` — datastore abstraction layer
- `design/surfaces/repo.md` — repository structure and architecture
- `design/enablers/expressions.md` — CEL expression language

### User-facing (swamp manual)

These live in the swamp manual at `swamp-club/swamp-club` under
`content/manual/explanation/` and provide stable, versioned conceptual
overviews:

- `how-swamp-works.md` — how swamp works end-to-end
- `models-types-and-methods.md` — behaviors, types, and methods explained

When answering architectural questions, prefer the user-facing manual docs for
human-facing explanations and the developer-facing design docs for
implementation-level reasoning.

## Source Attribution

When you explain an architectural choice or design trade-off to a human, name
the document you relied on. This is consistent with the skill's "verify, don't
guess" posture — architectural reasoning should be anchored to a canonical
source, not inferred from priors.

Example: "A workflow is the right choice here because you need to orchestrate
three methods with dependencies between them (see
`design/primitives/workflows.md` for how DAG-based step ordering works)."
