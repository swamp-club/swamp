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
        // writeResource(specName, instanceName, data) — for single-instance, use specName as instanceName
        const handle = await context.writeResource!("result", "result", {
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
| `type`            | Yes      | Unique identifier (`namespace/name`)                                     |
| `version`         | Yes      | CalVer version (`YYYY.MM.DD.MICRO`)                                      |
| `globalArguments` | No       | Zod schema for global arguments validation                               |
| `resources`       | No       | Resource output specs — JSON data with Zod schema                        |
| `files`           | No       | File output specs — binary/text with content type                        |
| `inputsSchema`    | No       | Zod schema for runtime inputs                                            |
| `methods`         | Yes      | Object of method definitions (each with required `arguments` Zod schema) |

### Model-Level Inputs

Models can define an `inputsSchema` for runtime parameterization. These inputs
are provided via `--input` or `--input-file` when running methods:

```typescript
export const model = {
  type: "@user/deploy",
  version: 1,
  globalArguments: z.object({
    serviceName: z.string(),
    target: z.string(), // Will use ${{ inputs.environment }}
  }),
  resources: {
    "state": {
      description: "Deployment resource state",
      schema: z.object({
        deployed: z.boolean(),
        target: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  inputsSchema: z.object({
    environment: z.enum(["dev", "staging", "production"]),
    dryRun: z.boolean().optional().default(false),
  }),
  methods: {
    deploy: {
      description: "Deploy the service",
      arguments: z.object({}),
      execute: async (args, context) => {
        // Inputs are evaluated before execution, so context.globalArgs
        // contains the resolved values (e.g., target = "production")
        const handle = await context.writeResource!("state", "state", {
          deployed: true,
          target: context.globalArgs.target,
        });
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

## Resources & Files

Models declare their data outputs using `resources` and/or `files` on the model
definition. These are model-level — shared across all methods. Any method can
write to any declared spec.

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

| Field               | Required | Description                                   |
| ------------------- | -------- | --------------------------------------------- |
| `description`       | No       | Human-readable description                    |
| `schema`            | Yes      | Zod schema for validation                     |
| `lifetime`          | Yes      | How long data persists                        |
| `garbageCollection` | Yes      | Version retention policy                      |
| `tags`              | No       | Extra tags (auto-includes `type: "resource"`) |

**Spec naming:** Resource spec keys must not contain hyphens (`-`). CEL
expressions use dot-notation to access resources
(`model.<m>.resource.<specName>.<instanceName>.attributes.<field>`), and hyphens
in spec names are interpreted as the subtraction operator. Use camelCase or
single words instead (e.g., `igw` not `internet-gateway`, `routeTable` not
`route-table`).

**Schema and expression validation:** If your resource will be referenced by
other models via CEL expressions, you must declare the referenced properties
explicitly in the Zod schema. Using `z.object({}).passthrough()` allows any data
to be stored, but the expression path validator cannot resolve attribute
references against an empty schema. Always declare the key properties you need
to reference:

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
  "download": {
    description: "Downloaded file",
    contentType: "application/octet-stream",
    lifetime: "infinite",
    garbageCollection: 10,
  },
},
```

| Field               | Required | Description                               |
| ------------------- | -------- | ----------------------------------------- |
| `description`       | No       | Human-readable description                |
| `contentType`       | Yes      | MIME type                                 |
| `lifetime`          | Yes      | How long data persists                    |
| `garbageCollection` | Yes      | Version retention policy                  |
| `streaming`         | No       | True for line-oriented streaming          |
| `tags`              | No       | Extra tags (auto-includes `type: "file"`) |

## Execute Function

The execute function receives pre-validated `args` (from the method's
`arguments` Zod schema) and a `context` object. It uses `writeResource` for JSON
data and `createFileWriter` for binary/text content.

```typescript
execute: (async (args, context) => {
  // args                   - Pre-validated against the method's `arguments` Zod schema
  // context.globalArgs     - Global arguments (validated against model's `globalArguments` schema)
  // context.definition     - { id, name, version, tags } of the current definition
  // context.methodName     - Name of the executing method
  // context.repoDir        - Repository root path
  // context.logger         - LogTape Logger for emitting log messages
  // context.dataRepository - For advanced data operations
  // context.writeResource  - Write structured JSON data (validates against schema)
  // context.createFileWriter - Create a writer for binary/text files
  // context.inputs         - Runtime inputs (if inputsSchema defined)

  // 1. Write a resource — specName must match a key in `resources`
  const handle = await context.writeResource!("result", "result", {
    value: "processed",
    timestamp: new Date().toISOString(),
  });

  // 2. Return the data handles
  return { dataHandles: [handle] };
});
```

### writeResource API

Write structured JSON data:
`context.writeResource(specName, name, data, overrides?)`.

- `specName` — must match a key in the model's `resources`
- `name` — the instance name (any non-empty string; use specName for
  single-instance resources)

Data is validated against the resource's Zod schema (warns on mismatch, doesn't
throw). The `name` you pass here is the `<instanceName>` used in CEL:
`model.<defName>.resource.<specName>.<instanceName>.attributes.<field>`.

**ResourceWriteOverrides** (optional):

| Field               | Description                                    |
| ------------------- | ---------------------------------------------- |
| `lifetime`          | Override lifetime (default from spec)          |
| `garbageCollection` | Override version retention (default from spec) |
| `tags`              | Additional tags                                |

### createFileWriter API

Create a file writer: `context.createFileWriter(specName, name, overrides?)`.

- `specName` — must match a key in the model's `files`
- `name` — the instance name (any non-empty string; use specName for
  single-instance files)

Returns a `DataWriter` for binary/streaming content. The `name` you pass here is
the `<instanceName>` used in CEL:
`model.<defName>.file.<specName>.<instanceName>.path`.

**FileWriterOverrides** (optional):

| Field               | Description                                    |
| ------------------- | ---------------------------------------------- |
| `contentType`       | Override MIME type (default from spec)         |
| `lifetime`          | Override lifetime (default from spec)          |
| `garbageCollection` | Override version retention (default from spec) |
| `streaming`         | True for line-oriented streaming               |
| `tags`              | Additional tags                                |

**DataWriter Methods:**

| Method                      | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `writeAll(content)`         | Write complete binary content (`Uint8Array`)     |
| `writeText(text)`           | Write text content (encoded as UTF-8)            |
| `writeLine(line)`           | Append a single line (for streaming/incremental) |
| `writeStream(stream, opts)` | Pipe a `ReadableStream<Uint8Array>`              |
| `getFilePath()`             | Get the file path for direct I/O                 |
| `finalize()`                | Finalize after using `writeLine`/`getFilePath`   |

**DataHandle** (returned by `writeResource` and writer methods):

| Field      | Description                          |
| ---------- | ------------------------------------ |
| `name`     | Data artifact name                   |
| `specName` | The declared spec name               |
| `kind`     | `"resource"` or `"file"`             |
| `dataId`   | Unique ID for this data              |
| `version`  | Version number of this write         |
| `size`     | Size of the written content in bytes |
| `tags`     | Tags from the writer options         |
| `metadata` | Full metadata for the data artifact  |

**UserMethodResult:**

The execute function returns `{ dataHandles?: DataHandle[] }`.

### Reading Stored Data

Delete and update methods need to read back previously stored resource data
(e.g., to get a resource ID for cleanup). Use `context.dataRepository` with
`context.modelType` and `context.modelId`:

```typescript
const content = await context.dataRepository.getContent(
  context.modelType,
  context.modelId,
  "<specName>", // matches a key in resources
  "<instanceName>", // instance name used when writing
);
// Returns Uint8Array | null
```

To parse the content:

```typescript
if (!content) {
  throw new Error("No data found - nothing to delete");
}
const data = JSON.parse(new TextDecoder().decode(content));
```

**Key dataRepository methods for model authors:**

| Method                                                    | Returns              | Description                            |
| --------------------------------------------------------- | -------------------- | -------------------------------------- |
| `getContent(type, modelId, dataName, instanceName, ver?)` | `Uint8Array \| null` | Get raw content bytes                  |
| `findByName(type, modelId, dataName, instanceName, ver?)` | `Data \| null`       | Get data metadata (tags, version, etc) |
| `findAllForModel(type, modelId)`                          | `Data[]`             | List all data for this model instance  |

### Lifetime Values

| Value       | Behavior                                     |
| ----------- | -------------------------------------------- |
| `ephemeral` | Deleted after method/workflow completes      |
| `job`       | Persists while creating job runs             |
| `workflow`  | Persists while creating workflow runs        |
| Duration    | Expires after time (e.g., `1h`, `7d`, `1mo`) |
| `infinite`  | Never expires (default)                      |

### Standard Tags

Tags are auto-applied based on the spec kind:

| Tag                  | Applied to | Description                              |
| -------------------- | ---------- | ---------------------------------------- |
| `type: "resource"`   | resources  | Auto-added to all resource data outputs  |
| `type: "file"`       | files      | Auto-added to all file data outputs      |
| `specName: "<name>"` | both       | Auto-added with the output spec key name |

## Instance Names

The `name` parameter (second argument) on `writeResource` and `createFileWriter`
sets the **instance name** — this is the same identifier used in CEL expressions
to access the data:

```
writeResource("state", "my-deploy", data)
  → accessible as: model.<defName>.resource.state.my-deploy.attributes.<field>
                                          ─────  ─────────
                                        specName instanceName
```

**Convention:** For single-instance resources (most models), pass the specName
as both arguments: `writeResource("state", "state", data)`. This produces the
CEL path `model.<name>.resource.state.state.attributes.<field>`.

**Factory models** use distinct instance names to produce multiple outputs from
one spec — see [Factory Models](#factory-models-dynamic-instance-names) below.

> **Both `specName` and `name` are required.** If you omit the `name` argument
> (old 2-arg form), the `data` object is silently treated as the name string,
> causing a runtime error.

## Factory Models (Dynamic Instance Names)

A single method execution can produce multiple dynamically-named resources from
the same output spec by passing a `name` override. This is useful when a model
discovers N items and needs to emit each as a separately-addressable resource.

```typescript
// extensions/models/subnet_scanner.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({ vpcId: z.string() });

const SubnetSchema = z.object({
  subnetId: z.string(),
  cidr: z.string(),
  az: z.string(),
});

export const model = {
  type: "@user/subnet-scanner",
  version: "2026.02.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "subnet": {
      description: "Discovered subnet",
      schema: SubnetSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    scan: {
      description: "Scan VPC and emit each subnet as a named resource",
      arguments: z.object({}),
      execute: async (args, context) => {
        // Simulated discovery — real model would call AWS API
        const subnets = [
          { subnetId: "subnet-aaa", cidr: "10.0.1.0/24", az: "us-east-1a" },
          { subnetId: "subnet-bbb", cidr: "10.0.2.0/24", az: "us-east-1b" },
        ];

        const handles = [];
        for (const subnet of subnets) {
          // Each call uses the same "subnet" spec but a unique instance name
          const handle = await context.writeResource!(
            "subnet",
            subnet.subnetId,
            subnet,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },
  },
};
```

### How it works

- The `name` parameter (second argument) on `writeResource` / `createFileWriter`
  sets the instance name.
- Each write produces a distinct data artifact — validation passes because
  instance names are unique.
- A `specName` tag is auto-injected so all instances from the same spec can be
  discovered with `data.findBySpec("model-name", "subnet")`.
- Individual instances are addressable in CEL as
  `model.<name>.resource.<specName>.<instanceName>.attributes.<field>`.

### Discovering factory outputs in CEL

```yaml
# Get all subnets produced by the scanner
allSubnets: ${{ data.findBySpec("my-scanner", "subnet") }}

# Access a specific named instance
subnetA: ${{ model.my-scanner.resource.subnet.subnet-aaa.attributes.cidr }}
```

### Factory vs forEach

| Pattern            | Use when                                         |
| ------------------ | ------------------------------------------------ |
| Factory model      | One execution discovers/creates N outputs        |
| forEach (workflow) | Run the same model N times with different inputs |

## CRUD Lifecycle Models

Models that manage real resources typically have `create`, `update`, and
`delete` methods. See
[references/examples.md](references/examples.md#crud-lifecycle-model-vpc) for a
complete VPC example with all three methods.

**Pattern summary:**

- **`create`** — run a command/API call, store the result via `writeResource()`
- **`update`** — read stored data via `context.dataRepository.getContent()`,
  modify the resource, write updated state via `writeResource()` (new version)
- **`delete`** — read stored data, clean up the resource, return
  `{ dataHandles: [] }`

**Delete workflow ordering:** Delete workflows require **explicit `dependsOn`**
in reverse dependency order. Unlike create workflows where CEL expressions
create implicit dependencies, delete methods read their own stored data via
`context.dataRepository` — not other models' data via expressions. See the
`swamp-workflow` skill's
[data-chaining reference](../swamp-workflow/references/data-chaining.md) for
delete workflow examples.

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
      arguments: z.object({}),
      execute: async (args, context) => {
        // Extensions use the target model's resources/files
        const handle = await context.writeResource!("message", "message", {
          message: `Audited: ${context.definition.name}`,
          timestamp: new Date().toISOString(),
        });
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
- Extension methods must define their own `arguments` Zod schema
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
context.logger.info("Processing {name}", { name: context.definition.name });
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

const GlobalArgsSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
});

export const model = {
  type: "@user/shell",
  version: "2026.02.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "output": {
      description: "Command output",
      schema: z.object({
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Execute shell command",
      arguments: z.object({}),
      execute: async (args, context) => {
        const result = await executeProcess({
          command: context.globalArgs.command,
          args: context.globalArgs.args,
          logger: context.logger,
        });

        const handle = await context.writeResource!("output", "output", {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

### Model with Resources and Files

```typescript
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({ query: z.string() });

export const model = {
  type: "@user/search",
  version: "2026.02.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "results": {
      description: "Search results",
      schema: z.object({ results: z.array(z.string()) }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    "log": {
      description: "Search execution log",
      contentType: "application/json",
      lifetime: "7d",
      garbageCollection: 10,
      streaming: true,
    },
  },
  methods: {
    search: {
      description: "Search and store results with log",
      arguments: z.object({}),
      execute: async (args, context) => {
        const results = ["result1", "result2"];

        // Primary result data (resource)
        const resultsHandle = await context.writeResource!(
          "results",
          "results",
          {
            results,
          },
        );

        // Execution log (file)
        const logWriter = context.createFileWriter!("log", "log");
        const logHandle = await logWriter.writeText(JSON.stringify({
          query: context.globalArgs.query,
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

const GlobalArgsSchema = z.object({
  endpoint: z.string().url(),
  apiKey: z.string(), // Use vault expression: ${{ vault.get(my-vault, API_KEY) }}
});

export const model = {
  type: "@user/api-resource",
  version: "2026.02.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "state": {
      description: "API resource state",
      schema: z.object({
        resourceId: z.string(),
        status: z.string(),
        createdAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create resource via API",
      arguments: z.object({}),
      execute: async (args, context) => {
        const response = await fetch(context.globalArgs.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${context.globalArgs.apiKey}`,
          },
        });
        const data = await response.json();

        const handle = await context.writeResource!("state", "state", {
          resourceId: data.id,
          status: data.status,
          createdAt: new Date().toISOString(),
        });
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

const GlobalArgsSchema = z.object({
  bucketName: z.string(),
  region: z.string().default("us-east-1"),
  accessKeyId: z.string(), // Use: ${{ vault.get(aws-vault, ACCESS_KEY_ID) }}
  secretAccessKey: z.string(), // Use: ${{ vault.get(aws-vault, SECRET_ACCESS_KEY) }}
});

export const model = {
  type: "@user/s3-bucket",
  version: "2026.02.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "bucket": {
      description: "S3 bucket resource state",
      schema: z.object({
        bucketName: z.string(),
        region: z.string(),
        arn: z.string(),
        createdAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "objects": {
      description: "S3 object listing",
      schema: z.object({
        objects: z.array(z.any()),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create an S3 bucket",
      arguments: z.object({}),
      execute: async (args, context) => {
        const { bucketName, region, accessKeyId, secretAccessKey } =
          context.globalArgs;

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

        const handle = await context.writeResource!("bucket", "bucket", {
          bucketName,
          region,
          arn: `arn:aws:s3:::${bucketName}`,
          createdAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "List objects in the bucket",
      arguments: z.object({}),
      execute: async (args, context) => {
        // Implement S3 ListObjects API call
        const handle = await context.writeResource!("objects", "objects", {
          objects: [], // Populate from API response
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

### Method with Arguments

Each method defines its own `arguments` Zod schema for per-method parameters.
These are pre-validated and passed as the first argument to `execute`:

```typescript
methods: {
  deploy: {
    description: "Deploy with environment-specific config",
    arguments: z.object({
      environment: z.enum(["dev", "staging", "prod"]),
      dryRun: z.boolean().optional(),
    }),
    execute: async (args, context) => {
      const env = args.environment;
      // Use env for deployment logic...

      const handle = await context.writeResource!("state", "state", {
        environment: env,
        status: "deployed",
      });
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

- **Examples**: See [references/examples.md](references/examples.md) for
  complete model examples (CRUD lifecycle, data chaining, extensions, etc.)
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  errors and fixes
- **Built-in example**: See `src/domain/models/echo/echo_model.ts` for reference
- **Model loader**: See `src/domain/models/user_model_loader.ts` for API details
- **Model design**: See [design/models.md](design/models.md) for concepts
