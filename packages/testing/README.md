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

## CEL Evaluation in Tests

`createModelTestContext` provides `ctx.createCelEnvironment()` — a working
cel-js Environment seeded with the same baseline registrations as production.
Extensions that use CEL evaluation in their `execute` methods can be unit-tested
with no extra setup. See the
[Custom CEL Evaluation section in the model API
reference](https://github.com/systeminit/swamp/blob/main/.claude/skills/swamp-extension/references/model/api.md#custom-cel-evaluation)
for usage patterns.

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

## Model authoring escape hatch

In addition to test utilities, this package exports `ModelDefinition` (and
`defineModel`) for extension authors who hit `TS7006` — implicit-`any` errors on
`execute` parameters — when a sibling `_test.ts` file imports the model source
under strict mode. The escape hatch is a one-line wrap of the model literal:

```typescript
import { z } from "npm:zod@4";
import type { ModelDefinition } from "jsr:@systeminit/swamp-testing";

const GlobalArgsSchema = z.object({ region: z.string() });

export const model = {
  type: "@myorg/my-model",
  version: "2026.04.21.1",
  globalArguments: GlobalArgsSchema,
  methods: {
    run: {
      description: "Run the model",
      arguments: z.object({ bucket: z.string() }),
      execute: async (_args, context) => {
        // context.globalArgs narrows to { region: string }
        return { dataHandles: [] };
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;
```

No change is required for models whose tests don't import the source — the
unannotated default form in the swamp-extension-model skill still applies. See
the
[`references/typing.md`](https://github.com/systeminit/swamp/blob/main/.claude/skills/swamp-extension-model/references/typing.md)
guide in the swamp-extension-model skill for the full rationale, worked example,
and the `defineModel` function-form alternative.

## License

AGPL-3.0-only — see
[LICENSE](https://github.com/systeminit/swamp/blob/main/LICENSE).
