# @swamp-club/swamp-testing

Test utilities for [swamp](https://github.com/swamp-club/swamp) extensions.
Provides test factories for all extension types — models, vaults, datastores,
and reports — for unit testing without real infrastructure.

## Installation

```bash
deno add jsr:@swamp-club/swamp-testing
```

Or add to your `deno.json` imports:

```json
{
  "imports": {
    "@swamp-club/swamp-testing": "jsr:@swamp-club/swamp-testing"
  }
}
```

## Usage

```typescript
import { createModelTestContext } from "@swamp-club/swamp-testing";
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
reference](https://github.com/swamp-club/swamp/blob/main/.claude/skills/swamp-extension/references/model/api.md#custom-cel-evaluation)
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
import { createVaultTestContext } from "@swamp-club/swamp-testing";

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
import { createDatastoreTestContext } from "@swamp-club/swamp-testing";

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

## `createInMemoryRemote`

A shared remote datastore held in memory, with file content. Each
`connect(cacheDir)` returns a sync service for one local cache directory, so
several connections simulate several machines sharing one bucket.

```typescript
import { createInMemoryRemote } from "@swamp-club/swamp-testing";

Deno.test("a pushed file reaches another machine", async () => {
  const remote = createInMemoryRemote();
  const a = remote.connect(cacheA, { instance: "a" });
  const b = remote.connect(cacheB, { instance: "b" });

  await Deno.writeTextFile(join(cacheA, "data", "x"), "hello");
  await a.markDirty({ relPath: "data/x" });
  await a.pushChanged();

  await b.pullChanged();
  assertEquals(await Deno.readTextFile(join(cacheB, "data", "x")), "hello");
});
```

Connected services follow the `markDirty` contract:

- **Marks.** A `markDirty` call with a `relPath` marks that path; a bare call
  marks everything and makes the next push a full walk of the cache. A `relPath`
  that is not cache-relative with forward slashes is recorded in `violations()`
  and never pushed. `markDirty` never throws.
- **Push.** A marked file is uploaded. A marked directory uploads every file
  under it. A marked path missing on disk is deleted remotely, with everything
  under it. A push only deletes paths that connection has already pushed or
  pulled, so it never deletes a peer's file it has not seen. It clears only the
  marks it started with, and only on success.
- **Pull.** A pull downloads files the remote changed since that connection last
  synced them. It skips files that are marked locally and never overwrites a
  local edit to a file the remote has not changed.
- **Two-phase push.** `preparePush` stages a push without touching the remote or
  the marks; `commitPush` applies it and clears the marks it was built from.
- **Per-machine files.** `_catalog.db*`, `.lock` files, `_index/`, `_control/`
  and the sync sidecars never cross between machines, as in the S3 and GCS
  datastores.

| Option (`createInMemoryRemote`) | Default                                       | Description                                             |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `pullDeletes`                   | `false`                                       | Pull deletes local files a peer removed (unless marked) |
| `capabilities`                  | `{ twoPhaseSync: true, configRefresh: true }` | What every connection reports from `capabilities()`     |

| Option (`connect`)    | Default        | Description                               |
| --------------------- | -------------- | ----------------------------------------- |
| `instance`            | `instance-<n>` | Name recorded in `remote.ops()`           |
| `fullWalkOnFirstPush` | `false`        | Treat the first push as a full cache walk |

`pullDeletes: false` matches what the S3 and GCS datastores do today: a pull
stops tracking a file a peer deleted but leaves it on disk.
`fullWalkOnFirstPush` defaults to `false` on purpose. The contract asks a sync
service that keeps its marks in memory to walk the whole cache on its first push
after starting, but a full walk would upload files whose `markDirty` call was
missed, hiding exactly the bugs this fake exists to catch.

For tests:

- `remote.files()`, `read`, `write` and `delete` inspect or seed the remote
  directly, as an out-of-band peer would.
- `remote.ops()` lists every successful push, pull, prepare and commit across
  connections, in order.
- `failNext(op, error?)` makes the next `"push"`, `"pull"`, `"prepare"` or
  `"commit"` reject before it changes anything.
- `offline(true)` makes every remote call reject while marks still record.
- `marks()`, `dirtyPaths()` and `isBulkDirty()` show a connection's marks.

The fake does not scope by namespace and has no lazy hydration, control-plane
store or `previewPush`.

In swamp's own repository, `registerTestDatastoreType(remote)` in
`src/infrastructure/persistence/test_helpers/test_datastore_type.ts` registers
the fake as a datastore type, so `requireInitializedRepo` connects a repo to it
end to end. It lives there because this package cannot import swamp core.

## `createRecordingSyncService`

A sync service that only records `markDirty` calls. Push and pull do nothing.

```typescript
import { createRecordingSyncService } from "@swamp-club/swamp-testing";

const { service, marks } = createRecordingSyncService();
await service.markDirty({ relPath: "data/x" });
await service.markDirty();
assertEquals(marks, ["data/x", undefined]); // undefined is a bare call
```

## `createReportTestContext`

Fake `ReportContext` for testing report `execute` functions. Supports all three
scopes (method, model, workflow) with pre-seeded data and definition
repositories.

```typescript
import { createReportTestContext } from "@swamp-club/swamp-testing";

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
import type { ModelDefinition } from "jsr:@swamp-club/swamp-testing";

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
[`references/typing.md`](https://github.com/swamp-club/swamp/blob/main/.claude/skills/swamp-extension-model/references/typing.md)
guide in the swamp-extension-model skill for the full rationale, worked example,
and the `defineModel` function-form alternative.

## License

AGPL-3.0-only — see
[LICENSE](https://github.com/swamp-club/swamp/blob/main/LICENSE).
