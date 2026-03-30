# Testing Datastore Extensions

The `@systeminit/swamp-testing` package provides conformance suites and test
doubles for datastore extensions.

Install: `deno add jsr:@systeminit/swamp-testing`

## Export Conformance

One call replaces all structural boilerplate tests (metadata, config schema,
method existence on provider/lock/verifier):

```typescript
import { assertDatastoreExportConformance } from "@systeminit/swamp-testing";
import { datastore } from "./s3.ts";

Deno.test("datastore export conforms", () => {
  assertDatastoreExportConformance(datastore, {
    validConfigs: [{ bucket: "my-bucket", region: "us-east-1" }],
    invalidConfigs: [{}, { bucket: "AB" }],
  });
});
```

This verifies: type matches naming pattern, name/description are non-empty,
configSchema accepts/rejects configs, createProvider returns a DatastoreProvider
with createLock/createVerifier/resolveDatastorePath, lock has all required
methods, verifier has verify().

## Lock Conformance

Test the full DistributedLock contract against your implementation:

```typescript
import { assertLockConformance } from "@systeminit/swamp-testing";

Deno.test("lock contract", async () => {
  const lock = provider.createLock("/test/path");
  await assertLockConformance(lock);
});
```

Tests: acquire/release lifecycle, withLock executes and releases, withLock
releases on error, inspect when held/not held, forceRelease with correct/wrong
nonce, release is idempotent.

Works with both real backends and mocked clients (e.g., `createMockS3Client`).

## Verifier Conformance

```typescript
import { assertVerifierConformance } from "@systeminit/swamp-testing";

Deno.test("verifier contract", async () => {
  const verifier = provider.createVerifier();
  await assertVerifierConformance(verifier);
});
```

Validates: verify() returns a result with healthy (boolean), message (string),
latencyMs (non-negative number), datastoreType (string).

## In-Memory Test Double

For testing code that _consumes_ a datastore (not the datastore itself):

```typescript
import { createDatastoreTestContext } from "@systeminit/swamp-testing";

Deno.test("lock behavior", async () => {
  const { provider, isLockHeld } = createDatastoreTestContext();
  const lock = provider.createLock("/ds");

  await lock.acquire();
  assertEquals(isLockHeld(), true);
  await lock.release();
});
```

| Option             | Default                       | Description                      |
| ------------------ | ----------------------------- | -------------------------------- |
| `datastorePath`    | `"/tmp/swamp-test-datastore"` | Path from `resolveDatastorePath` |
| `cachePath`        | `undefined`                   | Path from `resolveCachePath`     |
| `healthResult`     | healthy                       | Override health check result     |
| `lockAcquireFails` | `false`                       | Make lock acquire reject         |
| `withSyncService`  | `false`                       | Enable `createSyncService`       |

## In-Repo Extensions

Import directly from the testing package source:

```typescript
import {
  assertDatastoreExportConformance,
  assertLockConformance,
} from "../../packages/testing/mod.ts";
```
