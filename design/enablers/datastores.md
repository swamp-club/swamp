---
audience: maintainer, operator, extension-author
enables: [data]
last-verified: 2026-08-28 @ 3d5955a9
---

# Datastores

A datastore is where swamp keeps runtime data: versioned model data, workflow
runs, method outputs, audit logs, telemetry, encrypted secrets and cached
bundles.

Source-of-truth files (model definitions, workflow definitions, vault configs)
are never in the datastore. They live in the repo's top-level
`models/`, `workflows/` and `vaults/` directories, tracked in git.

## Backends

Filesystem is the one built-in backend. Others come from datastore extensions.

### Filesystem

Stores runtime data at a local path. This is the default: with no datastore
configured, runtime data lives in `{repoDir}/.swamp/`.

```yaml
# .swamp.yaml
datastore:
  type: filesystem
  path: /mnt/shared/swamp-data
```

An external path suits shared NFS mounts, or keeps runtime data out of git.

### S3 (via `@swamp/s3-datastore` extension)

Stores runtime data in an S3 bucket. All reads and writes use a local cache at
`~/.swamp/repos/{repoId}/`, which syncs with S3 before and after each CLI
command.

```yaml
# .swamp.yaml
datastore:
  type: "@swamp/s3-datastore"
  config:
    bucket: my-swamp-bucket
    prefix: project-name
    region: us-east-1
```

Legacy `type: s3` configs are remapped to `@swamp/s3-datastore` with a
deprecation warning. The extension installs itself on first use if the
logged-in user has a trusted collective; with none, there is no auto-resolver
(`src/cli/mod.ts` `resolveTrustedCollectives`). `@swamp/gcs-datastore` is the
GCS equivalent (`src/cli/commands/datastore_setup.ts`).

The local cache is disposable. If it is deleted, or the repo is cloned on a new
machine, the next command refills it from S3.

## Custom Backends

Extensions add datastore backends in `extensions/datastores/`. Each is a
TypeScript file exporting a `datastore` object that implements the
`DatastoreProvider` interface, so data can live on any backend.

### Type Registry

The `DatastoreTypeRegistry` is a Map-backed singleton (`datastoreTypeRegistry`).
The filesystem type is registered at startup. Extension types (e.g.
`@swamp/s3-datastore`) are loaded from `extensions/datastores/` by
`ExtensionLoader` with `datastoreKindAdapter`, or auto-resolved from the
registry on first use. Names must match `@collective/name` or `collective/name`
(e.g. `@myorg/redis-store`). Registering a type twice is an error.

### DatastoreProvider Interface

A custom datastore implements seven methods; three are required:

- **`createLock`**: returns a `DistributedLock` for concurrency control.
- **`createVerifier`**: returns a `DatastoreVerifier` for health checks.
- **`createSyncService?`** (optional): returns a `DatastoreSyncService` for
  remote sync (pull/push).
- **`resolveDatastorePath`**: resolves the datastore path relative to the repo.
- **`resolveCachePath?`** (optional): resolves a local cache path for remote
  backends.
- **`registerNamespace?`** (optional): writes the namespace manifest; fails if
  the slug is taken.
- **`listNamespaces?`** (optional): returns the slugs in namespace manifests
  (see [Namespace manifests](#namespace-manifests)).

Full interface: `src/domain/datastore/datastore_provider.ts`.

### Loading & Bundling

`ExtensionLoader` (with `datastoreKindAdapter`) finds `.ts` files recursively in
the datastores directory, skipping `_test.ts`. It bundles each with Deno (zod
externalized) and validates the export against `UserDatastoreSchema`. That Zod
schema requires `type`, `name`, `description`, an optional `configSchema` and a
`createProvider` factory. Files with no `datastore` export are silently skipped.

Bundles are cached in `.swamp/datastore-bundles/` and rebuilt when their content
fingerprint changes: a sha-256 over the entry point and every local `.ts`
dependency. Mtime-based freshness was unreliable with atomic-rename saves,
mtime-preserving sync tools and sub-millisecond edits (issue #125;
`src/domain/extensions/bundle_freshness.ts`).

If re-bundling fails and a cached bundle exists, the cached bundle is used
(`extension_loader.ts`). Expected failures log at debug level, others at warn.
The expected case is a bare specifier such as `from "zod"` instead of
`from "npm:zod@4"`, which cannot resolve without the project's `deno.json`
import map. Only the module's own static imports count; imports inside template
literals are generated code and are ignored.

### Custom Type Configuration

Custom types resolve in the same priority order as built-in ones. In
`.swamp.yaml` they use `type:` and `config:`:

```yaml
datastore:
  type: "@myorg/redis-store"
  config:
    host: localhost
    port: 6379
```

As an environment variable: `SWAMP_DATASTORE=@org/name:{"key":"val"}`. The
config is validated against the extension's optional `configSchema` Zod schema.

### Custom Backend Implementation Files

| File | Purpose |
|------|---------|
| `src/domain/datastore/datastore_provider.ts` | `DatastoreProvider` interface |
| `src/domain/datastore/datastore_type_registry.ts` | Type registry singleton |
| `src/domain/extensions/extension_loader.ts` | Generic extension loader (used with kind adapters) |
| `src/domain/extensions/datastore_kind_adapter.ts` | Datastore kind adapter for ExtensionLoader |
| `src/domain/datastore/datastore_sync_service.ts` | `DatastoreSyncService` interface |
| `src/cli/datastore_expression_resolver.ts` | Resolves `${{ env.* }}` and `${{ vault.get() }}` in datastore config values |

### Config Value Interpolation

String values in the datastore `config` can use `${{ }}` expressions, as model
and workflow definitions do. They are resolved before the extension's schema
validation and `createProvider()` factory see the config.

Two namespaces are supported.

**Environment variables**: `${{ env.VAR_NAME }}`

Resolves to the named environment variable. Startup fails if it is unset or
empty. This is the simplest way to keep secrets out of `.swamp.yaml`: the token
comes from the operator's environment (direnv, shell profile, 1Password CLI,
etc.).

```yaml
datastore:
  type: "@myorg/gitlab-datastore"
  config:
    token: "${{ env.GITLAB_TOKEN }}"
    endpoint: "https://${{ env.GITLAB_HOST }}/api/v4"
```

**Vault secrets**: `${{ vault.get(vaultName, secretKey) }}`

Resolves to the decrypted secret from the named vault. Every installed vault
type works: native `local_encryption` and extension providers like
`@swamp/aws-sm`. The vault service starts only when a `vault.get()` expression
appears.

```yaml
datastore:
  type: "@myorg/postgres-datastore"
  config:
    connectionString: "${{ vault.get(infra, pg-connection-string) }}"
```

**Limitations:**

- Only `env.*` and `vault.get()` work. The full CEL context (model references,
  data lookups) does not exist this early in startup.
- Extension vault bundles load straight from the `.swamp/vault-bundles/` cache
  during early boot, bypassing the extension loader. Install an extension vault
  before referencing it here.
- Vault expressions do not work with `managedConfig: true`, which stores vault
  configs in the datastore tier and would create a circular dependency. Use
  environment variables instead.

## Configuration

### Resolution Priority

Datastore config comes from, highest priority first:

1. `SWAMP_DATASTORE` environment variable
2. CLI `--datastore` argument
3. `.swamp.yaml` `datastore` field
4. Default: filesystem at `{repoDir}/.swamp/`

The environment variable format is `type:value`:

```bash
export SWAMP_DATASTORE=filesystem:/path/to/dir
export SWAMP_DATASTORE=@swamp/s3-datastore:{"bucket":"my-bucket","region":"us-east-1"}
```

The legacy `s3:bucket-name/prefix` format is remapped to `@swamp/s3-datastore`.

### Fine-Grained Control

Two optional fields decide which data goes to the datastore:

- **`directories`**: subdirectories in the datastore. Defaults to
  `DEFAULT_DATASTORE_SUBDIRS` (`datastore_config.ts`): `auto-definitions`,
  `definitions-evaluated`, `workflows-evaluated`, `config`, `data`, `outputs`,
  `workflow-runs`, `audit`, `telemetry`, `logs`, `files`, plus the bundle
  directories. Anything unlisted stays in local `.swamp/`. The
  `ALWAYS_LOCAL_SUBDIRS` (`secrets`, `bundles`, `vault-bundles`,
  `report-bundles`) always stay local.
  `swamp datastore setup filesystem --directories` sets the list at setup.
- **`exclude`**: gitignore-style globs. Matching files stay local even if their
  directory is in the datastore.

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

The coordinator enforces a hard deadline on each direction of a remote sync
(push and pull), so a slow or stuck extension cannot hang the CLI. The first
source giving a positive value wins:

1. `--timeout <seconds>` CLI flag, per invocation, limited to 21,600 seconds
   (6 hours). `swamp datastore sync` rejects larger values (`datastore_sync.ts`
   `SYNC_TIMEOUT_CLI_MAX_SECONDS`); `swamp datastore setup extension` clamps
   them (`datastore_setup.ts`). The preferred override for a one-off large sync
   or first setup of a large repo.
2. `CustomDatastoreConfig.syncTimeoutMs` in `.swamp.yaml`. Applies to explicit
   `swamp datastore sync` and to the implicit syncs of write commands. Not used
   by `datastore setup extension`, which runs outside the flush coordinator.
3. `SWAMP_DATASTORE_SYNC_TIMEOUT_MS` environment variable, uncapped. Useful for
   a shell session during a long migration. Applies to sync and setup
   extension.
4. `DEFAULT_SYNC_TIMEOUT_MS`: 5 minutes.

The deadline raises `SyncTimeoutError` even if the extension ignores the
`AbortSignal` passed to `pushChanged(options)` / `pullChanged(options)`. A
timeout exits the CLI non-zero, so the user sees the data did not reach the
remote. Other push errors are still downgraded to warnings, as before, so a
brief S3 failure does not kill a run.

**Setup timeout behavior.** In `datastore setup extension`, a push or pull
timeout is recoverable. The datastore type is still written to `.swamp.yaml`,
and the user resumes with `swamp datastore sync --push --timeout <big>`. Hard
failures (auth, network, config) still block writing the type. Otherwise a slow
first push would leave a repo with valid credentials and config un-migrated.

The `SyncTimeoutError` message lists every fix: `--timeout`, the env var,
updating the datastore extension, releasing a stuck lock. It says "the latest
extension" rather than a version number, so it does not go stale.

See `src/domain/datastore/datastore_config.ts` (`DEFAULT_SYNC_TIMEOUT_MS`,
`SYNC_TIMEOUT_ENV_VAR`, `resolveSyncTimeoutMs`),
`src/domain/datastore/datastore_sync_service.ts` (`SyncTimeoutError`),
`src/cli/commands/datastore_sync.ts` (`--timeout` flag),
`src/cli/commands/datastore_setup.ts` (`--timeout` flag on setup extension), and
`src/infrastructure/persistence/datastore_sync_coordinator.ts`
(`runBoundedSync`).

## Path Resolution

Every file operation goes through a `DatastorePathResolver`, which decides
whether a path is in the local tier or the datastore tier:

```
DatastorePathResolver.resolvePath(subdir, ...rest) → string
```

For filesystem datastores it returns `{config.path}/{subdir}/...`. For extension
datastores (e.g. S3) it returns `{datastorePath}/{subdir}/...`, usually the
local cache. The `DefaultDatastorePathResolver` compiles exclude patterns once,
at construction.

### Namespace prefixing (giga-swamp)

When a `namespace` is set (several repos sharing one datastore, "giga-swamp"),
the resolver adds it as the outermost datastore-tier segment:
`{base}/{namespace}/{subdir}/...`, never `{base}/{subdir}/{namespace}/...`. It
is applied only in `datastorePath()`, so every datastore-tier subdir gets it.
Solo mode (empty namespace) gives byte-identical paths to an un-namespaced repo,
with no prefix or stray separator. The local tier (`localPath`, `.swamp/`) is
never namespaced.

#### Migration

`swamp datastore namespace migrate` moves data from the solo layout to the
namespaced one. Each `DEFAULT_DATASTORE_SUBDIRS` directory found at
`{base}/{subdir}/` is moved to `{base}/{namespace}/{subdir}/` with
`Deno.rename()`. The catalog is then invalidated so backfill rebuilds it from
the new paths.

If a file exists at both the root and namespace paths, forward migration
compares them byte by byte. Identical copies (e.g. left by a buggy pull that
wrote namespace-stripped files to the cache root) are resolved by deleting the
root copy. Differing files still error, for the user to resolve by hand.

`--reverse` flattens namespaced paths back to solo layout. It refuses if the
un-namespaced path already holds data files, except in the subdirectories in
`MERGEABLE_ON_REVERSE` (`src/libswamp/datastores/namespace_migrate.ts`), which
are merged. `swamp datastore namespace unset --migrate` does unset plus reverse
migration. Both `namespace migrate` and `namespace unset --migrate` only preview
until `--yes`/`--confirm` is passed.

Two things are not namespaced:

- **The `_catalog.db` catalog** is repo-local at `{repoDir}/.swamp/data/`, found
  via the `catalogDbPath` helper, not `resolvePath`. On a shared datastore each
  repo has its own catalog, so one repo's backfill never overwrites another's
  rows. The `namespace` column separates the repo's own rows from foreign rows
  pulled in a later phase.
- **Secrets and vault bundles** are written through `swampPath`/`localPath`
  (`.swamp/secrets`, `.swamp/vault-bundles`), never `resolvePath`. The namespace
  prefix cannot reach them, so vaults are always repo-local.

#### Orphaned data reclamation (`swamp data prune`)

**Orphaned data** is stored data whose model definition no longer exists in its
namespace: the definition was deleted, or the model instance moved to another
namespace and left its old data behind.

`swamp data delete` and `swamp data gc` both fail on it. The on-disk layout and
the catalog `DELETE` predicate are keyed by model type
(`{typeDir}/{modelId}/...` and `type_normalized`), and the type normally comes
from the definition. So `delete` throws `Model not found`, and `gc` only applies
each item's frozen `lifetime`/`garbageCollection` policy, never collecting
`infinite`-lifetime orphans. The rows pile up, growing the index and the sync
cost of every write.

`swamp data prune` reclaims them. It walks the data root (`findAllGlobal`),
groups by `(type, modelId)`, and checks whether each group's definition still
exists. The check uses the definition repository's `findById`, which searches
both `models/` and `.swamp/auto-definitions/`, like `swamp model get`. So
auto-definition-backed models (auto-created model-run/workflow models, installed
`@swamp/*` models) count as live and are never pruned. Groups with no live
definition are removed by the definition-free `delete(type, modelId, dataName)`,
which deletes all versions on disk and their catalog rows.

Reclamation is irreversible and based on inference: a definition can be briefly
absent during a branch switch or migration. So prune runs only when invoked,
asks for confirmation by default, and offers `--dry-run` for a preview on the
lock-free read-only path. Otherwise it takes the global datastore lock (via
`requireInitializedRepo`), like `gc`/`delete`.

Two neighbouring concepts differ:

- **`swamp data gc`** applies the retention policy a model declared (lifetime
  and version cap). `prune` removes data whose model is gone. `gc` stays safe
  to run unattended; `prune` keeps the inferential deletion behind its own verb.
- **"Orphan recovery"** in `data_access_service.ts` does the opposite: at read
  time it keeps data reachable across a model's UUID change. It never deletes.

## Remote Datastore Sync

With a remote datastore (e.g. S3 via `@swamp/s3-datastore`), sync is
automatic:

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

`swamp datastore sync` skips the coordinator's implicit pull/push on purpose.
Without `skipImplicitSync`, the implicit pull would move the files and the
explicit pull would find nothing, reporting `filesPulled: 0` even though data
was hydrated (lab #220). This command's job is to report what it synced, so it
does its own I/O and reports true counts.

`--pull` mode uses `requireInitializedRepoReadOnly` (no lock), like other
read-only commands.

Read-only commands skip lock and sync, so they can run alongside writes. On
filesystem datastores reads see writes at once (same directory). On S3
datastores reads see what a write command last synced to the local cache; run
`swamp datastore sync --pull` to refresh.

### Serve Runtime Data Refresh

In a multi-instance `swamp serve` deployment on a shared remote datastore, an
idle server does not see a peer's runtime output by itself. Write commands sync
when they run, but `data.query` reads the local cache without pulling.

Serve runs three background pollers to fix this:

- **ConfigPoller** refreshes managed configuration. It pulls extension files
  (`config/pulled-extensions/`) separately from definitions (`config/`), so the
  extension registry reloads only when extension files change.
- **AccessDataPoller** (`subdirs: ["data/swamp/grant", ...]`) refreshes
  access-control grants and groups, then reloads the policy snapshot.
- **RuntimeDataPoller** (`subdirs: ["data"]`) refreshes the `data/` subtree
  (runtime model output), then invalidates the query catalog so the next
  `data.query` rebuilds from the new local files.

All three run every 30 seconds by default (set with `swamp serve
--datastore-poll-interval`, `SWAMP_DATASTORE_POLL_INTERVAL` or the `serve.yaml`
key `datastore-poll-interval`; minimum 1 s), starting when a
`DatastoreSyncService` is available. They are independent: a config-only pull
does not count as a runtime refresh, and vice versa.

Every poller pull runs under serve's **sync gate** (`src/serve/sync_gate.ts`),
in exclusive mode. Handler mutations and every run's syncs hold the same gate.
So a pull can never land between a local delete and the push that deletes the
remote object, and it can never prune index entries a run push is committing
(see the serve handler obligation below). Each pull is hard-limited by
`POLLER_PULL_TIMEOUT_MS`, so the gate comes back even if an extension ignores
the AbortSignal.

A poller never makes runs wait for it. It takes the gate only when the gate is
idle, retrying every second for most of its interval without joining the queue.
If the gate never frees, it skips the cycle and logs a warning with its count of
consecutive skips. After `POLLER_ESCALATE_AFTER_SKIPS` (three) skips in a row it
queues for the gate instead, so a steady stream of run pushes can delay a poller
but never starve it. A poller never pulls ungated, and `stop()` ends any wait
for the gate at once.

The RuntimeDataPoller gives **eventual visibility**, not immediate consistency.
An idle peer sees committed output within one polling interval of it reaching
the remote. Under steady run load it can take about four intervals: three
skips, then an escalated cycle. The same bound applies to changes reaching the
AccessDataPoller. The query catalog is invalidated only after a successful pull
that reports changes, so quiet cycles keep fast cached reads.

### SyncContext and SyncCapabilities

Extensions advertise capabilities through the optional `capabilities()` method
on `DatastoreSyncService`:

```typescript
capabilities(): SyncCapabilities {
  return { scopedSync: true, namespacedSync: true };
}
```

`SyncCapabilities` (`src/domain/datastore/datastore_sync_service.ts`) has
`scopedSync`, `lazyHydration`, `namespacedSync`, `twoPhaseSync`, `previewPush`
(makes `sync --push` preview first unless `--yes`/`--confirm`), `controlPlane`
and `configRefresh`.

**`namespacedSync`** (Phase 6): when `true`, the extension handles the
`namespace` field on `DatastoreSyncOptions`, limiting its index walk and upload
to `{namespace}/` in the remote. Extensions without it still receive the field
but should ignore it and sync everything, as in solo mode.

When `scopedSync` is `true`, swamp core passes `pullChanged()` and
`pushChanged()` a `SyncContext` listing the models being worked on:

```typescript
interface SyncContext {
  models?: ReadonlyArray<{ modelType: string; modelId: string }>;
}
```

Extensions map this to their own storage: S3 extensions filter by key prefix,
MongoDB extensions build a query filter, and so on.

**Capability gating.** Core passes context only if the extension advertises
`scopedSync`. Without `capabilities()`, or with `{ scopedSync: false }`, the
extension gets `pullChanged()` / `pushChanged()` with no arguments, as today.

**Graceful degradation.** If `capabilities()` throws, core falls back to full
sync. The try/catch wraps only the `capabilities()` call, not pull/push.

**Per-model loop behavior.** `acquireModelLocks` calls `pullChanged()` once per
model as it takes each lock. With `scopedSync`, each call's context holds only
the model whose lock was taken, so the extension pulls one model per call.

**Push path.** The flush function calls `pushChanged()` once (not per model)
under the global lock. With `scopedSync`, the context holds all models,
deduplicated. With `twoPhaseSync`, the push splits into `preparePush` (outside
the global lock) and `commitPush` (under it); see "Two-Phase Sync" below.

**Catalog rebuild invariant.** `synced = true` is set after `pullChanged()`
succeeds, on both scoped and full paths. It is returned in `{ flush, synced }`
and checked at every call site in `src/cli` and `src/serve` (21 at last count)
to trigger `catalogStore.invalidate()`. It must never be skipped or moved.

### Namespace-Scoped Sync

When a repo sets a `namespace` in `.swamp.yaml`, push and pull cover only that
namespace's subtree in the remote. This is how two repos share one S3 bucket
without syncing each other's data.

#### How namespace flows through sync

1. **Config → coordinator.** `repo_context.ts` passes
   `datastoreConfig.namespace` to `registerDatastoreSync({ namespace })`, which
   stores it on the `SyncEntry`.
2. **Coordinator → extension.** The coordinator passes `{ signal, namespace }`
   to `pullChanged()` on pull and to `pushChanged()` on push (flush). The
   namespace field is included only when non-empty; solo-mode calls omit it.
3. **Per-model path.** `acquireModelLocks` reads `datastoreConfig.namespace` and
   passes it with the `SyncContext` (model list). With `namespacedSync`
   advertised, both are passed. With only a namespace (no `scopedSync`), the
   extension gets `{ namespace }` alone.

#### Per-namespace index partitioning

> **Extension behaviour.** This section describes the `@swamp/s3-datastore`
> extension's index design; none of it is implemented in this repo.

> **See also:** The [shard-first index](#shard-first-index) design extends
> partitioning beyond per-namespace to per-model shards covering all datastore
> subdirectories and removes the monolithic index.

Extensions advertising `namespacedSync: true` partition their remote index per
namespace:

- **Pull**: fetch `{namespace}/.datastore-index.json`; walk only keys under
  `{namespace}/`.
- **Push**: upload only files under `{namespace}/`; write
  `{namespace}/.datastore-index.json`.
- **Solo mode** (no namespace): use the global `.datastore-index.json` and walk
  all keys, as before namespaces.

The zero-diff fast path (sidecar fingerprint + dirty flag) is per namespace: the
sidecar caches the ETag of the namespace's index, not the global one. A repo
that has written nothing skips sync in O(1), however much data other namespaces
hold.

Push must never delete keys outside the namespace prefix. It uploads files under
`{namespace}/` and updates only that namespace's index. Other namespaces' keys
are invisible to the walk and untouched.

#### Namespace manifests

Registering a namespace (`swamp datastore namespace set`) writes a
`.namespace.json` manifest to the datastore:

```json
{
  "namespace": "infra",
  "repoId": "uuid-of-the-repo",
  "registeredAt": "2026-06-03T00:00:00.000Z"
}
```

It lives at `{namespace}/.namespace.json` in the remote (extension backends) or
`{datastorePath}/{namespace}/.namespace.json` (filesystem). It has two uses:

- **Conflict detection**: registration fails with a clear error if a manifest
  already exists with a different `repoId`.
- **Discovery**: `swamp datastore namespace list` scans for `.namespace.json`
  files (`src/cli/commands/datastore_namespaces.ts`,
  `src/libswamp/datastores/namespace_list.ts`).

For extension datastores, `DatastoreProvider.registerNamespace()` and
`DatastoreProvider.listNamespaces()` manage manifests through the remote API
(S3 PUT/GET, or GCS). After the remote write, swamp core also writes the
manifest to the local cache at `{cachePath}/{namespace}/.namespace.json`.
Otherwise the extension's `pushChanged()` orphan detection would find no local
copy and delete the remote one (swamp-club#834). For filesystem datastores, the
built-in `namespace_manifest.ts` utility reads and writes manifests directly.
Both methods are optional on `DatastoreProvider`. Without them, the CLI warns
that conflict detection is unavailable and only updates `.swamp.yaml`.

### Two-Phase Sync

> **Next step:** `commitPush` still reads, merges and writes the full monolithic
> index. The [shard-first index](#shard-first-index) design removes it:
> `commitPush` touches only the affected per-model partition shard(s), so
> lock-hold time scales with the write size, not the total index.

When an extension advertises `twoPhaseSync: true`, swamp core splits the push
in two to shorten the global-lock critical section:

```
Single-phase (default — pushChanged under global lock):

  acquire global lock
  pushChanged()          ← entire sync: index read + file upload + index write
  release global lock

Two-phase (twoPhaseSync: true):

  preparePush()          ← file uploads only, outside global lock
  acquire global lock
  commitPush(manifest)   ← index merge only, fast
  release global lock
```

This helps when many per-model writers in one namespace run at once. Without
it, each writer holds the global lock for a full push, so all writes queue. With
it, the slow file I/O (`preparePush`) overlaps across writers and only the fast
index merge (`commitPush`) is serialized.

#### Extension contract

Extensions implement two optional methods on `DatastoreSyncService`:

- **`preparePush(options?)`**: upload new and changed files and return an opaque
  `PushManifest` of what changed. Do NOT update the remote index. Do NOT clear
  the dirty flag; if `commitPush` fails, it must stay set so the next push
  retries.
- **`commitPush(manifest, options?)`**: read the **current** remote index, not
  a cached copy, since another writer may have committed after `preparePush`.
  **Merge** the manifest entries in; never replace the whole index. Write the
  index back, and clear the dirty flag only after that write succeeds.

`PushManifest` is opaque to core, which passes it from `preparePush` to
`commitPush` unread. The extension defines its contents.

#### Integrity guarantees

Core provides these, so extensions need no concurrency control of their own:

1. **Global lock on `commitPush`.** The index read-modify-write is always
   serialized; two `commitPush` calls never overlap.
2. **Per-model locks across both phases**, held from before `preparePush` to
   after `commitPush`. The symmetric drain in structural commands waits for
   them, so a concurrent delete or GC cannot interfere.
3. **Additive merge.** Per-model locks keep concurrent writers on separate file
   paths, so their manifests never conflict. `commitPush` merges into whatever
   the index currently holds.
4. **Catalog export before upload.** `.catalog-export.json` is written before
   `preparePush`, so it is uploaded with the files. It is a full snapshot of the
   local catalog, so a concurrent overwrite still gives a correct (more
   complete) result. This avoids an export that changed but was never uploaded.

#### Fallback

Extensions that do not advertise `twoPhaseSync`, or lack
`preparePush`/`commitPush`, keep the single-phase
`pushChanged`-under-global-lock path, with no regression.

### Shard-First Index

> **Extension behaviour.** This section describes the `@swamp/s3-datastore`
> extension's index design and is not implemented in this repo. Core's only
> part is the optional `migrateMonolithToShards?()` method on
> `DatastoreSyncService`, its `MigrateIndexResult`, and the
> `swamp datastore migrate-index` command that calls it.

Even with two-phase sync, `commitPush` reads, parses, merges and rewrites the
whole monolithic `.datastore-index.json` under the lock. On a busy namespace
with a large index, this can take so long that few concurrent writers fit in
the 60-second lock timeout.

Shard-first splits the index into per-model shard files under `_index/`, and
`commitPush` reads and writes only the shard(s) it touches. The monolith is no
longer the source of truth during `commitPush`. Lock-hold time depends on the
write size (typically KB), not the index size (possibly hundreds of MB).

#### Partition scheme

Each datastore subdirectory has a partition key strategy:

| Subdirectory              | Partition key pattern                      | Granularity  |
|---------------------------|--------------------------------------------|--------------|
| `data/`                   | `data--{type}--{modelId}`                  | Per model    |
| `outputs/`                | `outputs--{type}--{modelId}`               | Per model    |
| `definitions-evaluated/`  | `definitions-evaluated--{type}--{modelId}` | Per model    |
| `workflows-evaluated/`    | `workflows-evaluated--{workflowId}`        | Per workflow |
| `workflow-runs/`          | `workflow-runs--{workflowId}`              | Per workflow |
| `auto-definitions/`       | `auto-definitions`                         | Single shard |
| `audit/`                  | `audit`                                    | Single shard |
| `telemetry/`              | `telemetry`                                | Single shard |
| `logs/`                   | `logs`                                     | Single shard |
| `files/`                  | `files`                                    | Single shard |

Model-scoped subdirectories (`data/`, `outputs/`, `definitions-evaluated/`) get
a shard per model. Low-cardinality ones (`audit/`, `telemetry/`, etc.) get one
shard each, since they are small and rarely written concurrently.

Each shard is `_index/{partitionKey}.json`. A `_meta.json` file lists all
partition keys and a monotonic `commitSeq` counter:

```json
{
  "version": 2,
  "partitions": ["data--mytype--abc123", "outputs--mytype--abc123", "audit"],
  "commitSeq": 42,
  "lastCompacted": "2026-07-01T12:00:00.000Z"
}
```

- `version: 2` marks shard-first, unlike the earlier `version: 1` (dual-write)
  format. A reader seeing `version: 1` knows the monolith is still
  authoritative.
- `commitSeq` increments on every `commitPush` and replaces the monolith ETag as
  the zero-diff fast path fingerprint.

#### Push path (`commitPush`)

Every index write is a compare-and-swap merge. The global lock does not
serialize it, because serve-handler pushes take this path without the lock. A
writer must assume the remote shard changed under it:

1. Read `_meta.json` for the current partition list and `commitSeq`.
2. Read each shard the manifest entries touch, keeping its etag (S3) or
   generation (GCS).
3. Apply **only this writer's** upserts and removals to the shard as read.
   Never rewrite a shard from the local view: entries the local view lacks
   belong to other writers and must survive.
4. Write each shard back conditionally (`If-Match` / `ifGenerationMatch`). On a
   lost race, re-read and re-merge instead of overwriting.
5. Merge `_meta.json` the same way: append new partition keys and set
   `commitSeq` to the value read plus one.
6. Clear the dirty flag.

A store that answers `NotImplemented` to a conditional PUT falls back to
merge-on-write without compare-and-swap, and warns once.

`preparePush` is unchanged. It uploads files outside the lock and returns an
opaque manifest of the affected relative paths, from which `commitPush` derives
partition keys.

#### Pull path

**Scoped pull** (`pullChanged` with `context.models`): read the relevant model
shard(s) from `_index/`. With `_meta.json` at version 2, no monolith fallback is
needed.

**Unscoped pull** (`pullChanged` without context): read `_meta.json` for all
partition keys, fetch every shard in parallel, and merge into the in-memory
index. N parallel GETs replace one monolith GET, which on S3/GCS is usually
faster than fetching one large object.

#### Memory contract

In `swamp serve`, the sync service is a singleton created at startup and shared
by all pollers and handlers for the life of the process. Any state
`pullChanged` accumulates across calls is a memory leak.

Rules:

1. **Stream file content to disk.** Do not keep downloaded bodies
   (`Uint8Array`, `ArrayBuffer`) in instance state after writing them to the
   cache. Prefer streaming (`ReadableStream.pipeTo`) to buffering
   (`transformToByteArray`). If you must buffer, scope the reference to the
   download function so it is freed once the write completes.

2. **Bound or flush internal indexes.** If you keep an in-memory index (e.g. a
   `Record<string, IndexEntry>`), write it to disk after each `pullChanged`
   instead of growing it across calls. On a serve singleton it would grow
   without bound along with the datastore.

3. **No file-content hashing in the JS heap.** Compare local files to remote
   hashes with a streaming hasher (`node:crypto.createHash`), not by reading
   whole files with `Deno.readFile`.

These rules are convention only; the interface cannot express memory behavior.
The conformance suite in `packages/testing/` documents the expectation.

#### Shard cleanup

A shard emptied by deletions is left in place as an empty object, not deleted.
S3-compatible stores ignore `If-Match` on DELETE, so a delete cannot be
conditional and would race a concurrent add to the same shard. The key is
removed from the `_meta.json` partitions list only while a HEAD still shows the
etag/generation this push wrote. If another writer has refilled the shard, the
key stays.

#### Zero-diff fast path

The sidecar caches `commitSeq`. On the next sync the extension reads
`_meta.json` and compares `commitSeq`. Unchanged means skip, with no per-entry
work. Changed means fetch the relevant shard(s).

#### Migration

Migrating from the monolith to shard-first is a one-time explicit step, never
triggered by normal writes. Otherwise several writers on a freshly upgraded
extension could each read a large monolith and write redundant shards.

Run it from the CLI:

```
swamp datastore migrate-index
```

The command takes the distributed lock and calls `migrateMonolithToShards()` on
the active sync service, which:

1. Reads the existing `.datastore-index.json`.
2. Partitions all entries into shards using the scheme above.
3. Writes all shard files to `_index/`.
4. Writes `_meta.json` with `version: 2` and `commitSeq: 1`.

As a structural command it runs under the lock, so migrations cannot race. It is
idempotent. If the monolithic index is empty, it lists existing shard files in
`_index/` and rebuilds `_meta.json`.

Edge cases:

- **Filesystem datastore**: reports that index migration is only for
  sync-capable custom datastores.
- **Extension without migration support**: advises updating to an extension
  version that supports shard-first indexing.
- **Empty datastore**: recovers from the `_index/` listing if shards exist.

**Pre-migration behavior:** When `_meta.json` is missing or `version: 1`,
`commitPush` and `pullChanged` use the monolithic path, as before shard-first.
An info-level log says migration is available via
`swamp datastore migrate-index`. Upgrading the extension alone causes no
regression.

#### Backward compatibility

**Phase 1 (initial release):** `commitPush` writes shards as the source of truth
and also writes the monolith as a derived copy. Old extension versions read the
monolith; new ones read shards.

**Phase 2 (future major version):** Stop writing the monolith. Old extension
versions must upgrade.

**Old writers:** An old version may write the monolith but not shards.
Shard-first readers fall back to the monolith when `_meta.json` is missing or
`version: 1`. This fallback is permanent and stays after migration.

#### Namespace interaction

In namespaced mode the shard path is `{namespace}/_index/`. The partition scheme
is unchanged; existing path resolution adds the namespace prefix. `_meta.json`
and all shards are per namespace.

#### Recovery

If `_meta.json` is missing or corrupt, the extension lists the `_index/` prefix
with `ListObjectsV2` to find all shards and rebuilds `_meta.json`, with no
operator action.

If one shard is missing or corrupt, the extension uses the monolith for that
shard's entries, if the monolith exists. If not, it rebuilds the shard by
listing objects under the shard's path prefix.

### Zero-Diff Fast Path (Extension Guidance)

At production scale most syncs have nothing to do: the local cache already
matches the remote index. Walking every index entry each time makes these O(n)
when they could be O(1). Extension authors implementing `DatastoreSyncService`
SHOULD add a zero-diff fast path that returns `0` with no per-entry work when it
can prove cache and remote match.

The recommended pattern is a **fingerprint + local-dirty watermark** in a small
sidecar file in the cache directory:

- **Remote fingerprint**: a cheap, backend-native change token for the remote
  index. S3 uses the object ETag; GCS the `generation` number. Any monotonic
  identifier from a metadata-only request (HEAD-equivalent, not the index body)
  works. Cache the last value seen on disk.
- **Local-dirty flag**: set `true` by every code path that writes to the cache
  (e.g. the extension's `pushFile` equivalent). Cleared only after a successful
  writeback or a verified zero-diff pull. It must default to `true` if the sidecar
  is missing or corrupt, so the slow path runs.

On `pullChanged` and `pushChanged`, the fast path makes one metadata request for
the remote index. If the fingerprint matches the sidecar and the dirty flag is
`false`, it returns `0`. On any mismatch, corruption or doubt it falls through
to the full walk. The fast path must never skip real work.

The sidecar is client-local: never uploaded, excluded from the sync walker, and
always safe to delete to force a full re-check.

#### `markDirty()` contract

Swamp core writes into the cache directly. The persistence repositories
(`FileSystemUnifiedDataRepository`, `YamlOutputRepository`,
`YamlWorkflowRunRepository`, `YamlEvaluatedDefinitionRepository`) call
`atomicWriteFile` / `atomicWriteTextFile` / `Deno.remove` on paths the sync
service walks. These writes bypass the extension's write path, so the dirty flag
would stay `false` and the next `pushChanged` would skip real work.

`markDirty()` on `DatastoreSyncService` closes this gap. It takes an options bag
with an optional `relPath`, so extensions that track dirty state per path can
record which path changed instead of flipping one global bit:

```typescript
markDirty(options?: DatastoreSyncOptions): Promise<void>;

interface DatastoreSyncOptions {
  signal?: AbortSignal;
  /** Cache-relative path of the file about to be written or removed. */
  relPath?: string;
  /** Domain-level sync context, passed when the extension advertises scopedSync. */
  context?: SyncContext;
  /** Namespace whose data subtree this sync operation targets (Phase 6). */
  namespace?: string;
  /** When true, pull downloads only metadata files (lazy hydration). */
  metadataOnly?: boolean;
  /** Restrict the sync to these datastore subdirectories. */
  subdirs?: readonly string[];
}
```

The contract has eight rules:

1. **Pre-write timing.** `markDirty` fires before the cache write. The file is
   not on disk yet, so extensions MUST NOT act on `relPath` synchronously. Record
   it as a hint for the next `pushChanged`.
2. **Absence-on-disk = delete.** If `pushChanged` later finds a recorded
   `relPath` missing from the cache, the extension SHOULD delete the remote
   record. One signal covers create, update and delete.
3. **`undefined` `relPath` = bulk.** No `relPath` means core could not tie the
   change to one path (`rename`, `deleteAllByWorkflowId`, `clearAll`).
   Extensions with a per-path dirty set MUST either invalidate the set (stop
   trusting it) or mark the next `pushChanged` for a full walk.
4. **Process restart loses the set.** Extensions holding the set in memory MUST
   do a full walk on the first `pushChanged` after start. Persisting it to a
   sidecar is allowed but optional.
5. **`relPath` is cache-relative + forward-slash.** It is relative to the
   directory from `DatastoreProvider.resolveCachePath`, with forward slashes on
   every OS, matching the `.datastore-index.json` key convention. **Extensions
   using `relPath` for disk access on Windows MUST convert to native
   separators** (e.g. `@std/path` `join`) before `Deno.stat`/`Deno.readFile`/etc.
   Core never sends a `relPath` that escapes the cache. The hook
   (`buildMarkDirtyHook` in `src/cli/repo_context.ts`, shared by the CLI and
   serve) maps a path under the repo's `.swamp/` onto the cache layout, and
   sends nothing for a path outside both. That is repo-local config such as
   `models/`, `workflows/` and `vaults/` without managedConfig, which the
   datastore never syncs. The S3 and GCS extensions treat an escaping `relPath`
   as bulk (rule 3), so forwarding one would turn the next push into a walk of
   the whole cache (swamp-club#2415).
6. **Backward compatibility.** `relPath` is optional. Existing implementations
   (`@swamp/s3-datastore`, `@swamp/gcs-datastore`, the filesystem no-op, every
   test mock) work unchanged: the single-watermark pattern still meets the
   contract, since any `markDirty` call sets the dirty flag.
7. **Field scope.** Core sets `relPath` only on `markDirty`. It means nothing on
   `pullChanged` or `pushChanged`; it sits on the shared `DatastoreSyncOptions`
   for source compatibility only.
8. **Bulk overrides per-path within one operation.** Some operations send both a
   bulk signal and per-path signals. In `rename`, the first `markDirty()` has no
   `relPath` (bulk, for tombstone and latest-marker writes that do not split by
   path), then the inner `save()` of the new name sends a per-path signal.
   Extensions MUST let a bulk signal override per-path signals from the same
   operation. Simplest approach: keep a `bulkInvalidated: boolean` flag beside
   the dirty set, and do a full walk in `pushChanged` whenever it is true.

**Core obligation.** Repositories writing into the cache call the dirty hook at
the start of every public mutation method. These are `save`, `append`, `delete`,
`rename`, `allocateVersion`, `finalizeVersion`, `removeLatestMarker`,
non-dry-run `collectGarbage`, and the equivalents on the three yaml
repositories. The call comes before any write, so a crash mid-write leaves the
watermark dirty. A dirty flag plus a slow walk always recovers; a lost dirty
flag does not.

**Per-call granularity emitted by core.**

| Method                                     | `relPath`                                                       |
| ------------------------------------------ | --------------------------------------------------------------- |
| `save`, `append`, `allocateVersion`        | data-name directory (version not yet allocated)                 |
| `removeLatestMarker`                       | data-name directory                                              |
| `delete(version=specific)`                 | version directory                                                |
| `delete(version=undefined)`                | one signal per version directory + latest marker file (see below) |
| `finalizeVersion`, `finalizeVersionDeferred` | version directory (version known)                              |
| `saveDeferred`                             | data-name directory                                              |
| `rename`                                   | old name's data-name directory (see below)                       |
| `collectGarbage` (non-dry-run)             | one signal per removed version directory, or the data-name directory when the whole name goes |
| `pruneExcessVersions` (write-time cap)     | one signal per removed version directory                         |
| Yaml repos: `save`, `delete`, `deleteOlderThan` | per-yaml file path                                          |
| Definition repo: `save`, `delete`          | target file path                                                 |
| Workflow repo: `save`, `delete`            | target file path                                                 |
| Evaluated workflow repo: `save`, `delete`  | target file path                                                 |
| Evaluated workflow repo: `clear`           | workflows-evaluated directory                                    |
| `deleteAllByWorkflowId`                    | workflow's runs directory                                        |
| Evaluated definition repo: `clearAll`      | definitions-evaluated base directory                             |

`delete(version=undefined)` matches the `collectGarbage` pattern and falls back
to the data-name directory if it cannot list versions. For `rename`, the inner
`save()` sends its own per-path signal for the new name.

`advanceLatestMarkers` and `rollbackVersions` send nothing; they rely on the
signal from `saveDeferred` / `finalizeVersionDeferred`
(`src/infrastructure/persistence/unified_data_repository.ts`).

Filesystem datastores have no fast path and no sync service, so markDirty is a
no-op for them.

**Serve handler obligation.** Serve code never calls a bare `markDirty()`.
Mutations that go through repositories with per-path `markDirty` wired (model,
workflow, data, output and definition repos) rely on the repositories' signals.
This covers the mutation handlers, the OAuth server-token mint in
`device_auth_handler.ts`, and `access.reload`, which reconciles grant files
through the definition and data repos. The per-path signals are enough, and they
drive the extension's scoped walk, which detects deletions by absence on disk
(rule 2). A bare `markDirty()` sets `bulkInvalidated` in the extension and
overrides the per-path signal. That has two costs:

- **Dropped deletions.** The full walk skips deletion detection unless the
  per-path set overflowed, so remote deletions are silently lost
  (swamp-club#2273).
- **A full-cache push.** The push rebuilds the index from every remote shard
  and hashes every cached file. On a cache filled by pulling, a change to a few
  files then costs time proportional to the whole cache. On the login mint this
  made every `swamp auth server-login` slower as the datastore grew
  (swamp-club#2408), and every vault or access change did the same
  (swamp-club#2415).

The repositories mark a path dirty before they write it, so a push can land
between a repository's mark and its write. That push finds the path absent,
treats it as a delete and clears the mark, and the writer's own push then has
nothing to upload. Serve's gate now keeps run pushes (shared mode) out of every
handler mutation (exclusive mode), so a run finishing at the same moment can no
longer do this to a gated handler (swamp-club#2405). Concurrent runs still
share the gate and can still do it to each other. The OAuth mint and
`access.reload` also re-mark their paths, by path, after the writes and just
before `pushChanged()`: the mint for the token's definition file and data
folder, `access.reload` for each grant definition it created and each grant data
folder it wrote. A reload that changes nothing marks nothing, so its push takes
the fast path. A push already running when the re-mark lands still clears it,
because the extension resets the whole dirty set when a push completes.
swamp-club#2421 tracks the proper fix: repositories that mark after the write,
and extensions that clear only the marks a push handled.

**Writes outside a hooked repository.** Some serve mutations write cache files
that no hooked repository covers. Each marks exactly those files, by path, after
writing:

- `vault.create` and `vault.migrate` mark the vault config file, because
  `YamlVaultConfigRepository` has no hook. `vault.migrate` also marks the old
  config it removed, so the scoped push deletes the remote copy. Otherwise the
  config poller would bring it back as a second config with the same name.
- The extension handlers (`extension.install`, `pull`, `rm`, `update`) mark the
  config-tier lockfile. Serve still writes extension sources to the repo-local
  pulled-extensions root (swamp-club#2429), so the lockfile is the only file
  they change in the cache.
- The serve startup migration moves grant and server-token definitions from
  `models/` to `auto-definitions/` on disk, and marks each moved file.

Without managedConfig, the vault config is repo-local and the hook drops the mark
(rule 5). The extension handlers do not push at all then, since nothing they
write is in the cache. Handlers that never write into the cache do not push:
`vault.put`, `vault.annotate`, `vault.delete` and `vault.edit`. Secrets and
annotations live in the always-local `.swamp/secrets`, and vault audit entries
go to the repo-local `.swamp/audit`.

Mark files, not shared directories. A directory mark makes the scoped walk
delete remotely every index entry under it that is missing locally. That
includes files another serve instance pushed that this one has not pulled yet,
and definitions a partial startup pull left missing. A directory mark is safe
only for a tree the mutation itself owns and has just written, such as a data
item's folder.

`integration/datastore_sync_rules_test.ts` enforces this at build time:

- One rule rejects a bare `notifyDirty()` inside the per-path-wired
  repositories.
- Another rejects any bare `markDirty()` call in `src/serve` and
  `src/cli/commands/serve.ts`. It matches the `.markDirty()` and
  `.markDirty?.()` forms on any receiver, and names the top-level function that
  makes the call.

Every serve mutation handler that changes the cache must call `pushChanged()`
after the mutation. The data-domain handlers (`data.delete`, `data.rename`,
`data.gc`, `data.prune`, `run.gc`) push in a `finally`, so a cancelled or failed
request still pushes what it already changed locally. `markDirty` only records dirty state. Until a
push runs, the remote keeps the old objects, and the next poller pull restores
anything deleted locally (swamp-club#2240).

**The mutation and its push are one unit.** A delete is two steps: remove the
file from the cache, then `pushChanged()`. The push picks delete or upload by
checking the file on disk (rule 2). A poller pull between the steps puts the
file back, so the push re-uploads it and the delete is silently undone
(swamp-club#2247). Serve closes this window with the **sync gate**
(`src/serve/sync_gate.ts`), an in-process FIFO read/write lock.

**Runs sync under the gate too.** Serve shares one sync service instance across
pollers, handlers and runs, and a pull prunes index entries whose objects were
missing from a listing it took earlier. A run push that commits entries into
that shared in-memory index while a poller's listing is in flight gets its new
entries pruned, and the pull CAS-writes the pruned shard. The objects stay in
the datastore, but the index no longer lists them (swamp-club#2405). So every
run push holds the gate as well.

The gate has two modes:

- **Exclusive**, held across:
  - a whole mutating handler, at its dispatch site in `connection.ts`
    (`withSyncGate`);
  - the server-token mint in `device_auth_handler.ts`;
  - the worker GC cycle in `worker_gc_service.ts`: the whole worker prune and
    its push as one unit, then each bookkeeping reap batch (up to 100 ended
    step leases and pending dispatches, `bookkeeping_gc.ts`) with its push as
    its own unit, releasing the gate between batches so waiting runs are not
    held behind a large first reap;
  - each poller's pull (`gatedPull`).
- **Shared**, held by every run push and step-start pull (`withSharedSyncGate`):
  each step's model-lock pull and flush push (serve passes `acquireModelLocks` a
  `wrapSync` hook, normally through `createStepLockHook`), and the post-run and
  post-resume pushes of `workflow.run`, `workflow.resume`, `model.method.run`,
  scheduled, webhook and auto-resumed runs. Shared holders exclude pulls and
  handler mutations but not each other, so fan-out workflows keep their
  parallel uploads. The `wrapSync` hook covers only the sync calls, never the
  model-lock wait.

The fitness test in `integration/serve_deps_rules_test.ts` fails the build if a
serve function pushes outside the gate: a raw push outside a
`withSharedSyncGate` span in a function not gated at dispatch, or an
`acquireModelLocks` call without `wrapSync`. The only exemptions are pinned in
`UNGATED_PUSH_HANDLERS`: startup hydration and the gate's own plumbing.
`createStepLockHook` and `executeWorkflowWithLocks` take the gate as a required
parameter, so the compiler also catches callers outside `src/serve`, such as the
scheduler in `src/cli/commands/serve.ts`.

Six properties of the gate are easy to misread:

- **Not reentrant.** Acquiring it inside an exclusively gated handler waits on
  itself until `GATE_WAIT_TIMEOUT_MS`. A second fitness rule forbids a
  dispatch-gated handler from taking the shared mode or building a step-lock
  hook. `workflow.approve` launches auto-resume detached and never awaits it.
- **Lock order: model lock before gate, never the reverse.** A run step holds
  its model lock while it waits for the gate. That is safe only because no gate
  holder ever waits on a model lock: no dispatch-gated handler takes one, and
  libswamp takes no datastore locks. Keep it that way.
- **Handlers wait for run pushes.** Exclusive handler mutations also wait for
  run pushes already in flight, so a long upload can delay an admin mutation.
- **What is still not covered.** An overlapping poll can still restore data a
  run's version GC removed, because the gate covers the run's push, not the
  whole step. Pushes are not globally serial either: shared holders run
  concurrently, as extensions have had to tolerate since swamp-club#2235.
- **In-process only.** It does not cover HA peers: another instance's dirty
  path can still re-upload what this one deleted. The cross-process
  `DistributedLock` covers the CLI flush path, not serve pushes. This includes
  the worker GC: a peer whose cache still holds a reaped lease or dispatch can
  re-upload it on its first full-walk push after a restart (`markDirty` rule
  4). The record is still ended, so the next reap deletes it again.
- **Waits are bounded, in different ways.** A request cancelled while queued
  still mutates. The cancel signal is not passed to the gate acquisition,
  because a rejected acquisition would leave the client with no response frame,
  so the handler runs and then reports `cancelled` from its own abort check. A
  handler mutation or run push waiting longer than `GATE_WAIT_TIMEOUT_MS`
  proceeds without the gate and logs a warning, so a stuck holder falls back to
  pre-gate behaviour instead of stalling the server. A poller never falls back:
  it skips the cycle, so the pull side of the race never runs ungated. Runs wait
  on a poller only during its escalated cycle, and only for as long as the
  pushes already ahead of it (at most `GATE_WAIT_TIMEOUT_MS`).

**Sync is not a content-integrity tool.** The fingerprint detects index changes,
not per-file corruption. A damaged cache file (bit rot, a truncated write after
a crash) can pass the fast path if the index is unchanged. Integrity is the
verifier's job: use `DatastoreVerifier.verify()`, or `rm -rf` the cache and
re-pull.

### Foreign Catalog Export/Pull (Phase 6)

In a giga-swamp, each namespace publishes `.catalog-export.json` after each
push: a flat JSON array of its catalog rows. Foreign catalog pull fetches other
namespaces' exports and upserts them into the local catalog.

**Interface methods** (optional on `DatastoreSyncService`):

```typescript
exportCatalog?(namespace: string): Promise<void>;
pullForeignCatalogs?(namespaces: readonly string[]): Promise<CatalogExportEntry[]>;
fetchForeignContent?(namespace: string, relPath: string): Promise<Uint8Array | null>;
```

- `exportCatalog`: writes `{namespace}/.catalog-export.json` to the remote.
- `pullForeignCatalogs`: fetches exports from named namespaces, returns rows.
- `fetchForeignContent`: downloads one file from a foreign namespace.

**Catalog backfill** uses `bulkUpsert(rows)` (INSERT OR REPLACE) to merge the
on-disk walk into the catalog, keeping rows the walk cannot see (e.g. lazily
hydrated remote data). Foreign rows go through `bulkUpsertForeign`, which
records a `foreign_synced:{namespace}` timestamp in `catalog_meta`.

**On-demand content fetch** (Phase 6d): when a cross-namespace CEL expression
reads `attributes` whose content is not local, the `DataQueryService` calls
`fetchForeignContent` through its `ForeignContentFetcher` callback. Content is
cached in memory for the command, not persisted. Missing content or errors
leave attributes empty.

**CLI**: `swamp datastore catalog pull --namespaces infra,security` pulls
foreign catalog metadata from those namespaces.

### Lazy Hydration

With `hydrationStrategy: "lazy"` on a custom datastore, the initial pull fetches
only metadata files (`metadata.yaml`, `latest` markers, partition indexes) and
skips content files (`raw`) under `data/`. The catalog is fully visible, so
`data list`, `data query` and CEL expressions work at once, while the costly
content download waits until needed.

#### How it works

1. **Setup/initial pull**: the extension's `pullChanged` filters by suffix.
   Under `data/`, files ending `/metadata.yaml` or `/latest` are downloaded.
   Files ending `/raw` are skipped, but their parent directories are created so
   the catalog backfill walker (which uses `readdir`) finds the version
   directories. Files outside `data/` (outputs, workflow-runs,
   definitions-evaluated) have no metadata/raw split and are downloaded fully.
2. **Model runs / workflow runs**: `acquireModelLocks` does a scoped pull via
   `pullChanged({ context })`. It reads the partition file, sees `raw` missing
   locally, and downloads it. The existing Phase 2 scoped sync handles this; no
   new code is needed.
3. **`data get` (read-only, no sync)**: `UnifiedDataRepository.getContent()`
   tries to read `raw`. If it is missing and a `HydrateFileHook` is wired, it
   calls the hook to download that file, then retries the read.

#### `HydrateFileHook` contract

`HydrateFileHook` mirrors `MarkDirtyHook`: a thin callback injected into
repositories so they need no handle on the sync service. Repositories pass an
absolute path. The composition root in `repo_context.ts` wraps
`DatastoreSyncService.hydrateFile` with path normalization (absolute to
cache-relative, forward slashes). As with `MarkDirtyHook`, repositories never
convert paths themselves.

- Wired in `requireInitializedRepo`, `requireInitializedRepoUnlocked` and
  `requireInitializedRepoReadOnly`. The read-only variant creates a lightweight
  sync service with no lock, only for single-file downloads.
- Wired in `WorkflowExecutionService` → `DefaultStepExecutor` via the
  `RepositoryContext.hydrateFile` field, so workflow steps on serve can hydrate
  lazy content during `readResource` calls.
- Returns `true` if the file was downloaded, `false` if it is not on the remote.
- Implementations MUST write atomically (tmp + rename) so concurrent readers
  never see a partial file.

#### `getContentSync` limitation

`getContentSync()` is synchronous and cannot call the async `HydrateFileHook`.
Its callers:

- `data_record_mapper.ts`: loads attributes/content for query predicates during
  `data query '<predicate>'`.
- `model_resolver.ts`: resolves CEL expressions during model runs.
- The composite and in-memory repositories, which delegate to it.

The `model_resolver.ts` path is safe: model runs go through `acquireModelLocks`
→ scoped pull, which downloads `raw` files before CEL evaluation.

`DataQueryService.getLatestRecord()`, the lookup behind `data.latest()`, checks
that a catalog row still has content before trusting it while the catalog is
unpopulated (every datastore sync invalidates it). The check uses the async
`getContent()`, so on a lazy-hydration datastore it downloads the `raw` file
instead of mistaking a metadata-only row for a stale one. A row whose content
is also absent remotely is still stale (swamp-club#2288).

That scoped pull covers only the step's own model. `DataRecord.path` from
`data.latest()` / `data.version()` must name a present file, so those lookups
stat the path and, if missing, call the async `getContent()` to hydrate it. If
the file is still absent, or hydration throws, `path` is `""`. List lookups
(`data.findBySpec()`, `data.findByTag()`, `data.query()` record results) only
stat and clear missing paths. They never download, so a metadata query cannot
pull every matching `raw` file.

Through the `data_record_mapper.ts` path, `data query` predicates on
`attributes` or `content` of un-hydrated data see `null`. This is a documented
limitation of lazy hydration. Queries filtering only on metadata fields (tags,
version, owner, etc.) work.

#### Configuration

- `CustomDatastoreConfig.hydrationStrategy`: `"full"` (default) or `"lazy"`.
- `SyncCapabilities.lazyHydration`: advertised by extensions supporting
  selective pull and single-file hydration.
- `DatastoreSyncService.hydrateFile`: optional; omitted by extensions without
  lazy hydration. Core wires the `HydrateFileHook` only when
  `hydrationStrategy === "lazy"` and the service implements `hydrateFile`
  (`src/cli/repo_context.ts`).

### Index

> **Extension behaviour.** This and the next three sections describe the
> `@swamp/s3-datastore` extension; none of it is implemented in this repo.

A metadata index (`.datastore-index.json`) tracks every file in the S3 bucket.
It is a JSON manifest mapping relative paths to size and last-modified time. It
is fetched once per command, with a short local cache TTL to avoid refetching
during rapid command sequences.

### Change Detection

> **Extension behaviour** (`@swamp/s3-datastore`), not implemented in this repo.

Changes are detected by comparing `stat.size` and `stat.mtime`:

- **Pull**: downloads remote-index files that are missing locally or differ in
  size.
- **Push**: uploads cache files that are new or differ from the index in size or
  mtime.

There is no content hashing. The write paths (`atomicWriteTextFile`,
`Deno.writeFile`) always update mtime, so rewrites are detected even when size
is unchanged.

### Transfer Concurrency

> **Extension behaviour** (`@swamp/s3-datastore`), not implemented in this repo.

Pull and push transfer files concurrently in bounded batches. Overlapping S3
round trips speeds up syncs with many files; the limit avoids overloading the
network or hitting S3 rate limits.

### Offline Behavior

> **Extension behaviour** (`@swamp/s3-datastore`), not implemented in this repo.
> Core's own contribution is the sync timeout above and the diagnostics in
> `src/infrastructure/persistence/sync_error_diagnostic.ts`.

If S3 is unreachable, pull and push warn and continue against the local cache.
Data is pushed on the next successful connection.

## Concurrency Control

Both backends use a distributed lock against concurrent writes. Write commands
take it at start and release it at end, on success or error. Read-only commands
(`requireInitializedRepoReadOnly`) skip it and can run alongside writes. This is
safe because every write goes to a temp file that is then renamed into place
(`atomicWriteTextFile`), so reads never see partial or corrupt files.

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

`forceRelease` re-checks the lock's nonce just before deleting and returns
`false` if the holder changed. That shrinks the TOCTOU window to the gap between
the final read and the delete. It is the breakglass primitive behind
`swamp datastore lock release --force`, and `acquireModelLocks` uses it to
clear stale global locks seen while taking per-model locks (see "Lock
Lifecycle" below).

Lock metadata (`LockInfo`) is stored as JSON:

```json
{
  "holder": "user@hostname",
  "hostname": "hostname",
  "pid": 12345,
  "acquiredAt": "2026-03-10T12:00:00.000Z",
  "ttlMs": 30000,
  "nonce": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

### Extension Locks

> **Extension behaviour.** The S3 mechanism below is the
> `@swamp/s3-datastore` extension's design, not implemented in this repo.

Extension datastores supply their own `DistributedLock` via
`DatastoreProvider.createLock()`. For example, `@swamp/s3-datastore` takes the
lock atomically with S3 conditional writes (`PutObject` with
`If-None-Match: *`) and keeps it alive with a background heartbeat.

### FileLock

Uses advisory lockfiles (`Deno.open({ createNew: true })`) for atomic
check-and-create. In solo mode the lockfile is `{datastorePath}/.datastore.lock`.
A background heartbeat rewrites it with a fresh timestamp. Stale locks (where
`acquiredAt + ttlMs < now`) are removed and the acquire retried.

With a `namespace` set, `datastoreGlobalLockOptions` returns
`{ lockKey: ".datastore.lock", namespace }`. `FileLock` and the remote lock
providers (S3, GCS) put the key under `{namespace}/`, at
`{datastorePath}/{namespace}/.datastore.lock`. Repos on different namespaces of
a shared datastore then never contend on structural commands, and IAM
credentials scoped to the namespace prefix can reach the lock. Only the lock
path changes; the lifecycle below is the same.

Per-model lock keys are namespaced too: `{namespace}/data/{type}/{modelId}/.lock`
with a namespace, `data/{type}/{modelId}/.lock` without. The `modelLockKey()`
helper in `lock.ts` builds the key; `createModelLock` and `acquireModelLocks`
read `config.namespace` to pass it through. `parseModelLockKey` is unchanged:
callers strip the namespace from filesystem-relative paths with
`stripNamespacePrefix()` before parsing.

### Lock Timeout and Retry Behavior

The default lock timeout is **60 seconds** (`DEFAULT_LOCK_TIMEOUT_MS`). That is
enough for most workloads, because per-step locking gives each model method step
a fresh timeout.

`SWAMP_LOCK_TIMEOUT_MS` overrides it (`LOCK_TIMEOUT_ENV_VAR` in
`datastore_config.ts`). The first positive value wins:

1. Per-invocation override (internal; no CLI flag currently exposes it)
2. `SWAMP_LOCK_TIMEOUT_MS` env var (must parse as a positive integer)
3. `DEFAULT_LOCK_TIMEOUT_MS` (60,000 ms)

Invalid env values (non-numeric, zero, negative) are silently ignored.

Every lock creation site gets the resolved timeout: per-model locks
(`createModelLock`), global datastore locks (`createDatastoreLock`), and inline
locks in `requireInitializedRepo` and the flush paths. Custom providers receive
`maxWaitMs` in `LockOptions`; honouring it is up to them.

**Retry backoff.** `FileLock.acquire` uses jittered exponential backoff. It
starts at `retryIntervalMs` (default 1 second), doubles per attempt up to 8
seconds, and adds ±25% jitter. Each sleep is clamped to the remaining budget, so
the loop never overshoots `maxWaitMs`. Per-model locks (`createModelLock`) start
at 25 ms instead: they guard brief local writes, and the 1 second default made
waiters sleep through a release that came milliseconds later. Backoff still
doubles, so sustained contention reaches the same pace.

**Contention logging.** A lock taken after one or more retries logs the retry
count and total wait at info level:

```
INF datastore·lock Acquired lock "/abs/path/to/datastore/.datastore.lock" after 3 retries (4521ms)
```

The path is the absolute `lockPath` (`file_lock.ts`).

### Lock Lifecycle

The sync coordinator (`datastore_sync_coordinator.ts`), a global singleton,
manages the lock lifecycle:

- `registerDatastoreSync({ service?, lock?, label?, syncTimeoutMs?,
  metadataOnly?, namespace? })`: take the lock, pull if S3.
- `flushDatastoreSync()`: push if S3, release the lock.

Per-model commands (`model method run`) take only per-model locks, via
`acquireModelLocks`. They do not take the global lock, but `inspect()` it to
wait out any running structural command. That `inspect()` must target the
same namespaced global-lock key the structural command takes
(`datastoreGlobalLockOptions`). Otherwise, in namespaced mode, it would check a
different lock and the drain would silently do nothing. If it sees a stale
global lock, `acquireModelLocks` calls `forceRelease(expectedNonce)` to clear
it. Without that, the post-acquire TOCTOU re-check would find the same stale
lock on every pass and recurse forever.

Workflow commands (`workflow run`, `workflow resume`) and serve-hosted workflow
runs do not lock up front. A `StepLockHook` callback injected into the
workflow engine takes per-model locks per step. Each model method step takes its
lock before running and releases it in a finally block afterwards. This avoids
deadlock when a model method starts a subprocess `swamp model method run` on a
model the parent workflow would otherwise hold.

Parallel steps on different models lock independently. Parallel steps on the
same model serialize at the lock, which is correct since concurrent writes to
one model are unsafe. The coordinator gives each acquisition a unique key (with
a random ID suffix), so parallel steps on the same model do not overwrite each
other's entries.

Because per-model lock keys are namespace-scoped, `waitForPerModelLocks` uses
`stripNamespacePrefix` to match locks in the repo's namespace. The walk starts
at the datastore root and sees other namespaces' locks, but the prefix check
filters them out, so only this namespace's per-model locks are drained.

#### Symmetric Drain (structural commands)

Structural commands (`requireInitializedRepo`) take the global lock with a
**symmetric drain**: `waitForPerModelLocks` runs once before and once after
acquiring it.

1. **First drain (pre-acquire).** Wait for per-model locks visible at command
   start to be released. A writer past its own TOCTOU recheck (in
   `acquireModelLocks`) is committed to writing and must be allowed to finish.
2. **Acquire global lock.** From here, any writer that runs `inspect()` on the
   global lock sees it held and backs off.
3. **Second drain (post-acquire).** Wait for per-model locks that slipped past
   the first drain: writers that inspected the global lock between the first
   drain and the acquire, saw it free, and took a per-model lock.

The second drain closes the TOCTOU window on the other side. Without it, a
writer can:

1. Inspect global → not held (deleter has not yet acquired)
2. Take per-model lock
3. Pass its TOCTOU recheck → not held (deleter still has not acquired)
4. Begin writing a new version directory

…while the deleter finishes its first drain, takes the global lock, and runs
`Deno.remove(dataNameDir, { recursive: true })`. The recursive remove races the
writer's new version subdirectory and fails with ENOTEMPTY (Linux:
`os error 39`, macOS: `os error 66`), as in swamp-club#234.

The second drain sees the writer's per-model lock and waits until the writer
commits or releases on its own recheck before structural work starts. The
writer's recheck runs right after it takes the per-model lock, before any
data I/O, so no window remains for it to write unseen by the second drain.

> **Maintainer note.** Both drain calls are required. The two sites cite each
> other (`src/cli/repo_context.ts:requireInitializedRepo` ↔ this section) so
> anyone removing one wait sees the contract first. If
> you change this lifecycle, update both.

Caveat: `waitForPerModelLocks` scans only the local filesystem. Custom (S3,
distributed) datastores rely on their own `DistributedLock` semantics instead.

#### Parent-Process Lock Awareness

`acquireModelLocks` sets `SWAMP_LOCK_HOLDER_PID` to the current process PID when
it takes per-model locks. `waitForPerModelLocks` skips any lock file whose `pid`
matches. Those locks belong to the parent, and waiting on them would deadlock:
the parent waits on the child, the child on the parent's locks.

This happens when a workflow shell step runs a nested `swamp` command (e.g.
`swamp extension push`). The child inherits the env var and does not poll its
parent's locks. The parent clears the variable when it flushes its locks.

A SIGINT handler makes a best effort to release locks on Ctrl-C. If the process
crashes without releasing, the lock expires after the TTL (30 seconds by
default).

### Lock Breakglass

Two CLI commands inspect and force-release stuck locks:

```bash
swamp datastore lock status                          # Show who holds the lock
swamp datastore lock release --force                 # Delete the global lock directly
swamp datastore lock release --force --model type/id # Release one per-model lock
```

`--force` is required. Release bypasses `acquire()`/`release()` and deletes the
lock directly, for when a crashed process left a lock that has not expired.

### Other maintenance commands

- `swamp datastore type search`: search the registry for datastore extension
  types (`src/cli/commands/datastore_type_search.ts`).
- `swamp datastore compact`: checkpoint the WAL and vacuum `_catalog.db`
  (`datastore_compact.ts`).
- `swamp datastore config migrate`: copy definitions, vault configs, the
  extension lockfile and pulled extensions into the datastore `config/` tier and
  set `managedConfig: true` (`datastore_config_migrate.ts`). That flag alone
  activates managed config: whenever it is true, `resolveManagedConfigPaths`
  (`src/cli/repo_context.ts`) points the pulled-extensions root and lockfile at
  the datastore-resolved config path. For custom datastores (S3, GCS),
  `ensureManagedConfigBase` resolves the datastore config to derive the
  cache-relative config path. Extension commands call it before
  `resolveManagedConfigPaths` so the module-level registry is filled correctly.
- `swamp doctor datastores [--repair [-y]]`: health check with optional repair
  of catalog completeness, unmigrated root-level data, and foreign namespace
  contamination (the last via the optional `repairNamespaceContamination?()` on
  `DatastoreSyncService`) (`src/cli/commands/doctor_datastores.ts`).

## Setup and Migration

### Initial Setup

`swamp repo init` creates a default filesystem datastore at `.swamp/`. For
another backend, run `swamp datastore setup` after init:

```bash
swamp datastore setup filesystem --path /mnt/shared/swamp-data
swamp datastore setup extension @swamp/s3-datastore \
  --config '{"bucket":"my-bucket","prefix":"my-project","region":"us-east-1"}'
```

Each setup command (`src/libswamp/datastores/setup.ts`):

1. Checks the target is accessible (writable directory or reachable S3 bucket).
2. Migrates existing runtime data from `.swamp/` to the new location (skipped
   with `--skip-migration`).
3. Pushes migrated data to the remote (extension datastores; skipped with
   `--skip-migration` or when there is nothing to push).
4. Hydrates the local cache from the remote (extension datastores only).
   Runs regardless of `--skip-migration`, but only if no earlier step
   reported an error.
5. Persists and cleans up, in an order that depends on the backend:
   - **extension**: removes migrated directories from `.swamp/`, only if no step
     reported an error. It then updates `.swamp.yaml` if there were no errors,
     or only timeouts (see below). Last, it registers the namespace manifest via
     `provider.registerNamespace` if `--namespace` was given.
   - **filesystem**: updates `.swamp.yaml`, then removes migrated directories.
     A crash in between leaves harmless orphaned source data, not a repo
     pointing at a cleaned-up datastore.

`setup extension` also takes `--namespace <slug>` and
`--hydration-strategy full|lazy`, both saved in the datastore block.

`--skip-migration` controls steps 2 and 3 (moving existing `.swamp/` data and
pushing it to the remote). It does not skip step 4 (hydration). A contributor
joining a shared datastore that already has data needs hydration even with
nothing local to migrate. Without it the cache stays empty and reads return
nothing until a manual `swamp datastore sync --pull`.

**Hydration invariant.** After `swamp datastore setup extension` succeeds with
no errors, the local cache holds every entry in the remote
`.datastore-index.json` at setup time. Datastore-tier repositories then read
consistent data without a prior `swamp datastore sync --pull`.

### Partial Failure and Retry

If `swamp datastore setup extension` fails partway (network blip, auth error,
Ctrl-C, transient 5xx), the repo stays safe and resumable:

- `.swamp.yaml` is not updated, so the repo stays filesystem-typed. If the
  only errors were sync timeouts, the type is written so the user can
  resume with `swamp datastore sync --push --timeout <big>` (see
  [Sync Timeout](#sync-timeout)).
- `.swamp/` data is not cleaned up; it stays intact for a retry.
- Objects already pushed are harmless: S3 PutObject is idempotent, so the next
  push overwrites them with identical content.

**To retry:** re-run the same `swamp datastore setup extension` command (or,
after a timeout-only failure, `swamp datastore sync --push`).

### Directory Relocation

Enabling a datastore on a repo with the default filesystem layout moves the
runtime directories (`data`, `outputs`, `workflow-runs` and the rest of
`DEFAULT_DATASTORE_SUBDIRS`) from `{repoDir}/.swamp/` to the datastore path. For
extension datastores that is the local cache (`~/.swamp/repos/{repoId}/`), not
the remote. Setup prints what moved and where:

```
Relocated: data, outputs, workflow-runs now resolve under /new/path
  Moved from: /repo/.swamp
```

After setup, `DefaultDatastorePathResolver.resolvePath()` routes these
subdirectories to the new location. Code that hardcodes `.swamp/workflow-runs/`
or similar paths silently breaks. Use `swamp workflow run search --json`,
`swamp data get` or other CLI commands instead of direct filesystem access.

The migration copies files to the cache (overwriting any partial cache from an
earlier attempt), pushes to the remote (idempotent), and pulls from it. Only
then does it clean up `.swamp/` and update `.swamp.yaml`, in that order for
extension datastores (see [Initial Setup](#initial-setup)).

`swamp datastore setup filesystem` is the same: the config update waits for a
successful migration, so a partial copy leaves `.swamp.yaml` unchanged and a
retry is safe.

If setup finishes with errors, the CLI prints a retry hint so the user knows
re-running is safe.

### Migrating Between Backends

Run `swamp datastore setup` again with the new backend type. It migrates data
from the current location to the new one.

When switching **from a remote/sync-based datastore to filesystem**, the CLI
resolves the old datastore's local cache path (`~/.swamp/repos/{repoId}/`) and
passes it to `datastoreSetupFilesystem` as `outgoingCachePath`. Content is
copied from the cache, not from `{repoDir}/.swamp`, which is empty for remote
datastores. If the cache path is missing or unresolvable (e.g. the old
extension was uninstalled), setup falls back to `{repoDir}/.swamp` and logs a
warning.

Run `swamp datastore sync --pull` first so the cache is up to date before
switching.

### Health Verification

The per-command entry points only do a light accessibility check
(`src/cli/repo_context.ts`):

- **Filesystem**: `requireInitializedRepo()` and
  `requireInitializedRepoReadOnly()` `Deno.stat` the path and fail only if it
  exists and is not a directory. A missing directory is allowed; it is created on
  first write. Writability is not tested.
- **Extension datastores**: the write path creates the cache directory if needed
  and creates the sync service. The read-only path does the same with no lock
  and no health check. Neither calls `createVerifier()`.

Full health checks (`DatastoreVerifier.verify()` from `createVerifier()`, or
`filesystem_datastore_verifier.ts`) run in `swamp datastore status`,
`swamp datastore setup`, `swamp doctor datastores`, and at `swamp serve`
startup. `swamp datastore status` shows config, health, latency, directories and
exclude patterns.

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
| `src/domain/datastore/datastore_types.ts` | Datastore type name parsing/validation |
| `src/infrastructure/persistence/namespace_manifest.ts` | `.namespace.json` read/write for filesystem datastores |
| `src/infrastructure/persistence/sync_error_diagnostic.ts` | Turns sync failures into user-facing summaries |
| `src/infrastructure/persistence/lockfile_repository.ts` | Extension lockfile persistence (local or managed-config tier) |
| `src/domain/extensions/bundle_freshness.ts` | Content-fingerprint bundle invalidation |

### Infrastructure Layer

| File | Purpose |
|------|---------|
| `src/infrastructure/persistence/default_datastore_path_resolver.ts` | Path resolver with compiled patterns |
| `src/infrastructure/persistence/filesystem_datastore_verifier.ts` | Filesystem health check |
| `src/infrastructure/persistence/datastore_sync_coordinator.ts` | Global sync lifecycle (lock + pull/push) |
| `src/infrastructure/persistence/file_lock.ts` | File-based distributed lock (advisory lockfile) |

### Application Layer (libswamp)

`src/libswamp/datastores/` has one generator per command: `setup.ts`,
`status.ts`, `sync.ts`, `lock.ts`, `compact.ts`, `migrate_index.ts`,
`type_search.ts`, `namespace_set.ts`, `namespace_unset.ts`,
`namespace_migrate.ts`, `namespace_list.ts`, `doctor_datastores.ts`.

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
| `src/cli/commands/datastore_namespace.ts` | `swamp datastore namespace set/unset/migrate` |
| `src/cli/commands/datastore_namespaces.ts` | `swamp datastore namespace list` |
| `src/cli/commands/datastore_catalog_pull.ts` | `swamp datastore catalog pull` |
| `src/cli/commands/datastore_compact.ts` | `swamp datastore compact` |
| `src/cli/commands/datastore_migrate_index.ts` | `swamp datastore migrate-index` |
| `src/cli/commands/datastore_type_search.ts` | `swamp datastore type search` |
| `src/cli/commands/datastore_config_migrate.ts` | `swamp datastore config migrate` |
| `src/cli/commands/doctor_datastores.ts` | `swamp doctor datastores` |
| `src/presentation/renderers/datastore_status.ts` | `swamp datastore status` rendering |
| `src/presentation/renderers/datastore_sync.ts` | `swamp datastore sync` rendering |
| `src/presentation/renderers/datastore_lock.ts` | `swamp datastore lock` rendering |
| `src/presentation/renderers/datastore_setup.ts` | `swamp datastore setup` rendering |
| `src/presentation/renderers/datastore_compact.ts` | `swamp datastore compact` rendering |
| `src/presentation/renderers/datastore_migrate_index.ts` | `swamp datastore migrate-index` rendering |
| `src/presentation/renderers/datastore_namespace_set.ts` | `swamp datastore namespace set` rendering |
| `src/presentation/renderers/datastore_namespace_unset.ts` | `swamp datastore namespace unset` rendering |
| `src/presentation/renderers/datastore_namespace_migrate.ts` | `swamp datastore namespace migrate` rendering |
| `src/presentation/renderers/datastore_namespace_list.ts` | `swamp datastore namespace list` rendering |

## Managed Config Deployment Architecture

With `managedConfig: true` in `.swamp.yaml`, model definitions, workflow
definitions, vault configs, the extension lockfile and pulled extension sources
live in the datastore's `config/` tier instead of the repo's top-level
directories. This allows stateless pod deployments, with the datastore (e.g.
S3) as the only source of truth for configuration.

### Where mutations write

Every CLI command and serve handler that changes config-tier files writes to the
`config/` subdirectory resolved by `DatastorePathResolver`, then pushes to the
remote with `pushManagedConfigChanges` (`src/cli/managed_config_sync.ts`):

| Mutation type | Config-tier path | CLI push | Serve push |
|---------------|-----------------|----------|------------|
| Model definition create/edit | `config/models/` | `pushManagedConfigChanges` | `ctx.syncService.pushChanged` |
| Workflow definition create/edit | `config/workflows/` | `pushManagedConfigChanges` | `ctx.syncService.pushChanged` |
| Vault config create/migrate | `config/vaults/` | `pushManagedConfigChanges` | `ctx.syncService.pushChanged` after marking the config file (and, for migrate, the old one) |
| Extension pull/install/rm/update | `config/pulled-extensions/`, `config/upstream_extensions.json` | `pushManagedConfigChangesDeferred` | `ctx.syncService.pushChanged` after marking the lockfile; serve still writes sources outside the tier (swamp-club#2429) |
| Auto-definitions (direct type execution) | `.swamp/auto-definitions/` (datastore subdir, not config tier) | Via flush coordinator | Via per-model lock flush |

Auto-definitions are a normal datastore subdirectory
(`DEFAULT_DATASTORE_SUBDIRS` includes `auto-definitions`). They sync through the
usual write-command lifecycle (pull on lock acquire, push on flush), not the
config-tier push.

### Extension commands and the chicken-and-egg

Extension commands (`pull`, `install`, `rm`, `update`) use the lightweight
`requireRepoMarker` initialization instead of `requireInitializedRepoUnlocked`.
This avoids a circular failure when the datastore extension itself is being
pulled or updated (see #445). After the change,
`pushManagedConfigChangesDeferred` resolves the datastore and creates a sync
service for the push. This is safe because `config migrate` needs a working
datastore, so `managedConfig: true` implies the datastore extension is
installed.

### Pod boot sequence under managed config

Recommended init container sequence for a stateless pod:

1. **Create `.swamp.yaml`**: copy in the marker file with the datastore config
   and `managedConfig: true`.
2. **`swamp datastore setup extension`**: configure the datastore backend.
3. **`swamp datastore sync --pull`**: hydrate the local cache from the remote,
   including `config/` (definitions, pulled extensions, lockfile).
4. **`swamp datastore config migrate`**: idempotent. First boot copies local
   config into the datastore tier and pushes; later boots the sentinel skips the
   copy.
5. **`swamp extension install`**: restore pulled extensions whose source files
   are missing from the hydrated cache. It writes to the config tier and pushes
   to the remote.

Step 5 (`extension install`) must run so pulled extension sources
are complete. The remote `config/pulled-extensions/` tree may be incomplete if
the first `config migrate` ran before extensions were installed.

### Recovery from missing-extensions state

When a pod boots and logs "N pulled extension(s) have missing source files":

1. **From an operator machine with datastore access:**
   ```bash
   swamp extension install --repo-dir /path/to/repo
   ```
   This restores source files and pushes them to the remote. The next pod boot
   pulls the complete tree.

2. **Via the serve API (with `--hot-reload` enabled):**
   ```bash
   swamp extension install --server https://pod-url
   swamp serve reload --server https://pod-url
   ```
   The serve handler installs and pushes to the remote. `serve reload`
   re-bundles the updated extensions. Without `--hot-reload` the reload step
   fails and the pod must be restarted.

### Extension auto-reload via config poller

With `managedConfig`, the config poller pulls `config/pulled-extensions/`
separately from the rest of `config/` and calls `performServeReload` only when
extension files changed. Definition-only changes (model, vault or workflow YAML
edits) invalidate catalogs without reloading extension registries. Extensions
that arrive after boot (from another instance's `extension install --server` or
`extension pull`) are found and loaded without a restart or manual SIGHUP.
`--hot-reload` is still useful for trigger overrides and workflow reloading via
`swamp serve reload`, but extension registration no longer needs it.
