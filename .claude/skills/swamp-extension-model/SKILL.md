---
name: swamp-extension-model
description: Create user-defined TypeScript models for swamp — define Zod schemas, implement model interfaces, configure output specs. Use when users want to extend swamp with custom model types, create automation models, or add new integrations. Triggers on "create model", "new model type", "custom model", "extension model", "user model", "typescript model", "extend swamp", "build integration", "zod schema", "model plugin", "deno model", "extensions/models", "model development", "implement model".
---

# Swamp Extension Model

Create TypeScript models in `extensions/models/*.ts` that swamp loads at
startup.

## When to Create a Custom Model

**Create an extension model when no built-in or community type exists for your
use case.**

Before creating a custom model, always check both local types and community
extensions:

1. Search local types: `swamp model type search <query>`
2. Search community extensions: `swamp extension search <query>`
3. If a community extension exists, install it instead of building from scratch
4. Only create a custom model if nothing exists locally or in the community

Extension models let you:

- Integrate with any API or service (AWS S3, Stripe, custom APIs, etc.)
- Define any automation logic you need
- Create reusable components for your workflows

**Example decision flow:**

```
User wants to work with S3 buckets
swamp model type search S3 → no local results
swamp extension search S3 → no community extension
No existing model → Create extensions/models/s3_bucket.ts
```

**Important:** Do not default to generic CLI types (like `command/shell`) for
specific service integrations. If the user wants to manage S3 buckets, EC2
instances, or other resources, create a dedicated model for that service rather
than wrapping CLI commands.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help extension` for the complete, up-to-date CLI schema.

## Quick Reference

| Task                | Command/Action                                          |
| ------------------- | ------------------------------------------------------- |
| Search community    | `swamp extension search <query> --json`                 |
| Create model file   | Create `extensions/models/my_model.ts`                  |
| Verify registration | `swamp model type search --json`                        |
| Check schema        | `swamp model type describe @myorg/my-model --json`      |
| Create instance     | `swamp model create @myorg/my-model my-instance --json` |
| Run method          | `swamp model method run my-instance run --json`         |
| Create manifest     | Create `manifest.yaml` with model/workflow entries      |
| Format extension    | `swamp extension fmt manifest.yaml --json`              |
| Check formatting    | `swamp extension fmt manifest.yaml --check --json`      |
| Push extension      | `swamp extension push manifest.yaml --json`             |
| Dry-run push        | `swamp extension push manifest.yaml --dry-run --json`   |

## Quick Start

```typescript
// extensions/models/my_model.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({ message: z.string() });

const OutputSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
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

| Field             | Required | Description                                       |
| ----------------- | -------- | ------------------------------------------------- |
| `type`            | Yes      | Unique identifier (`@collective/name`)            |
| `version`         | Yes      | CalVer version (`YYYY.MM.DD.MICRO`)               |
| `globalArguments` | No       | Zod schema for global arguments                   |
| `resources`       | No       | Resource output specs (JSON data with Zod schema) |
| `files`           | No       | File output specs (binary/text with content type) |
| `inputsSchema`    | No       | Zod schema for runtime inputs                     |
| `methods`         | Yes      | Object of method definitions with `arguments` Zod |
| `checks`          | No       | Pre-flight checks run before mutating methods     |

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

```typescript
execute: (async (args, context) => {
  // args                   - Pre-validated method arguments
  // context.globalArgs     - Global arguments
  // context.definition     - { id, name, version, tags }
  // context.methodName     - Name of the executing method
  // context.repoDir        - Repository root path
  // context.logger         - LogTape Logger
  // context.dataRepository - For advanced data operations
  // context.writeResource  - Write structured JSON data
  // context.createFileWriter - Create a writer for files

  const handle = await context.writeResource("result", "main", {
    value: "processed",
    timestamp: new Date().toISOString(),
  });

  return { dataHandles: [handle] };
});
```

### Error Handling

Models should throw when execution fails. Throw **before** writing data — failed
executions should not persist incorrect or misleading data.

```typescript
execute: (async (args, context) => {
  const result = await callExternalApi(args);

  // Throw BEFORE writing data — don't persist failure data
  if (result.status >= 400) {
    throw new Error(`API request failed with status ${result.status}`);
  }

  const handle = await context.writeResource("result", "main", {
    statusCode: result.status,
    response: result.body,
  });

  return { dataHandles: [handle] };
});
```

The workflow engine catches exceptions and marks the step as failed. Use
`allowFailure: true` on a workflow step to continue execution after a failure.

For detailed API documentation on `writeResource`, `createFileWriter`,
`DataWriter`, `DataHandle`, and `dataRepository`, see
[references/api.md](references/api.md).

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
the same output spec. This is useful when a model discovers N items and needs to
emit each as a separately-addressable resource.

```typescript
const handles = [];
for (const subnet of subnets) {
  const handle = await context.writeResource(
    "subnet",
    subnet.subnetId, // Dynamic instance name
    subnet,
  );
  handles.push(handle);
}
return { dataHandles: handles };
```

**Discovering factory outputs in CEL:**

```yaml
# Get all subnets produced by the scanner
allSubnets: ${{ data.findBySpec("my-scanner", "subnet") }}

# Access a specific named instance
subnetA: ${{ model.my-scanner.resource.subnet.subnet-aaa.attributes.cidr }}
```

See [references/scenarios.md](references/scenarios.md) for complete factory
model examples.

## CRUD Lifecycle Models

Models that manage real resources typically have `create`, `update`, `delete`,
and `sync` methods:

- **`create`** — run a command/API call, store the result via `writeResource()`
- **`update`** — read stored data via `context.dataRepository.getContent()`,
  modify the resource, write updated state
- **`delete`** — read stored data, clean up the resource, return
  `{ dataHandles: [] }`
- **`sync`** — read stored resource ID via
  `context.dataRepository.getContent()`, call the live provider API to get
  current state, write refreshed state via `writeResource()` (or mark as
  `not_found` if the resource is gone)

Unlike `get` (which requires the user to provide the resource ID as an
argument), `sync` reads the ID from already-stored state, making it zero-arg.
This makes `sync` suitable for automated drift detection — a workflow can call
`sync` on every instance without knowing resource IDs up front.

See [references/examples.md](references/examples.md#crud-lifecycle-model-vpc)
for a complete VPC example with all four methods and
[references/examples.md](references/examples.md#sync-method) for the standalone
sync pattern with workflow examples.

### Optional Patterns for Cloud/API Models

Two patterns are common for models that manage real cloud resources. Neither is
required — ask the user whether they want them when creating a new extension
model.

- **[Polling to completion](references/examples.md#polling-to-completion)** —
  When the provider's API is async, poll until the resource is fully provisioned
  before returning. Useful when downstream models depend on attributes that
  aren't populated until ready (IPs, ARNs, endpoints). Not needed when the API
  returns complete state synchronously.

- **[Idempotent creates](references/examples.md#idempotent-creates)** — Check
  `context.dataRepository.getContent()` for existing state before creating, to
  avoid duplicates on workflow re-runs. Useful for non-idempotent APIs
  (droplets, EC2 instances). Not needed when the API is naturally idempotent
  (tags, S3 buckets) or you intentionally want multiple instances.

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

Swamp discovers models and extensions recursively:

1. **Repository extensions**: `{repo}/extensions/models/**/*.ts`
2. **Built-in models**: Bundled with swamp binary

Files are classified by export name: `export const model` defines new types,
`export const extension` adds methods to existing types.

## Publishing Extensions

Extensions are published to the swamp registry via a `manifest.yaml` and the
`swamp extension push` command.

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

The manifest `name` collective must match your authenticated username. Model
paths are relative to `extensions/models/`; local imports are auto-resolved.

**Optional metadata fields:**

- `platforms` — OS/architecture hints (e.g. `darwin-aarch64`, `linux-x86_64`).
  Use when your extension contains platform-specific code.
- `labels` — Categorization labels (e.g. `aws`, `kubernetes`, `security`).

Both are omitted from the archive when not specified.

For the full manifest schema, safety rules, CalVer versioning, and
troubleshooting, see [references/publishing.md](references/publishing.md).

## Key Rules

1. **Export**: Use `export const model = { ... }` for new types or
   `export const extension = { ... }` for extending existing types
2. **Import**: `import { z } from "npm:zod@4";` is always required. Any
   Deno-compatible import (`npm:`, `jsr:`, `https://`) can also be used — swamp
   bundles all dependencies automatically (see
   [references/examples.md](references/examples.md#using-external-dependencies))
3. **Static imports only**: All npm imports must be static top-level imports
   (e.g., `import { x } from "npm:pkg@1"`). Dynamic `import()` calls are not
   supported — the bundler cannot correctly handle CJS/ESM interop for
   dynamically imported packages. The quality checker rejects dynamic imports
   during `extension push`.
4. **Pin npm versions**: Always pin explicit versions for npm imports (e.g.,
   `npm:lodash-es@4.17.21`, not `npm:lodash-es`). Swamp does not use a lockfile
   during bundling, so unpinned versions may resolve differently across runs.
   `npm:zod@4` is the one exception — it is externalized and provided by swamp.
5. **Type naming**: Use `@<collective>/<name>` or `<collective>/<name>` format
   (e.g., `@user/my-model` or `myorg/my-model`)
6. **No type annotations**: Avoid TypeScript types in execute parameters
7. **File naming**: Use snake_case (`my_model.ts`)

## Collective Rules

User-defined models can use any collective except reserved ones (`swamp`, `si`):

| Type                        | Valid? | Notes                       |
| --------------------------- | ------ | --------------------------- |
| `@user/my-model`            | ✅     | Valid collective            |
| `@myorg/deploy`             | ✅     | Custom collective allowed   |
| `myorg/my-model`            | ✅     | Non-@ format allowed        |
| `digitalocean/app-platform` | ✅     | Non-@ multi-segment allowed |
| `@user/aws/s3`              | ✅     | Nested paths allowed        |
| `swamp/my-model`            | ❌     | Reserved collective         |
| `si/my-model`               | ❌     | Reserved collective         |

## Verify

After creating your model:

```bash
swamp model type search --json              # Model should appear
swamp model type describe @myorg/my-model --json  # Check schema
```

## When to Use Other Skills

| Need                      | Use Skill        |
| ------------------------- | ---------------- |
| Use existing models       | `swamp-model`    |
| Create/run workflows      | `swamp-workflow` |
| Manage secrets for models | `swamp-vault`    |
| Repository structure      | `swamp-repo`     |
| Manage model data         | `swamp-data`     |

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
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md)
- **Docker execution**: See
  [references/docker-execution.md](references/docker-execution.md)
