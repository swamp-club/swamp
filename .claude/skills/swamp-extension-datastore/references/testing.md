# Unit Testing Datastore Providers

The `@systeminit/swamp-testing` package provides `createDatastoreTestContext()`
for unit testing datastore provider implementations without real storage
backends.

Install: `deno add jsr:@systeminit/swamp-testing`

## createDatastoreTestContext Options

| Option             | Default                       | Description                      |
| ------------------ | ----------------------------- | -------------------------------- |
| `datastorePath`    | `"/tmp/swamp-test-datastore"` | Path from `resolveDatastorePath` |
| `cachePath`        | `undefined`                   | Path from `resolveCachePath`     |
| `healthResult`     | healthy                       | Override health check result     |
| `lockAcquireFails` | `false`                       | Make lock acquire reject         |
| `withSyncService`  | `false`                       | Enable `createSyncService`       |

## Inspection Helpers

```typescript
const {
  provider, // DatastoreProvider to pass to code under test
  getLockOperations, // () => LockOperation[]
  getSyncOperations, // () => SyncOperation[]
  isLockHeld, // () => boolean
} = createDatastoreTestContext();
```

## Testing Lock Behavior

```typescript
import { createDatastoreTestContext } from "@systeminit/swamp-testing";
import { assertEquals } from "@std/assert";

Deno.test("withLock executes callback under lock", async () => {
  const { provider, isLockHeld } = createDatastoreTestContext();
  const lock = provider.createLock("/ds");

  let heldDuring = false;
  await lock.withLock(async () => {
    heldDuring = isLockHeld();
    await Promise.resolve();
  });

  assertEquals(heldDuring, true);
  assertEquals(isLockHeld(), false);
});
```

## Testing Health Checks

```typescript
Deno.test("verifier reports healthy", async () => {
  const { provider } = createDatastoreTestContext();
  const result = await provider.createVerifier().verify();
  assertEquals(result.healthy, true);
});

Deno.test("verifier reports unhealthy", async () => {
  const { provider } = createDatastoreTestContext({
    healthResult: { healthy: false, message: "Unreachable" },
  });
  const result = await provider.createVerifier().verify();
  assertEquals(result.healthy, false);
});
```

## Testing Sync Services

```typescript
Deno.test("sync service pulls and pushes", async () => {
  const { provider, getSyncOperations } = createDatastoreTestContext({
    withSyncService: true,
  });

  const sync = provider.createSyncService!("/repo", "/cache");
  await sync.pullChanged();
  await sync.pushChanged();

  assertEquals(getSyncOperations().length, 2);
});
```

## Testing Lock Failure Handling

```typescript
import { assertRejects } from "@std/assert";

Deno.test("handles lock acquisition failure", async () => {
  const { provider } = createDatastoreTestContext({ lockAcquireFails: true });
  const lock = provider.createLock("/ds");
  await assertRejects(() => lock.acquire(), Error);
});
```

## In-Repo Extensions

Import directly from the testing package source:

```typescript
import { createDatastoreTestContext } from "../../packages/testing/mod.ts";
```
