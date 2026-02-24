---
name: swamp-extension-model
description: Create user-defined TypeScript models for swamp. Use when users want to extend swamp with custom model types, create automation models, or add new integrations. Triggers on "create model", "new model type", "custom model", "extension model", "user model", "typescript model", "extend swamp", "build integration", "zod schema", "model plugin", "deno model", "extensions/models", "model development", "implement model".
---

# Swamp Extension Model

Create TypeScript models in `extensions/models/*.ts` that swamp loads at
startup.

## When to Create a Custom Model

**Create an extension model when no built-in type exists for your use case.**

If you search for a type with `swamp model type search <query>` and get no
results, you should create a custom model rather than assuming the functionality
doesn't exist. Extension models let you:

- Integrate with any API or service (AWS S3, Stripe, custom APIs, etc.)
- Define any automation logic you need
- Create reusable components for your workflows

**Example decision flow:**

```
1. User wants to work with S3 buckets
2. Run: swamp model type search S3 → no results
3. Solution: Create extensions/models/s3_bucket.ts with the S3 logic you need
```

**Important:** Do not default to generic CLI types (like `command/shell`) for
specific service integrations. If the user wants to manage S3 buckets, EC2
instances, or other resources, create a dedicated model for that service rather
than wrapping CLI commands.

## Quick Reference

| Task                | Command/Action                                          |
| ------------------- | ------------------------------------------------------- |
| Create model file   | Create `extensions/models/my_model.ts`                  |
| Verify registration | `swamp model type search --json`                        |
| Check schema        | `swamp model type describe @myorg/my-model --json`      |
| Create instance     | `swamp model create @myorg/my-model my-instance --json` |
| Run method          | `swamp model method run my-instance run --json`         |

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
| `type`            | Yes      | Unique identifier (`@namespace/name`)             |
| `version`         | Yes      | CalVer version (`YYYY.MM.DD.MICRO`)               |
| `globalArguments` | No       | Zod schema for global arguments                   |
| `resources`       | No       | Resource output specs (JSON data with Zod schema) |
| `files`           | No       | File output specs (binary/text with content type) |
| `inputsSchema`    | No       | Zod schema for runtime inputs                     |
| `methods`         | Yes      | Object of method definitions with `arguments` Zod |

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

Models that manage real resources typically have `create`, `update`, and
`delete` methods:

- **`create`** — run a command/API call, store the result via `writeResource()`
- **`update`** — read stored data via `context.dataRepository.getContent()`,
  modify the resource, write updated state
- **`delete`** — read stored data, clean up the resource, return
  `{ dataHandles: [] }`

See [references/examples.md](references/examples.md#crud-lifecycle-model-vpc)
for a complete VPC example with all three methods.

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

**Extension rules:**

- Extensions **cannot** change the target model's Zod schema
- Extensions **only** add new methods — no overriding existing methods
- `methods` is always an array of `Record<string, MethodDef>` objects

## Model Discovery

Swamp discovers models and extensions recursively:

1. **Repository extensions**: `{repo}/extensions/models/**/*.ts`
2. **Built-in models**: Bundled with swamp binary

Files are classified by export name: `export const model` defines new types,
`export const extension` adds methods to existing types.

## Key Rules

1. **Export**: Use `export const model = { ... }` for new types or
   `export const extension = { ... }` for extending existing types
2. **Import**: Only `import { z } from "npm:zod@4";` is needed
3. **Type naming**: Use `@<namespace>/<name>` format (e.g., `@user/my-model`)
4. **No type annotations**: Avoid TypeScript types in execute parameters
5. **File naming**: Use snake_case (`my_model.ts`)

## Namespace Rules

User-defined models can use any namespace except reserved ones (`swamp`, `si`):

| Type              | Valid? | Notes                    |
| ----------------- | ------ | ------------------------ |
| `@user/my-model`  | ✅     | Valid namespace          |
| `@myorg/deploy`   | ✅     | Custom namespace allowed |
| `@user/aws/s3`    | ✅     | Nested paths allowed     |
| `mycompany/model` | ❌     | Missing `@` prefix       |
| `@swamp/my-model` | ❌     | Reserved namespace       |

## Verify

After creating your model:

```bash
swamp model type search --json              # Model should appear
swamp model type describe @myorg/my-model   # Check schema
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
- **Examples**: See [references/examples.md](references/examples.md) for
  complete model examples (CRUD lifecycle, data chaining, extensions, etc.)
- **Scenarios**: See [references/scenarios.md](references/scenarios.md) for
  end-to-end scenarios (custom API, cloud CRUD, factory models)
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  errors and fixes
- **Built-in example**: See `src/domain/models/echo/echo_model.ts` for reference
- **Model design**: See [design/models.md](design/models.md) for concepts
