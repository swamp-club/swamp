# Extension Model API Reference

Detailed API documentation for extension model development.

## Table of Contents

- [Resource & File Specs](#resource--file-specs)
- [Reading Bundled Assets](#reading-bundled-assets)
- [writeResource API](#writeresource-api)
- [createFileWriter API](#createfilewriter-api)
- [DataWriter Methods](#datawriter-methods)
- [DataHandle Structure](#datahandle-structure)
- [Reading Stored Data](#reading-stored-data)
- [Lifetime Values](#lifetime-values)
- [Standard Tags](#standard-tags)
- [Error Handling](#error-handling)
- [Logging API](#logging-api)

---

## Resource & File Specs

Models declare their data outputs using `resources` and/or `files` on the model
export.

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
schema: z.object({ VpcId: z.string() }).passthrough();
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

---

## Reading Bundled Assets

Models shipped via an extension manifest can declare runtime assets in
`additionalFiles`. These paths resolve relative to the manifest's own directory
in both modes — no migration needed for existing manifests (default mode is
unchanged):

```yaml
# manifest.yaml
additionalFiles:
  - prompts/review.md
  - templates/summary.txt
```

Read them at runtime via `ctx.extensionFile()`:

```ts
execute: (async (_args, ctx) => {
  const promptPath = ctx.extensionFile("prompts/review.md");
  const prompt = await Deno.readTextFile(promptPath);
  // ...
});
```

Do **not** hardcode `.swamp/pulled-extensions/<name>/files/...` — that layout
only exists for pulled extensions. Source-loaded extensions
(`swamp extension source add`) resolve the same relative path against the
manifest directory, which `ctx.extensionFile()` handles for you. Hardcoded paths
pass smoke tests in source mode but break when consumers pull the extension.

---

## writeResource API

Write structured JSON data:
`context.writeResource(specName, instanceName, data, overrides?)`.

**Parameters:**

| Parameter      | Description                                                     |
| -------------- | --------------------------------------------------------------- |
| `specName`     | Must match a key in the model's `resources`                     |
| `instanceName` | The instance name (must be unique across all specs — see below) |
| `data`         | JSON data to write (validated against the resource's Zod schema |
| `overrides`    | Optional overrides (see below)                                  |

Data is validated against the resource's Zod schema (warns on mismatch, doesn't
throw). The `instanceName` you pass here is used in CEL:
`model.<defName>.resource.<specName>.<instanceName>.attributes.<field>`.

**Instance name uniqueness:** Instance names map directly to storage paths on
disk. If two different specs use the same instance name (e.g.,
`writeResource("summary", "bixu", ...)` and
`writeResource("repo", "bixu", ...)`), the second write overwrites the first.
When a model has multiple resource specs, prefix instance names with the spec
name or use another strategy to ensure uniqueness across all specs within a
method execution.

```typescript
// Wrong — "bixu" collides across specs on disk
await context.writeResource("summary", "bixu", summaryData);
await context.writeResource("repo", "bixu", repoData); // overwrites!

// Correct — prefix ensures unique storage paths
await context.writeResource("summary", `summary-${user}`, summaryData);
await context.writeResource("repo", `repo-${repo}`, repoData);
```

**ResourceWriteOverrides** (optional):

| Field               | Description                                    |
| ------------------- | ---------------------------------------------- |
| `lifetime`          | Override lifetime (default from spec)          |
| `garbageCollection` | Override version retention (default from spec) |
| `tags`              | Additional tags                                |

**Example:**

```typescript
// Single-instance resource (use descriptive instance name)
const handle = await context.writeResource("state", "current", {
  status: "active",
  updatedAt: new Date().toISOString(),
});

// Factory model (use dynamic instance names)
for (const item of items) {
  await context.writeResource("item", item.id, item);
}
```

---

## createFileWriter API

Create a file writer:
`context.createFileWriter(specName, instanceName, overrides?)`.

**Parameters:**

| Parameter      | Description                              |
| -------------- | ---------------------------------------- |
| `specName`     | Must match a key in the model's `files`  |
| `instanceName` | The instance name (any non-empty string) |
| `overrides`    | Optional overrides (see below)           |

Returns a `DataWriter` for binary/streaming content. The `instanceName` you pass
here is used in CEL: `model.<defName>.file.<specName>.<instanceName>.path`.

**FileWriterOverrides** (optional):

| Field               | Description                                    |
| ------------------- | ---------------------------------------------- |
| `contentType`       | Override MIME type (default from spec)         |
| `lifetime`          | Override lifetime (default from spec)          |
| `garbageCollection` | Override version retention (default from spec) |
| `streaming`         | True for line-oriented streaming               |
| `tags`              | Additional tags                                |

---

## DataWriter Methods

| Method                      | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `writeAll(content)`         | Write complete binary content (`Uint8Array`)     |
| `writeText(text)`           | Write text content (encoded as UTF-8)            |
| `writeLine(line)`           | Append a single line (for streaming/incremental) |
| `writeStream(stream, opts)` | Pipe a `ReadableStream<Uint8Array>`              |
| `getFilePath()`             | Get the file path for direct I/O                 |
| `finalize()`                | Finalize after using `writeLine`/`getFilePath`   |

**Example:**

```typescript
// Write text file
const logWriter = context.createFileWriter("log", "execution");
const handle = await logWriter.writeText(JSON.stringify({
  timestamp: new Date().toISOString(),
  message: "Operation completed",
}));

// Streaming log (line by line)
const streamWriter = context.createFileWriter("log", "stream", {
  streaming: true,
});
await streamWriter.writeLine("Starting process...");
await streamWriter.writeLine("Step 1 complete");
await streamWriter.writeLine("Done");
const handle = await streamWriter.finalize();
```

---

## DataHandle Structure

Returned by `writeResource` and writer methods:

| Field      | Description                                |
| ---------- | ------------------------------------------ |
| `name`     | Data artifact name                         |
| `specName` | The declared spec name                     |
| `kind`     | `"resource"` or `"file"`                   |
| `dataId`   | Unique ID for this data                    |
| `version`  | Version number of this write               |
| `size`     | Size of the written content in bytes       |
| `tags`     | Tags from the writer options               |
| `metadata` | Metadata for the data artifact (see below) |

**`metadata` sub-fields:**

| Field               | Type                      | Description                                              |
| ------------------- | ------------------------- | -------------------------------------------------------- |
| `contentType`       | `string`                  | MIME type (e.g. `"application/json"`)                    |
| `lifetime`          | `Lifetime`                | TTL from the spec (e.g. `"7d"`, `"infinite"`)            |
| `garbageCollection` | `GarbageCollectionPolicy` | Version retention count or duration                      |
| `streaming`         | `boolean`                 | Whether the data was written as streaming                |
| `tags`              | `Record<string, string>`  | Tags (e.g. `type`, `specName`, `modelName`)              |
| `ownerDefinition`   | `OwnerDefinition`         | Owner type and ref (model-method, workflow-step, manual) |
| `lifecycle`         | `"active" \| "deleted"`   | Current lifecycle state                                  |
| `renamedTo`         | `string?`                 | New name if the data was renamed                         |

**UserMethodResult:**

The execute function returns `{ dataHandles?: DataHandle[] }`.

---

## Reading Stored Data

Delete and update methods need to read back previously stored resource data
(e.g., to get a resource ID for cleanup). Use `context.readResource()`:

```typescript
// Define a type alias from your resource schema for type-safe access:
type VpcData = z.infer<typeof VpcSchema>;
const data = await context.readResource!("vpc") as VpcData | null;
if (!data) {
  throw new Error("No data found - nothing to delete");
}
// data is now typed — access properties without `as any`
data.VpcId; // ← type-safe
```

**Signature:**

```typescript
readResource(
  instanceName: string,  // instance name used when writing
  version?: number,      // optional specific version (defaults to latest)
): Promise<Record<string, unknown> | null>
```

- Returns the parsed JSON object, or `null` if no data exists
- Vault reference expressions are automatically resolved when a vault service is
  available
- Cast the result using `z.infer<typeof YourSchema>` to get type-safe access
  (the data was already validated against the schema on write)

**Low-level alternative for binary data:**

For non-JSON content (binary files, raw bytes), use `context.dataRepository`
directly:

```typescript
const content = await context.dataRepository.getContent(
  context.modelType,
  context.modelId,
  "<instanceName>",
);
// Returns Uint8Array | null
```

**Key dataRepository methods for model authors:**

| Method                                      | Returns              | Description                            |
| ------------------------------------------- | -------------------- | -------------------------------------- |
| `getContent(type, modelId, dataName, ver?)` | `Uint8Array \| null` | Get raw content bytes                  |
| `findByName(type, modelId, dataName, ver?)` | `Data \| null`       | Get data metadata (tags, version, etc) |
| `findAllForModel(type, modelId)`            | `Data[]`             | List all data for this model instance  |

---

## Lifetime Values

| Value       | Behavior                                     |
| ----------- | -------------------------------------------- |
| `ephemeral` | Deleted after method/workflow completes      |
| `job`       | Persists while creating job runs             |
| `workflow`  | Persists while creating workflow runs        |
| Duration    | Expires after time (e.g., `1h`, `7d`, `1mo`) |
| `infinite`  | Never expires (default)                      |

---

## Standard Tags

Tags are auto-applied based on the spec kind:

| Tag                  | Applied to | Description                              |
| -------------------- | ---------- | ---------------------------------------- |
| `type: "resource"`   | resources  | Auto-added to all resource data outputs  |
| `type: "file"`       | files      | Auto-added to all file data outputs      |
| `specName: "<name>"` | both       | Auto-added with the output spec key name |

---

## Error Handling

Models should throw when execution fails. Throw **before** writing data — failed
executions should not persist incorrect or misleading data.

**Pattern: check for failure first, only write data on success.**

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
    timestamp: new Date().toISOString(),
  });

  return { dataHandles: [handle] };
});
```

**Workflow integration:** When a model method throws, the workflow engine
automatically marks the step as failed. Use `allowFailure: true` on a workflow
step to catch exceptions and allow continued execution of subsequent steps.

---

## CheckDefinition API

Pre-flight checks are defined in the model's `checks` field and run
automatically before mutating methods (`create`, `update`, `delete`, `action`).

### execute Signature

```typescript
execute: async (context: MethodContext): Promise<CheckResult>
```

### MethodContext Fields Available in Checks

| Field                    | Description                                    |
| ------------------------ | ---------------------------------------------- |
| `context.globalArgs`     | Validated global arguments from the definition |
| `context.definition`     | `{ id, name, version, tags }`                  |
| `context.methodName`     | Name of the method being invoked               |
| `context.repoDir`        | Repository root path                           |
| `context.logger`         | LogTape Logger for diagnostic output           |
| `context.dataRepository` | For reading previously stored data             |
| `context.modelType`      | The model type string                          |
| `context.modelId`        | The model instance ID                          |

**Important:** `context.writeResource` and `context.createFileWriter` are **NOT
available** in check execute functions. Checks must not produce data output —
they only inspect state and return a pass/fail result.

### CheckResult

```typescript
interface CheckResult {
  pass: boolean;
  errors?: string[]; // required when pass is false; human-readable reasons
}
```

### Three Common Patterns

**1. Value/policy validation** — inspect `context.globalArgs` directly:

```typescript
execute: async (context) => {
  if (context.globalArgs.budget < 0) {
    return { pass: false, errors: ["budget must be non-negative"] };
  }
  return { pass: true };
},
```

**2. Cross-model validation** — read other model's stored data via
`context.dataRepository`:

```typescript
execute: async (context) => {
  const content = await context.dataRepository.getContent(
    "aws/vpc",
    context.globalArgs.vpcId,
    "state",
  );
  if (!content) {
    return { pass: false, errors: [`VPC ${context.globalArgs.vpcId} has no stored state`] };
  }
  return { pass: true };
},
```

**3. Live API checks** — call an external API to verify conditions:

```typescript
execute: async (context) => {
  const res = await fetch(`https://api.example.com/quotas/${context.globalArgs.region}`);
  const quota = await res.json();
  if (quota.remaining < 1) {
    return { pass: false, errors: [`No quota remaining in region ${context.globalArgs.region}`] };
  }
  return { pass: true };
},
```

Label live checks with `labels: ["live"]` so users can skip them in offline
environments using `--skip-check-label live`.

### Extension Checks via modelRegistry.extend()

The `modelRegistry.extend()` method accepts an optional third parameter
`checks?: Record<string, CheckDefinition>` to add checks to an existing model
type:

```typescript
modelRegistry.extend("aws/ec2/vpc", {}, {
  "my-custom-check": {
    description: "Custom policy check added by extension",
    labels: ["policy"],
    execute: async (context) => {
      return { pass: true };
    },
  },
});
```

Check names must be unique -- conflicts with existing checks on the target model
throw an error at registration time.

---

## Logging API

Model methods have access to a pre-configured LogTape logger via
`context.logger`. The logger category is set automatically based on the model
type and method name.

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

| Method/Feature                    | Description                                    |
| --------------------------------- | ---------------------------------------------- |
| `context.logger.with({ ... })`    | Returns logger with extra properties           |
| `context.logger.getChild("name")` | Creates child logger with sub-category         |
| Flag handling                     | Respects `--log-level`, `--verbose`, `--quiet` |
| JSON mode                         | Non-fatal suppressed; fatal goes to stderr     |
