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

const InputSchema = z.object({ message: z.string() });

export const model = {
  type: "@myorg/my-model",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Model output data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Process the input message",
      execute: async (definition, context) => {
        const writer = context.createDataWriter!({
          name: "result",
          specType: "data",
        });
        const handle = await writer.writeText(JSON.stringify({
          message: definition.attributes.message.toUpperCase(),
          timestamp: new Date().toISOString(),
        }));
        return { dataHandles: [handle] };
      },
    },
  },
};
```

## Model Structure

| Field                   | Required | Description                               |
| ----------------------- | -------- | ----------------------------------------- |
| `type`                  | Yes      | Unique identifier (`namespace/name`)      |
| `version`               | Yes      | CalVer version (`YYYY.MM.DD.MICRO`)       |
| `inputAttributesSchema` | Yes      | Zod schema for input validation           |
| `dataOutputSpecs`       | Yes      | Data output spec declarations (see below) |
| `inputsSchema`          | No       | Zod schema for runtime inputs             |
| `methods`               | Yes      | Object of method definitions              |

### Model-Level Inputs

Models can define an `inputsSchema` for runtime parameterization. These inputs
are provided via `--input` or `--input-file` when running methods:

```typescript
export const model = {
  type: "@user/deploy",
  version: 1,
  inputAttributesSchema: z.object({
    serviceName: z.string(),
    target: z.string(), // Will use ${{ inputs.environment }}
  }),
  dataOutputSpecs: {
    "resource": {
      specType: "resource",
      description: "Deployment resource state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
    },
  },
  inputsSchema: z.object({
    environment: z.enum(["dev", "staging", "production"]),
    dryRun: z.boolean().optional().default(false),
  }),
  methods: {
    deploy: {
      description: "Deploy the service",
      execute: async (definition, context) => {
        // Inputs are evaluated before execution, so definition.attributes
        // contains the resolved values (e.g., target = "production")
        const writer = context.createDataWriter!({
          name: "resource",
          specType: "resource",
        });
        const handle = await writer.writeText(JSON.stringify({
          deployed: true,
          target: definition.attributes.target,
        }));
        return { dataHandles: [handle] };
      },
    },
  },
};
```

**Usage:**

```bash
swamp model method run my-deploy deploy --input '{"environment": "production"}' --json
```

The `inputsSchema` defines what runtime inputs are accepted. These inputs are
available in CEL expressions via `${{ inputs.<name> }}`.

## Data Output Specs

Every model must declare its data output specifications in `dataOutputSpecs`.
This is the single source of truth for what spec types a model can produce. When
`createDataWriter` is called with a `specType`, it must match a key in
`dataOutputSpecs` — otherwise the factory fails fast with an "undeclared spec
type" error.

Each spec entry defines defaults for `contentType`, `lifetime`,
`garbageCollection`, and `tags`. The `createDataWriter` call only needs `name`
and `specType`; all other fields are inherited from the spec and can be
overridden per-write if needed.

```typescript
dataOutputSpecs: {
  "data": {
    specType: "data",
    description: "Model output data",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "data" },
  },
  "log": {
    specType: "log",
    description: "Execution log",
    contentType: "text/plain",
    lifetime: "7d",
    garbageCollection: 5,
    tags: { type: "log" },
  },
},
```

## Execute Function

The execute function receives the definition and context. It uses the
`DataWriter` API to write data directly to disk and returns `DataHandle`
references.

```typescript
execute: (async (definition, context) => {
  // definition.id         - UUID
  // definition.name       - User-provided name
  // definition.attributes - Validated input data (expressions already resolved)
  // context.repoDir       - Repository root path
  // context.logger        - LogTape Logger for emitting log messages
  // context.dataRepository - For advanced data operations
  // context.createDataWriter - Factory for creating DataWriter instances
  // context.inputs        - Runtime inputs (if inputsSchema defined)

  // 1. Create a DataWriter — specType must match a key in dataOutputSpecs
  const writer = context.createDataWriter!({
    name: "my-data",
    specType: "data", // references "data" entry in dataOutputSpecs
  });

  // 2. Write content using one of the writer methods
  const handle = await writer.writeText(JSON.stringify({
    result: "processed value",
    timestamp: new Date().toISOString(),
  }));

  // 3. Return the data handles
  return { dataHandles: [handle] };
});
```

### DataWriter API

Create a writer with `context.createDataWriter(options)`:

**SpecBasedWriterOptions:**

| Field               | Required | Description                                    |
| ------------------- | -------- | ---------------------------------------------- |
| `name`              | Yes      | Unique name for this data artifact             |
| `specType`          | Yes      | Must match a key in `dataOutputSpecs`          |
| `contentType`       | No       | Override MIME type (default from spec)         |
| `lifetime`          | No       | Override lifetime (default from spec)          |
| `garbageCollection` | No       | Override version retention (default from spec) |
| `streaming`         | No       | True for line-oriented streaming data          |
| `tags`              | No       | Override tags (default from spec)              |

**Writer Methods:**

| Method                      | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `writeAll(content)`         | Write complete binary content (`Uint8Array`)     |
| `writeText(text)`           | Write text content (encoded as UTF-8)            |
| `writeLine(line)`           | Append a single line (for streaming/incremental) |
| `writeStream(stream, opts)` | Pipe a `ReadableStream<Uint8Array>`              |
| `getFilePath()`             | Get the file path for direct I/O                 |
| `finalize()`                | Finalize after using `writeLine`/`getFilePath`   |

All write methods that complete a data artifact return a `Promise<DataHandle>`.
Use `writeLine` for incremental writes, then call `finalize()` to get the
handle.

**DataHandle** (returned by write methods):

| Field      | Description                          |
| ---------- | ------------------------------------ |
| `name`     | Data artifact name                   |
| `specType` | Data spec type                       |
| `dataId`   | Unique ID for this data              |
| `version`  | Version number of this write         |
| `size`     | Size of the written content in bytes |
| `tags`     | Tags from the writer options         |
| `metadata` | Full metadata for the data artifact  |

**UserMethodResult:**

The execute function returns `{ dataHandles?: DataHandle[] }`.

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

## Extending Existing Model Types

You can add new methods to existing model types (built-in or user-defined)
without changing their schema. Use `export const extension` instead of
`export const model`.

### Extension Structure

```typescript
// extensions/models/echo_audit.ts
export const extension = {
  type: "swamp/echo", // target type to extend
  methods: [{
    audit: {
      description: "Audit the echo message",
      execute: async (definition, context) => {
        // Extensions use the target model's dataOutputSpecs
        const writer = context.createDataWriter!({
          name: "audit-result",
          specType: "data",
        });
        const handle = await writer.writeText(JSON.stringify({
          audited: true,
          name: definition.name,
        }));
        return { dataHandles: [handle] };
      },
    },
  }],
};
```

| Field     | Required | Description                           |
| --------- | -------- | ------------------------------------- |
| `type`    | Yes      | Target model type to extend           |
| `methods` | Yes      | Array of method record objects to add |

### Extension Rules

- Extensions **cannot** change the target model's Zod schema
- Extensions **only** add new methods — no overriding existing methods
- `methods` is always an array of `Record<string, MethodDef>` objects
- One file can contain one method or many methods
- Multiple extension files can target the same type
- Extension methods without `inputAttributesSchema` inherit the target model's
- Models are loaded first, then extensions (two-pass loading)

## Model Discovery

Swamp discovers models and extensions recursively:

1. **Repository extensions**: `{repo}/extensions/models/**/*.ts` (nested dirs
   supported)
2. **Built-in models**: Bundled with swamp binary

Files are classified by export name: `export const model` defines new types,
`export const extension` adds methods to existing types. Files can live in
subdirectories for organization (e.g., `extensions/models/aws/s3_audit.ts`).

Repository models take precedence, allowing you to override built-in types.

## Key Rules

1. **Export**: Use `export const model = { ... }` for new types or
   `export const extension = { ... }` for extending existing types
2. **Import**: Only `import { z } from "npm:zod@4";` is needed
3. **Type naming**: Use `@<namespace>/<name>` format (e.g., `@keeb/my-model`,
   `@stack72/deploy`). Reserved namespaces (`swamp`, `si`) are for built-in
   types only.
4. **No type annotations**: Avoid TypeScript types in execute parameters
5. **File naming**: Use snake_case (`my_model.ts`), test files excluded
6. **Nesting**: Files can live in subdirectories for organization

## Namespace Rules

User-defined models can use any namespace except reserved ones (`swamp`, `si`):

| Type                  | Valid? | Notes                       |
| --------------------- | ------ | --------------------------- |
| `@user/my-model`      | ✅     | Valid namespace             |
| `@stack72/my-model`   | ✅     | Custom namespace allowed    |
| `@keeb/keyboard`      | ✅     | Custom namespace allowed    |
| `@myorg/deploy`       | ✅     | Custom namespace allowed    |
| `@user/aws/s3-bucket` | ✅     | Nested paths allowed        |
| `@stack72/aws/s3`     | ✅     | Nested paths allowed        |
| `mycompany/model`     | ❌     | Missing `@` prefix          |
| `@user`               | ❌     | Needs 2+ segments           |
| `swamp/my-model`      | ❌     | Reserved for built-in types |
| `@swamp/my-model`     | ❌     | Reserved namespace          |
| `si/auth`             | ❌     | Reserved namespace          |
| `@si/auth`            | ❌     | Reserved namespace          |

## Data Ownership

Data artifacts are tracked with ownership information. This prevents other
models from accidentally overwriting data.

- Each model "owns" the data it creates
- Multiple models can read the same data via CEL expressions
- Only the creating model can update its own data
- Use unique data names to avoid conflicts

## Logging

Model methods have access to a pre-configured LogTape logger via
`context.logger`. The logger category is set automatically based on the model
type and method name — no configuration needed.

### Log Levels

From low to high severity: `trace`, `debug`, `info`, `warning`, `error`,
`fatal`.

### Structured Placeholders (Preferred)

Use named `{placeholder}` tokens with a properties object:

```typescript
context.logger.info("Processing {name}", { name: definition.name });
context.logger.error("Request failed: {error}", { error: err.message });
```

Use `{*}` to inline all properties from the object:

```typescript
context.logger.info("Bucket created: {*}", {
  bucket: "my-bucket",
  region: "us-east-1",
});
// Output: Bucket created: bucket=my-bucket region=us-east-1
```

### Additional Features

- `context.logger.with({ requestId: "abc" })` — returns a logger with extra
  properties on all messages
- `context.logger.getChild("subsystem")` — creates a child logger with a
  sub-category
- Logger respects `--log-level`, `--verbose`, `--quiet`, and `--json` flags
  automatically
- In JSON mode, non-fatal messages are suppressed; fatal goes to stderr as JSON

## Examples

### Shell Command Model

Use `executeProcess` from `src/infrastructure/process/process_executor.ts` for
shell commands. Pass `context.logger` to stream output through LogTape (console
display + file persistence via RunFileSink).

```typescript
import { z } from "npm:zod@4";
import { executeProcess } from "../../../../src/infrastructure/process/process_executor.ts";

const InputSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
});

export const model = {
  type: "@user/shell",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Command output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description: "Execute shell command",
      execute: async (definition, context) => {
        const result = await executeProcess({
          command: definition.attributes.command,
          args: definition.attributes.args,
          logger: context.logger,
        });

        const writer = context.createDataWriter!({
          name: "output",
          specType: "data",
        });
        const handle = await writer.writeText(JSON.stringify({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }));
        return { dataHandles: [handle] };
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
  type: "@user/search",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "data": {
      specType: "data",
      description: "Search results",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
    "log": {
      specType: "log",
      description: "Search execution log",
      contentType: "application/json",
      lifetime: "7d",
      garbageCollection: 10,
      tags: { type: "log" },
    },
  },
  methods: {
    search: {
      description: "Search and store results with log",
      execute: async (definition, context) => {
        const results = ["result1", "result2"];

        // Primary result data
        const resultsWriter = context.createDataWriter!({
          name: "results",
          specType: "data",
        });
        const resultsHandle = await resultsWriter.writeText(
          JSON.stringify({ results }),
        );

        // Execution log
        const logWriter = context.createDataWriter!({
          name: "search-log",
          specType: "log",
        });
        const logHandle = await logWriter.writeText(JSON.stringify({
          query: definition.attributes.query,
          timestamp: new Date().toISOString(),
          resultCount: results.length,
        }));

        return { dataHandles: [resultsHandle, logHandle] };
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
  type: "@user/api-resource",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "resource": {
      specType: "resource",
      description: "API resource state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
    },
  },
  methods: {
    create: {
      description: "Create resource via API",
      execute: async (definition, context) => {
        const response = await fetch(definition.attributes.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${definition.attributes.apiKey}`,
          },
        });
        const data = await response.json();

        const writer = context.createDataWriter!({
          name: "resource",
          specType: "resource",
        });
        const handle = await writer.writeText(JSON.stringify({
          resourceId: data.id,
          status: data.status,
          createdAt: new Date().toISOString(),
        }));
        return { dataHandles: [handle] };
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
  type: "@user/s3-bucket",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataOutputSpecs: {
    "resource": {
      specType: "resource",
      description: "S3 bucket resource state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
    },
    "data": {
      specType: "data",
      description: "S3 object listing",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    create: {
      description: "Create an S3 bucket",
      execute: async (definition, context) => {
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

        const writer = context.createDataWriter!({
          name: "resource",
          specType: "resource",
        });
        const handle = await writer.writeText(JSON.stringify({
          bucketName,
          region,
          arn: `arn:aws:s3:::${bucketName}`,
          createdAt: new Date().toISOString(),
        }));
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "List objects in the bucket",
      execute: async (definition, context) => {
        // Implement S3 ListObjects API call
        const writer = context.createDataWriter!({
          name: "objects",
          specType: "data",
        });
        const handle = await writer.writeText(JSON.stringify({
          objects: [], // Populate from API response
        }));
        return { dataHandles: [handle] };
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

      const writer = context.createDataWriter!({
        name: "resource",
        specType: "resource",
      });
      const handle = await writer.writeText(JSON.stringify({
        environment: env,
        status: "deployed",
      }));
      return { dataHandles: [handle] };
    },
  },
},
```

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

- **Built-in example**: See `src/domain/models/echo/echo_model.ts` for reference
- **Model loader**: See `src/domain/models/user_model_loader.ts` for API details
- **Model design**: See [design/models.md](design/models.md) for concepts
