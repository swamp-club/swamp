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
  architecture.md    the story across the six primitives, top down
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
2. `primitives/` in the order architecture.md tells the story: models → data →
   workflows → vaults → extensions → serve
3. [contributing/libswamp.md](../contributing/libswamp.md) — the one pattern
   every command follows; then `src/cli/commands/data_get.ts` as the example
4. [enablers/remote-execution.md](./enablers/remote-execution.md)
5. `enablers/` as needed, following the `enables:` links from the primitive
   you are working on
