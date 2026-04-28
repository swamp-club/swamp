---
name: swamp-extension-model
description: >
  Create, test, and develop new extension models for swamp — define Zod
  schemas, implement model interfaces, smoke test against live APIs, and write
  manifest.yaml. Use ONLY when the user wants to author, build, or implement a
  new TypeScript model in extensions/models/. Do NOT use for running or
  executing existing models (that is swamp-model), orchestrating models in
  workflows (that is swamp-workflow), debugging model errors (that is
  swamp-troubleshooting), or publishing, pushing, or releasing extensions (that
  is swamp-extension-publish). Triggers on "create model", "new model type",
  "custom model", "extension model", "user model", "typescript model", "extend
  swamp", "build integration", "zod schema", "model plugin", "deno model",
  "extensions/models", "model development", "implement model", "smoke test",
  "test extension", "verify model", "test against API", "before push test",
  "test extension from another repo", "source extension loading", "manifest",
  "manifest.yaml", "write manifest".
---

# Swamp Extension Model

Create TypeScript models in `extensions/models/*.ts` that swamp loads at
startup.

## Choosing a Collective Name

Before creating a model, determine the collective name for the `type` field. Run
`swamp auth whoami --json` to see available collectives. If multiple collectives
are returned, **always ask the user** which one to use — never auto-select. Use
`@collective/model-name` as the type from the start (e.g., `@keeb/ports`). Do
not use placeholder prefixes like `@local/` — they will be rejected during
`swamp extension push`.

## When to Create a Custom Model

Decide in this order:

1. `swamp model type search <query>` — built-in or installed type covers it? Use
   it. Stop.
2. `swamp extension search <query>` — community extension covers it? Install and
   use. Trusted collectives (`@swamp/*`, `@si/*`, membership collectives)
   auto-resolve on first use; check `swamp extension trust list`.
3. Type exists but lacks a method you need? Add the method via
   `export const extension` — see
   [Extending Existing Model Types](#extending-existing-model-types). Do **not**
   fall back to CLI wrappers when the domain model already exists.
4. Nothing covers the task? Create a new extension model.

**Never** default to generic CLI types (`command/shell`) to wrap service
integrations (S3, EC2, GitHub). Build a dedicated model for the service.

**Reports vs. models:** transforming existing model output into a report is a
report extension (see `swamp-report`). Extension models are for new data sources
and integrations.

**Verify CLI syntax:** run `swamp help extension` for the up-to-date schema.

## Quick Reference

| Task                | Command/Action                                                       |
| ------------------- | -------------------------------------------------------------------- |
| Search community    | `swamp extension search <query> --json`                              |
| Create model file   | Create `extensions/models/my_model.ts`                               |
| Verify registration | `swamp model type search --json`                                     |
| Check schema        | `swamp model type describe @myorg/my-model --json`                   |
| Create instance     | `swamp model create @myorg/my-model my-instance --json`              |
| Create with args    | `swamp model create @myorg/my-model inst --global-arg message=hi -j` |
| Run method          | `swamp model method run my-instance run`                             |
| Next version        | `swamp extension version @myorg/my-model --json`                     |
| Create manifest     | Create `manifest.yaml` with model/workflow entries                   |
| Format extension    | `swamp extension fmt manifest.yaml --json`                           |
| Check formatting    | `swamp extension fmt manifest.yaml --check --json`                   |
| Push extension      | `swamp extension push manifest.yaml --json`                          |
| Dry-run push        | `swamp extension push manifest.yaml --dry-run --json`                |
| Smoke test model    | See [references/smoke_testing.md](references/smoke_testing.md)       |

## Quick Start

```typescript
// extensions/models/my_model.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const OutputSchema = z.object({
  id: z.uuid(),
  message: z.string(),
  timestamp: z.iso.datetime(),
});

export const model = {
  type: "@myorg/my-model",
  version: "2026.02.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "result": {
      description: "Model output data",
      schema: OutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Process the input message",
      arguments: z.object({}),
      execute: async (args, context) => {
        const handle = await context.writeResource("result", "main", {
          id: crypto.randomUUID(),
          message: context.globalArgs.message.toUpperCase(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

## Development Workflow

From empty `extensions/models/` to published extension. Do not skip steps — each
one's checkpoint catches a class of regression the next step can't.

1. **Confirm nothing covers it** —
   [When to Create a Custom Model](#when-to-create-a-custom-model).
2. **Author the model file** — copy [Quick Start](#quick-start); `deno check`.
3. **Verify registration** — `swamp model type search --json` shows the type.
   Files in `extensions/models/` are auto-discovered on first use; you do
   **not** need `swamp extension source add` for this directory. If the type
   does not appear, check stderr for `swamp-warning:` lines naming the model
   file — they identify validation or type-extraction failures that would
   otherwise be silent.
4. **Adversarial review** — pre-test quality gate. See
   [Adversarial Review Gate](#adversarial-review-gate) below for the required
   procedure and output format. This step MUST complete before steps 5 and 6.
5. **Smoke test** against live APIs —
   [references/smoke_testing.md](references/smoke_testing.md).
6. **Unit tests** — colocate `*_test.ts`; `deno test` passes.
7. **Version + manifest** — `swamp extension version`,
   `swamp extension fmt manifest.yaml --check`.
8. **Dry-run, then publish** — `swamp extension push manifest.yaml --dry-run`,
   then without `--dry-run`.

### Adversarial Review Gate

> **STOP — do not skip.**
>
> After authoring or **significantly modifying** extension code, and BEFORE
> running smoke tests or unit tests, you MUST:
>
> 1. Read [references/adversarial-review.md](references/adversarial-review.md)
>    and self-review against every applicable dimension.
> 2. Produce the structured findings report described in that file's "Output
>    Format" section (one `PASS` or `ISSUE FOUND — <detail>` line per
>    dimension).
> 3. Present the report to the user and wait for acknowledgement before moving
>    to step 5.
>
> The gate is advisory — no tool enforces it. Skipping under authoring momentum
> is the failure mode it exists to prevent.

## Model Structure

| Field             | Required | Description                                                              |
| ----------------- | -------- | ------------------------------------------------------------------------ |
| `type`            | Yes      | Unique identifier (`@collective/name`)                                   |
| `version`         | Yes      | CalVer version (`YYYY.MM.DD.MICRO`)                                      |
| `globalArguments` | No       | Zod schema for global arguments                                          |
| `resources`       | No       | Resource output specs (JSON data with Zod schema)                        |
| `files`           | No       | File output specs (binary/text with content type)                        |
| `inputsSchema`    | No       | Zod schema for runtime inputs                                            |
| `methods`         | Yes      | Object of method definitions with `arguments` Zod                        |
| `checks`          | No       | Pre-flight checks run before mutating methods                            |
| `reports`         | No       | Inline report definitions (see `swamp-report`)                           |
| `upgrades`        | No       | Version upgrade chain ([references/upgrades.md](references/upgrades.md)) |

## CalVer Versioning

Use `swamp extension version @myorg/my-model --json` to get the correct next
version. See
[publishing reference](../swamp-extension-publish/references/publishing.md#determining-the-next-version)
for details.

## Version Upgrades

When bumping `version`, always add an `upgrades` entry so existing instances
migrate. **Prompt the user** to confirm:

1. Did the `globalArguments` schema change?
2. If yes: what fields were added/renamed/removed and what defaults to use?
3. If no: add a no-op upgrade (`upgradeAttributes: (old) => old`)

The last upgrade's `toVersion` must equal the model's current `version`.
Upgrades run lazily at method execution time and persist after first run.

See [references/upgrades.md](references/upgrades.md) for patterns and examples.

## Zod Types

All standard Zod types work in schemas. Swamp-specific modifiers:
`.meta({ sensitive: true })` marks fields for vault storage.

## Resources & Files

Models declare their data outputs as `resources` (structured JSON validated
against a Zod schema) and/or `files` (binary or text, including logs). Each spec
sets `lifetime` and `garbageCollection`. Resource spec keys must not contain
hyphens — use camelCase or single words (`igw`, not `internet-gateway`). Mark
secret fields with `z.meta({ sensitive: true })` to route them to a vault.

For full spec syntax (resource examples, file examples, sensitive-field rules,
schema requirements for CEL references), see
[references/api.md](references/api.md#resource--file-specs).

## Execute Function

The execute function receives pre-validated `args` and a `context` object:

- `args` — Pre-validated method arguments
- `context.globalArgs` — Global arguments
- `context.definition` — `{ id, name, version, tags }`
- `context.methodName` — Name of the executing method
- `context.repoDir` — Repository root path
- `context.logger` — LogTape Logger
- `context.writeResource(specName, instanceName, data)` — Write structured JSON
- `context.readResource(instanceName, version?)` — Read stored JSON
- `context.createFileWriter(specName, instanceName)` — Create file writer
- `context.dataRepository` — Advanced data operations
- `context.extensionFile(relPath)` — Resolve a path from the manifest's
  `additionalFiles` to an absolute filesystem path. Works identically in
  source-loaded and pulled modes. Throws if the path is unsafe, if the file is
  missing, or if the model is not shipped via an extension manifest.

### Reading bundled assets

Models shipped via an extension manifest can declare runtime assets in
`additionalFiles` and read them at runtime with `ctx.extensionFile(relPath)`. Do
**not** hardcode `.swamp/pulled-extensions/<name>/files/...` — source-loaded and
pulled extensions resolve paths differently and `ctx.extensionFile()` handles
both. See [references/api.md](references/api.md#reading-bundled-assets) for the
manifest example, runtime usage, and failure mode.

Return `{ dataHandles: [handle] }` from execute. Throw **before** writing data —
failed executions should not persist incorrect data. The workflow engine catches
exceptions and marks the step as failed.

See [references/api.md](references/api.md) for detailed API documentation.

## Instance Names

The `instanceName` parameter on `writeResource` and `createFileWriter` sets the
identifier used in CEL expressions:

```
writeResource("state", "current", data)
  → model.<name>.resource.state.current.attributes.<field>
                          ─────  ───────
                        specName instanceName
```

**Convention:** For single-instance resources (most models), use a descriptive
instance name like `main`, `current`, or `primary`.

**Factory models** use distinct instance names to produce multiple outputs from
one spec — see [Factory Models](#factory-models) below.

## Factory Models

A single method execution can produce multiple dynamically-named resources from
the same output spec by passing distinct instance names to `writeResource`. See
[references/scenarios.md](references/scenarios.md#scenario-3-factory-model-for-discovery)
for complete factory model examples with CEL discovery patterns.

## CRUD Lifecycle Models

Models that manage real resources typically expose `create`, `update`, `delete`,
and `sync` methods. Unlike `get` (which requires the resource ID as an
argument), `sync` reads the ID from already-stored state via
`context.readResource()`, making it zero-arg and suitable for automated drift
detection across many instances.

For full method bodies, see
[references/examples.md](references/examples.md#crud-lifecycle-model-vpc) (VPC
example) and [references/examples.md](references/examples.md#sync-method) (sync
pattern + workflow). When designing a new cloud/API model, ask the user whether
to include [polling to completion](references/examples.md#polling-to-completion)
and [idempotent creates](references/examples.md#idempotent-creates).

## Pre-flight Checks

Checks run automatically before mutating methods (`create`, `update`, `delete`,
`action`). Define them on `checks` in the model export — see the Quick Start
example above. For the full `CheckDefinition` interface, labels conventions,
`appliesTo` scoping, and extension checks, see
[references/checks.md](references/checks.md).

## Extending Existing Model Types

Add new methods to existing model types without changing their schema. Use
`export const extension` instead of `export const model`:

```typescript
// extensions/models/shell_audit.ts
export const extension = {
  type: "command/shell", // target type to extend
  methods: [{
    audit: {
      description: "Audit the shell command execution",
      arguments: z.object({}),
      execute: async (args, context) => {
        const handle = await context.writeResource("result", "result", {
          exitCode: 0,
          command: `audit: ${context.definition.name}`,
          executedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  }],
};
```

Extensions can also add pre-flight checks — see
[references/checks.md](references/checks.md#extension-checks) for the format.

**Extension rules:**

- Extensions **cannot** change the target model's Zod schema
- Extensions **only** add new methods — no overriding existing methods
- `methods` is always an array of `Record<string, MethodDef>` objects
- `checks` is always an array of `Record<string, CheckDefinition>` objects
- Check and method names must not conflict with existing ones on the target type

## Model Discovery

Swamp discovers models and extensions from multiple sources, in priority order:

1. **Local extensions**: `{repo}/extensions/models/**/*.ts`
2. **Source extensions**: Paths from `.swamp-sources.yaml` (see `swamp-repo`
   skill)
3. **Pulled extensions**: `.swamp/pulled-extensions/models/**/*.ts`
4. **Built-in models**: Bundled with swamp binary

Sources override pulled extensions of the same type — if you're developing a
local copy of a pulled extension, add it as a source and your version loads
instead.

Files are classified by export name: `export const model` defines new types,
`export const extension` adds methods to existing types.

`swamp extension source add` is for OTHER directories — a sibling clone of an
extension under development or a shared toolbox dir. Pointing it at
`extensions/models/` is a no-op. The target path can be either a repo root (with
`extensions/<kind>/` subdirs) or a directory whose files declare extension
exports directly. The source extension must have a `deno.json` with its
dependencies (e.g., `"zod": "npm:zod@4"`) for bundling to succeed. The command
validates the path up-front and fails with a clear error if it contributes
nothing.

When a model file fails to load (bad `version`, missing required fields,
non-literal `type`, syntax error), swamp emits a stderr line prefixed
`swamp-warning:` naming the file and the error — watch stderr if a type doesn't
appear.

## Smoke Testing

Before pushing an extension, verify it works against the live API. Unit tests
with mocked responses can't catch Content-Type mismatches, bundle caching bugs,
or API validation quirks that only surface with real HTTP calls.

**For models that call external APIs:** Before pushing, verify all API endpoints
and request/response schemas against the provider's official REST API reference
documentation. Cross-reference HTTP methods, request body schemas, response
fields, and naming conventions. This catches contract mismatches that mocked
tests cannot detect.

Follow the smoke-test protocol in
[references/smoke_testing.md](references/smoke_testing.md) to systematically
test your model's methods against the real API. Start with safe read-only
methods (list, get), then run the full CRUD lifecycle.

## Unit Testing

Use the `@systeminit/swamp-testing` package to unit test `execute` functions
without real infrastructure:

```typescript
import { createModelTestContext } from "@systeminit/swamp-testing";
import { assertEquals } from "@std/assert";
import { model } from "./my_model.ts";

Deno.test("run method writes expected resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { message: "hello" },
  });

  await model.methods.run.execute({}, context);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].data.message, "HELLO");
});
```

See [references/testing.md](references/testing.md) for CRUD lifecycle testing
with `storedResources`, injectable client patterns, log assertions, and
cancellation testing.

## Publishing Extensions

Use the `swamp-extension-publish` skill to publish extensions to the registry.
It provides a state-machine checklist that enforces all prerequisites
(repository initialization, authentication, manifest validation, collective
verification) before allowing a push.

## Key Rules

1. **Export**: `export const model = { ... }` for new types,
   `export const extension = { ... }` for extending existing types
2. **Import**: `import { z } from "npm:zod@4";` is always required
3. **Static imports only**: Dynamic `import()` is rejected during push
4. **Pin npm versions**: Always pin — inline, via `deno.json`, or `package.json`
5. **Execute parameters are unannotated by default.** If a sibling `_test.ts`
   file imports the model source and `deno test` fails with TS7006, use the
   `satisfies ModelDefinition<...>` escape hatch documented in
   [references/typing.md](references/typing.md)
6. **File naming**: Use snake_case (`my_model.ts`)
7. **Version upgrades**: When bumping `version`, always add an `upgrades` entry

For import styles, helper scripts, collective naming rules, and version details,
see the
[publishing reference](../swamp-extension-publish/references/publishing.md).

## Verify

After creating your model:

```bash
swamp model type search --json              # Model should appear
swamp model type describe @myorg/my-model --json  # Check schema
```

## When to Use Other Skills

| Need                               | Use Skill                 |
| ---------------------------------- | ------------------------- |
| Use existing models                | `swamp-model`             |
| Create/run workflows               | `swamp-workflow`          |
| Manage secrets for models          | `swamp-vault`             |
| Repository structure               | `swamp-repo`              |
| Manage model data                  | `swamp-data`              |
| Create reports for models          | `swamp-report`            |
| Quality scorecard & best practices | `swamp-extension-quality` |
| Understand swamp internals         | `swamp-troubleshooting`   |

## References

- **API Reference**: See [references/api.md](references/api.md) for detailed
  `writeResource`, `createFileWriter`, `DataWriter`, and logging API docs
- **Pre-flight Checks**: See [references/checks.md](references/checks.md) for
  `CheckDefinition` interface, `CheckResult`, labels, scoping, and extension
  checks
- **Examples**: See [references/examples.md](references/examples.md) for
  complete model examples (CRUD lifecycle, data chaining, extensions, etc.)
- **Scenarios**: See [references/scenarios.md](references/scenarios.md) for
  end-to-end scenarios (custom API, cloud CRUD, factory models)
- **Publishing**: Use the `swamp-extension-publish` skill for the full
  publishing workflow, manifest schema, safety rules, and CalVer versioning
- **Smoke Testing**: See
  [references/smoke_testing.md](references/smoke_testing.md) for the pre-push
  smoke-test protocol, CRUD lifecycle testing, and common failure patterns
- **Unit Testing**: See [references/testing.md](references/testing.md) for
  `createModelTestContext`, injectable client patterns, and test examples
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md)
- **Version Upgrades**: See [references/upgrades.md](references/upgrades.md) for
  upgrade patterns, user prompt workflow, and migration examples
- **Adversarial Review**: See
  [references/adversarial-review.md](references/adversarial-review.md) for the
  pre-test quality review (dimensions + Output Format for findings report)
- **Docker execution**: See
  [references/docker-execution.md](references/docker-execution.md)
- **Bundling Skills**: See [references/skills.md](references/skills.md) for
  packaging skills with extensions (directory structure, frontmatter,
  validation, manifest declaration)
