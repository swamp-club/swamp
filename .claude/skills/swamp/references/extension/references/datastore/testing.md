# Testing Datastore Extensions

The `@swamp-club/swamp-testing` package provides conformance suites, mock
primitives, and test doubles for datastore extensions.

Install: `deno add jsr:@swamp-club/swamp-testing`

## Export Conformance

One call replaces all structural boilerplate tests (metadata, config schema,
method existence on provider/lock/verifier):

```typescript
import { assertDatastoreExportConformance } from "@swamp-club/swamp-testing";
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
import { assertLockConformance } from "@swamp-club/swamp-testing";

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
import { assertVerifierConformance } from "@swamp-club/swamp-testing";

Deno.test("verifier contract", async () => {
  const verifier = provider.createVerifier();
  await assertVerifierConformance(verifier);
});
```

Validates: verify() returns a result with healthy (boolean), message (string),
latencyMs (non-negative number), datastoreType (string).

## Sync Service Round-Trip Conformance

Hold a sync service to the `markDirty` contract, delete propagation and
two-phase push. The factory returns two services on two different cache
directories over one fresh, empty backend; the suite calls it once per case:

```typescript
import { assert } from "@std/assert";
import { assertSyncServiceRoundTripConformance } from "@swamp-club/swamp-testing";

Deno.test("sync service round-trips", async () => {
  const result = await assertSyncServiceRoundTripConformance(async () => {
    const bucket = await createTestBucket();
    const firstCache = await Deno.makeTempDir();
    const secondCache = await Deno.makeTempDir();
    return {
      first: { service: syncFor(bucket, firstCache), cacheDir: firstCache },
      second: { service: syncFor(bucket, secondCache), cacheDir: secondCache },
      failNextPush: () => bucket.failNextPut(), // optional transport failure
      cleanup: async () => {
        await bucket.destroy();
        await Deno.remove(firstCache, { recursive: true });
        await Deno.remove(secondCache, { recursive: true });
      },
    };
  });
  for (const name of ["round-trip", "push-deletes", "failed-push-retry"]) {
    assert(result.passed.includes(name), `${name} did not run`);
  }
  for (const { name, reason } of result.skipped) {
    console.log(`skipped ${name}: ${reason}`);
  }
});
```

Cases: `round-trip`, `push-deletes`, `pull-deletes`, `bulk-mark`,
`failed-push-retry`, `two-phase`, `pull-nothing-new`, `forward-slash-paths`. A
failing case rejects naming the case. Skips come back in `result.skipped` with a
reason rather than failing:

- `pull-deletes` unless `{ expectPullDeletes: true }` — S3/GCS pulls never
  delete local files;
- `failed-push-retry` without `failNextPush`;
- `two-phase` without `preparePush`/`commitPush`.

Experimental: like `createInMemoryRemote`, its defaults (such as skipping
`pull-deletes`) follow what the S3 and GCS datastore extensions do today and may
change as those extensions change. New cases may be added, and some may skip, so
assert on the cases you rely on and log the skips rather than pinning the exact
skipped list.

## Mocking External Calls

Test the exact production code path by intercepting at the runtime boundary.

### S3/AWS-based datastores

Datastores that accept an `endpoint` config can point at a local mock server to
test verifier and sync behavior without real AWS credentials:

```typescript
import { assertVerifierConformance } from "@swamp-club/swamp-testing";
import { datastore } from "./s3.ts";

Deno.test({
  name: "s3 verifier reports healthy",
  sanitizeResources: false,
  fn: async () => {
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      if (req.method === "HEAD") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });

    const addr = server.addr as Deno.NetAddr;
    Deno.env.set("AWS_ACCESS_KEY_ID", "test");
    Deno.env.set("AWS_SECRET_ACCESS_KEY", "test");

    try {
      const provider = datastore.createProvider({
        bucket: "my-bucket",
        region: "us-east-1",
        endpoint: `http://localhost:${addr.port}`,
        forcePathStyle: true,
      });
      const verifier = provider.createVerifier();
      await assertVerifierConformance(verifier);
    } finally {
      Deno.env.delete("AWS_ACCESS_KEY_ID");
      Deno.env.delete("AWS_SECRET_ACCESS_KEY");
      await server.shutdown();
    }
  },
});
```

### Lock testing with mock clients

For testing lock semantics, create an in-memory mock of your storage client and
pass it to your lock implementation. The S3 datastore uses this pattern:

```typescript
import { assertLockConformance } from "@swamp-club/swamp-testing";
import { S3Lock } from "./_lib/s3_lock.ts";

function createMockS3Client() {
  const storage = new Map<string, Uint8Array>();
  return {
    storage,
    putObjectConditional(key, body) {
      if (storage.has(key)) return Promise.resolve(false);
      storage.set(key, body);
      return Promise.resolve(true);
    },
    getObject(key) {
      const data = storage.get(key);
      if (!data) return Promise.reject(new Error("NoSuchKey"));
      return Promise.resolve(data);
    },
    deleteObject(key) {
      storage.delete(key);
      return Promise.resolve();
    },
    // ... other methods
  };
}

Deno.test("S3Lock passes conformance", async () => {
  const mock = createMockS3Client();
  const lock = new S3Lock(mock, { ttlMs: 5000 });
  await assertLockConformance(lock);
});
```

### CLI-based datastores

Use `withMockedCommand` for datastores that shell out to CLI tools:

```typescript
import { withMockedCommand } from "@swamp-club/swamp-testing";

await withMockedCommand((cmd, args) => {
  if (cmd === "rclone" && args.includes("sync")) {
    return { stdout: "Transferred: 3 files", code: 0 };
  }
  return { stdout: "", code: 1 };
}, async () => {
  const sync = provider.createSyncService!("/repo", "/cache");
  await sync.pullChanged();
});
```

### REST API-based datastores

Use `withMockedFetch` for datastores that call `fetch()` directly:

```typescript
import { withMockedFetch } from "@swamp-club/swamp-testing";

await withMockedFetch((req) => {
  if (req.method === "HEAD") return new Response(null, { status: 200 });
  return new Response(null, { status: 404 });
}, async () => {
  const verifier = provider.createVerifier();
  const result = await verifier.verify();
  assertEquals(result.healthy, true);
});
```

## In-Memory Test Double

For testing code that _consumes_ a datastore (not the datastore itself):

```typescript
import { createDatastoreTestContext } from "@swamp-club/swamp-testing";

const { provider, isLockHeld } = createDatastoreTestContext();
```

| Option             | Default                       | Description                      |
| ------------------ | ----------------------------- | -------------------------------- |
| `datastorePath`    | `"/tmp/swamp-test-datastore"` | Path from `resolveDatastorePath` |
| `cachePath`        | `undefined`                   | Path from `resolveCachePath`     |
| `healthResult`     | healthy                       | Override health check result     |
| `lockAcquireFails` | `false`                       | Make lock acquire reject         |
| `withSyncService`  | `false`                       | Enable `createSyncService`       |

### Shared remote across machines

Experimental: the defaults track today's extension behaviour and will change
during the datastore rework.

`createInMemoryRemote()` holds remote content in memory; each
`remote.connect(cacheDir)` is one simulated machine's sync service. Its defaults
reproduce today's S3/GCS sync gaps (bare marks disable deletes, unmarked writes
are never pushed, pulls never delete locally), so do not expect it to be
friendlier than production. Switch a gap off through `semantics`.

```typescript
import { createInMemoryRemote } from "@swamp-club/swamp-testing";

const remote = createInMemoryRemote();
const a = remote.connect(aCache, { instance: "a" });
const b = remote.connect(bCache, { instance: "b" });
await a.markDirty({ relPath: "note" }); // after writing aCache/note
await a.pushChanged();
await b.pullChanged(); // bCache/note now exists
remote.failNext("push"); // also "pull" | "prepare" | "commit"; remote.offline(true)
remote.ops(); // ordered { instance, op, paths, deleted }
```

To assert only which paths core marks, use `createRecordingSyncService()`, which
returns `{ service, marks, events }` and does nothing else.

## In-Repo Extensions

Import directly from the testing package source:

```typescript
import {
  assertDatastoreExportConformance,
  assertLockConformance,
  assertSyncServiceRoundTripConformance,
  withMockedCommand,
} from "../../packages/testing/mod.ts";
```
