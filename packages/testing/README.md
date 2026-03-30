# @systeminit/swamp-testing

Test utilities for [swamp](https://github.com/systeminit/swamp) extensions.
Provides test factories for all extension types — models, vaults, datastores,
execution drivers, and reports — for unit testing without real infrastructure.

## Installation

```bash
deno add jsr:@systeminit/swamp-testing
```

Or add to your `deno.json` imports:

```json
{
  "imports": {
    "@systeminit/swamp-testing": "jsr:@systeminit/swamp-testing"
  }
}
```

## Usage

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

## `createModelTestContext` Options

| Option            | Default             | Description                                           |
| ----------------- | ------------------- | ----------------------------------------------------- |
| `globalArgs`      | `{}`                | Global arguments passed to the execute function       |
| `definition`      | auto-generated      | Definition metadata (`name`, `id`, `version`, `tags`) |
| `methodName`      | `"run"`             | Name of the method being executed                     |
| `repoDir`         | `"/tmp/swamp-test"` | Repository directory path                             |
| `signal`          | never-aborted       | Abort signal for cancellation testing                 |
| `storedResources` | `{}`                | Pre-seed data for `readResource` calls                |
| `onEvent`         | captures only       | Optional callback for domain events                   |

## Inspection Helpers

The return value includes helpers to inspect what happened during execution:

```typescript
const {
  context, // MethodContext to pass to execute()
  getWrittenResources, // Returns Array<{ specName, name, data, handle }>
  getWrittenFiles, // Returns Array<{ specName, name, content, handle }>
  getLogs, // Returns Array<{ level, message, args }>
  getLogsByLevel, // (level) => filtered log entries
  getEvents, // Returns Array<{ type, ...fields }>
} = createModelTestContext();
```

## Testing CRUD Lifecycle Models

Seed stored resources to test methods that read existing state:

```typescript
Deno.test("sync refreshes state", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    storedResources: {
      "main": { instanceId: "i-abc123", status: "running" },
    },
  });

  await model.methods.sync.execute({}, context);

  const resources = getWrittenResources();
  assertEquals(resources[0].data.instanceId, "i-abc123");
});
```

## Injectable Client Pattern

For models that call external APIs, accept an optional client parameter so tests
can pass a stub:

```typescript
// In your model
execute: (async (args, context) => {
  const s3 = args._s3Client ??
    new S3Client({ region: context.globalArgs.region });
  // ...
});

// In your test
const mockClient = { send: () => Promise.resolve({ Bucket: "test" }) };
await model.methods.create.execute({ _s3Client: mockClient }, context);
```

## `createVaultTestContext`

In-memory `VaultProvider` for testing code that reads/writes secrets.

```typescript
import { createVaultTestContext } from "@systeminit/swamp-testing";

Deno.test("reads API key from vault", async () => {
  const { vault, getOperations } = createVaultTestContext({
    secrets: { "api-key": "sk-test-123" },
  });

  const key = await vault.get("api-key");
  assertEquals(key, "sk-test-123");
  assertEquals(getOperations().length, 1);
});
```

| Option           | Default        | Description                           |
| ---------------- | -------------- | ------------------------------------- |
| `name`           | `"test-vault"` | Vault provider name                   |
| `secrets`        | `{}`           | Pre-seed secrets for `get()` calls    |
| `throwOnMissing` | `true`         | Reject on missing keys vs return `""` |

## `createDatastoreTestContext`

In-memory `DatastoreProvider` with fake locking, health checks, and sync.

```typescript
import { createDatastoreTestContext } from "@systeminit/swamp-testing";

Deno.test("lock acquire and release", async () => {
  const { provider, isLockHeld } = createDatastoreTestContext();
  const lock = provider.createLock("/ds");

  await lock.acquire();
  assertEquals(isLockHeld(), true);
  await lock.release();
  assertEquals(isLockHeld(), false);
});
```

| Option             | Default                       | Description                      |
| ------------------ | ----------------------------- | -------------------------------- |
| `datastorePath`    | `"/tmp/swamp-test-datastore"` | Path from `resolveDatastorePath` |
| `cachePath`        | `undefined`                   | Path from `resolveCachePath`     |
| `healthResult`     | healthy                       | Override health check result     |
| `lockAcquireFails` | `false`                       | Make lock acquire reject         |
| `withSyncService`  | `false`                       | Enable `createSyncService`       |

## `createDriverTestContext`

Test harness for `ExecutionDriver` implementations. Provides a well-formed
`ExecutionRequest` and callbacks that capture events.

```typescript
import { createDriverTestContext } from "@systeminit/swamp-testing";

Deno.test("driver executes method", async () => {
  const { request, callbacks, getCapturedLogs } = createDriverTestContext({
    methodName: "run",
    globalArgs: { region: "us-east-1" },
  });

  const result = await myDriver.execute(request, callbacks);
  assertEquals(result.status, "success");
});
```

| Option            | Default        | Description                   |
| ----------------- | -------------- | ----------------------------- |
| `protocolVersion` | `1`            | Protocol version              |
| `modelType`       | `"test/model"` | Model type identifier         |
| `methodName`      | `"run"`        | Method to execute             |
| `globalArgs`      | `{}`           | Global arguments              |
| `methodArgs`      | `{}`           | Method arguments              |
| `definitionMeta`  | auto-generated | Definition metadata overrides |

## `createReportTestContext`

Fake `ReportContext` for testing report `execute` functions. Supports all three
scopes (method, model, workflow) with pre-seeded data and definition
repositories.

```typescript
import { createReportTestContext } from "@systeminit/swamp-testing";

Deno.test("report generates markdown", async () => {
  const { context } = createReportTestContext({
    scope: "method",
    modelType: "aws/ec2",
    methodName: "create",
    executionStatus: "succeeded",
    dataHandles: [],
  });

  const result = await myReport.execute(context);
  assertStringIncludes(result.markdown, "## Summary");
});
```

| Option          | Default             | Description                            |
| --------------- | ------------------- | -------------------------------------- |
| `scope`         | required            | `"method"`, `"model"`, or `"workflow"` |
| `dataArtifacts` | `[]`                | Pre-seed data for the fake repository  |
| `definitions`   | `[]`                | Pre-seed definitions                   |
| `repoDir`       | `"/tmp/swamp-test"` | Repository directory path              |

## License

AGPL-3.0-only — see
[LICENSE](https://github.com/systeminit/swamp/blob/main/LICENSE).
