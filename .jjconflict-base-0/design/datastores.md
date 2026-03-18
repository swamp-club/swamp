# Datastores

A datastore in swamp determines where runtime data is stored. Runtime data
includes versioned model data, workflow runs, method outputs, audit logs,
telemetry, encrypted secrets, and cached bundles.

**Important:** Source-of-truth files (model definitions, workflow definitions,
vault configs) always live in the top-level `models/`, `workflows/`, `vaults/`
directories of the repository and are tracked in git. They are never part of the
datastore.

## Backends

Swamp supports two datastore backends:

### Filesystem

Stores runtime data at a local filesystem path. This is the default backend —
when no datastore is configured, runtime data lives in `{repoDir}/.swamp/`.

```yaml
# .swamp.yaml
datastore:
  type: filesystem
  path: /mnt/shared/swamp-data
```

An external filesystem path is useful for shared NFS mounts or keeping runtime
data out of the git repository.

### S3

Stores runtime data in an S3 bucket with a local cache at
`~/.swamp/repos/{repoId}/`. All reads and writes hit the local cache;
synchronization with S3 happens automatically before and after each CLI command.

```yaml
# .swamp.yaml
datastore:
  type: s3
  bucket: my-swamp-bucket
  prefix: project-name
  region: us-east-1
```

The local cache is fully disposable. Deleting it or cloning the repo on a new
machine repopulates the cache from S3 on the next command.

## Custom Backends

Extensions can register custom datastore backends via `extensions/datastores/`.
These are TypeScript files that export a `datastore` object conforming to the
`DatastoreProvider` interface, enabling storage on any backend swamp doesn't
ship with.

### Type Registry

The `DatastoreTypeRegistry` is a Map-backed singleton
(`datastoreTypeRegistry`). Built-in types (filesystem, s3) are registered at
startup. User-defined types are loaded from `extensions/datastores/` via
`UserDatastoreLoader`. Types must follow the `@collective/name` or
`collective/name` pattern (e.g., `@myorg/redis-store`). Duplicate type
registrations are rejected with an error.

### DatastoreProvider Interface

A custom datastore implements five methods:

- **`createLock`** — returns a `DistributedLock` for concurrency control
- **`createVerifier`** — returns a `DatastoreVerifier` for health checks
- **`createSyncService?`** — optional; returns a `DatastoreSyncService` for
  remote sync (pull/push)
- **`resolveDatastorePath`** — resolves the datastore path relative to the repo
- **`resolveCachePath?`** — optional; resolves a local cache path (for remote
  backends)

See `src/domain/datastore/datastore_provider.ts` for the full interface.

### Loading & Bundling

`UserDatastoreLoader` discovers `.ts` files recursively in the datastores
directory (excluding `_test.ts` files), bundles each via Deno with zod
externalized, and validates the export against `UserDatastoreSchema` — a Zod
schema requiring `type`, `name`, `description`, an optional `configSchema`, and
a `createProvider` factory function. Files without a `datastore` export are
silently skipped. Bundles are cached in `.swamp/datastore-bundles/` with
mtime-based invalidation to avoid redundant compilation.

### Custom Type Configuration

Custom types use the same resolution priority as built-in types. In
`.swamp.yaml`, custom types use the `type:` and `config:` fields:

```yaml
datastore:
  type: "@myorg/redis-store"
  config:
    host: localhost
    port: 6379
```

In environment variable format: `SWAMP_DATASTORE=@org/name:{"key":"val"}`. The
config object is validated against the optional `configSchema` Zod schema
defined by the extension.

### Custom Backend Implementation Files

| File | Purpose |
|------|---------|
| `src/domain/datastore/datastore_provider.ts` | `DatastoreProvider` interface |
| `src/domain/datastore/datastore_type_registry.ts` | Type registry singleton |
| `src/domain/datastore/user_datastore_loader.ts` | Loader, validator, bundler |
| `src/domain/datastore/datastore_sync_service.ts` | `DatastoreSyncService` interface |

## Configuration

### Resolution Priority

Datastore config is resolved from multiple sources (highest priority first):

1. `SWAMP_DATASTORE` environment variable
2. CLI `--datastore` argument
3. `.swamp.yaml` `datastore` field
4. Default: filesystem at `{repoDir}/.swamp/`

The environment variable format is `type:value`:

```bash
export SWAMP_DATASTORE=filesystem:/path/to/dir
export SWAMP_DATASTORE=s3:bucket-name/prefix
```

### Fine-Grained Control

Two optional fields control which data goes to the datastore:

- **`directories`** — which subdirectories belong to the datastore. Defaults to
  all runtime subdirectories (`data`, `outputs`, `workflow-runs`, `secrets`,
  `audit`, `telemetry`, etc.). Anything not listed stays in local `.swamp/`.
- **`exclude`** — gitignore-style glob patterns. Files matching these patterns
  stay local even if their parent directory is in the datastore.

```yaml
datastore:
  type: filesystem
  path: /data/my-project
  directories:
    - data
    - outputs
    - workflow-runs
  exclude:
    - "telemetry/**"
```

## Path Resolution

Every file operation goes through a `DatastorePathResolver` that decides whether
a path belongs to the local tier or the datastore tier:

```
DatastorePathResolver.resolvePath(subdir, ...rest) → string
```

For filesystem datastores, this returns `{config.path}/{subdir}/...`. For S3
datastores, this returns `{cachePath}/{subdir}/...` (the local cache path). The
`DefaultDatastorePathResolver` pre-compiles exclude patterns at construction
time.

## S3 Sync

When an S3 datastore is configured, synchronization happens automatically:

```
Write commands (create, edit, delete, run, gc, etc.):

  requireInitializedRepo()           ← called at command start
    ├─ acquire distributed lock
    └─ pullChanged()                 ← download new/modified files from S3

    ─── command executes ───
    (reads/writes local cache)

  flushDatastoreSync()               ← called after command completes
    ├─ pushChanged()                 ← upload new/modified files to S3
    └─ release distributed lock

Read-only commands (search, get, list, validate, history, etc.):

  requireInitializedRepoReadOnly()   ← called at command start
    └─ (no lock, no sync)

    ─── command executes ───
    (reads local cache directly)

    (no flush needed)
```

Read-only commands skip the lock and sync entirely, allowing them to run
concurrently with write operations. On filesystem datastores, reads see writes
immediately (same directory). On S3 datastores, reads see whatever was last
synced to the local cache by a write command; users can run
`swamp datastore sync --pull` to refresh manually.

### Index

A metadata index (`.datastore-index.json`) tracks all files in the S3 bucket.
It is a JSON manifest mapping relative paths to their size and last-modified
timestamp. The index is fetched once per command (with a 60-second local cache
TTL to avoid redundant fetches during rapid command sequences).

### Change Detection

Changes are detected by comparing `stat.size` and `stat.mtime`:

- **Pull**: files in the remote index that are missing locally or have a
  different size are downloaded.
- **Push**: files in the local cache that are new or have a different
  size/mtime compared to the index are uploaded.

No content hashing is used. The write paths (`atomicWriteTextFile`,
`Deno.writeFile`) always update mtime, so mtime changes reliably detect
rewrites even when the file size doesn't change.

### Transfer Concurrency

All pull and push operations download/upload files concurrently in batches of
10. This reduces wall-clock time for syncs with many files by overlapping S3
round trips. The concurrency limit (`MAX_CONCURRENCY = 10`) prevents
overwhelming the network or hitting S3 request rate limits.

### Offline Behavior

If S3 is unreachable, pull and push warn and continue. The command runs against
the local cache. Data is pushed on the next successful connection.

## Concurrency Control

Both backends use a distributed lock to prevent concurrent write access. The
lock is acquired by write commands at command start and released at command end
(on both success and error paths). Read-only commands
(`requireInitializedRepoReadOnly`) bypass the lock entirely, allowing concurrent
reads alongside writes. This is safe because all file writes use atomic
write-to-temp-then-rename (`atomicWriteTextFile`), so reads never see
partial/corrupt files.

### DistributedLock Interface

```typescript
interface DistributedLock {
  acquire(): Promise<void>;   // Acquire lock, start heartbeat
  release(): Promise<void>;   // Release lock, stop heartbeat
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  inspect(): Promise<LockInfo | null>;  // Read without acquiring
}
```

Lock metadata (`LockInfo`) is stored as JSON:

```json
{
  "holder": "user@hostname",
  "hostname": "hostname",
  "pid": 12345,
  "acquiredAt": "2026-03-10T12:00:00.000Z",
  "ttlMs": 30000
}
```

### S3Lock

Uses S3 conditional writes (`PutObject` with `If-None-Match: *`) for atomic
lock acquisition. The lock is an S3 object at `.datastore.lock`. A background
heartbeat extends the lock every TTL/3 by overwriting the object with a fresh
timestamp. Stale locks (where `LastModified + ttlMs < now`) are force-acquired
by deleting and retrying.

### FileLock

Uses advisory lockfiles (`Deno.open({ createNew: true })`) for atomic
check-and-create. The lockfile is at `{datastorePath}/.datastore.lock`. A
background heartbeat rewrites the lockfile content with a fresh timestamp.
Stale locks (where `acquiredAt + ttlMs < now`) are removed and retried.

### Lock Lifecycle

The sync coordinator (`datastore_sync_coordinator.ts`) manages the lock
lifecycle as a global singleton:

- `registerDatastoreSync({ service?, lock? })` — acquire lock, pull if S3
- `flushDatastoreSync()` — push if S3, release lock

A SIGINT handler ensures best-effort lock release on Ctrl-C. If the process
crashes without releasing, the lock expires after the TTL (30 seconds by
default).

### Lock Breakglass

Two CLI commands for inspecting and force-releasing stuck locks:

```bash
swamp datastore lock status           # Show who holds the lock
swamp datastore lock release --force  # Delete lock object/file directly
```

The `--force` flag is required. The release command bypasses `acquire()`/
`release()` and directly deletes the lock, which is necessary when a crashed
process left a lock that hasn't expired yet.

## Setup and Migration

### Initial Setup

`swamp repo init` creates a default filesystem datastore at `.swamp/`. To use
a different backend, run `swamp datastore setup` after init:

```bash
swamp datastore setup filesystem --path /mnt/shared/swamp-data
swamp datastore setup s3 --bucket my-bucket --prefix my-project --region us-east-1
```

Each setup command:
1. Verifies the target is accessible (writable directory or reachable S3 bucket)
2. Migrates existing runtime data from `.swamp/` to the new location
3. Updates `.swamp.yaml` with the new datastore config
4. Cleans up migrated directories from `.swamp/`

Use `--skip-migration` to skip the data copy.

### Migrating Between Backends

Run `swamp datastore setup` again with the new backend type. The setup command
migrates data from the current location to the new one.

### Health Verification

`requireInitializedRepo()` (write commands) and
`requireInitializedRepoReadOnly()` (read-only commands) both verify the
datastore is accessible before every command:

- **Filesystem**: checks the directory exists, is a directory, and is writable
- **S3**: ensures the local cache directory exists (write commands additionally
  issue a `HeadBucket` request and pull changed files)

`swamp datastore status` shows the current config, health, latency, directories,
and exclude patterns.

## Implementation Files

### Domain Layer

| File | Purpose |
|------|---------|
| `src/domain/datastore/datastore_config.ts` | `DatastoreConfig` union type, directory lists |
| `src/domain/datastore/datastore_path_resolver.ts` | `DatastorePathResolver` interface |
| `src/domain/datastore/datastore_pattern_matcher.ts` | Gitignore-style glob compiler |
| `src/domain/datastore/datastore_health.ts` | `DatastoreVerifier` interface |
| `src/domain/datastore/datastore_migration_service.ts` | File copy + verification for migration |
| `src/domain/datastore/distributed_lock.ts` | `DistributedLock` interface, `LockInfo`, `LockTimeoutError` |

### Infrastructure Layer

| File | Purpose |
|------|---------|
| `src/infrastructure/persistence/default_datastore_path_resolver.ts` | Path resolver with compiled patterns |
| `src/infrastructure/persistence/filesystem_datastore_verifier.ts` | Filesystem health check |
| `src/infrastructure/persistence/s3_datastore_verifier.ts` | S3 health check (`HeadBucket`) |
| `src/infrastructure/persistence/s3_client.ts` | AWS S3 SDK wrapper |
| `src/infrastructure/persistence/s3_cache_sync.ts` | S3 cache with index, push queue, sync methods |
| `src/infrastructure/persistence/datastore_sync_coordinator.ts` | Global sync lifecycle (lock + pull/push) |
| `src/infrastructure/persistence/s3_lock.ts` | S3 distributed lock (conditional writes) |
| `src/infrastructure/persistence/file_lock.ts` | File-based distributed lock (advisory lockfile) |

### CLI Layer

| File | Purpose |
|------|---------|
| `src/cli/resolve_datastore.ts` | Config resolution (env > CLI > yaml > default) |
| `src/cli/repo_context.ts` | Wires datastore into repo lifecycle, `createDatastoreLock()` factory |
| `src/cli/commands/datastore.ts` | `swamp datastore` command group |
| `src/cli/commands/datastore_status.ts` | `swamp datastore status` |
| `src/cli/commands/datastore_setup.ts` | `swamp datastore setup` (filesystem + S3) |
| `src/cli/commands/datastore_sync.ts` | `swamp datastore sync` (manual) |
| `src/cli/commands/datastore_lock.ts` | `swamp datastore lock` (status + release) |
| `src/presentation/output/datastore_output.ts` | Datastore command rendering (log + json) |
