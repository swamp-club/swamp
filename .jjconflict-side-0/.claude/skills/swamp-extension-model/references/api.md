# Extension Model API Reference

Detailed API documentation for extension model development.

## Table of Contents

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

---

## Reading Stored Data

Delete and update methods need to read back previously stored resource data
(e.g., to get a resource ID for cleanup). Use `context.dataRepository` with
`context.modelType` and `context.modelId`:

```typescript
const content = await context.dataRepository.getContent(
  context.modelType,
  context.modelId,
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
