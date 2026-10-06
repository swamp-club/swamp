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
brief S3 failure does not kill a run. Managed-config writes are the exception:
any failed push exits non-zero (see "Where mutations write").

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
  pulled in a later phase. Because each catalog only sees its own repo's
  writes, see "Catalog freshness" below for how catalogs on a shared
  filesystem datastore notice each other's.
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

- **ConfigPoller** refreshes managed configuration. It pulls `config/` and
  invalidates catalogs when the pull changed anything, then reloads the
  extension registry when the config-tier lockfile's content hash changes. See
  "Extension auto-reload via config poller" below. It runs whenever
  managedConfig is active, and without a sync service it checks only the hash.
- **AccessDataPoller** (`subdirs: ["data/swamp/grant", ...]`) refreshes
  access-control grants and groups, then reloads the policy snapshot.
- **RuntimeDataPoller** (`subdirs: ["data", "auto-definitions"]`) refreshes the
  `data/` subtree (runtime model output), then invalidates the query catalog so
  the next `data.query` rebuilds from the new local files. It pulls
  `auto-definitions/` in the same pull, because a definition a peer creates
  while serve is running is looked up in the local cache: token authentication
  resolves a server token's definition by name on every connection, and worker
  enrollment runs the enrollment token's definition. Without it a token minted
  on one instance was rejected by its peers until they restarted
  (swamp-club#2481).

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
AccessDataPoller, and to a newly minted token being accepted by a peer: until
the peer's next pull, it rejects the token as unknown. The query catalog is
invalidated only after a successful pull that reports changes, so quiet cycles
keep fast cached reads.

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

**`controlPlane`**: when `true`, the sync service exposes `controlPlaneStore()`
for small records read and written in the datastore directly. A workflow that
contains a `wait_for_signal` step runs on a custom datastore only when this is
advertised and the store implements `putIfAbsent`, since the wait's records must
be visible to every host at once. `assertControlPlaneStoreConformance` in
`@swamp-club/swamp-testing` checks a store against that contract.

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
succeeds on both scoped and full paths, unless it resolved to `0`. It is
returned in `{ flush, synced }` and checked at every call site in `src/cli` and
`src/serve` (21 at last count) to trigger `catalogStore.invalidate()`. It must
never be skipped or moved.

A pull that resolves to `0` changed nothing in the local cache, so the catalog
is still accurate. Skipping the invalidation then avoids a full catalog
backfill, which on a large repo would otherwise run while the per-model lock is
held (swamp-club#2553). That makes the `pullChanged` return value part of the
sync contract: the number of local cache files written or removed, `0` only
when nothing changed, and `void` when unknown (treated as changed). The S3 and
GCS extensions return the downloaded count, and neither removes local files
during a pull.

**Catalog freshness.** An invalidated catalog keeps its rows, because a full
backfill is additive (swamp-club#1581), so three rules keep reads current:

- `CatalogStore.invalidate()` advances a `generation` counter in
  `catalog_meta`. A backfill reads the generation before walking the disk and
  marks the catalog populated only if it is unchanged, so a backfill that
  overlapped an invalidation cannot mark stale rows fresh.
- While the catalog is unpopulated, `DataQueryService.getLatestRecord` compares
  a known row with the on-disk `latest` marker and, if the marker names another
  version, upserts that version and returns it. Without this, a row whose
  content still exists after a pull kept answering with the old version.
  Foreign-namespace rows are never refreshed this way.
- A filesystem datastore has no sync service, so nothing invalidates after a
  peer writes. When its data lives outside the repo's `.swamp/` (a shared
  directory), `createCatalogStore` attaches a `SharedDatastoreWriteTracker`.
  Each catalog rewrites its own token in `.catalog-writers/` at the datastore
  tier root after every data write, and `isPopulated()` invalidates when
  another writer's token changed (swamp-club#2858). The tokens are plain files,
  not SQLite, because WAL is unsafe on network filesystems. A backfill never
  writes a token, so two catalogs cannot invalidate each other in a loop.
  Token I/O is best-effort: a token that cannot be written is logged and the
  data write still succeeds, and tokens that cannot be read are logged and
  treated as a foreign write. A recreated catalog (deleted `_catalog.db`, or a
  schema-version bump) gets a new writer id and leaves its old token behind;
  old tokens never change, so they cost one read each but never invalidate,
  and the directory grows only with catalog recreations.

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

`assertSyncServiceRoundTripConformance` in `@swamp-club/swamp-testing` holds
every `DatastoreSyncService` adapter to this contract, delete propagation and
two-phase push semantics, by syncing two caches over one backend. The suite is
experimental: like `createInMemoryRemote`, its defaults follow what the S3 and
GCS datastore extensions do today and may change as those extensions change.

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

**Unit of work (datastore rework Phase 1).** `UnitOfWork`
(`src/domain/datastore/unit_of_work.ts`) is the seam later phases build on.
Repositories stage each change (`write` or `remove` with an absolute path, or
`bulk`) before writing, and a use case commits the unit once the operation is
done. The legacy adapter (`src/infrastructure/persistence/legacy_unit_of_work.ts`)
forwards each staged change to the dirty hook straight away, `markDirty(path)`
for a write or remove and `markDirty()` for bulk. It keeps the pre-write timing
and the order of bulk and per-path signals, and never batches or deduplicates.
`commit` waits for any stage still in flight, runs once, and spends the unit
even when it fails.

Repositories route their signal through `signalChange`
(`src/infrastructure/persistence/unit_of_work_scope.ts`). The data and output
repositories (swamp-club#2979), the definition, workflow, evaluated definition
and evaluated workflow repositories (swamp-club#2980), the workflow run
repository (swamp-club#2992) and the vault config repository (swamp-club#2995)
stage a typed change at each call site: `write`
for a path that exists after the operation, `remove` for one that is gone after
it. A definition or workflow `delete` that leaves its resolved path in place,
because that file declares another entity sharing the id, stages a `write` of
it. No repository has a private `notifyDirty` now. The legacy adapter forwards
`write` and `remove` the same way, so the marks sent do not depend on the kind.

A change is staged before its write, so its kind is the intended effect: a
`remove` whose removal then fails (EACCES, say) names a file still on disk.
That is harmless while the legacy adapter turns every kind into the same mark.
When Phase 2 gives `remove` its own meaning, a use case must not commit a unit
of work whose operation failed.

When an operation runs inside `runInUnitOfWork`, the
repository stages the change into that ambient unit of work, but only when the
unit is a legacy adapter over the repository's own hook instance. A unit belongs
to one repository context, so a second context in the same process (side-by-side
repos, namespace migration) never hands it its changes. Otherwise the repository
calls its hook as before, and with no hook (filesystem datastores) it does
nothing. The scope is an `AsyncLocalStorage` store, so concurrent operations
each see their own unit, and a promise started inside a scope keeps it after the
scope returns. A write that lands after its unit committed is rejected. No
production code opens a scope yet (pinned empty in
`integration/datastore_write_seams_rules_test.ts`): the flush paths still push,
and behaviour is unchanged. Phase 2 opens scopes from use cases.

**End of Phase 1 (swamp-club#2996).** Every hooked datastore-tier repository
stages typed changes through `signalChange`. Two rules in
`integration/datastore_write_seams_rules_test.ts` hold this: inside the
datastore-tier repository classes the hook field appears only as the first
argument of `signalChange`, and under `src/infrastructure/persistence/` only
`legacy_unit_of_work.ts` and `unit_of_work_scope.ts` call a mark hook. The
first rule scans only the classes in `DATASTORE_TIER_REPOSITORIES`, so a new
hooked repository must be added to that list. At the end of Phase 1 writes
still marked through `signalChange`'s hook fallback, because nothing opened a
scope. Phase 2 removes that fallback once every write path runs inside a scope;
see route-2 reporting below.

**Phase 2: use cases own the unit of work (swamp-club#3025).** Every libswamp
use case that writes through a datastore-tier repository runs its whole
operation inside a unit of work:

- `LibSwampContext.openUnitOfWork()` opens one per operation. Children from
  `withTimeout` and `withSignal` keep the factory. A context built without one
  opens an unbound unit, which no repository stages into.
- `withUnitOfWork` (`src/libswamp/unit_of_work.ts`) opens a scope around each
  use case. It runs each step of the use case's stream inside the unit and
  commits once after a `completed` stream finishes. Every other ending calls
  `abandon` once: the stream yields `error`, throws, ends on another terminal
  (`workflowRun` ends `suspended` or `cancelled`), or the consumer stops early.
  `result()` stops at `completed`, so most use cases end through abandon even
  when they succeed. For legacy units the ending does not change what is
  pushed, because the root decides. A Phase 3 unit that discards on abandon
  must treat `completed` followed by `return()` as success, and decide what to
  commit on `suspended` and `cancelled`.
- `abandon` is on the port (swamp-club#3032): the operation ended without
  completing, and the staged changes are not committed. It spends the unit like
  `commit`. A legacy unit's changes have already reached the hook and today's
  paths push them on failure too, so a legacy unit with a flush also flushes on
  abandon. A Phase 3 commit-log unit discards instead; the difference is
  deliberate. A change staged after a unit ended goes to its nearest open
  ancestor, or follows `afterCommit`; an abandoned unit no longer collects work
  that outlives its stream (a detached nested run).
- **Root and child units (swamp-club#3032).** `runInRootUnitOfWork`
  (`src/infrastructure/persistence/repo_unit_of_work.ts`) runs one command or
  request in a root unit over `repoContext.markDirty` with the push as its
  flush. It always ends the root: `commit` when the work resolved, `abandon`
  when it threw, so a legacy root pushes once on every outcome, as the CLI and
  serve do today. If the work threw and the push failed too, the work's error
  is rethrown and the push error goes to `onFlushError` or a warn log; if only
  the push failed, its error is thrown. A unit opened while a unit for the same
  hook is ambient is a child: it forwards each change to the hook at once,
  records it in itself and every open ancestor, and its `commit` and `abandon`
  never flush. Nested use cases roll up the same way. A nested
  `runInRootUnitOfWork` opens a child when it is given no push, and throws
  when it is given one, so a push is never dropped silently. Composition
  code stages its hand marks through the root: `root.stage({ kind: "bulk" })`
  replaces a bare mark, and `root.stage({ kind: "write" | "remove", path })` a
  per-path mark, each forwarded as the identical hook call. swamp-club#3034
  adopts it for serve.
- **Root checkpoints (swamp-club#3053).** A root can push partway through:
  `runInRootUnitOfWork` takes a `checkpoint` option, the mid-operation push
  the caller makes, and `root.checkpoint()` waits for every mark the root and
  its children sent before the call, then runs it. The root stays open and
  still flushes once when it ends. A root opened without the option throws,
  as does a nested call's child (the outer root owns the checkpoint) and a
  nested call given its own checkpoint, so a checkpoint is never dropped. A
  failing checkpoint rejects inside the work, as a direct push did.
  `checkpoint` lives on `RootUnitOfWork` and the legacy adapter, not on the
  domain `UnitOfWork` port: what a Phase 3 commit-log unit means by a partial
  commit is a Phase 3 decision.
- **CLI commands in root units (swamp-club#3033).** Every CLI write command
  runs its write section in `runCommandInRootUnit`
  (`src/cli/command_root_unit.ts`), whose flush is the push the command made
  before, at the same point:
  - Model-lock commands split `ModelLockResult.flush()` into `push()` and
    `release()`. `push` is the root's flush, and `release` runs after the root
    has ended, so the locks are released after the push, as before. `flush()`
    is still push-then-release for per-step locks inside a workflow run, its
    one remaining caller (swamp-club#3055).
  - Commands that pushed only once their mutation completed (the
    managed-config commands through `runManagedConfigMutation`, worker prune,
    datastore config migrate) pass `pushWhen: "completed"`, which
    `runInRootUnitOfWork` applies (swamp-club#3055), so a failed command
    still pushes nothing.
  - A push or release failure reaches the handler the command used before:
    the release error replaces the push error, as a `finally` did, and neither
    hides the command's own error.
  - Former bare marks are `root.stage({ kind: "bulk", reason })`. Access token
    mint and worker token create and revoke also push mid-command (mint and
    create then read the token back). That push is the root's checkpoint
    (`runCommandInRootUnit`'s `checkpoint` option, swamp-club#3053), pinned
    in `PINNED_CHECKPOINT_CALLS`, and the root still makes the end-of-command
    lock push.
  - Commands on the global lock run in a root since swamp-club#3055; see
    "One flush path" below.
  - The use-case sync characterization switches on `rootUnit` for these rows,
    checking that the root staged every mark and that pushes keep their place
    relative to lock release (`syncOrder`, recorded before the change).
    `PINNED_CLI_ROOT_UNIT_COMMANDS` and `PINNED_LOCK_FLUSH_CALLERS` list the
    commands with a root and the callers of the combined flush.
- **Serve roots (swamp-club#3034).** Each serve handler that pushes through
  `pushChangedToRemote` after its work, on every outcome, runs that work in a
  root whose flush is `pushChangedToRemote(ctx)`. The root opens where the
  handler's `try` began, inside its sync gate, so a refused request still pushes
  nothing and every reply keeps its place relative to the push.
  `cancelLocatedRunAndPush` (`src/serve/suspended_run_cancel.ts`) does the same.
  `executeWorkflowWithLocks` (`src/serve/deps.ts`) runs each workflow run from
  the `workflow.run` handler, webhooks and the scheduler in a root whose flush
  is the post-run push under the gate's shared mode. Each step's model lock
  still pushes on its own when the step releases it. A run's root stays open for
  the whole run, so every change its steps stage is held in the root's
  `staged()` list until the run ends. Each entry is a path, so this costs little
  today, but a Phase 3 unit that keeps payloads in that list must bound or spill
  it for long runs. The device auth mint, grant publishing and `access.reload`
  stage their per-path re-marks through `stageWritesThenPush`
  (`src/serve/stage_writes_then_push.ts`), a root that covers only the marks and
  the push, as a failed write pushed nothing before. It pushes only once every
  mark was staged (`pushWhen: "completed"`), because a legacy root also flushes
  on abandon.
- **Serve success-only, method run and resume roots (swamp-club#3035).** The
  handlers that push only after a successful reply (model, vault and workflow
  create, edit and delete, and `vault.migrate`) run their work in a root whose
  flush pushes only once that reply was sent. A root always commits there,
  because those handlers answer their own failures, so the flush checks the
  reply rather than the outcome. `model.method.run` runs the run in a root
  whose flush is its push under the gate's shared mode, once the run completed
  (a use case that reports an error still completes). A run that took model
  locks pushes them as the root's flush instead, on every outcome, and releases
  them after the root (swamp-club#3055). `workflow.resume` and the detached
  resume (`startDetachedResume`, `src/serve/resume_launcher.ts`) push on every
  outcome as their root's flush.
  The detached resume's root ends after its terminal frame; its cleanup and
  the parent's auto-resume run after that, so the parent's resume opens a root
  of its own rather than one nested in the child's, which would throw. If its
  root cannot open, it still ends its stream with an error frame.
- **One flush path (swamp-club#3055).** Every production push is a root's
  flush or checkpoint, or a pinned deliberate exception:
  - `runInRootUnitOfWork` hands its flush the outcome (`{ completed }`) and
    takes `pushWhen: "always" | "completed"`, the one "push only on success"
    option; the CLI's root, `stageWritesThenPush` and the serve method-run
    handlers use it instead of their own flags.
  - Serve `model.method.run` makes the model lock's push its root's flush on
    every outcome and releases the lock after the root. The reply, telemetry,
    cancel or run deregistration and stream terminal keep their place: before
    a lock's push, and around the no-lock push as before.
  - The CLI commands that pushed only at the `flushDatastoreSync()` teardown
    (workflow delete, data gc, data prune, run gc, the `--all` evaluates,
    model validate with check options, datastore compact) run in
    `runInCoordinatorRoot` (`src/cli/coordinator_root.ts`), whose flush is
    the global lock's coordinator push (`pushGlobalLockAtEnd`). As at
    teardown, a push timeout is thrown after a completed command and dropped
    after a failed one. `workflow evaluate` with dynamic model references
    gives that push to the root it already opens, since a second root would
    nest. The teardown stays as a safety net and finds nothing left to flush.
  - Per-step model locks inside a workflow run keep `ModelLockResult.flush()`
    (push, then release): the step's lock owns its push and release, and Phase
    3 replaces model locks with leases.
  - The push functions live in `src/infrastructure/persistence/push_paths.ts`
    (`pushNamespace`, `pushModelLockScope`, `pushGlobalLockAtEnd`); commands
    and handlers pass them as a flush or checkpoint and never call
    `pushChanged` themselves. `PINNED_DIRECT_PUSHES`
    (`integration/datastore_write_seams_rules_test.ts`) lists every production
    `pushChanged` call: the push paths, the coordinator, and the deliberate
    exceptions (`datastore sync`, `datastore setup`'s migration push, the
    lockfile publish, serve start-up and token GC, serve background GC). In
    serve, a push-path call outside a root's flush is pinned in
    `integration/serve_root_unit_rules_test.ts`; `pushChangedToRemote`, the
    push path the handlers' flushes call, is the only one.
- **Route-2 reporting (swamp-club#3056).** `signalChange`'s hook fallback
  (route 2: a hooked write with no unit bound to its hook ambient) still marks
  exactly as before, then reports the write. The report runs after the mark,
  so it can never stop one.
  - In production it logs a warning under `["datastore", "unit-of-work"]`,
    once per call site per process, naming the change and the first stack
    frame outside `src/infrastructure/persistence/`. The stack is captured
    only on route 2.
  - Tests replace the warning through `useUnscopedChangeReporterForTesting`,
    which only tests may call. `withUnscopedWriteGuard`
    (`integration/unscoped_write_guard.ts`) fails a test when production
    code (`src/`, not a test file) writes on route 2, even when the code
    catches the error and only logs it. Writes made from test code are
    ignored. The guard wraps every `withRowRepos` test and `captureUnits`
    run (the use-case characterization, root-unit harness, remote failure,
    serve root-unit and CLI root-unit tests), and the peer propagation and
    dirty coverage harnesses.
  - `PINNED_UNSCOPED_WRITERS` in the guard module lists the production
    callers still allowed on route 2, each with a reason. It is empty: every
    route-2 caller found runs in a root. The pushing ones make their push the
    root's flush: serve bookkeeping GC and server-token GC. The rest run in a
    root with no flush, which forwards each mark to the hook at once and
    pushes nothing, as before: the device-auth mint, `access.reload` and the
    grant commit (their writes, before the root `stageWritesThenPush` already
    opens for the push), serve boot reconciliation and its continuous tick,
    serve shutdown's run interrupts, the OAuth collective refresh's token
    updates and revokes, `model.validate` (whose model checks receive the
    hooked repositories), `run.doctor`'s fix, worker data-plane writes and
    capability deletes, and the CLI's
    `workflow cancel`, `workflow recover`, `model cancel` and `run doctor`.
  - Hand marks never pass through `signalChange` and are not reported; they
    stay pinned in `PINNED_MARK_CALL_SITES`.
  - Route 2 is removed in a follow-up once nothing reports: no route-2
    warnings in dogfooding, or in the swamp-uat datastore and serve suites run
    against a release that contains this change, and
    `PINNED_UNSCOPED_WRITERS` still empty.
- The CLI (`libSwampContextForRepo` in `src/cli/repo_context.ts`) and serve
  (`handlerLibSwampContext` in `src/serve/handlers/shared.ts`) bind each unit to
  `repoContext.markDirty` itself, through `repoUnitOfWorkFactory`
  (`src/infrastructure/persistence/repo_unit_of_work.ts`). A unit over any other
  function would collect nothing.
- Commit pushes nothing yet: every production unit has no flush, so marks
  reach the sync service as before and the four flush paths keep pushing.
  Production units forward a change staged after commit to the hook
  (`afterCommit: "forward"`), so a write that escapes its use case never fails
  a command. Tests build units with `"reject"` through
  `useUnitOfWorkFactoryForTesting`, and the use-case sync characterization
  checks that each use case's units staged exactly the marks it made.
- `PINNED_TRANSACTIONAL_USE_CASES` lists the wrapped use cases.

Deliberately unbound: commands whose deps build their own unhooked repositories
(`model create`, `workflow create`, `vault create`, `vault migrate` on the CLI),
read-only contexts, and commands with no repository context. Their writes have
no hook to bind to, so nothing changes for them.

What still marks by hand, all owned by Phase 2 (`PINNED_MARK_CALL_SITES` lists
each site):

- `swamp datastore sync`, which owns its pull and push
  (`src/cli/commands/datastore_sync.ts`). The other CLI write commands stage
  their marks through their root unit (swamp-club#3033).
- `pushManagedConfigChanges` (`src/cli/managed_config_sync.ts`), which sends
  a bare mark. No command calls it since swamp-club#3033: the managed-config
  commands stage the bare mark through `runManagedConfigMutation`'s root. The
  per-path `pushManagedConfigPaths` and both deferred variants had no callers
  and were removed.
- Namespace migration: `datastoreNamespaceMigrate`
  (`src/libswamp/datastores/namespace_migrate.ts`) and its CLI deps
  (`buildMigrateDeps` in `src/cli/commands/datastore_namespace.ts`).
- Serve: the extension lockfile (`extensionLockfileTransaction` in
  `src/serve/handlers/admin_handlers.ts`). Device auth, grant tracking and
  access reload stage their marks through a root (swamp-club#3034).
- The serve start-up definition migration, which marks each moved file by path
  (`serveCommand` in `src/cli/commands/serve.ts`).
- The namespace catalog export, marked by path after it is written before a
  push (`writeCatalogExportIfNeeded` in `src/cli/repo_context.ts`).

`buildMarkDirtyHook` in the same file is pinned too, but it is the hook itself,
not a hand mark.

The lockfile is deferred to Phase 2. `ManagedLockfileTransaction` publishes
through the port `createDatastoreLockfileSync` builds
(`src/libswamp/extensions/managed_lockfile_transaction.ts`), whose `publish`
marks the lockfile path as a publish signal and pushes: with `mustUpload` a
push that reports sending nothing rejects, and a failed publish is recorded as
pending and published by the next transaction. swamp-club#2865 has the
reasoning.

**Serve handler obligation.** Serve code never calls a bare `markDirty()`.
Mutations that go through repositories with per-path `markDirty` wired (model,
workflow, data, output, definition and vault config repos) rely on the
repositories' signals. This covers the mutation handlers, the OAuth server-token
mint in `device_auth_handler.ts`, and `access.reload`, which reconciles grant
files through the definition and data repos. `vault.create`, `vault.edit` and
`vault.migrate` write through serve's shared vault config repository
(swamp-club#2995). `vault.migrate` removes the old config through it too, so the
scoped push deletes the remote copy. Otherwise the config poller would bring it
back as a second config with the same name. The per-path signals are enough,
and they drive the extension's scoped walk, which detects deletions by absence
on disk (rule 2). A bare `markDirty()` sets `bulkInvalidated` in the extension
and overrides the per-path signal. That has two costs:

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

- The extension handlers (`extension.install`, `pull`, `rm`, `update`) change
  the config-tier lockfile inside a managed lockfile transaction, which marks
  exactly the lockfile and pushes under the datastore global lock (see
  [Extension commands and the chicken-and-egg](#extension-commands-and-the-chicken-and-egg)). Serve still
  writes extension sources to the repo-local pulled-extensions root
  (swamp-club#2612).
- The serve startup migration moves grant and server-token definitions from
  `models/` to `auto-definitions/` on disk, and marks each moved file.

Without managedConfig, the vault config is repo-local and the hook drops the
vault config repository's mark (rule 5). The extension handlers do not push at
all then, since nothing they write is in the cache. Handlers that never write
into the cache do not push:
`vault.put`, `vault.annotate` and `vault.delete`. Secrets and annotations live
in the always-local `.swamp/secrets`, and vault audit entries go to the
repo-local `.swamp/audit`.

Mark files, not shared directories. A directory mark makes the scoped walk
delete remotely every index entry under it that is missing locally. That
includes files another serve instance pushed that this one has not pulled yet,
and definitions a partial startup pull left missing. A directory mark is safe
only for a tree the mutation itself owns and has just written, such as a data
item's folder.

The CLI extension commands follow the same rule. `extension pull`, `update`,
`rm` and `install`, search install, `repo upgrade` and
`doctor extensions --repair` run their lockfile change in a managed lockfile
transaction, which marks the config-tier lockfile by path and pushes it,
bounded by the datastore's sync timeout, instead of the bulk mark that
`runManagedConfigMutation` stages. It publishes only when the lockfile changed
or an earlier publish is still pending. An extension that keeps its dirty set in
memory still walks the whole cache on a fresh process (rule 4), so "exact
paths" means the marks sent, not the objects the extension compares. The
lockfile is uploaded either way.

`integration/datastore_sync_rules_test.ts` enforces this at build time:

- Repositories that stage typed changes must give every `bulk` change a
  non-empty reason, and their bulk changes are pinned (none today). A guard
  pins the `notifyDirty` definitions under `src/infrastructure/persistence/`
  to an empty list, so no repository goes back to an untyped mark.
- Another rejects any bare `markDirty()` call in `src/serve` and
  `src/cli/commands/serve.ts`. It matches the `.markDirty()` and
  `.markDirty?.()` forms on any receiver, and names the top-level function that
  makes the call.
- A third checks a pinned list of CLI extension writers. None may call
  `pushManagedConfigChanges` or `runManagedConfigMutation` (a bulk mark), or a
  per-path publish helper that skips the fetch, and each must run its change in
  `withManagedLockfileTransaction(createManagedLockfileTransaction(...))`.
  A fourth requires serve's extension handlers to do the same and not push
  after the change (swamp-club#2838).

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
3. **`data get` and `data query` (read-only, no sync)**:
   `UnifiedDataRepository.getContent()` tries to read `raw`. If it is missing
   and a `HydrateFileHook` is wired, it calls the hook to download that file,
   then retries the read. `data query` reaches it through
   `DataQueryService.query()` (see "`getContentSync` limitation" below).

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

- `data_record_mapper.ts` (`fromRow`): loads attributes/content for query
  predicates, `select` projections and results.
- `model_resolver.ts`: resolves CEL expressions during model runs.
- The composite and in-memory repositories, which delegate to it.

The async `DataQueryService.query()`, which backs `data query`, serve's
`data.query` and extension `queryData`, works around it. `fromRow` reports a
needed body that is not on local disk, and `query()` downloads those rows
through the async `getContent()` and matches again, until no row is left
untried (swamp-club#2962). Only own-namespace rows whose body the predicate,
the `select` or the results needed are downloaded, and rows the caller's
`include` filter rejects never are, and a row is downloaded at most once
per query, across serve's `include` batches too. A row whose body is absent
remotely too is returned with empty attributes, as `data get` returns that
item without content. A download error fails the query, as it fails
`data get`; before swamp-club#2962 such a row silently matched as empty.

A downloaded row can stop matching a predicate it matched while empty (for
example `!has(attributes.x)`), so under a limit a later pass can reach rows
an earlier pass never evaluated. Only when a pass after a download reaches
rows not yet tried does `query()` double the limit it collects under, then
one last pass applies the caller's limit. That keeps such predicates to
log(rows / limit) passes, with body reads linear in the rows scanned rather
than one full rescan per limit window. Downloading the bodies of rows that
are only being returned does not change which rows match, so it never widens
the window: a metadata predicate under a limit downloads only the rows it
returns (serve's `include` path matches in batches of four times the limit,
so up to that many). `integration/data_query_get_parity_test.ts` holds
`data query` to `data get` on filesystem, full-hydration and lazy
datastores.

The locked repo contexts wire `hydrateFile` for any custom datastore whose
provider implements it, whatever its `hydrationStrategy`. On such a
datastore, a catalog row whose body is gone locally (deleted, or a write
that never finished; `filterStaleRows` is off) costs one remote lookup per
query that needs its body, where before it matched as empty.

`querySync()`, behind CEL `data.query()`, cannot download. The
`model_resolver.ts` path is safe: model runs go through `acquireModelLocks`
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

A workflow run's claim is a lock of its own:
`{namespace}/workflow-run-claims/{runId}/.lock`, built by `workflowRunLockKey()`
in `lock.ts` and created by `createWorkflowRunLock` in `repo_context.ts`. It
uses the per-model lock's retry settings, since it is held only for one load,
decision and save of the run record (a resume's take-over also restores the
run's sensitive values under it, which can read a vault). The file is named
`.lock`, the one name sync never transfers. The key is outside `data/`, so
`parseModelLockKey` rejects it and the structural commands' drain does not wait
on it, and outside `workflow-runs/`, so the run repository never reads it. See
"Run claims" in `design/primitives/workflows.md` for what takes it.

The writers of one server token share a lock as well:
`{namespace}/server-token-locks/{sha256(name)}/.lock`, built by
`serverTokenLockKey()` and created by `createServerTokenLock`
(`src/infrastructure/persistence/server_token_lock.ts`). The key holds a
digest of the token name rather than the name, because the name arrives from a
client before any definition has validated it. Like the run claim it uses the
per-model retry settings, is named `.lock`, and sits outside `data/`. It is
taken before a per-model lock, never after. See "Tokens" in
`design/primitives/serve.md` for what takes it.

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

**Extension lock timeouts.** Extensions cannot import core's
`LockTimeoutError`, so they throw their own error. The S3 and GCS datastores use
`code: "LOCK_TIMEOUT"`. `datastoreKindAdapter` wraps each extension's
`createProvider`, so every lock its providers create passes through
`withCoreLockErrors` (`distributed_lock.ts`). That translates any rejection
whose `code` is `lock_timeout` in any case into the core `LockTimeoutError`.

As a result, a lock timeout on an extension datastore gets the same treatment
as a filesystem one: exit code 75, `"code": "lock_timeout"` in `--json`
output, no stack trace, and serve's `lock_timeout` client error. The
translation needs `lockKey` and `waitedMs` on the error, and
`assertLockTimeoutConformance` in `@swamp-club/swamp-testing` holds extension
locks to that shape (swamp-club#2553).

**Retry backoff.** `FileLock.acquire` uses jittered exponential backoff. It
starts at `retryIntervalMs` (default 1 second), doubles per attempt up to
`maxBackoffMs` (a `FileLock`-only option, default 8 seconds), and adds ±25%
jitter. Each sleep is clamped to the cap and to the remaining budget, so the loop
never overshoots `maxWaitMs`.

Per-model locks (`createModelLock`) start at 25 ms and cap at 250 ms. A workflow
step holds its model's lock for the whole method run, so concurrent steps
against one instance — `forEach` iterations, for example — queue on it. Under
the 1 second start a waiter slept through a release that came milliseconds
later. Under the 8 second cap the tail of a queue slept for seconds after each
release, so a 13-wide `forEach` of 0.2 s methods took 14 s instead of about 3 s
(swamp-club#2870). The cap keeps every waiter within a quarter second of the
holder letting go. The auto-definition create lock (`createAutoDefinitionLock`
in `direct_execution.ts`) starts at 25 ms for the same reason, so forEach
iterations that race to create one direct-type definition do not stall; it
keeps the default cap.

**Contention logging.** A lock taken after one or more retries logs the retry
count and total wait at info level:

```
INF datastore·lock Acquired lock "/abs/path/to/datastore/.datastore.lock" after 3 retries (4521ms)
```

The path is the absolute `lockPath` (`file_lock.ts`), built with `@std/path`
`join`, so it uses the platform separator: timeout errors and log lines name a
valid Windows path.

**Slow-lock advice.** An acquisition that waits longer than 5 seconds
(`SLOW_LOCK_THRESHOLD_MS`) may log one warning, chosen by `slowLockAdvice`
(`slow_lock_advice.ts`) from the lock's scope. Each caller of the sync
coordinator passes that scope as `slowLockScope`:

- **Per-model lock.** The key already holds the model type and id, so a
  namespace cannot help. The warning names the cause, concurrent runs (workflow
  steps, separate commands, serve) taking turns on one model instance's lock.
- **Global lock.** The warning suggests `swamp datastore namespace set` only
  when no namespace is set and another repo can reach the datastore
  (`isShareableDatastore`). Extension datastores always count as shareable.
  Filesystem datastores count as shareable unless they sit in the repo's own
  `.swamp` directory. With one repo on its own directory, the global lock
  stays silent.

A registration without `slowLockScope` logs no advice (swamp-club#2941).

### Lock Lifecycle

The sync coordinator (`datastore_sync_coordinator.ts`), a global singleton,
manages the lock lifecycle:

- `registerDatastoreSync({ service?, lock?, label?, syncTimeoutMs?,
  metadataOnly?, namespace?, slowLockScope? })`: take the lock, pull if S3.
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

A workflow shell step can run a nested `swamp` command (e.g.
`swamp extension push`) while the step's own per-model lock is held. If the
child's drain waited on that lock it would deadlock: the parent waits on the
child, the child on the parent's lock.

Every swamp hands three variables to the swamps it starts, through
`LockHolderMarker` in `src/domain/datastore/lock_holder_marker.ts`. It never
clears the first two from its own env:

- `SWAMP_LOCK_ANCESTOR_PIDS`, published once at startup (`runInvocation`):
  the comma-separated pids of every swamp above it, followed by its own (at
  most 64, the newest kept). If no chain was inherited, it is seeded from an
  inherited `SWAMP_LOCK_HOLDER_PID`.
- `SWAMP_LOCK_HOLDER_PID`, which older binaries read alone: the swamp's own
  pid from the first time it takes a per-model lock (`acquireModelLocks`).
  Until then it keeps the value it inherited, so through a swamp that takes
  no locks (e.g. a read-only `model method run`) it still names the real lock
  holder.
- `SWAMP_LOCK_HOLDER_TOKENS`, set per spawn and never written to a swamp's
  own process env (a dispatch runner is started with one, below):
  comma-separated `<pid>:<nonce>+<nonce>` entries naming, for each swamp
  above the child, the per-model locks it holds for the run that started the
  child. A nonce is the one each lock file already records. The shell model
  adds `LockHolderMarker.childLockEnv()` to the child's env: the inherited
  entries plus one for its own pid. That entry lists the locks held by the
  `runHolding` scope (an `AsyncLocalStorage` scope) the spawn runs in, and is
  empty when that run holds none. Each locked execution runs in its scope: a
  workflow step's method (`execution_service.ts`, from `StepLockHook`'s
  `heldLockIds`; a hook that leaves them out runs the step outside any scope,
  so its children fall back to the pid match rather than wait on the step's
  own lock), and a CLI or `swamp serve` model method run
  (`runUnderModelLocks`, `src/cli/repo_context.ts`). Scopes nest, so
  `runModel()` and other in-process nesting carry the outer run's locks.
  `integration/model_lock_scope_rules_test.ts` pins the model-run sites.

A run requested through `--server` crosses no process boundary to inherit
through. When a step of a run hosted by `swamp serve` runs
`swamp model method run --server` (or `workflow run` / `workflow resume`) back
into the same serve, the requested run starts in a request handler, outside
the step's scope, so on its own it would tell its children only about its own
locks and they would wait on the step's (swamp-club#2982). Instead the client
sends the list it would hand a child (`forwardedLockTokens()`) as
`lockHolderTokens` in the `workflow.run`, `model.method.run` and
`workflow.resume` payloads (`src/cli/remote_run.ts`), and serve runs each of
those requests inside `runAdoptingForwardedLocks` at its dispatch site in
`src/serve/connection.ts`, under which the run's and its steps' own scopes
nest.

The forwarded list is untrusted. `LockHolderMarker.runAdopting` uses only the
entry for its own pid, and of its nonces only those a `runHolding` scope is
open for at that moment, so a client can name no lock serve does not hold and
a list stops working once the calling step ends. Nothing else is adopted; with
no usable nonce the request runs as before. This gives a client no more than
it has: a shell method's explicit env already overrides
`SWAMP_LOCK_HOLDER_TOKENS` for its child. The client cannot tell a loopback
from a remote server, so the pids and lock nonces above it reach any server it
runs against. A list longer than `MAX_FORWARDED_LOCK_TOKENS_LENGTH`
(16,384 characters, also the schema's limit) is not sent, and that request runs
as before. Older clients send nothing and older servers drop the field.

A process that adopts must name the locks of every step it runs inside the
adopted scope: a step whose hook leaves out `heldLockIds` would run in the
adopted scope rather than outside any, and its nested swamp would wait on the
step's own lock. Serve is the only adopter
(`integration/model_lock_scope_rules_test.ts`) and takes every step lock
through `createStepLockHook`, which names them
(`integration/serve_deps_rules_test.ts`, `src/serve/deps_test.ts`).

Before publishing, the marker captures what the process inherited.
`waitForPerModelLocks` skips a lock file when its `pid` is one of those
ancestors and its `hostname` is this host, and, if that ancestor has an entry
in `SWAMP_LOCK_HOLDER_TOKENS`, its `nonce` is listed there. A lock whose
ancestor has no entry (it was started outside any scope, e.g. by an extension
using `Deno.Command`, or through an older swamp), or a lock file without a
nonce, is matched on the pid alone, as before. A process on another host sharing
the datastore (e.g. over NFS) can carry the same pid, so its lock is still
waited on. A lock file with no `hostname` is matched on pid alone. The
hostname is read when the drain runs. If the host is renamed after an ancestor
took its lock (macOS can rename on a network change), that lock no longer
matches and the child waits on it until `SWAMP_LOCK_TIMEOUT_MS`. The drain
never skips its own pid, so a structural command still waits on in-flight
writes by other runs in its own process.

The skip is what avoids the deadlock: the run that started the child holds
its lock until the child exits. The nonce list narrows it from the process to
the run (swamp-club#2955). A nested swamp under one `swamp serve` run, or
under one of several parallel workflow steps, waits on the locks the same
process holds for its other runs instead of racing their in-flight writes.
When that wait times out, the `LockTimeoutError` names the locks held for an
ancestor's other runs and says why.

A step dispatched to a remote worker runs while the orchestrator holds its
lock, and a worker is not a descendant of the orchestrator, so ancestry alone
would leave a nested structural swamp on a same-host worker waiting on its own
step's lock (swamp-club#2983). The dispatch carries the lock holder instead.
When the orchestrator builds the request for a remote step
(`method_execution_service.ts`), `LockHolderMarker.remoteLockHolder()` reads
the `runHolding` scope and returns the orchestrator's pid, its hostname and
the nonces of the locks held for that run. Nothing is sent when the run holds
no lock. It travels as the optional `lockHolder` field of `DispatchParams`.
The worker passes it to `withRemoteLockHolder` when it builds the dispatch
runner's env (`buildRunnerEnvironment`, `src/worker/dispatch_handler.ts`).
If the hostname is the worker's own, the orchestrator's pid goes at the front
of the runner's `SWAMP_LOCK_ANCESTOR_PIDS` and its nonces into
`SWAMP_LOCK_HOLDER_TOKENS`. The runner and the shell model then hand both
down as they would an inherited chain. The pid is never added without its
tokens entry, so the nested swamp skips the dispatched step's locks and waits
on every other lock the orchestrator holds. The field arrives over the
network: the dispatch schema bounds it and `withRemoteLockHolder` checks the
pid and nonces again, dropping anything malformed. If the orchestrator
releases the step's lock while the runner's child is still running, the nonce
matches no lock file and nothing is skipped.

Known limits of the run-level match:

- Two parallel steps or runs that each start a nested structural command
  (e.g. `swamp data gc`) wait on each other: each holds its step lock until
  its child exits. One of them fails within a few seconds instead of both
  failing at `SWAMP_LOCK_TIMEOUT_MS`; see "Drain-Wait Markers" below. Still
  run such commands one at a time or in a step of their own.
- A `--server` call adopts only the locks of the serve it calls. A nested
  structural swamp under the requested run still waits on the lock of a swamp
  that is not above it: a local `swamp workflow run` between the calling step
  and the `--server` client, or the caller itself when `--server` names a
  different swamp process sharing the datastore. Skipping those would mean
  trusting pids a client supplied.
- A step dispatched to a remote worker on another host that shares the
  datastore (e.g. over NFS) runs while serve holds its lock. The hand-off
  above is for a worker on serve's own host, so a nested structural swamp
  there waits on its own step's lock.
- The dispatch hand-off names only the locks the orchestrator itself holds
  for the step. Locks held by a swamp above the orchestrator (a
  `swamp workflow run` whose shell step started the orchestrating swamp) are
  not passed on, so a nested structural swamp on the worker still waits on
  those.
- A child left running in the background after its ancestors exit can skip a
  lock taken by an unrelated process that reused an ancestor's pid on this
  host.

Keeping either value for the rest of the process's life is equivalent to
keeping it while holding locks, because a lock file carrying a pid exists only
while that process holds it. Setting the holder on acquire and clearing it on
flush is
not safe: per-step workflow locks and concurrent `swamp serve` runs hold locks
side by side in one process, and the first flush would clear the marker while
the others still held theirs (swamp-club#2659). The ancestor chain keeps a
nested swamp working when a swamp between it and the lock holder takes no
locks itself, such as a read-only `model method run`.

With mixed versions, a child still skips the locks of the nearest swamp above
it that holds locks, as before this change:

- An older child reads only `SWAMP_LOCK_HOLDER_PID`, which names that swamp.
  It does not skip lock holders further up.
- A newer child under an older parent falls back to `SWAMP_LOCK_HOLDER_PID`.
- An older swamp in the middle sets the holder only while it holds locks. If
  it starts the child from a shell step, its allowlist predates
  `SWAMP_LOCK_ANCESTOR_PIDS`, so the chain is dropped and the child skips
  only the holder. If the child inherits the env directly (an extension using
  `Deno.Command`), the chain survives and the child skips every ancestor.
- An older child ignores `SWAMP_LOCK_HOLDER_TOKENS` and skips by pid. An
  older swamp in the middle strips it from a shell step's env, so the child
  matches every ancestor on the pid alone. Neither waits on a lock it skipped
  before.

- A worker that predates `lockHolder` ignores the field, and an orchestrator
  that predates it never sends it. A nested swamp on that worker waits on its
  step's lock, as before.

A SIGINT handler makes a best effort to release locks on Ctrl-C. If the process
crashes without releasing, the lock expires after the TTL (30 seconds by
default).

#### Drain-Wait Markers

Nested structural commands can wait on each other with no way out. Each skips
the lock its own run holds and waits on the other run's lock, and each run
keeps its lock until its nested command exits. The same happens between two
separate top-level runs. Left alone, both fail at `SWAMP_LOCK_TIMEOUT_MS`.

A drain that has to wait therefore says so (swamp-club#2981). While
`waitForPerModelLocks` waits, it keeps a **drain wait** on disk: a small JSON
marker at `{namespace}/drain-waits/{id}.json` under the datastore root
(`DrainWaitStore`, `src/infrastructure/persistence/drain_wait_store.ts`). The
directory is outside `data/`, so the lock scan never sees it. The marker
(`DrainWait`, `src/domain/datastore/drain_wait.ts`) lists, by lock-file nonce:

- `skipping`: the live locks the drain skips because an ancestor named them
  in `SWAMP_LOCK_HOLDER_TOKENS`, which are held until this drain's process
  exits. A lock skipped on the pid alone is left out: it may be held for
  another run and released first, so it proves no cycle;
- `waitingOn`: the live locks it waits on.

It also carries the drain's pid, hostname, start time, last refresh and a
10-second ttl. The drain rewrites it on every poll and removes it when the
wait ends, however it ends. A drain that skips no lock, or waits on none with
a nonce, cannot be part of a cycle and publishes nothing, so a structural
command run on its own does no marker I/O.

Two drains are **mutually waiting** when each waits on a lock the other
skips. On every poll a drain reads the other markers and asks
`drainToYieldTo`:

- Unexpired waits are ordered by start time, then id, and taken in order. A
  drain **yields** when it is mutually waiting with an earlier drain that is
  not itself yielding. Every drain that sees the same markers reaches the same
  answer, so of a group that all wait on each other exactly one keeps
  waiting.
- A drain that skips every lock the other skips, because it runs deeper inside
  the same run, is not waited on by the other and is never failed for it.
- A drain yields only after it has seen the same opponent on two polls in a
  row with the opponent's marker refreshed in between. A marker can be a poll
  old, and a killed drain never refreshes, so neither can fail a drain that
  was about to proceed.

The yielding drain throws `LockWaitCycleError` (`distributed_lock.ts`), a
`UserError` with code `lock_wait_cycle`. It is not a `LockTimeoutError`: it
exits 1, not 75, and `swamp serve` does not mark it retryable. Retrying while
the run that started the command still holds its lock meets the same wait and
yields again. The error names the other process and the locks waited on.

The drain that stays keeps waiting, and proceeds when the yielding command's
run ends and releases its lock. Limits:

- If the yielding command's step ignores the failure and keeps running, its
  lock stays held and the other drain still times out.
- A drain running an older swamp publishes no marker, so a cycle that includes
  one ends at the timeout, as before.
- A drain whose ancestors handed down no lock list (a step lock hook that
  names no locks, a spawn outside any scope) skips on the pid alone, lists
  nothing in `skipping` and publishes no marker.
- A scan that takes close to the 10-second ttl, on a very large datastore,
  lets markers expire between refreshes, so no cycle is confirmed.
- Custom datastore locks are not scanned by the drain and are not covered.
- Reading or writing a marker can fail (a read-only directory, a file held
  open on Windows). The failure is logged at debug and the drain waits as if
  markers did not exist.

Markers are read from a directory other processes write, so `parseDrainWait`
rejects anything malformed or oversized, a marker must be named after its own
id, and a listing reads at most 256 entries. A listing also deletes files that
are not live markers and have not been written for a full ttl, which clears
what a killed drain left behind.

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
  (`src/cli/repo_context.ts`) points the extension lockfile at the
  datastore-resolved config path. Pulled extension sources stay in the repo's
  `.swamp/config/pulled-extensions` until swamp-club#2612. For custom
  datastores (S3, GCS), `ensureManagedConfigBase` resolves the datastore config
  to derive the cache-relative config path and records it, with its
  provenance, in the module-level registry; see "Extension commands and the
  chicken-and-egg" below.
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
`swamp data query` or other CLI commands instead of direct filesystem access.

The migration copies files to the cache (overwriting any partial cache from an
earlier attempt), pushes to the remote (idempotent), and pulls from it. Only
then does it clean up `.swamp/` and update `.swamp.yaml`, in that order for
extension datastores (see [Initial Setup](#initial-setup)). Under
managedConfig, part of `.swamp/config` may be left out of the copy and the
cleanup (see [Setup under managedConfig](#setup-under-managedconfig)).

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

### Setup under managedConfig

Setup rewrites only the `.swamp.yaml` datastore keys it owns: `type`, `path`,
`config`, `directories`, `namespace` and `hydrationStrategy`.
`mergeSetupDatastoreBlock` (`src/domain/datastore/datastore_config.ts`) keeps
the keys in `SETUP_PRESERVED_DATASTORE_KEYS` (`managedConfig`, `exclude`) from
the existing block. A re-run or a backend switch therefore never turns
managedConfig off. Keys from an old backend are still dropped.

Under managedConfig, the repo's own `.swamp/config` is not always the config
tier, so setup classifies it before migrating (`classifyInRepoConfig`). It
compares that directory with the current datastore's resolved tier path
(`resolveConfigTierPath` in `src/cli/resolve_datastore.ts`, the same resolver
startup uses):

- **Tier** (a filesystem datastore at `.swamp`): `config` migrates with the
  datastore. `config/pulled-extensions` stays: it is neither copied nor removed,
  because pulled extension sources stay in the repo (swamp-club#2612). If
  `.swamp/config` is a symlink, cleanup leaves the link alone rather than
  deleting the files of its target.
- **Instance-local** (the tier is elsewhere, or the current datastore cannot be
  resolved): `.swamp/config` holds only this instance's pulled extension
  sources and the transitional auto-resolve lockfile. Setup leaves it out of
  the copy, the push and the cleanup. Otherwise the push would upload it over
  the shared remote tier (swamp-club#2837).

The filesystem branch applies these skips only when it migrates from `.swamp`.
An outgoing extension cache's `config` is the real tier and migrates as usual.

After a setup that fully succeeded, setup checks that the new datastore's config
tier holds config (swamp-club#2845). `inspectManagedConfigTier` re-reads the
rewritten `.swamp.yaml` and, when managedConfig is on, resolves the tier with
`resolveConfigTierPath`. `isConfigTierPopulated`
(`src/domain/datastore/managed_config_migration.ts`) counts the tier as
populated when it holds the migration sentinel or any entry in `models/`,
`workflows/` or `vaults/`. The sentinel alone is not enough, because the
`.swamp.yaml` flag alone turns managedConfig on and definitions can then be
created in a tier that was never migrated. An empty tier gets an
`empty_config_tier` warning that names the tier path and
`swamp datastore config migrate`; in JSON output it is an entry in `warnings`
with that `code`, beside the `existing_namespaces` warning. Setup skips the
check when the tier cannot be resolved, and after an extension setup that only
timed out, since a partial transfer proves nothing about the remote. Under lazy
hydration the setup pull already brings `config/` down in full, so before
warning, setup only asks the sync service's `hydrateFile` for the sentinel,
only when the tier lies inside the cache, and within the setup sync timeout
(`runBoundedSync`), so a stalled remote cannot hang setup. `swamp serve`'s
`datastore.setup.extension` handler does not forward setup warnings.

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
remote through `src/cli/managed_config_sync.ts`: `runManagedConfigMutation` for
definitions and vault configs (a bulk mark staged through the command's root
unit, which pushes it), and the per-path helpers for the extension
lockfile:

| Mutation type | Config-tier path | CLI push | Serve push |
|---------------|-----------------|----------|------------|
| Model definition create/edit | `config/models/` | `runManagedConfigMutation` (bare mark staged through the root, root pushes) | `ctx.syncService.pushChanged` |
| Model definition delete | `config/models/` | Per-model lock push as its root unit's flush, through `reportManagedConfigCleanupError` | Via per-model lock flush |
| Workflow definition create/edit | `config/workflows/` | `runManagedConfigMutation` (bare mark staged through the root, root pushes) | `ctx.syncService.pushChanged` |
| Vault config create/migrate | `config/vaults/` | `runManagedConfigMutation` (bare mark staged through the root, root pushes) | `ctx.syncService.pushChanged` after marking the config file (and, for migrate, the old one) |
| Extension pull/install/rm/update | `config/upstream_extensions.json` (sources stay in the repo's pulled root until swamp-club#2612) | Managed lockfile transaction: fetch, change and publish exactly the lockfile under the global lock; none when the datastore-extension exemption records into the in-repo lockfile | Managed lockfile transaction, inside the handler's exclusive sync gate; a failed publish is logged and left pending |
| Search install, `repo upgrade`, `doctor extensions --repair` | `config/upstream_extensions.json` | Managed lockfile transaction | — |
| Auto-definitions (direct type execution) | `.swamp/auto-definitions/` (datastore subdir, not config tier) | Via flush coordinator | Via per-model lock flush |

A CLI config write whose push fails, or times out, exits non-zero with
`ManagedConfigUnpublishedError` (code `managed_config_unpublished`). A deferred
helper that cannot resolve the datastore after the write fails the same way,
as does a lockfile that cannot be read after the command. The local write is
kept, never rolled back, and the error names `swamp datastore sync --push` as
the retry. `model delete` fails this way only when its lock flush fails after
the delete completed; a flush failure while an earlier error propagates is
logged, so it cannot replace that error (swamp-club#2752).

The extension lockfile is the exception: a failed publish records the change
itself (a `LockfileDelta`) in `.swamp/managed-config-lockfile-unpublished`
(`pending_lockfile_publish.ts`), and the error names `swamp extension install`
as the retry. Any later lockfile transaction fetches the datastore's lockfile,
replays the recorded change onto it and publishes, whether or not it changed
anything itself, then clears the record. Commands that report a result per
extension (`extension install`'s restore, `extension update`,
`doctor extensions --repair`) count an extension whose only failure was the
publish as done, and exit non-zero with the publish error after the report.
While a recorded change cannot be published, any extension write, including
the `extension rm` preview, fails with the publish error first, since it
publishes the recorded change before reading or changing anything. That error
says an earlier change is still unpublished and that this command did not
change the lockfile, rather than that its own change was saved.
`datastore sync --push` and a full
`datastore sync` clear only a record from an older swamp that holds no change
(swamp-club#2838).

Auto-definitions are a normal datastore subdirectory
(`DEFAULT_DATASTORE_SUBDIRS` includes `auto-definitions`). They sync through the
usual write-command lifecycle (pull on lock acquire, push on flush), not the
config-tier push.

### Extension commands and the chicken-and-egg

Under managed config on an extension-backed datastore (S3, GCS), the extension
lockfile lives at the datastore's config base, but finding that base needs the
datastore extension, which is itself a pulled extension. swamp breaks the loop
at startup (`configureStartupExtensions` in `src/cli/mod.ts`,
swamp-club#2483):

1. **Datastore extensions are found on disk.** The datastore-kind loader scans
   both in-repo pulled roots (`.swamp/config/pulled-extensions` and the
   pre-migrate `.swamp/pulled-extensions`) for extension roots whose manifest
   name matches their path and whose `datastores/` has sources, deduped by
   name with the managed root preferred. It reads no lockfile, so it works
   whichever lockfile recorded the extension, including right after
   `datastore config migrate`. A directory it cannot read is skipped with a
   warning. Reconcile walks and exempts those sources the same way at every
   construction site. As a result, datastore code under
   either root loads whether or not a lockfile lists it, at the same trust
   level as repo-local `extensions/`: an extension a teammate removed from the
   shared lockfile, or a copy left under the legacy root after migrate, keeps
   loading until its directory is deleted.
2. **The base is resolved once, installed-only.** Startup calls
   `ensureManagedConfigBase` with `autoResolve: false`: nothing is installed
   from the network before logging starts. Filesystem datastores always
   resolve; extension-backed ones skip this for thin clients (`--server`,
   `SWAMP_SERVE_URL`, `SWAMP_SERVER_URL`), and the loaders resolve on first
   use instead.
3. **The registry records provenance.** A base from the datastore resolver is
   *resolved*; the in-repo `.swamp/config` fallback is *unresolved*. The last
   resolved registration wins and a fallback never replaces a resolved base,
   so the base cannot move within a process.
4. **Loaders read the lockfile path when they load.** Reconcile and the
   missing-source-files check run only once the base is resolved; if startup
   had to skip them, they run once, best-effort, when a loader first finds it
   resolved. A missing lockfile is normal and silent; an unreadable one warns.
5. **Writes refuse a guessed base.** Extension write commands (`pull`,
   `update`, `rm`, `install`, search's install, `doctor extensions --repair`)
   go through `resolveManagedLockfileForWrite`. It resolves the base as other
   commands do, auto-installing a missing datastore extension, so a fresh
   checkout or CI job needs no extra step. Only when the base is still
   unresolved (the extension could not be installed, for example from an
   untrusted collective or with the registry unreachable, or it does not
   load) does it throw `ManagedConfigUnresolvedError` (code
   `managed_config_unresolved`) rather than write to the in-repo guess. Its
   remedy is `swamp extension pull <datastore extension>` (with `--force` if
   it is installed but fails to load), then `swamp datastore sync --pull`.
   That pull is the one exception: `extension pull`, `extension update` or
   search's install naming the datastore extension itself (#445) records into
   the in-repo lockfile while the base is unresolved and skips the publish,
   and the next command resolves from the on-disk scan. With the base
   unresolved, `repo upgrade` skips its install pass and the
   untrusted-collectives check, and reports `installSkipped` and
   `untrustedCollectivesSkipped`; `doctor extensions` skips its rescan and
   repairs but still reports, with the reason in `rescanSkipped`; `extension
   update --check` reads the in-repo fallback and marks its result
   `lockfileSource: "fallback"`.

Until swamp-club#2495, the auto-resolver records installs in the in-repo
`.swamp/config/upstream_extensions.json` rather than the datastore's lockfile,
which pulls would overwrite. It still reads pinned versions and checksums from
the datastore's lockfile once the base resolves (the resolved entry wins), so a
fresh checkout auto-installs the team's pin (#465). Loaders, the reconcile
orphan rule, the missing-files check and `extension list` read those entries
read-only alongside the resolved lockfile (the resolved entry wins). An
auto-resolved entry whose directory and source files are all gone awaits
reinstall on next use, so neither the missing-files check nor `extension list`
reports it (`isAbsentFromDisk`, mirroring the auto-resolver's `missing`
inspection). `update`,
`rm` and `install` act on the resolved lockfile only, and workflows from
auto-resolved extensions stay invisible to the workflow loaders, as before.

The resolved lockfile is a cache file, and the datastore stores each file
last-writer-wins, so publishing it from a stale cache would erase entries
other checkouts added. Extension writes therefore run in a managed lockfile
transaction (`ManagedLockfileTransaction`, swamp-club#2838) on
extension-backed datastores:

1. Download, verify and extract outside any lock.
2. Take the datastore global lock (`datastoreGlobalLock`, namespace-aware),
   fetch the shared lockfile with a `config`-scoped `pullChanged`, and replay
   any change an earlier transaction failed to publish.
3. Under the pulled-extensions lock, apply the change to the lockfile.
4. Record the whole outstanding change (any earlier record merged with what
   this change did to the lockfile it started from) in
   `.swamp/managed-config-lockfile-unpublished`, publish exactly the
   lockfile, clear the record, and release the global lock. This also runs
   when the change throws after writing the lockfile.

A process killed during step 3 (Ctrl-C during a dependency download, say)
records nothing: the next fetch replaces the local lockfile, and the
interrupted change must be run again. Any earlier record is untouched.

`extension rm`'s preview, `extension update`'s target selection and
`extension install`'s restore fetch under the lock first, so they read what
other checkouts wrote. `repo upgrade`'s install pass does not: it restores
from the local lockfile, so an upgrade with nothing to restore never contacts
the datastore, while each entry it does install still goes through a
transaction. If that pass fails to publish, the upgrade result is reported
first and the command then exits with the publish error. A dependency that the fetched lockfile lists but whose
files are missing from this checkout is installed at the version it pins, not
skipped. When the fetch fails nothing changes
(`ManagedLockfileUnavailableError`); when the publish fails the change stays
recorded and the next extension write replays it onto a fresh fetch. The error
names `swamp extension install` as the retry, since it fetches and replays;
`swamp datastore sync --push` would publish the stale local copy. In
`swamp serve` the handlers take the global lock inside their exclusive sync
gate, and a failed publish is logged and left pending. A command already
holding the global lock (the sync coordinator) does not take it again.
Filesystem datastores and repos without managedConfig skip all of this.

`extension install`'s restore and `extension update` choose their targets
from one fetch, then install each target in its own transaction after its
download. Another checkout that changes one of those entries in between
(updates or removes it) can have that change reverted when this checkout
reaches the entry. The window is the length of the loop; closing it needs a
re-check of each entry under the lock, tracked as a follow-up.

The fetch is a scoped pull under the lock, and a scoped pull's slow path
re-downloads any `config/` file that differs from the datastore's index. A
config write another process on the same checkout made and has not pushed
yet can therefore be overwritten; the lockfile itself is protected by the
pending-change record.

The lockfile's own advisory lock (`LockfileRepository`) is a sibling file
named exactly `.lock`, which datastore sync excludes in both directions, so a
push never uploads it to other checkouts. Everyone writing that lockfile shares
it: repos on a shared filesystem datastore and worktrees sharing a cache.

Dependencies are the one exception to "downloads outside every lock": they
install inside the parent's apply, whether a dependency needs installing is
only known from the lockfile read under the lock, so their downloads run while
the global lock is held. The CLI holds the global lock through the sync
coordinator, whose SIGINT handler releases it on Ctrl-C.

### Pod boot sequence under managed config

Recommended init container sequence for a stateless pod:

1. **Create `.swamp.yaml`**: copy in the marker file with the datastore config
   and `managedConfig: true`.
2. **`swamp datastore setup extension`**: configure the datastore backend.
3. **`swamp datastore sync --pull`**: hydrate the local cache from the remote,
   including `config/` (definitions and the lockfile). Pulled extension sources
   are not loaded from the remote (swamp-club#2612); step 5 restores them into
   the repo's pulled root.
4. **`swamp datastore config migrate`**: idempotent. First boot copies local
   config into the datastore tier and pushes; later boots the sentinel skips the
   copy. Either way it sets `managedConfig: true` in `.swamp.yaml` if missing,
   so a repo joining an already-migrated datastore is configured too.
   On a first boot against an empty remote, step 2 warns that the config tier is
   empty (`empty_config_tier`); this step populates it.
5. **`swamp extension install`**: restore pulled extensions whose source files
   are missing from the repo's pulled root. It records into the config-tier
   lockfile and pushes the lockfile; sources are not pushed.

The order matters: step 3 hydrates the lockfile that step 5 records into, so
step 5 does not replace the team's entries. Each step auto-installs the
datastore extension if it is missing. When the datastore extension's
collective is not trusted (so it cannot auto-install), pull it explicitly
with `swamp extension pull <datastore extension>` before step 2. Step 5 must
run on every pod so pulled extension sources are complete: each pod restores
its own sources.

### Recovery from missing-extensions state

When a pod boots and logs "N pulled extension(s) have missing source files":

1. **On the pod (or its image's init step):**
   ```bash
   swamp extension install --repo-dir /path/to/repo
   ```
   This restores the source files locally. Sources are not pushed to the
   remote, so each pod restores its own (pod boot step 5). If serve is already
   running on the pod, follow with `swamp serve reload` (requires
   `--hot-reload`) or restart it so the restored types register.

2. **Via the serve API (with `--hot-reload` enabled):**
   ```bash
   swamp extension install --server https://pod-url
   swamp serve reload --server https://pod-url
   ```
   The serve handler installs on that pod and pushes the lockfile.
   `serve reload` re-bundles the updated extensions. Without `--hot-reload` the
   reload step fails and the pod must be restarted. This covers only the pod
   behind that URL; other replicas still need their own restore (step 1).

### Extension auto-reload via config poller

With `managedConfig`, serve builds the config poller whether or not it has a
sync service. Each poll pulls `config/` when a sync service exists, and
invalidates catalogs when the pull reports files changed or an unknown count
(`void`). A cycle skipped for a busy sync gate invalidates nothing. The poll then
hashes the config-tier lockfile and compares it with the last hash it acted on.
That baseline is seeded at boot, right after `pullManagedConfigAtBoot`, so the
registries' first load is not repeated. When the hash differs, the poller
advances the baseline and calls `performServeReload`. A change that lands while
the reload runs is picked up on the next poll.

So a peer's `extension pull`, `update`, `rm` or version pin now reloads serve,
and so does a CLI extension write on the same host, or a handler's own write.
Only a lockfile change triggers it. Definition-only changes (model, vault or
workflow YAML edits) invalidate catalogs without reloading the registries.

The reloader reports `ok`, `failed` or `busy`. `busy` means another reload was
running, and serve's `Reload already in progress` response maps to it. A busy
reload stays pending and is retried on the next poll. A failed reload is retried
up to three times per lockfile version, then waits for the next change. The
poller logs a failed reload's errors itself: as warnings on the first and last
attempt, and at debug level in between.

The reload re-bundles from the pod's own pulled root. Extension sources are not
pushed (they stay in each repo's pulled root until swamp-club#2612), so a peer's
new extension still needs `extension install` on each pod before it can
register. A peer's `rm` unregisters the removed extension's types on every pod
at the next reload, and retires its catalog rows on pods that still have them
(swamp-club#2742; see [serve §High
availability](../primitives/serve.md#high-availability)). Until swamp-club#2612,
`--hot-reload` is therefore needed for extension registration as well as for
trigger overrides and workflow reloading.
