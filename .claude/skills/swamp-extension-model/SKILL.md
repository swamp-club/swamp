---
name: swamp-extension-model
description: Create user-defined TypeScript models for swamp. Use when users want to extend swamp with custom model types, create automation models, or add new integrations. Triggers on "create model", "new model type", "custom model", "extension model", "user model", "typescript model", "extend swamp", "build integration", "zod schema", "model plugin", "deno model", "extensions/models", "model development", "implement model".
---

# Swamp Extension Model

Create TypeScript models in `extensions/models/*.ts` that swamp loads at
startup.

## Quick Reference

| Task                | Command/Action                                         |
| ------------------- | ------------------------------------------------------ |
| Create model file   | Create `extensions/models/my_model.ts`                 |
| Verify registration | `swamp type search --json`                             |
| Check schema        | `swamp type describe myorg/my-model --json`            |
| Create instance     | `swamp model create myorg/my-model my-instance --json` |
| Run method          | `swamp model method run my-instance run --json`        |

## Quick Start

```typescript
// extensions/models/my_model.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({ message: z.string() });
const DataSchema = z.object({ result: z.string(), timestamp: z.string() });

export const model = {
  type: "myorg/my-model",
  version: 1,
  inputAttributesSchema: InputSchema,
  dataAttributesSchema: DataSchema, // Use resourceAttributesSchema for persistent output
  methods: {
    run: {
      description: "Process the input",
      execute: async (input, _context) => ({
        data: {
          id: input.id,
          attributes: {
            result: input.attributes.message.toUpperCase(),
            timestamp: new Date().toISOString(),
          },
        },
      }),
    },
  },
};
```

## Model Structure

| Field                      | Required | Description                            |
| -------------------------- | -------- | -------------------------------------- |
| `type`                     | Yes      | Unique identifier (`namespace/name`)   |
| `version`                  | Yes      | Schema version number                  |
| `inputAttributesSchema`    | Yes      | Zod schema for input validation        |
| `dataAttributesSchema`     | Pick one | For ephemeral output (not git-tracked) |
| `resourceAttributesSchema` | Pick one | For persistent output (git-tracked)    |
| `methods`                  | Yes      | Object of method definitions           |

### Output Schema Choice

- **`dataAttributesSchema`**: Use for ephemeral data that doesn't need to be
  tracked in git (logs, temporary results, intermediate state)
- **`resourceAttributesSchema`**: Use for persistent data that represents
  external resources or should be version controlled (AWS resources, configs)

## Execute Function

```typescript
execute: (async (input, context) => {
  // input.id        - UUID
  // input.name      - User-provided name
  // input.attributes - Validated input data
  // context.repoDir - Repository root path

  return {
    data: { // Or 'resource' for resourceAttributesSchema
      id: input.id,
      attributes: {/* output fields */},
    },
  };
});
```

## Model Discovery

Swamp discovers extension models in this order:

1. **Repository extensions**: `{repo}/extensions/models/*.ts`
2. **Built-in models**: Bundled with swamp binary

Repository models take precedence, allowing you to override built-in types.

## Key Rules

1. **Export**: Must use `export const model = { ... }`
2. **Import**: Only `import { z } from "npm:zod@4";` is needed
3. **Type naming**: Use `namespace/name` format to avoid conflicts
4. **No type annotations**: Avoid TypeScript types in execute parameters
5. **File naming**: Use snake_case (`my_model.ts`), test files excluded

## Advanced: Method Input Schema

Methods can define their own input schema for runtime parameters:

```typescript
methods: {
  deploy: {
    description: "Deploy with environment-specific config",
    inputAttributesSchema: z.object({
      environment: z.enum(["dev", "staging", "prod"]),
      dryRun: z.boolean().optional(),
    }),
    execute: async (input, context, methodInput) => {
      const env = methodInput?.environment ?? "dev";
      // ...
    },
  },
},
```

## Advanced: Context Usage

The context provides access to repository information:

```typescript
execute: (async (input, context) => {
  const configPath = `${context.repoDir}/config.yaml`;
  // Read config, access other files, etc.
});
```

## Examples

### Shell Command Model

```typescript
import { z } from "npm:zod@4";

const InputSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
});

const DataSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
});

export const model = {
  type: "myorg/shell",
  version: 1,
  inputAttributesSchema: InputSchema,
  dataAttributesSchema: DataSchema,
  methods: {
    run: {
      description: "Execute shell command",
      execute: async (input, _context) => {
        const cmd = new Deno.Command(input.attributes.command, {
          args: input.attributes.args ?? [],
        });
        const output = await cmd.output();
        return {
          data: {
            id: input.id,
            attributes: {
              stdout: new TextDecoder().decode(output.stdout),
              stderr: new TextDecoder().decode(output.stderr),
              exitCode: output.code,
            },
          },
        };
      },
    },
  },
};
```

### API Integration Model

```typescript
import { z } from "npm:zod@4";

const InputSchema = z.object({
  endpoint: z.string().url(),
  apiKey: z.string(), // Use vault expression: ${{ vault.get(my-vault, API_KEY) }}
});

const ResourceSchema = z.object({
  resourceId: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

export const model = {
  type: "myorg/api-resource",
  version: 1,
  inputAttributesSchema: InputSchema,
  resourceAttributesSchema: ResourceSchema,
  methods: {
    create: {
      description: "Create resource via API",
      execute: async (input, _context) => {
        const response = await fetch(input.attributes.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${input.attributes.apiKey}` },
        });
        const data = await response.json();
        return {
          resource: {
            id: input.id,
            attributes: {
              resourceId: data.id,
              status: data.status,
              createdAt: new Date().toISOString(),
            },
          },
        };
      },
    },
  },
};
```

## Verify

After creating your model:

```bash
swamp type search --json              # Model should appear
swamp type describe myorg/my-model    # Check schema
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

- **Complete examples**: See [references/examples.md](references/examples.md)
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md)
- **Model design**: See [design/models.md](design/models.md) for data structures
  and lifecycle concepts
