# API Reference — Extension Datastores

Full interface documentation for implementing custom datastore providers.

Source files:

- `src/domain/datastore/datastore_provider.ts`
- `src/domain/datastore/distributed_lock.ts`
- `src/domain/datastore/datastore_health.ts`
- `src/domain/datastore/datastore_sync_service.ts`

## DatastoreProvider

Factory interface returned by `createProvider`. Implementations provide the
components needed to operate a datastore.

```typescript
interface DatastoreProvider {
  createLock(datastorePath: string, options?: LockOptions): DistributedLock;
  createVerifier(): DatastoreVerifier;
  createSyncService?(repoDir: string, cachePath: string): DatastoreSyncService;
  resolveDatastorePath(repoDir: string): string;
  resolveCachePath?(repoDir: string): string;
}
```

### `createLock(datastorePath, options?)`

Returns a `DistributedLock` for serializing write access. Called by every write
command (`model create`, `model method run`, `workflow run`, `data gc`, etc.).

- `datastorePath` — the resolved datastore path from `resolveDatastorePath`
- `options` — optional lock configuration (see `LockOptions` below)

### `createVerifier()`

Returns a `DatastoreVerifier` used by `swamp datastore status` and the health
check in `requireInitializedRepo()`.

### `createSyncService(repoDir, cachePath)?`

Optional. Returns a `DatastoreSyncService` for remote datastores that need
pull/push synchronization. If not provided, the datastore is assumed to be
locally accessible (no sync needed).

- `repoDir` — repository root directory
- `cachePath` — local cache path from `resolveCachePath`

### `resolveDatastorePath(repoDir)`

Returns the absolute path where runtime data should be stored. For local
datastores, this is the actual data directory. For remote datastores, this
should be the local cache path.

### `resolveCachePath(repoDir)?`

Optional. Returns a local cache path for remote datastores. When present, swamp
uses this path for local caching and syncs to/from the remote backend via the
sync service.

## DistributedLock

Distributed lock for serializing write access across processes.

```typescript
interface DistributedLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  inspect(): Promise<LockInfo | null>;
  forceRelease(expectedNonce: string): Promise<boolean>;
}
```

### `acquire()`

Acquire the lock. Starts an internal heartbeat to prevent expiry. Retries until
`maxWaitMs`. Force-acquires stale locks (TTL expired).

Throws `LockTimeoutError` if the lock cannot be acquired within `maxWaitMs`.

### `release()`

Release the lock. Stops internal heartbeat. Safe to call multiple times.

### `withLock(fn)`

Convenience: acquires the lock, runs `fn`, releases the lock (even on error).

### `inspect()`

Read the current lock info without acquiring. Returns `null` if no lock is held.

### `forceRelease(expectedNonce)`

Breakglass operation for stuck locks. Only releases if the nonce matches.
Returns `true` if released, `false` if nonce didn't match.

## LockInfo

Metadata stored in the lock file.

```typescript
interface LockInfo {
  holder: string; // e.g., "user@hostname"
  hostname: string; // Machine name
  pid: number; // Process ID
  acquiredAt: string; // ISO timestamp
  ttlMs: number; // Lock duration before considered stale
  nonce?: string; // Fencing token for force-release
}
```

## LockOptions

Configuration for lock behavior.

```typescript
interface LockOptions {
  lockKey?: string; // Backend-specific key (default varies)
  ttlMs?: number; // TTL in ms (default: 30_000)
  retryIntervalMs?: number; // Retry interval in ms (default: 1_000)
  maxWaitMs?: number; // Max wait in ms (default: 60_000)
}
```

## DatastoreVerifier

Health check interface for verifying datastore accessibility.

```typescript
interface DatastoreVerifier {
  verify(): Promise<DatastoreHealthResult>;
}
```

## DatastoreHealthResult

Result of a health check.

```typescript
interface DatastoreHealthResult {
  readonly healthy: boolean; // Whether accessible
  readonly message: string; // Human-readable status
  readonly latencyMs: number; // Check latency in ms
  readonly datastoreType: string; // Datastore type that was checked
  readonly details?: Record<string, string>; // Additional info
}
```

## DatastoreSyncService

Optional interface for remote datastore synchronization.

```typescript
interface DatastoreSyncService {
  pullChanged(): Promise<void>;
  pushChanged(): Promise<void>;
}
```

### `pullChanged()`

Pull changed files from the remote datastore to the local cache. Called before
read/write operations on remote datastores.

### `pushChanged()`

Push changed files from the local cache to the remote datastore. Called after
write operations complete.
