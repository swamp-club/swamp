---
name: swamp-extension-model
description: Create, test, and publish extension models for swamp — define Zod schemas, implement model interfaces, smoke test against live APIs, write manifest.yaml, and push extensions to the registry. Use when creating models, writing manifest.yaml, publishing/pushing extensions, testing extensions, or preparing models for the registry. Covers all extension types (models, vaults, drivers, datastores, reports). Triggers on "create model", "new model type", "custom model", "extension model", "user model", "typescript model", "extend swamp", "build integration", "zod schema", "model plugin", "deno model", "extensions/models", "model development", "implement model", "smoke test", "test extension", "verify model", "test against API", "before push test", "push extension", "publish extension", "extension push", "release extension", "bump version", "publish to registry", "test extension from another repo", "source extension loading", "manifest", "manifest.yaml", "write manifest", "prepare for publishing".
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

**Create an extension model when no built-in or community type exists for your
use case.** Before creating one:

1. `swamp model type search <query>` — check local types
2. `swamp extension search <query>` — check community extensions
3. If a community extension exists, install it instead of building from scratch
4. Only create a custom model if nothing exists

Trusted collectives (`@swamp/*`, `@si/*`, membership collectives) auto-resolve
on first use — no manual `extension pull` needed. Use
`swamp extension trust list` to see trusted collectives.

If the task is transforming/analyzing existing model output into a report,
create a report extension instead (see `swamp-report` skill). Extension models
are for new data sources and integrations.

**When a model type exists but is missing a method:**

If the model type covers your domain but doesn't have the method you need:

1. Confirm the type exists: `swamp model type describe <type> --json`
2. Verify the method is missing from the output
3. Add the method via `export const extension` — see
   [Extending Existing Model Types](#extending-existing-model-types) below
4. Do not fall back to CLI tools (`gh`, `aws`, `curl`) when the domain model
   already exists

**Important:** Do not default to generic CLI types (like `command/shell`) for
specific service integrations. If the user wants to manage S3 buckets, EC2
instances, or other resources, create a dedicated model for that service rather
than wrapping CLI commands.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help extension` for the complete, up-to-date CLI schema.

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
[references/publishing.md](references/publishing.md#determining-the-next-version)
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

Models declare their data outputs using `resources` and/or `files`.

### Resource Specs

Resources are structured JSON data validated against a Zod schema:

```typescript
resources: {
  "state": {
    description: "Deployment state",
    schema: z.object({
      status: z.string(),
      endpoint: z.string().url(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  },
},
```

**Spec naming:** Resource spec keys must not contain hyphens (`-`). Use
camelCase or single words (e.g., `igw` not `internet-gateway`).

**Sensitive fields:** Mark fields containing secrets with
`z.meta({ sensitive: true })`. Values are stored in a vault and replaced with
vault references before persistence:

```typescript
resources: {
  "keypair": {
    schema: z.object({
      keyId: z.string(),
      keyMaterial: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  },
},
```

Set `sensitiveOutput: true` on the spec to treat all fields as sensitive. Set
`vaultName` on the spec to override which vault stores the values.

**Schema requirement:** If your resource will be referenced by other models via
CEL expressions, declare the referenced properties explicitly in the Zod schema:

```typescript
// Wrong — expression validator can't resolve attributes.VpcId
schema: z.object({}).passthrough(),

// Correct — VpcId is declared so expressions can reference it
schema: z.object({ VpcId: z.string() }).passthrough(),
```

### File Specs

Files are binary or text content (including logs):

```typescript
files: {
  "log": {
    description: "Execution log",
    contentType: "text/plain",
    lifetime: "7d",
    garbageCollection: 5,
    streaming: true,
  },
},
```

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

Models that manage real resources typically have `create`, `update`, `delete`,
and `sync` methods:

- **`create`** — run a command/API call, store the result via `writeResource()`
- **`update`** — read stored data via `context.readResource()`, modify the
  resource, write updated state
- **`delete`** — read stored data via `context.readResource()`, clean up the
  resource, return `{ dataHandles: [] }`
- **`sync`** — read stored resource ID via `context.readResource()`, call the
  live provider API to get current state, write refreshed state via
  `writeResource()` (or mark as `not_found` if the resource is gone)

Unlike `get` (which requires the user to provide the resource ID as an
argument), `sync` reads the ID from already-stored state, making it zero-arg.
This makes `sync` suitable for automated drift detection — a workflow can call
`sync` on every instance without knowing resource IDs up front.

See [references/examples.md](references/examples.md#crud-lifecycle-model-vpc)
for a complete VPC example with all four methods and
[references/examples.md](references/examples.md#sync-method) for the standalone
sync pattern with workflow examples.

### Optional Patterns for Cloud/API Models

Ask the user whether they want these when creating a new extension model:

- **[Polling to completion](references/examples.md#polling-to-completion)** —
  poll async APIs until the resource is fully provisioned
- **[Idempotent creates](references/examples.md#idempotent-creates)** — check
  for existing state before creating to avoid duplicates on re-runs

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

### Testing Extensions from a Separate Repo

To test an extension without copying files into the consumer repo:

```bash
# In the consumer repo, add the extension as a source
swamp extension source add ~/code/my-extensions/model/aws/ec2

# Verify it loads
swamp model type search ec2

# When done, remove the source
swamp extension source rm ~/code/my-extensions/model/aws/ec2
```

The source extension must have a `deno.json` with its dependencies (e.g.,
`"zod": "npm:zod@4"`) for bundling to succeed.

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

## Extension Adversarial Review

After writing or significantly modifying extension code, and before running unit
tests or smoke tests, read
[references/adversarial-review.md](references/adversarial-review.md) and
self-review against all applicable dimensions. Present findings to the user
before proceeding to testing.

## Publishing Extensions

Extensions are published to the swamp registry via a `manifest.yaml` and the
`swamp extension push` command. Extensions can contain models, workflows,
vaults, drivers, datastores, and reports.

**Minimal manifest:**

```yaml
manifestVersion: 1
name: "@myorg/my-model"
version: "2026.02.26.1"
models:
  - my_model.ts
```

**Push commands:**

```bash
swamp extension push manifest.yaml --json           # Push to registry
swamp extension push manifest.yaml --dry-run --json # Validate without pushing
swamp extension push manifest.yaml -y --json        # Skip confirmation prompts
```

The manifest `name` collective must match your authenticated username. Content
paths are relative to their respective directories (`extensions/models/`,
`extensions/vaults/`, `extensions/drivers/`, `extensions/datastores/`). Local
imports are auto-resolved. **All manifest paths must be relative and
downward-only — paths containing `..` components or starting with `/` are
rejected during push to prevent broken archives.**

For the full manifest schema, safety rules, CalVer versioning, and
troubleshooting, see [references/publishing.md](references/publishing.md).

## Key Rules

1. **Export**: `export const model = { ... }` for new types,
   `export const extension = { ... }` for extending existing types
2. **Import**: `import { z } from "npm:zod@4";` is always required
3. **Static imports only**: Dynamic `import()` is rejected during push
4. **Pin npm versions**: Always pin — inline, via `deno.json`, or `package.json`
5. **No type annotations**: Avoid TypeScript types in execute parameters
6. **File naming**: Use snake_case (`my_model.ts`)
7. **Version upgrades**: When bumping `version`, always add an `upgrades` entry

For import styles, helper scripts, collective naming rules, and version details,
see [references/publishing.md](references/publishing.md).

## Verify

After creating your model:

```bash
swamp model type search --json              # Model should appear
swamp model type describe @myorg/my-model --json  # Check schema
```

## When to Use Other Skills

| Need                       | Use Skill               |
| -------------------------- | ----------------------- |
| Use existing models        | `swamp-model`           |
| Create/run workflows       | `swamp-workflow`        |
| Manage secrets for models  | `swamp-vault`           |
| Repository structure       | `swamp-repo`            |
| Manage model data          | `swamp-data`            |
| Create reports for models  | `swamp-report`          |
| Understand swamp internals | `swamp-troubleshooting` |

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
- **Publishing**: See [references/publishing.md](references/publishing.md) for
  manifest schema, push workflow, safety rules, and CalVer versioning
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
  pre-push quality review checklist (credentials, logging, errors, idempotency)
- **Docker execution**: See
  [references/docker-execution.md](references/docker-execution.md)
