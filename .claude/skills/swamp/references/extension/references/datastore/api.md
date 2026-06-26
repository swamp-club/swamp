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
  resolveCachePath?(repoDir: string): string | undefined;

  registerNamespace?(
    datastorePath: string,
    namespace: string,
    repoId: string,
  ): Promise<void>;

  listNamespaces?(datastorePath: string): Promise<string[]>;
}
```

Although `resolveCachePath` is marked optional with `?`, the convention across
all `@swamp/*` datastores is to define it and return `undefined` when no custom
cache is desired. Omitting the method and returning `undefined` are
runtime-equivalent — every consumer in swamp core uses
`provider.resolveCachePath?.(repoDir) ?? <repoId-keyed default>`, so both cases
fall back to `~/.swamp/repos/<repoId>`. Defining the method makes the intent
explicit to readers.

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

### `registerNamespace(datastorePath, namespace, repoId)?`

Optional. Register a namespace in the datastore by writing a
`{namespace}/.namespace.json` manifest. Fails if the namespace slug is already
claimed by a different `repoId`. Solo-mode backends that don't support
namespaces omit this method.

### `listNamespaces(datastorePath)?`

Optional. List all registered namespaces by scanning for `.namespace.json`
manifests. Returns namespace slugs as strings. An empty array means solo mode.

### `resolveCachePath(repoDir)?`

Returns a local cache path for remote datastores, or `undefined` to accept
core's `~/.swamp/repos/<repoId>` default. Convention details above. When a
concrete path is returned, swamp uses it for local caching and syncs to/from the
remote backend via the sync service.

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
  pullChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  pushChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  capabilities?(): SyncCapabilities;
  markDirty(options?: DatastoreSyncOptions): Promise<void>;
  exportCatalog?(namespace: string): Promise<void>;
  pullForeignCatalogs?(
    namespaces: readonly string[],
  ): Promise<CatalogExportEntry[]>;
  fetchForeignContent?(
    namespace: string,
    relPath: string,
  ): Promise<Uint8Array | null>;
}

interface SyncCapabilities {
  scopedSync?: boolean;
  lazyHydration?: boolean;
  namespacedSync?: boolean;
}

interface DatastoreSyncOptions {
  signal?: AbortSignal;
  /** Cache-relative path of the file about to be written or removed. */
  relPath?: string;
  /** Namespace subtree this sync operation targets. */
  namespace?: string;
}
```

### `pullChanged(options?)`

Pull changed files from the remote datastore to the local cache. Called before
read/write operations on remote datastores. `options.relPath` has no defined
meaning here — core only sets it on `markDirty`.

### `pushChanged(options?)`

Push changed files from the local cache to the remote datastore. Called after
write operations complete. `options.relPath` has no defined meaning here — core
only sets it on `markDirty`.

### `markDirty(options?)`

Signal that the local cache has uncommitted work. Swamp core calls this at the
start of every repository-layer mutation that writes into the cache (e.g.
`save`, `delete`, `rename`), **before** the write begins — a crash mid-write
still leaves the watermark dirty.

When core can attribute the mutation to a single path, it sets `options.relPath`
to a forward-slash cache-relative path. Bulk mutations (`rename`, non-dry-run
`collectGarbage`, `deleteAllByWorkflowId`, `clearAll`) omit the field —
extensions MUST treat absence as "fall back to full walk."

The full eight-rule contract — pre-write timing, absence-on-disk = delete,
`undefined` = bulk, restart-loses-set, cache-relative + forward-slash (consumers
convert to native separators on Windows), backward compatibility, field scope,
bulk-overrides-per-path-within-one-operation — is documented in
`design/datastores.md` "markDirty() contract." Read that section before
implementing per-path tracking.

Implementations that unconditionally walk the cache on every `pushChanged` have
nothing to invalidate and can return `Promise.resolve()` — fully backward
compatible.

`markDirty()` must be idempotent and cheap — core does not deduplicate calls.

### `capabilities()?`

Optional. Returns a `SyncCapabilities` object advertising what this sync service
supports:

- `namespacedSync` — when `true`, the extension correctly handles the
  `namespace` field on `DatastoreSyncOptions`, scoping its index walk and upload
  to `{namespace}/` in the remote datastore. Extensions that don't advertise
  this still receive the namespace field but are expected to ignore it
  (solo-mode behavior).
- `scopedSync` — supports domain-level sync context.
- `lazyHydration` — supports metadata-only pulls with on-demand content fetch.

### `exportCatalog(namespace)?`

Optional. Export the local catalog for the given namespace as a flat JSON array
at `{namespace}/.catalog-export.json` in the remote datastore. Called after
`pushChanged` so the export reflects the latest state.

### `pullForeignCatalogs(namespaces)?`

Optional. Pull catalog exports from the given foreign namespaces. Each
namespace's export lives at `{namespace}/.catalog-export.json`. Returns one
`CatalogExportEntry` per namespace that was successfully fetched. Missing
exports are silently skipped.

### `fetchForeignContent(namespace, relPath)?`

Optional. Download a single file from a foreign namespace. Used for on-demand
cross-namespace content access when a CEL expression references another
namespace's data attributes. Returns the file contents, or `null` if the file
does not exist. Fetched content is NOT persisted locally — it is ephemeral,
cached only for the duration of the current command.
