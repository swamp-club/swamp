# Design docs

A document lives here only if it is one of swamp's **six primitives**, or it
says which primitive it **enables**. The primitives are what a user or agent
reasons in:

| Primitive      | What it is                                                |
| -------------- | --------------------------------------------------------- |
| **Models**     | A type plus a definition; running a method produces data  |
| **Data**       | Versioned, immutable, queryable artifacts of method runs  |
| **Workflows**  | A DAG of method steps with inputs, triggers and approvals |
| **Vaults**     | Secrets resolved at run time, never frozen into YAML      |
| **Extensions** | Packaged, published model types, vaults, datastores…      |
| **Serve**      | A long-running swamp that others run primitives through   |

A subsystem earns a doc under `enablers/` by answering "what does this do so
that primitive X works?" and declaring it in the header. Anything that cannot
name a primitive is a runbook, an ops note, or not worth a doc — see
[operations.md](./operations.md). There are no `decisions/`, `proposals/` or
`archive/` folders: git history and the internal dossier hold those. Rationale
that matters stays as a short _Why_ section inside the doc it explains.

## Layout

```
design/
  README.md          this file
  architecture.md    overview: who uses swamp, containers, key journeys
  operations.md      one line each for subsystems that get no design doc
  primitives/        the six primitives — the whole product in six files
  enablers/          subsystems that exist because a primitive needs them
  surfaces/          where primitives live and how they are reached
contributing/        how the binary is built (libswamp, renderers, skill pipeline)
```

Every doc starts with a header:

```yaml
---
audience: operator | extension-author | maintainer
enables: [workflows, serve] # enablers only — no primitive, no doc
last-verified: 2026-08-28 @ 4bde205b # date and commit someone checked it
---
```

`last-verified` means a person spot-checked the doc's claims against the code
at that commit. A PR that changes a subsystem's behaviour is expected to bump
the date on its doc.

## Index

### Primitives

| Doc                                          | Notes                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [models](./primitives/models.md)             |                                                                                                |
| [workflows](./primitives/workflows.md)       |                                                                                                |
| [vaults](./primitives/vaults.md)             | AWS SM, Azure KV and 1Password are extensions, not built-ins                                   |
| [extensions](./primitives/extensions.md)     | To be split into authoring (author-facing) and lifecycle (maintainer-facing)                   |
| [data](./primitives/data.md)                 | The record, write path, lifecycle, where it lives                                              |
| [serve](./primitives/serve.md)               | Configuration, surface, auth modes, detached runs, triggers, HA, operations                    |

### Enablers

| Doc                                                    | Enables           | Notes                                                              |
| ------------------------------------------------------ | ----------------- | ------------------------------------------------------------------ |
| [expressions](./enablers/expressions.md)               | models, workflows | CEL surface                                                        |
| [inputs](./enablers/inputs.md)                         | models, workflows |                                                                    |
| [data-query](./enablers/data-query.md)                 | data              | `data query`, catalog                                              |
| [datastores](./enablers/datastores.md)                 | data              | To be split: operator view / sync contract / locking               |
| [remote-execution](./enablers/remote-execution.md)     | serve             | Workers, leases, runners, data plane; serve protocol to be extracted |
| [reports](./enablers/reports.md)                       | models, workflows |                                                                    |
| [run-tracker](./enablers/run-tracker.md)               | workflows, models | To fold into a workflow-execution doc                              |
| [doctor-secrets](./enablers/doctor-secrets.md)         | models            | To fold into models.md operations section                          |
| [doctor-vaults](./enablers/doctor-vaults.md)           | vaults            | To fold into vaults.md operations section                          |

### Surfaces

| Doc                                                  | Notes                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| [repo](./surfaces/repo.md)                           | `.swamp.yaml` and the `.swamp/` layout                             |
| [agent-interface](./surfaces/agent-interface.md)     | Global skills; agent.md and audit.md fold in here                  |
| [agent](./surfaces/agent.md)                         | To fold into agent-interface.md                                    |
| [audit](./surfaces/audit.md)                         | Hook command log; to fold into agent-interface.md                  |
| [audit-doctor](./surfaces/audit-doctor.md)           | To fold into agent-interface.md                                    |

## Reading order for a new engineer

1. [architecture.md](./architecture.md)
2. `primitives/` in order: models → workflows → vaults → extensions (data and
   serve once written)
3. [contributing/libswamp.md](../contributing/libswamp.md) — the one pattern
   every command follows; then `src/cli/commands/data_get.ts` as the example
4. [enablers/remote-execution.md](./enablers/remote-execution.md)
5. `enablers/` as needed, following the `enables:` links from the primitive
   you are working on

## Diagrams

The C4 model lives in `design/architecture/` as [LikeC4](https://likec4.dev)
source — `model.c4` (people, external systems, containers, components) and
`views.c4` (context, containers, components, and one dynamic view per user
journey). Mermaid is generated into `design/architecture/generated/` and
spliced into [architecture.md](./architecture.md) between
`<!-- diagram: <view> -->` markers so GitHub renders it inline.

**Viewing.** Nothing to install: open
[architecture.md](./architecture.md) on GitHub, or in any editor with a
Mermaid-capable markdown preview (Zed, VS Code). For the interactive version
— pan, zoom, click through from a container to its components — run
`npx likec4 start design/architecture` and open the URL it prints, or install
the [LikeC4 VS Code extension](https://marketplace.visualstudio.com/items?itemName=likec4.likec4-vscode)
and open a `.c4` file.

**Editing.** Change `model.c4` / `views.c4`, then:

- `deno task diagrams:render` — regenerate the Mermaid and re-splice it into
  architecture.md. Needs `npx` (Node); the pinned `likec4` version is
  fetched on first use.
- `deno task diagrams:check` — what CI runs; fails if the generated files or
  the spliced blocks are stale.

Rules for the model: people are the swamp-uat personas; element ids under
`swamp` mirror `src/` directories and carry a `link` to the path; every
dynamic view is a journey a person actually runs and links to the swamp-uat
test that proves it. When a UAT journey is added or renamed, the view follows.
Context and container views are hand-curated; there are no code-level
diagrams.
