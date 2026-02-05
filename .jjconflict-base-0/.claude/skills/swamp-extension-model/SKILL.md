---
name: swamp-extension-model
description: Create user-defined TypeScript models for swamp. Use when users want to extend swamp with custom model types, create automation models, or add new integrations. Triggers on "create model", "new model type", "custom model", "extension model", "user model", "typescript model", "extend swamp", "build integration", "zod schema", "model plugin", "deno model", "extensions/models", "model development", "implement model".
---

# Swamp Extension Model

Create TypeScript models in `extensions/models/*.ts` that swamp loads at
startup.

## When to Create a Custom Model

**Create an extension model when no built-in type exists for your use case.**

If you search for a type with `swamp type search <query>` and get no results,
you should create a custom model rather than assuming the functionality doesn't
exist. Extension models let you:

- Integrate with any API or service (AWS S3, Stripe, custom APIs, etc.)
- Define any automation logic you need
- Create reusable components for your workflows

**Example decision flow:**

```
1. User wants to work with S3 buckets
2. Run: swamp type search S3 → no results
3. Solution: Create extensions/models/s3_bucket.ts with the S3 logic you need
```

**Important:** Do not default to generic CLI types (like `aws/cli`) for specific
service integrations. If the user wants to manage S3 buckets, EC2 instances, or
other resources, create a dedicated model for that service rather than wrapping
CLI commands. Dedicated models provide:

- Typed input validation with Zod schemas
- Structured output data for use in workflows
- Better error handling and resource tracking
- Reusable automation components

Extension models have the same capabilities as built-in models - they can make
HTTP requests, run shell commands, interact with cloud APIs, and produce data
outputs.

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

export const model = {
  type: "myorg/my-model",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    run: {
      description: "Process the input message",
      execute: async (definition, _context) => {
        return {
          data: {
            attributes: {
              message: definition.attributes.message.toUpperCase(),
              timestamp: new Date().toISOString(),
            },
            name: "result",
          },
        };
      },
    },
  },
};
```

## Model Structure

| Field                   | Required | Description                          |
| ----------------------- | -------- | ------------------------------------ |
| `type`                  | Yes      | Unique identifier (`namespace/name`) |
| `version`               | Yes      | Schema version number                |
| `inputAttributesSchema` | Yes      | Zod schema for input validation      |
| `methods`               | Yes      | Object of method definitions         |

## Execute Function

The execute function receives the definition and context, and returns data
outputs. There are three return formats: the preferred simpler formats
(`resource` and `data`) and the explicit `dataOutputs` array.

### Preferred: Simple Return Formats

```typescript
execute: (async (definition, context) => {
  // definition.id         - UUID
  // definition.name       - User-provided name
  // definition.attributes - Validated input data
  // context.repoDir       - Repository root path
  // context.dataRepository - For advanced data operations

  // For external resources (APIs, cloud services, etc.)
  return {
    resource: {
      attributes: {
        id: "resource-123",
        status: "created",
        endpoint: "https://api.example.com/resource/123",
      },
    },
  };

  // OR for general data output
  return {
    data: {
      attributes: {
        result: "processed value",
        timestamp: new Date().toISOString(),
      },
      name: "result", // optional, defaults to "data"
      tags: { category: "output" }, // optional custom tags
    },
  };
});
```

| Format     | Use Case                                 | Default Name | Default Tags       |
| ---------- | ---------------------------------------- | ------------ | ------------------ |
| `resource` | External resource state (APIs, services) | `"resource"` | `type: "resource"` |
| `data`     | General data output                      | `"data"`     | `type: "data"`     |

Both formats automatically:

- Serialize `attributes` as JSON with `application/json` content type
- Set lifetime to `"infinite"`
- Track ownership for data integrity

### Explicit: dataOutputs Array

For advanced use cases requiring multiple outputs, custom content types, or
streaming:

```typescript
execute: (async (definition, context) => {
  return {
    dataOutputs: [
      {
        name: "output-name",
        content: "string or Uint8Array",
        metadata: {
          contentType: "application/json",
          lifetime: "infinite",
          tags: { type: "data" },
        },
      },
    ],
  };
});
```

## Data Output Structure

Each data output in the `dataOutputs` array has:

| Field                  | Required | Description                                  |
| ---------------------- | -------- | -------------------------------------------- |
| `name`                 | Yes      | Unique name for this data artifact           |
| `content`              | Yes      | Data as `string` or `Uint8Array`             |
| `metadata.contentType` | No       | MIME type (default: `application/json`)      |
| `metadata.lifetime`    | No       | How long data persists (default: `infinite`) |
| `metadata.tags`        | No       | Key-value pairs for categorization           |
| `metadata.streaming`   | No       | True for line-oriented log data              |

### Lifetime Values

| Value       | Behavior                                     |
| ----------- | -------------------------------------------- |
| `ephemeral` | Deleted after method/workflow completes      |
| `job`       | Persists while creating job runs             |
| `workflow`  | Persists while creating workflow runs        |
| Duration    | Expires after time (e.g., `1h`, `7d`, `1mo`) |
| `infinite`  | Never expires (default)                      |

### Standard Tags

| Tag                | Use for                          |
| ------------------ | -------------------------------- |
| `type: "data"`     | General model data (default)     |
| `type: "log"`      | Execution logs (streaming, text) |
| `type: "file"`     | File artifacts                   |
| `type: "resource"` | External resource state          |

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

## Data Ownership

Data artifacts are tracked with ownership information. This prevents other
models from accidentally overwriting data.

- Each model "owns" the data it creates
- Multiple models can read the same data via CEL expressions
- Only the creating model can update its own data
- Use unique data names to avoid conflicts

## Examples

### Shell Command Model

```typescript
import { z } from "npm:zod@4";

const InputSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
});

export const model = {
  type: "myorg/shell",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    run: {
      description: "Execute shell command",
      execute: async (definition, _context) => {
        const cmd = new Deno.Command(definition.attributes.command, {
          args: definition.attributes.args ?? [],
        });
        const output = await cmd.output();

        return {
          data: {
            attributes: {
              stdout: new TextDecoder().decode(output.stdout),
              stderr: new TextDecoder().decode(output.stderr),
              exitCode: output.code,
            },
            name: "output",
          },
        };
      },
    },
  },
};
```

### Model with Multiple Outputs

```typescript
import { z } from "npm:zod@4";

const InputSchema = z.object({ query: z.string() });

export const model = {
  type: "myorg/search",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    search: {
      description: "Search and store results with log",
      execute: async (definition, _context) => {
        const results = ["result1", "result2"];

        return {
          dataOutputs: [
            // Primary result data
            {
              name: "results",
              content: JSON.stringify({ results }),
              metadata: {
                contentType: "application/json",
                lifetime: "infinite",
                tags: { type: "data" },
              },
            },
            // Execution log
            {
              name: "search-log",
              content: JSON.stringify({
                query: definition.attributes.query,
                timestamp: new Date().toISOString(),
                resultCount: results.length,
              }),
              metadata: {
                contentType: "application/json",
                lifetime: "7d",
                tags: { type: "log" },
              },
            },
          ],
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

export const model = {
  type: "myorg/api-resource",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    create: {
      description: "Create resource via API",
      execute: async (definition, _context) => {
        const response = await fetch(definition.attributes.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${definition.attributes.apiKey}`,
          },
        });
        const data = await response.json();

        return {
          resource: {
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

### Cloud Service Model (e.g., AWS S3)

When a built-in type doesn't exist, create your own:

```typescript
// extensions/models/s3_bucket.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({
  bucketName: z.string(),
  region: z.string().default("us-east-1"),
  accessKeyId: z.string(), // Use: ${{ vault.get(aws-vault, ACCESS_KEY_ID) }}
  secretAccessKey: z.string(), // Use: ${{ vault.get(aws-vault, SECRET_ACCESS_KEY) }}
});

export const model = {
  type: "myorg/s3-bucket",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    create: {
      description: "Create an S3 bucket",
      execute: async (definition, _context) => {
        const { bucketName, region, accessKeyId, secretAccessKey } =
          definition.attributes;

        // Use AWS SDK or direct API calls
        const response = await fetch(
          `https://s3.${region}.amazonaws.com/${bucketName}`,
          {
            method: "PUT",
            headers: {
              // Add AWS Signature V4 authentication
              Authorization: `...`, // Implement AWS signing
            },
          },
        );

        return {
          resource: {
            attributes: {
              bucketName,
              region,
              arn: `arn:aws:s3:::${bucketName}`,
              createdAt: new Date().toISOString(),
            },
          },
        };
      },
    },
    list: {
      description: "List objects in the bucket",
      execute: async (definition, _context) => {
        // Implement S3 ListObjects API call
        return {
          data: {
            attributes: {
              objects: [], // Populate from API response
            },
            name: "objects",
          },
        };
      },
    },
  },
};
```

### Method with Input Schema

Methods can define their own input schema for runtime parameters:

```typescript
methods: {
  deploy: {
    description: "Deploy with environment-specific config",
    inputAttributesSchema: z.object({
      environment: z.enum(["dev", "staging", "prod"]),
      dryRun: z.boolean().optional(),
    }),
    execute: async (definition, context, methodInput) => {
      const env = methodInput?.environment ?? "dev";
      // Use env for deployment logic...

      return {
        resource: {
          attributes: {
            environment: env,
            status: "deployed",
          },
        },
      };
    },
  },
},
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

- **Built-in example**: See `src/domain/models/echo/echo_model.ts` for reference
- **Model loader**: See `src/domain/models/user_model_loader.ts` for API details
- **Model design**: See [design/models.md](design/models.md) for concepts
