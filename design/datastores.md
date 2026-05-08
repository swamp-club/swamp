# Datastores

A datastore in swamp determines where runtime data is stored. Runtime data
includes versioned model data, workflow runs, method outputs, audit logs,
telemetry, encrypted secrets, and cached bundles.

**Important:** Source-of-truth files (model definitions, workflow definitions,
vault configs) always live in the top-level `models/`, `workflows/`, `vaults/`
directories of the repository and are tracked in git. They are never part of the
datastore.

## Backends

Swamp has one built-in datastore backend (filesystem) and supports extension
backends via the datastore extension system.

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

### S3 (via `@swamp/s3-datastore` extension)

Stores runtime data in an S3 bucket with a local cache at
`~/.swamp/repos/{repoId}/`. All reads and writes hit the local cache;
synchronization with S3 happens automatically before and after each CLI command.

```yaml
# .swamp.yaml
datastore:
  type: "@swamp/s3-datastore"
  config:
    bucket: my-swamp-bucket
    prefix: project-name
    region: us-east-1
```

Legacy `type: s3` configs are automatically remapped to `@swamp/s3-datastore`
with a deprecation warning. The extension is auto-installed on first use for
logged-in users.

The local cache is fully disposable. Deleting it or cloning the repo on a new
machine repopulates the cache from S3 on the next command.

## Custom Backends

Extensions can register custom datastore backends via `extensions/datastores/`.
These are TypeScript files that export a `datastore` object conforming to the
`DatastoreProvider` interface, enabling storage on any backend swamp doesn't
ship with.

### Type Registry

The `DatastoreTypeRegistry` is a Map-backed singleton
(`datastoreTypeRegistry`). The built-in type (filesystem) is registered at
startup. Extension types (e.g., `@swamp/s3-datastore`) are loaded from
`extensions/datastores/` via `UserDatastoreLoader` or auto-resolved from the
registry on first use. Types must follow the `@collective/name` or
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
content-fingerprint invalidation (sha-256 over the entry point plus every
local `.ts` dep) to avoid redundant compilation — mtime-based freshness was
unreliable under atomic-rename saves, mtime-preserving sync tools, and
sub-millisecond edits (issue #125). If the source contains
bare specifiers (e.g., `from "zod"` instead of `from "npm:zod@4"`) and a cached
bundle exists, the cached bundle is used since re-bundling would fail without
the project's `deno.json` import map.

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
export SWAMP_DATASTORE=@swamp/s3-datastore:{"bucket":"my-bucket","region":"us-east-1"}
```

Legacy `s3:bucket-name/prefix` format is auto-remapped to the
`@swamp/s3-datastore` extension.

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

### Sync Timeout

Each direction of a remote sync (push / pull) is bounded by a hard deadline
enforced in the coordinator, so a stuck or slow extension cannot hang the CLI
indefinitely. The effective timeout is resolved from the first source that
yields a positive value:

1. `swamp datastore sync --timeout <seconds>` — per-invocation override, capped
   at 21,600 seconds (6 hours). Preferred escape hatch for one-off large syncs.
2. `CustomDatastoreConfig.syncTimeoutMs` — per-datastore config in
   `.swamp.yaml`. Applies to both explicit `swamp datastore sync` calls and
   the implicit syncs triggered by write commands.
3. `SWAMP_DATASTORE_SYNC_TIMEOUT_MS` — environment variable, uncapped. Useful
   for shell-session-scoped overrides during long-haul migrations.
4. `DEFAULT_SYNC_TIMEOUT_MS` — 5 minutes.

The deadline fires a `SyncTimeoutError` regardless of whether the extension
honored the `AbortSignal` passed to `pushChanged(options)` / `pullChanged(options)`.
Timeouts propagate as a non-zero CLI exit so the user sees that data did not
make it to the remote; other push errors still warn-downgrade (preserves
historical behavior where a transient S3 blip does not kill a run).

The `SyncTimeoutError` message lists every available remedy inline
(`--timeout`, the env var, updating the datastore extension, releasing a stuck
lock) so users get actionable next steps without chasing docs. The wording is
version-free — it points at "the latest extension" rather than a specific
version that would rot across releases.

See `src/domain/datastore/datastore_config.ts` (`DEFAULT_SYNC_TIMEOUT_MS`,
`SYNC_TIMEOUT_ENV_VAR`, `resolveSyncTimeoutMs`),
`src/domain/datastore/datastore_sync_service.ts` (`SyncTimeoutError`),
`src/cli/commands/datastore_sync.ts` (`--timeout` flag), and
`src/infrastructure/persistence/datastore_sync_coordinator.ts`
(`runBoundedSync`).

## Path Resolution

Every file operation goes through a `DatastorePathResolver` that decides whether
a path belongs to the local tier or the datastore tier:

```
DatastorePathResolver.resolvePath(subdir, ...rest) → string
```

For filesystem datastores, this returns `{config.path}/{subdir}/...`. For
extension datastores (e.g., S3), this returns `{datastorePath}/{subdir}/...`
(typically the local cache path). The `DefaultDatastorePathResolver`
pre-compiles exclude patterns at construction time.

## Remote Datastore Sync

When a remote datastore (e.g., S3 via `@swamp/s3-datastore`) is configured,
synchronization happens automatically:

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

Explicit datastore sync (`swamp datastore sync` and `--push`):

  requireInitializedRepo({ skipImplicitSync: true })  ← command start
    └─ acquire distributed lock
       (no implicit pullChanged, no implicit pushChanged on flush)

    ─── command executes its OWN pullChanged / pushChanged ───
    (counts reflect work the command itself performed)

  flushDatastoreSync()
    └─ release distributed lock
```

`swamp datastore sync` deliberately bypasses the coordinator's implicit
pull/push. Without `skipImplicitSync` the implicit pull would silently
move files and the explicit pull would fast-path to 0, causing
`filesPulled: 0` to be reported even when data was hydrated (lab #220).
The explicit sync command is the user-facing "tell me what I synced"
command — it owns its I/O and reports honest counts.

`--pull` mode uses `requireInitializedRepoReadOnly` (no lock at all),
matching the existing read-only pattern.

Read-only commands skip the lock and sync entirely, allowing them to run
concurrently with write operations. On filesystem datastores, reads see writes
immediately (same directory). On S3 datastores, reads see whatever was last
synced to the local cache by a write command; users can run
`swamp datastore sync --pull` to refresh manually.

### Zero-Diff Fast Path (Extension Guidance)

At production scale, most sync invocations are "nothing to do" — the local
cache already matches the remote index. Sync implementations that walk every
index entry unconditionally become O(n) in wall time on invocations that
should be O(1). Extension authors implementing `DatastoreSyncService` SHOULD
provide a zero-diff fast path that returns `0` without per-entry work when it
can prove the cache and remote are in sync.

The recommended pattern is a **fingerprint + local-dirty watermark** stored
in a small sidecar file under the cache directory:

- **Remote fingerprint** — a cheap, backend-native change token for the remote
  index. S3 uses the object ETag; GCS uses the `generation` number; any
  monotonic identifier exposed by a metadata-only request (HEAD-equivalent,
  not the full index body) works. Cache the last-observed fingerprint on disk.
- **Local-dirty flag** — flipped `true` by every code path that writes to the
  cache (e.g. the extension's `pushFile`-equivalent); cleared only after a
  successful writeback or a verified zero-diff pull. Default must be `true`
  on missing/corrupt sidecar so the slow path runs.

On `pullChanged` and `pushChanged`, the fast path issues one metadata request
against the remote index. If the returned fingerprint matches the sidecar and
the local-dirty flag is `false`, return `0` immediately. On any mismatch,
corruption, or uncertainty, fall through to the full walk — the fast path
must never skip real work.

The sidecar is client-local state. It is never uploaded, is excluded from the
sync walker, and can always be deleted to force a full re-verification.

#### `markDirty()` contract

Swamp core writes into the cache directly — the persistence repositories
(`FileSystemUnifiedDataRepository`, `YamlOutputRepository`,
`YamlWorkflowRunRepository`, `YamlEvaluatedDefinitionRepository`) call
`atomicWriteFile` / `atomicWriteTextFile` / `Deno.remove` against paths that
the sync service walks. These writes bypass the extension's own write path, so
the fast path's local-dirty flag would stay `false` and the next `pushChanged`
would short-circuit past real work.

The `markDirty()` method on `DatastoreSyncService` is the contract that closes
this gap. The signature accepts an options bag with an optional `relPath` so
extensions tracking per-path dirty state can record exactly which path
changed instead of only flipping a single global bit:

```typescript
markDirty(options?: DatastoreSyncOptions): Promise<void>;

interface DatastoreSyncOptions {
  signal?: AbortSignal;
  /** Cache-relative path of the file about to be written or removed. */
  relPath?: string;
}
```

The contract is eight load-bearing rules:

1. **Pre-write timing.** `markDirty` fires *before* the cache write begins.
   Extensions MUST NOT act synchronously on `relPath` — the file isn't on
   disk yet. Treat `relPath` as a hint to record for the next `pushChanged`.
2. **Absence-on-disk = delete.** When `pushChanged` later consumes a
   recorded `relPath` and the file no longer exists in the cache, the
   extension SHOULD delete the corresponding remote record. This collapses
   create/update/delete into one signal — no separate op-kind needed.
3. **`undefined` `relPath` = bulk.** A call without `relPath` signals a
   mutation core couldn't attribute to a single path (e.g. `rename`,
   non-dry-run `collectGarbage`, `deleteAllByWorkflowId`, `clearAll`).
   Extensions maintaining a per-path dirty set MUST honor this by either
   invalidating the set or flagging the next `pushChanged` for a full
   walk.
4. **Process restart loses the set.** Extensions holding the dirty set in
   memory MUST fall back to a full walk on the first `pushChanged` after
   process start. Persisting the set to a sidecar is allowed but optional.
5. **`relPath` is cache-relative + forward-slash.** Relative to the
   directory returned by `DatastoreProvider.resolveCachePath`, with
   forward-slash separators on the wire regardless of host OS — matching
   the `.datastore-index.json` key convention. **Extensions consuming
   `relPath` for disk access on Windows MUST convert to native separators**
   (e.g. via `@std/path` `join`) before `Deno.stat`/`Deno.readFile`/etc.
6. **Backward compatibility.** `relPath` is optional. Existing
   implementations (`@swamp/s3-datastore`, `@swamp/gcs-datastore`,
   filesystem no-op, every test mock) keep working unchanged because the
   old single-watermark pattern still satisfies the contract — any
   `markDirty` call still flips the dirty flag.
7. **Field scope.** swamp core only sets `relPath` on `markDirty` calls.
   The field has no defined meaning on `pullChanged` or `pushChanged`
   (it lives on the shared `DatastoreSyncOptions` for source
   compatibility, not because pull/push consume it).
8. **Bulk overrides per-path within one operation.** Some core mutations
   emit a bulk signal AND one or more per-path signals from the same
   logical operation — `rename` is the canonical example: the upfront
   `markDirty()` call has no `relPath` (bulk, for the tombstone +
   latest-marker writes that don't decompose), and the inner `save()` of
   the new name then emits a per-path signal. Extensions MUST treat any
   bulk signal as overriding per-path signals from the same operation.
   Easiest implementation: keep both a `bulkInvalidated: boolean` flag
   and the dirty set; in `pushChanged`, fall back to a full walk when
   `bulkInvalidated` is true regardless of the set's contents.

**Core obligation.** Repositories writing into the cache call the dirty
hook at the start of every public mutation method (`save`, `append`,
`delete`, `rename`, `allocateVersion`, `finalizeVersion`,
`removeLatestMarker`, non-dry-run `collectGarbage`, and the equivalents
on the three yaml repositories). The call happens **before** any write
begins so a crash mid-write leaves the watermark dirty —
markDirty-then-slow-walk is always recoverable; a lost dirty-flip is not.

**Per-call granularity emitted by core.**

| Method                                     | `relPath`                                                       |
| ------------------------------------------ | --------------------------------------------------------------- |
| `save`, `append`, `allocateVersion`        | data-name directory (version not yet allocated at notify time)  |
| `removeLatestMarker`                       | data-name directory                                              |
| `delete(version=specific)`                 | version directory                                                |
| `delete(version=undefined)`                | data-name directory (entire subtree removed)                     |
| `finalizeVersion`                          | version directory (version known)                                |
| `rename`                                   | `undefined` (bulk; inner `save()` emits its own per-path signal) |
| `collectGarbage` (non-dry-run)             | `undefined` (bulk)                                               |
| Yaml repos: `save`, `delete`               | per-yaml file path                                               |
| `deleteAllByWorkflowId`, `clearAll`        | `undefined` (bulk)                                               |

Filesystem datastores have no fast path and wire no sync service, so the
markDirty plumbing is a no-op for them.

**Sync is not a content-integrity tool.** The fingerprint detects index-level
changes, not per-file corruption — a silently damaged cache file (bit rot,
truncated write after a crash) can slip through the fast path if the index
itself has not changed. Cache integrity is the verifier's job; use
`DatastoreVerifier.verify()` when integrity needs to be re-established, or
`rm -rf` the cache and re-pull.

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
  forceRelease(expectedNonce: string): Promise<boolean>;  // Breakglass delete
}
```

`forceRelease` re-verifies the lock's nonce immediately before deleting and
returns `false` if the holder has changed, narrowing the TOCTOU window to
the gap between that final read and the delete itself. It is the
breakglass primitive used by `swamp datastore lock release --force` and
by `acquireModelLocks` to clean up stale global locks observed during
per-model lock acquisition (see "Lock Lifecycle" below).

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

### Extension Locks

Extension datastores provide their own `DistributedLock` implementation via the
`DatastoreProvider.createLock()` method. For example, the `@swamp/s3-datastore`
extension uses S3 conditional writes (`PutObject` with `If-None-Match: *`) for
atomic lock acquisition with background heartbeat.

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

Per-model commands (`model method run`, `workflow run`) acquire only
per-model locks via `acquireModelLocks`; they do not acquire the global
lock but do `inspect()` it to wait out any in-flight structural command.
When a stale global lock is observed during this wait, `acquireModelLocks`
calls `forceRelease(expectedNonce)` to clear it — without this, the
post-acquire TOCTOU re-check would re-detect the same stale lock on every
iteration and recurse indefinitely.

#### Symmetric Drain (structural commands)

Structural commands (`requireInitializedRepo`) acquire the global lock with
a **symmetric drain** — `waitForPerModelLocks` is invoked twice, once
before the global lock is acquired and once after:

1. **First drain (pre-acquire).** Wait for any per-model locks visible at
   command start to be released. A writer that is already past its own
   TOCTOU recheck (in `acquireModelLocks`) is committed to writing data
   and must be allowed to finish.
2. **Acquire global lock.** From this point on, any writer that runs
   `inspect()` against the global lock will see it held and back off.
3. **Second drain (post-acquire).** Wait for any per-model locks that
   slipped past the first drain — i.e., writers that inspected the global
   lock between the first drain ending and the global-lock acquisition,
   saw it not held, and went on to acquire a per-model lock.

The second drain is what closes the symmetric TOCTOU window between the
two sides of the protocol. Without it, a writer can:

1. Inspect global → not held (deleter has not yet acquired)
2. Take per-model lock
3. Pass its TOCTOU recheck → not held (deleter still has not acquired)
4. Begin writing a new version directory

…while the deleter completes its first drain, acquires the global lock,
and runs `Deno.remove(dataNameDir, { recursive: true })`. The recursive
removal then races the writer's new version subdirectory and fails with
ENOTEMPTY (Linux: `os error 39`, macOS: `os error 66`) — the failure mode
behind swamp-club#234.

The second drain catches the writer's still-held per-model lock and waits
for the writer to finish (and either commit cleanly or release on its own
TOCTOU recheck) before structural work proceeds. Because the writer's
recheck runs *immediately* after taking the per-model lock — before any
data I/O — there is no remaining window where the writer can write data
without the deleter's second drain seeing the per-model lock.

> **Maintainer note.** Both drain calls are required to keep this
> contract sound. The bidirectional citation
> (`src/cli/repo_context.ts:requireInitializedRepo` ↔ this section) is
> there so a future change cannot silently remove one of the two waits
> without confronting the contract. When changing this lifecycle, update
> both sites.

Caveat: `waitForPerModelLocks` only scans the local filesystem. Custom
(S3, distributed) datastores use their own `DistributedLock`
implementation and rely on its semantics rather than the local drain.

#### Parent-Process Lock Awareness

When `acquireModelLocks` acquires per-model locks it sets the environment
variable `SWAMP_LOCK_HOLDER_PID` to the current process PID.
`waitForPerModelLocks` reads this variable and skips any lock file whose
`pid` field matches — those locks are held by the parent process, so
waiting for them would deadlock (the parent is blocked on the child, and
the child is blocked on the parent's locks).

This arises when a workflow shell step spawns a nested `swamp` command
(e.g. `swamp extension push`). The child inherits the env var and avoids
polling on its parent's locks. The env var is cleared when the parent
flushes its locks.

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
swamp datastore setup extension @swamp/s3-datastore \
  --config '{"bucket":"my-bucket","prefix":"my-project","region":"us-east-1"}'
```

Each setup command:
1. Verifies the target is accessible (writable directory or reachable S3 bucket)
2. Migrates existing runtime data from `.swamp/` to the new location
   (skipped when `--skip-migration` is used)
3. Pushes migrated data to the remote (extension datastores; skipped when
   `--skip-migration` is used or when there is nothing to push)
4. **Hydrates** the local cache from the remote datastore (extension
   datastores only) — runs unconditionally, regardless of `--skip-migration`
5. Updates `.swamp.yaml` with the new datastore config
6. Cleans up migrated directories from `.swamp/` (skipped if any prior step
   reported an error, so retry leaves local data intact)

`--skip-migration` controls only step 2 (the local→remote push of existing
`.swamp/` data). It does NOT skip step 4 (hydration). A contributor joining a
shared datastore that already has data needs hydration even when there is
nothing local to migrate; without it the local cache stays empty and reads
return nothing until a manual `swamp datastore sync --pull` runs.

**Hydration invariant.** After `swamp datastore setup extension` succeeds
with no errors, the local cache contains every entry advertised by the
remote `.datastore-index.json` at setup time. Subsequent reads from
datastore-tier repositories see consistent data without an explicit
`swamp datastore sync --pull` first.

### Partial Failure and Retry

If `swamp datastore setup extension` fails partway through (network blip,
timeout, Ctrl-C, transient 5xx), the repo stays in a safe, resumable state:

- `.swamp.yaml` is **not updated** — the repo remains filesystem-typed.
- `.swamp/` data is **not cleaned up** — local data stays intact for retry.
- Objects already pushed to the remote are harmless — S3 PutObject is
  idempotent, so a subsequent push overwrites with identical content.

**To retry:** re-run the exact same `swamp datastore setup extension` command.
The migration copies files to the cache (overwriting any partial cache from the
previous attempt), pushes to the remote (idempotent), pulls from the remote,
and only then updates `.swamp.yaml` and cleans up `.swamp/`.

The same applies to `swamp datastore setup filesystem` — the config update is
guarded behind a successful migration, so a partial copy leaves `.swamp.yaml`
unchanged and a retry is safe.

The CLI surfaces a retry hint in the output whenever setup completes with
errors, so the user knows re-running is safe without consulting documentation.

### Migrating Between Backends

Run `swamp datastore setup` again with the new backend type. The setup command
migrates data from the current location to the new one.

### Health Verification

`requireInitializedRepo()` (write commands) and
`requireInitializedRepoReadOnly()` (read-only commands) both verify the
datastore is accessible before every command:

- **Filesystem**: checks the directory exists, is a directory, and is writable
- **Extension datastores**: delegates to the provider's `createVerifier()` for
  health checks and `createSyncService()` for pull/push operations

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
| `src/infrastructure/persistence/datastore_sync_coordinator.ts` | Global sync lifecycle (lock + pull/push) |
| `src/infrastructure/persistence/file_lock.ts` | File-based distributed lock (advisory lockfile) |

### CLI Layer

| File | Purpose |
|------|---------|
| `src/cli/resolve_datastore.ts` | Config resolution (env > CLI > yaml > default) |
| `src/cli/repo_context.ts` | Wires datastore into repo lifecycle, `createDatastoreLock()` factory |
| `src/cli/commands/datastore.ts` | `swamp datastore` command group |
| `src/cli/commands/datastore_status.ts` | `swamp datastore status` |
| `src/cli/commands/datastore_setup.ts` | `swamp datastore setup` (filesystem + extension) |
| `src/cli/commands/datastore_sync.ts` | `swamp datastore sync` (manual) |
| `src/cli/commands/datastore_lock.ts` | `swamp datastore lock` (status + release) |
| `src/presentation/output/datastore_output.ts` | Datastore command rendering (log + json) |
