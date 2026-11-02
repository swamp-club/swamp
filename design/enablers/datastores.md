---
audience: maintainer, operator, extension-author
enables: [data]
last-verified: 2026-10-08 @ 03ca42ca
---

# Datastores

A datastore is where swamp keeps runtime data: versioned behavior data, workflow
runs, method outputs, encrypted secrets and cached bundles. Audit logs,
telemetry and run logs stay with the checkout that wrote them, whatever the
datastore (see "v3 stream directories").

Source-of-truth files (behavior definitions, workflow definitions, vault
configs) are never in the datastore. They live in the repo's top-level
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

**Durable v2 writes** (swamp-club#4017). On a v2 datastore (this backend, and
the local cache of a v2 extension datastore) whose `durable` setting is on (it
is off by default, below), a data version is synced before anything publishes
it. `FileSystemUnifiedDataRepository` writes `metadata.yaml` and `raw` through
the synced atomic write (`atomic_write.ts`: the temp file synced, renamed, the
directory synced), syncs the version directory once, then the data-name and
model directories, and only then moves the `latest` marker,
itself written synced, and writes the catalog row. A writer that creates
directories syncs the parent of each one (`make_directories.ts`). The per-model
lock creates a new model's directories before the repository writes under
them, so on a filesystem datastore `createModelLock` has its `FileLock` create
them the same way (`syncCreatedDirectories`). A sync is a full one
(`FsFile.sync()`: fsync on Linux, `F_FULLFSYNC` on macOS, `FlushFileBuffers` on
Windows, which cannot sync a directory), except on macOS for the default
datastore, which uses the ordering barrier (the v2 write-sync policy, below).
On v3 the repository does not sync a version the unit commits: the
commit is durable and replay rewrites the checkout. A version whose keys
(`metadata.yaml`, `raw` or the name's `latest` marker) the checkout's
`directories` or `exclude` keep local is dropped from the commit, so nothing
replays it, and the repository syncs it as on v2 (swamp-club#4019). It asks the
bound unit through `unitAdmitsKey` (`unit_of_work_scope.ts`), which answers
with the filter the unit was opened with. One key kept local syncs the whole
version, and the directories created above it: the repository creates them
once the first version number to try is known, so the decision covers that
version's keys. On v3 the per-model lock syncs the directories it
creates when the checkout may keep data local: data is not among its
`directories`, or any `exclude` pattern is set. See
[data.md](../primitives/data.md#writing-data) for what durable means.

A failed sync fails the write before anything publishes the version, with a
`SyncFailedError` naming the file or directory (`Could not sync <path> to
disk: <reason>`), its path marked for telemetry. Directory syncs go through
`syncDirectoryStrict`, which skips only a directory that cannot be synced at
all (Windows; `EACCES`, `EPERM` or `ENOENT` on open; `EINVAL`, `ENOTSUP` or
`EBADF` on fsync, as PostgreSQL's `fsync_fname` does) and reports anything else,
such as `EIO` or `ENOSPC`. The lenient `syncDirectory`, which swallows every
failure, stays with the v3 read model and chunk storage. A file sync refused as
unsupported adds a hint to turn durable writes off.

One sync runs after publishing starts: the data-name directory's, which makes
the renamed `latest` marker durable. The version's own files are already
synced by then. If that sync fails, the marker already names the version, so
`advanceLatestMarker` has the caller write the catalog row before the failure
is rethrown. The write still fails, but the marker and the catalog agree on the
latest version.

The **`durable`** datastore setting turns the syncing on:

```yaml
# .swamp.yaml
datastore:
  type: filesystem
  path: /mnt/shared/swamp-data
  durable: true
```

`resolveDurableWrites` (`datastore_config.ts`) decides it: the block's
`durable` when set (a non-boolean is refused when the config is resolved), else
`SWAMP_DATASTORE_DURABLE` (`1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`; any
other value is ignored), else off. Durable writes are opt-in because each write
then costs several fsyncs: about twice the write time on a local NVMe disk, and
far more where a full sync is slow (macOS `F_FULLFSYNC`, network and spinning
disks). It applies to the filesystem backend and to an extension datastore's
local cache, and `datastore setup` keeps it across a re-run
(`SETUP_PRESERVED_DATASTORE_KEYS`). Off, writes are as before swamp-club#4017:
atomic, so they survive a process crash, but a power cut can publish an empty
version (swamp-club#3955). `swamp doctor datastores` reports such versions on a
filesystem datastore, and `--repair` rolls each record back to its last readable
version; see [data-query.md](data-query.md#unreadable-versions). The writing
construction sites of `FileSystemUnifiedDataRepository` (the repository factory,
the workflow execution service, and `data delete`, `rename`, `gc`, `prune` and
`model delete`) pass the resolved setting; any other site keeps the
constructor's default, off.

A push refused because its model lock was lost (swamp-club#3485) deletes the
refused versions, then puts back the datastore's copy of each removed file
and `latest` marker (`discardRefusedVersions` in `repo_context.ts`). It writes
in the same order as the repository (swamp-club#4033). It reads the markers
first. A marker that names a version the cache does not hold, such as the new
lock holder's next version, has that version's `metadata.yaml` restored with
the content, plus its `raw` unless the cache hydrates lazily. All content is
written next, then each restored version directory and every directory above
it up to `data/` is synced once, then the markers are written. Syncing follows
the `durable` setting; with it off the order holds but nothing is synced.

Every marker that was read is written, even one naming a version the cache
still lacks (the datastore holds no such version, or restoring it failed). A
marker left removed stays marked dirty, and the next push would delete the
datastore's copy. A local marker naming a missing version reads as no data
until the next pull replaces it. So no single failure stops the markers: a
marker that cannot be read is skipped, and a failed content restore or
directory sync is logged before the markers are written. Only a clean restore
keeps the promise that a durable marker never names content a power cut could
lose.

The refused writes also left their paths marked: a save marks the data-name
directory before it allocates a version, then the version directory and the
`latest` marker. A push walks a marked directory and deletes every remote file
under it that the cache lacks, so a later bare push deleted the new holder's
versions the cache never held, and uploaded the restored `latest` marker over
a newer one (swamp-club#4091). For each data name whose restore matched the
datastore throughout (every read answered, every write and directory sync
succeeded), the discard then calls `clearDirty` with the refused version
directories, the files restored or left removed, the `latest` marker and the
data-name directory. A name with any failure keeps its marks. A sync service
without `clearDirty`, which today includes the S3 and GCS extensions, keeps
every mark, and the deletion stays possible until the extension implements
it. The refusal then warns once, naming the data names whose marks stay, that
a later push from the checkout can delete or overwrite the other run's
versions there, and that updating the extension fixes it once a release
implements `clearDirty`. A cache whose per-path marks have overflowed pushes with a whole-cache
walk that deletes what the cache lacks; `clearDirty` cannot help there.

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

A v3-capable datastore also implements `datastoreControlPlaneStore?`,
`datastoreWideLease`, `storage?` (see
[v3 chunk storage](#v3-chunk-storage-storage1)), `replicaTarget?` and
`replicaPaths?`. `replicaTarget?` says where its Litestream replica lives: the
bucket and the datastore root's key prefix, never credentials.
`replicaPaths?` lists and removes the lineage paths under that prefix's
`_litestream/`, so a takeover's old lineage can be collected. See "Phase 4:
the replica target" and "Phase 4: replica paths" in
`datastore-litestream.md`.

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
import map. Push rewrites the bare imports that map resolves in a published
extension's source (swamp-club#3637), so this is the case for a name the map
does not resolve or a `package.json` project. Only the module's own static
imports count; imports inside template literals are generated code and are
ignored.

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

String values in the datastore `config` can use `${{ }}` expressions, as
behavior and workflow definitions do. They are resolved before the extension's
schema validation and `createProvider()` factory see the config.

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

- Only `env.*` and `vault.get()` work. The full CEL context (behavior
  references, data lookups) does not exist this early in startup.
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
  directories. Anything unlisted stays in local `.swamp/`, as the
  [output summaries](./output-summary-index.md) always do. Nothing writes
  `audit`, `telemetry`, `logs` or `files` through the datastore, so listing
  them moves no data (see "v3 stream directories"). The
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

**Setup timeouts.** In `datastore setup extension`, a push or pull
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

On v3 each namespace also has a **cache root** in every checkout, where the
read model materialises its records (`v3CacheRoot`): `.swamp/<namespace>/`,
or `.swamp/` itself for the solo namespace. So on v3 the local tier shares
`.swamp/` with the solo namespace's cache root: a subdirectory a checkout
keeps local (outside its `directories`, or matching its `exclude`) is the
same directory the solo namespace's records of that subdirectory would be
written to. "v3 read model" below says how the read model keeps the two apart
(swamp-club#3691).

#### Reserved namespace names

Because a namespace is the outermost segment, one named after a layout directory
(`data`, `outputs`, ...) is the same directory as the solo layout's
`{base}/{subdir}/`. On v3 a namespace's cache root is `.swamp/<namespace>/`,
so one named after any directory swamp keeps in `.swamp/` (`vault`,
`definitions`, `datastore-bundles`, ...) would have its records written over
swamp's own files (swamp-club#3691).

`RESERVED_NAMESPACE_NAMES` in `src/domain/data/namespace.ts` is built from
`SWAMP_OWNED_DIR_NAMES` in `src/domain/datastore/datastore_config.ts`: every
first-level name swamp uses in a checkout's `.swamp/`. That is
`DEFAULT_DATASTORE_SUBDIRS`, `ALWAYS_LOCAL_SUBDIRS`, the rest of
`SWAMP_SUBDIRS` by first segment, `cache`, `start`, `pre-v3-records`
(swamp-club#3690) and the `managed-config-lockfile-unpublished` file, and the names swamp
keeps in `~/.swamp` (`repos`, `deno`, `source`, `log`, ...), which is a
checkout's `.swamp/` when the repository is the home directory. The list is
written out in the domain rather than derived from `SWAMP_SUBDIRS`, which
lives in `infrastructure/persistence/paths.ts`: deriving it would give the
namespace rules a domain-to-infrastructure import.
`integration/namespace_reserved_names_rules_test.ts` keeps it whole: it fails
when a first segment of `SWAMP_SUBDIRS` is not reserved, or when production
source spells a first-level `.swamp/` name in a path literal (`swampPath`,
`join(..., ".swamp", name)`, `SWAMP_DATA_DIR` joins), or passes a string
constant to `swampPath` or such a `join`, that a namespace could still take. A property test checks that no slug `createNamespace` accepts is
such a name.

- **Claiming** a name goes through `createNamespace`, which rejects a reserved
  name. `namespace set` also rejects a name equal to one of the repo's
  configured `datastore.directories`.
- **Loading** a name already in `.swamp.yaml` goes through `restoreNamespace`,
  which does not apply the reserved rule. On v2 a repo bound to such a name
  before it was reserved, or by hand, still loads.
- **A v3 checkout does not open** on a reserved namespace
  (swamp-club#3691). `v3RepositoryFactoryConfig` and `holdV3Writer` refuse it
  (`refuseUnsafeV3Checkout`, code `datastore_v3_reserved_namespace`) before
  recovery, the lease and catch-up, so nothing is written. v3 refuses `namespace set` and cannot be moved by
  setup, so the message (`reservedV3NamespaceMessage`) gives the one way that
  works on v3: set up a new, empty v3 datastore, then edit the repo's
  `.swamp.yaml` to a name that is not reserved and point it at the new
  datastore. Nothing is migrated; the records committed under the reserved
  name stay in the old datastore. `datastore setup filesystem --format 3`
  refuses a repo bound to a reserved name before it touches anything, with
  the v2 move-by-hand steps, since the repo is not on v3 yet; `setup
  extension --format 3` was already refused by the reserved check below.
- For a repo loaded with a colliding name, `namespace migrate` (both
  directions), `namespace unset --migrate` and the doctor un-migrated data
  repair refuse before touching anything, and `swamp doctor datastores` reports
  a failing `reserved_namespace` check (on v3, with the v3 message above; a
  retention check that would open the refused checkout reports the refusal as
  its finding). They cannot tell the namespace directory from solo data.
  `doctor datastores --repair` skips only the un-migrated data repair and
  still runs the others. The way out is a move by hand, described in the
  swamp skill's namespaces reference.
- `datastore setup extension` checks reserved names only. It writes a datastore
  block without `directories`, so the defaults apply afterwards and a configured
  directory name cannot collide. A re-run on a repo already bound to a reserved
  name is refused with the same move-by-hand steps.

#### Migration

`swamp datastore namespace migrate` moves data from the solo layout to the
namespaced one. Each `DEFAULT_DATASTORE_SUBDIRS` directory found at
`{base}/{subdir}/` is moved to `{base}/{namespace}/{subdir}/` with
`Deno.rename()`. The catalog is then invalidated so backfill rebuilds it from
the new paths.

Migration never treats the catalog as datastore content (swamp-club#3316). On a
repo-local datastore `{base}/data/` is also where the catalog lives, so that
directory is merged entry by entry rather than renamed whole, and `_catalog.db`
and its SQLite sidecars (`CATALOG_FILE_NAMES` in
`src/domain/datastore/datastore_config.ts`) stay where they are. They are not
moved, not compared in the collision check below, and not counted as data by
the reverse check. A directory holding only the catalog is nothing to move, so
the command is safe to re-run: after a complete migration it reports nothing to
migrate, and after one that stopped part-way it moves the directories the
earlier run did not reach. A confirmed run in either direction also deletes any
stale catalog copy from `{base}/{namespace}/data/`, which earlier versions left
there by moving the catalog along with the data. It never deletes from the
directory holding the live catalog.

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

**Orphaned data** is stored data whose behavior definition no longer exists in
its namespace: the definition was deleted, or the behavior instance moved to
another namespace and left its old data behind.

`swamp data delete` and `swamp data gc` both fail on it. The on-disk layout and
the catalog `DELETE` predicate are keyed by behavior type
(`{typeDir}/{modelId}/...` and `type_normalized`), and the type normally comes
from the definition. So `delete` throws `Behavior not found`, and `gc` only applies
each item's frozen `lifetime`/`garbageCollection` policy, never collecting
`infinite`-lifetime orphans. The rows pile up, growing the index and the sync
cost of every write.

`swamp data prune` reclaims them. It walks the data root (`findAllGlobal`),
groups by `(type, modelId)`, and checks whether each group's definition still
exists. The check uses the definition repository's `findById`, which searches
both `models/` and `.swamp/auto-definitions/`, like `swamp behavior get`. So
auto-definition-backed behaviors (ones auto-created by a direct run or a
workflow, and installed `@swamp/*` behaviors) count as live and are never
pruned. Groups with
no live definition are removed by the definition-free `delete(type, modelId,
dataName)`, which deletes all versions on disk and their catalog rows.

Reclamation is irreversible and based on inference: a definition can be briefly
absent during a branch switch or migration. So prune runs only when invoked,
asks for confirmation by default, and offers `--dry-run` for a preview on the
lock-free read-only path. Otherwise it takes the global datastore lock (via
`requireInitializedRepo`), like `gc`/`delete`.

Two neighbouring concepts differ:

- **`swamp data gc`** applies the retention policy a behavior declared (lifetime
  and version cap). `prune` removes data whose behavior is gone. `gc` stays safe
  to run unattended; `prune` keeps the inferential deletion behind its own verb.
- **"Orphan recovery"** in `data_access_service.ts` does the opposite: at read
  time it keeps data reachable across a behavior's UUID change. It never
  deletes.

## Remote Datastore Sync

This section describes today's (v2) sync. The v3 datastore replicates its
single-writer `commits.db` with Litestream instead; how swamp runs it is decided
in [datastore-litestream.md](./datastore-litestream.md).

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

### Format Marker

A datastore can carry a **format marker** naming the layout it is written in.
Today's layout is format 2. A datastore without a marker is format 2.
`swamp datastore setup filesystem --format 3` writes a format-3 marker when it
creates a v3 datastore (swamp-club#3279, "v3 opt-in"), and the v3 migration
will write one when it converts one (swamp-club#2865). This binary reads
formats 2 and 3 on a filesystem datastore and format 2 on every other
(swamp-club#3189).

The marker is JSON. Unknown keys are ignored so later writers can add fields:

```json
{ "format": 3, "minReaderFormat": 3, "writtenBy": "2027.01.01.1" }
```

| Key               | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `format`          | Positive integer: the layout the datastore is written in      |
| `minReaderFormat` | Optional positive integer: the oldest format that can read it |
| `writtenBy`       | Optional string: the swamp version that wrote the marker      |

**Where it lives.** The marker belongs to the whole datastore, not to a
namespace:

- **Filesystem datastores:** `<path>/datastore-format.json`, at the datastore
  root. A namespace is a subdirectory of `<path>`, so namespaced and
  non-namespaced repos read the same file, and namespace migration never moves
  it.
- **Datastores whose sync service advertises `controlPlane`** (S3, GCS): the
  control-plane record `datastore-format`, at `<prefix>/_control/datastore-format`.
  A provider that implements the optional `datastoreControlPlaneStore()` is
  read through it: a read-only store keyed at the datastore-wide `_control/`
  root that binds no namespace and builds no sync service, so the read is one
  `get` (swamp-club#3191). Only a missing record reads as null; access denied
  and every other failure reject, so the read counts as failed, not absent.
  For a provider without it, core reads the record through a sync service
  built for that read alone. A sync
  service that has not pulled or pushed has no namespace bound, so the S3 and
  GCS extensions resolve the key to the root `_control/` even for a namespaced
  repo. This holds for every released S3/GCS version: before extensions#242
  (August 2026) control-plane keys were never namespaced, and since then the
  namespace binds lazily on first use. Verified against
  ministack and fake-gcs-server 1.56.1 with `@swamp/s3-datastore` 2026.08.27.3
  and 2026.10.07.1 and `@swamp/gcs-datastore` 2026.10.07.1, solo and
  namespaced. A provider whose `createSyncService`
  returns the same instance twice is skipped, because the read would bind
  that shared instance to no namespace and break the command's later
  namespaced pull. An identity check cannot see shared state behind fresh
  wrapper objects; extensions must not share namespace binding between the
  instances they return.
- **Other extensions** (no `controlPlane`, no sync service, no cache path): no
  marker can be read, so the check is skipped and logged at debug. The v3
  storage contract must require `datastoreControlPlaneStore()` of every
  v3-capable datastore, rather than relying on lazy binding.
  `assertDatastoreControlPlaneStoreConformance` in `@swamp-club/swamp-testing`
  checks an implementation.
- **Namespace-scoped credentials.** A namespaced repo whose credentials reach
  only its own `<prefix>/<namespace>/` cannot read the root record. The read
  fails, and the check is skipped, the same through either path.

**The check.** `assertSupportedDatastoreFormat`
(`src/domain/datastore/datastore_format.ts`) decides; the infrastructure reader
(`datastore_format_marker_reader.ts`) reads; `ensureSupportedDatastoreFormat`
(`datastore_format_guard.ts`) runs both.

| Marker read                                  | Outcome                                                     |
| -------------------------------------------- | ----------------------------------------------------------- |
| Not found                                    | Format 2, passes                                            |
| `minReaderFormat` (or `format`) ≤ 2          | Passes                                                      |
| `minReaderFormat` (or `format`) > 2          | Refused: `datastore_format_unsupported`                     |
| Not a marker (bad JSON or shape, > 64 KiB, not a regular file) | Refused: `datastore_format_marker_invalid` |
| Read failed (network, permissions, timeout)  | Passes, logged at debug                                     |
| Datastore cannot carry a marker              | Passes, logged at debug                                     |

A refusal is a `UserError` with that code in `--json` output and exit code 1,
and says nothing was changed. A garbled marker is refused because treating it
as format 2 is the unsafe direction. A failed read passes because blocking
offline or degraded use would change how every v2 datastore works, and the
command meets the same outage itself. The remote read is bounded by
`DATASTORE_FORMAT_READ_TIMEOUT_MS` (3 s) through a provider's datastore-wide
store, and by `DATASTORE_FORMAT_FALLBACK_READ_TIMEOUT_MS` (4 s) on the
fresh-sync-service fallback, which pays one more round trip. The `get` is
handed an `AbortSignal` that aborts at that deadline, so an extension that honours it stops its
request and retry backoff then; until then it may retry, so one transient
error does not skip the check. A remote slower than the deadline is treated as
a failed read.

**Cost** (swamp-club#3191, measured with
`scripts/bench_datastore_format_guard.ts` against local ministack and
fake-gcs-server, 20 interleaved runs per cell). With the current S3 and GCS
extensions, which have no `datastoreControlPlaneStore()` yet, each guarded
command builds two sync services and makes one control-plane `get`: on S3 that
is a `HeadBucket` credentials preflight plus the `GetObject`, two requests; on
GCS one request. Against a local emulator this adds no time distinguishable
from noise. A stalled read used to add the whole 5 s; it now adds the cap of
its path. Through `datastoreControlPlaneStore()` the check builds no sync
service and, as the extensions implement it, makes one request.

The caps were set from emulator runs with injected round trips and a slow AWS
container-credentials source, since a real bucket's first request pays
connection setup and credential resolution. A read that misses its deadline
skips the check silently, so the caps keep headroom: at 300 ms round trips and
a 1 s credentials fetch the S3 read took about 1.95 s through the
datastore-wide store, and more than 2 s on the fallback, where a 2 s cap let
a newer-format datastore through in 5 of 5 runs. With the 3 s and 4 s caps a
planted newer-format marker was refused in every run, up to a 1.5 s
credentials fetch.

**A lost marker** (swamp-club#3617). `writeDatastoreFormatMarker` writes the
marker durably: the temp file is synced and closed before it is linked into
place, and the datastore directory is synced after, so a power cut leaves no
marker or a whole one. `initializeV3Datastore` syncs the parent of every
directory it creates before the marker, and creates `commits.db` only after
the marker is durable. A marker an older swamp wrote can still be lost: a
**lost format marker** is a filesystem datastore whose root holds a
regular-file `commits.db` beside no marker, or beside a blank one (empty, or
only whitespace and NUL bytes: a file whose length reached the disk before its
content). `lostDatastoreFormatMarker` (`datastore_format_guard.ts`) only stats
`commits.db`; it never opens it. The guard never opens such a datastore as
format 2, which would write v2 files into it, and refuses it with advice for
where it was met (`lostFormatMarkerAdvice`), keeping the existing codes:

| Lost marker met | Refusal |
|---|---|
| Blank marker, any context | `InvalidDatastoreFormatMarkerError` (`datastore_format_marker_invalid`), its middle advice replaced |
| Missing, config says format 3 | `DatastoreFormatMismatchError` (`datastore_format_mismatch`): run `swamp doctor datastores --repair` |
| Missing, config says format 2 or none, or a datastore override (`SWAMP_DATASTORE`, `--datastore`) | `LostDatastoreFormatMarkerError` (`datastore_format_mismatch`), one advice text: unset the override, then repair in the repository whose `.swamp.yaml` uses it with format 3 |
| Missing, the `datastore setup` target | `LostDatastoreFormatMarkerError`: re-run an interrupted `setup --format 3`, or repair from the repository that uses it |

Every other marker refusal keeps its text byte for byte. Two ways out:

- **Repair.** `swamp doctor datastores --repair` branches to the marker repair
  only after the format guard refused the repository's datastore with one of
  those two codes, under a filesystem config that says format 3, for a
  datastore `lostDatastoreFormatMarker` recognises; any other refusal is
  rethrown unchanged. Without `-y` it previews from stats alone and exits 0.
  With `-y`, `restoreV3FormatMarker` (`v3_datastore.ts`) requires a
  regular-file `commits.db` holding a v3 commit log at a schema version from 1
  to `COMMIT_STORE_SCHEMA_VERSION`, opens it read-write without any DDL (so
  SQLite recovers a write-ahead log a crash left), removes a blank marker and
  writes a new one. A valid v3 marker already there, or written meanwhile by
  another restore, counts as restored. With `--json` it prints one object:
  `{"status": "format_marker_preview", datastorePath, markerPath, marker}`
  without `-y` (`marker` is `absent` or `blank`),
  `{"status": "format_marker_restored", ...}` with the same fields after a
  restore, and `{"status": "format_marker_not_needed", datastorePath}` when the
  marker turns out not to be lost. A failed restore exits 1 with the
  `UserError`'s own code, or `format_marker_repair_failed` for any other
  error.
- **Setup resume.** `datastore setup filesystem --format 3` on a target
  refused for a lost marker resumes when the target is a fresh skeleton
  (`isFreshV3Skeleton`) under a stricter check: `commits.db` a regular file
  with no partition heads and a compaction point of 0, an empty outbox and
  `_blobs/`, and no replication or Litestream directory, so no datastore with
  history passes for one. Two resumes can race past a blank marker: a remove
  that finds the marker already gone is ignored, and a resume whose marker
  write finds a v3 marker another wrote meanwhile syncs the directory and
  goes on, as a racing restore does. A fresh setup still refuses a marker
  that appeared.

A lost marker on a replicated datastore, whose root holds no `commits.db`, is
not recognised (see `datastore-litestream.md`).

**Where it runs.** Before anything locks, pulls, pushes or writes:

- `resolveDatastoreForRepo`, right after the config is resolved. Every
  `requireInitializedRepo*` helper starts there, as do `swamp serve` start-up
  (before hydration and pollers) and the commands that open a datastore
  themselves (namespace, lock, catalog pull, doctor).
- `acquireModelLocks`, for a config resolved some other way.
- `datastore setup filesystem` and `datastore setup extension`, against the
  **target** datastore, before the first write to it.
- Serve's dedicated audit datastores.

A config that passed, or whose check was skipped, is remembered for the rest
of the process, keyed on the config object, so one command pays one read (or
one bounded wait on a degraded remote). A refusal is never remembered. Nothing is cached across
processes: a datastore can be migrated between runs. `swamp worker` never
opens a datastore; it reaches one only through serve.
`integration/datastore_format_guard_rules_test.ts` pins every production call
that builds a sync service or takes a datastore lock, each with the reason it
is guarded.

**For writers.** The S3 and GCS extensions move every root `_control/*` record
into `<namespace>/_control/` on a namespaced push when the legacy namespaced
index `<namespace>/.datastore-index.json` exists, which marks a namespace a
solo datastore was upgraded to (`migrateRootControlPlaneToNamespace`; checked
against `@swamp/s3-datastore` 2026.10.13.1 on ministack, swamp-club#3364). A
push into a namespace that has only the current `_index/` layout moves
nothing. A guarded binary refuses before it pushes, but a binary older than
the guard does not, so a writer of the marker must leave no legacy namespaced
index behind.

**Datastore-wide writes** (swamp-club#3364). `datastoreControlPlaneStore()` may
return a `WritableDatastoreControlPlaneStore`: the same root `_control/`, with
`put`, `putIfAbsent` (create-only), `delete` and `list`, binding no namespace.
The v3 writer lease keeps its records (`writer/`) there, because one
`commits.db` has one writer whatever namespace a checkout syncs, so a
v3-capable provider must return a writable one.
`assertWritableDatastoreControlPlaneStoreConformance` in
`@swamp-club/swamp-testing` checks one: the control-plane store contract
(create-only races, a refused create leaving the record unchanged), the
read-only contract above, the root scope of its writes, and that a record
under `writer/` stays at the root through a namespaced push into a namespace
upgraded from solo, the push that triggers `migrateRootControlPlaneToNamespace`.
The suite cannot create that state itself, so the extension's test supplies
`markNamespaceUpgradedFromSolo` (for S3 and GCS: write the legacy index); the
case is skipped without it. Datastore-wide records must
never move into a namespace: serve's own boot copy takes only the prefixes in
`ROOT_CONTROL_PLANE_IMPORT_PREFIXES`, which exclude `writer/` and
`datastore-format`, and the S3 and GCS extensions must skip `_control/writer/`
and `_control/lineage/` in their move before a bucket can be v3. The
namespaced-push case checks a record under each.

**Declared, not inferred** (swamp-club#3414). A writable store shows only that
the lease's records can be written at the root, not that a namespaced push
leaves them there: an extension could return its existing store before its
move skips `writer/`. So `datastoreWriterLeaseStore` binds the lease only for a
provider that declares `datastoreWideLease: true`, and refuses any other with
a message naming the declaration. The declaration promises only that
`_control/writer/` and `_control/lineage/` are never moved or copied. The
replication lineages (swamp-club#3482) are published under `lineage/`, and one
moved into a namespace would hide the head a restore reads (swamp-club#3507).
The S3 and GCS extensions declare it in the release that carries the skip
(swamp-club#3395), whose writable conformance test must run the
namespaced-push case. The Phase 4 bucket opt-in
binds the lease only through `datastoreWriterLeaseStore`, so it cannot be
enabled against an extension version that does not declare it.

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
  access-control grants and groups, then reloads the policy snapshot. It is
  the one poller that also runs without a sync service: on a v2 filesystem
  datastore the files are shared but each instance's policy snapshot is not,
  so it fingerprints those directories and reloads on a change another
  process made (swamp-club#3371). The other two have nothing to do there: a
  peer's data and auto-definitions are read straight from the shared files,
  and the shared-datastore write tracker (swamp-club#2858) keeps each
  checkout's query catalog current.
- **RuntimeDataPoller** (`subdirs: ["data", "auto-definitions"]`) refreshes the
  `data/` subtree (runtime behavior output), then invalidates the query catalog
  so the next `data.query` rebuilds from the new local files. It pulls
  `auto-definitions/` in the same pull, because a definition a peer creates
  while serve is running is looked up in the local cache: token authentication
  resolves a server token's definition by name on every connection, and worker
  enrollment runs the enrollment token's definition. Without it a token minted
  on one instance was rejected by its peers until they restarted
  (swamp-club#2481).

On a v3 datastore none of the three polls (swamp-club#4120): there is no
sync service, so the access and runtime pollers never start, and the config
poller only hashes the lockfile, its interval kept as the retry for a
reload that failed. Every commit a serve node sees, its own and, on a
follower, the leader's commit feed, keeps it current instead ("Team mode:
forwarding and the commit feed").

None of them pulls `workflow-runs/`. A pull overwrites a local file that
differs from the remote index, and a run saves its record between its pushes
with no gate held, so a pull landing there would undo a save the next push
then never sends. An instance's copy of a run it does not drive therefore
goes stale after boot. Serve's continuation of suspended runs is built for
that: it never refreshes a run record, and a continuation claim in the
control-plane store stops an instance with an old copy from resuming a run a
peer already resumed (see "Continuation claims" in
[workflows](../primitives/workflows.md)).

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
the peer's next pull, it rejects the token as unknown. A worker enrolling on a
peer that already has an enrollment token's record but not its definition is
refused as retryable (`token_not_synced`), and the peer never creates a
definition of its own for the token. The query catalog is
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
`pushChanged()` a `SyncContext` listing the behaviors being worked on:

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

**Per-behavior loop.** `acquireModelLocks` calls `pullChanged()` once
per behavior as it takes each lock. With `scopedSync`, each call's context holds
only the behavior whose lock was taken, so the extension pulls one behavior per
call.

**Push path.** The flush function calls `pushChanged()` once (not per behavior)
under the global lock. With `scopedSync`, the context holds all behaviors,
deduplicated. With `twoPhaseSync`, the push splits into `preparePush` (outside
the global lock) and `commitPush` (under it); see "Two-Phase Sync" below.

**Catalog rebuild invariant.** `synced = true` is set after `pullChanged()`
succeeds on both scoped and full paths, unless it resolved to `0`. It is
returned in `{ flush, synced }` and checked at every call site in `src/cli` and
`src/serve` (21 at last count) to trigger `catalogStore.invalidate()`. It must
never be skipped or moved.

A pull that resolves to `0` changed nothing in the local cache, so the catalog
is still accurate. Skipping the invalidation then avoids a full catalog
backfill, which on a large repo would otherwise run while the per-behavior lock
is held (swamp-club#2553). That makes the `pullChanged` return value part of the
sync contract: the number of local cache files written or removed, `0` only when
nothing changed, and `void` when unknown (treated as changed). The S3 and GCS
extensions return the downloaded count, and neither removes local files during a
pull.

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
3. **Per-behavior path.** `acquireModelLocks` reads `datastoreConfig.namespace`
   and passes it with the `SyncContext` (behavior list). With `namespacedSync`
   advertised, both are passed. With only a namespace (no `scopedSync`), the
   extension gets `{ namespace }` alone.

#### Per-namespace index partitioning

> **Extension design.** This section describes the `@swamp/s3-datastore`
> extension's index design; none of it is implemented in this repo.

> **See also:** The [shard-first index](#shard-first-index) design extends
> partitioning beyond per-namespace to per-behavior shards covering all
> datastore subdirectories and removes the monolithic index.

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
  `src/libswamp/datastores/namespace_list.ts`). A v3 datastore writes no
  manifests: there the list is the namespaces its `commits.db` partition heads
  name, read with a read-only connection, plus the current namespace before
  its first commit (swamp-club#3301). `createNamespaceListDeps` builds the
  listing for the CLI and serve alike.

A manifest that is not valid JSON, lacks string `namespace` and `repoId`
fields, or has a `registeredAt` that is not a string, is never skipped: namespace commands refuse with an error naming the
file (swamp-club#3319). Skipping it would let `datastore setup` treat a
namespace whose owner cannot be read as unclaimed.

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
> `commitPush` touches only the affected per-behavior partition shard(s), so
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

This helps when many per-behavior writers in one namespace run at once. Without
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
2. **Per-behavior locks across both phases**, held from before `preparePush` to
   after `commitPush`. The symmetric drain in structural commands waits for
   them, so a concurrent delete or GC cannot interfere.
3. **Additive merge.** Per-behavior locks keep concurrent writers on separate
   file paths, so their manifests never conflict. `commitPush` merges into
   whatever the index currently holds.
4. **Catalog export before upload.** `.catalog-export.json` is written before
   `preparePush`, so it is uploaded with the files. It is a full snapshot of the
   local catalog, so a concurrent overwrite still gives a correct (more
   complete) result. This avoids an export that changed but was never uploaded.

#### Fallback

Extensions that do not advertise `twoPhaseSync`, or lack
`preparePush`/`commitPush`, keep the single-phase
`pushChanged`-under-global-lock path, with no regression.

### Shard-First Index

> **Extension design.** This section describes the `@swamp/s3-datastore`
> extension's index design and is not implemented in this repo. Core's only
> part is the optional `migrateMonolithToShards?()` method on
> `DatastoreSyncService`, its `MigrateIndexResult`, and the
> `swamp datastore migrate-index` command that calls it.

Even with two-phase sync, `commitPush` reads, parses, merges and rewrites the
whole monolithic `.datastore-index.json` under the lock. On a busy namespace
with a large index, this can take so long that few concurrent writers fit in
the 60-second lock timeout.

Shard-first splits the index into per-behavior shard files under `_index/`, and
`commitPush` reads and writes only the shard(s) it touches. The monolith is no
longer the source of truth during `commitPush`. Lock-hold time depends on the
write size (typically KB), not the index size (possibly hundreds of MB).

#### Partition scheme

Each datastore subdirectory has a partition key strategy:

| Subdirectory              | Partition key pattern                      | Granularity  |
|---------------------------|--------------------------------------------|--------------|
| `data/`                   | `data--{type}--{modelId}`                  | Per behavior |
| `outputs/`                | `outputs--{type}--{modelId}`               | Per behavior |
| `definitions-evaluated/`  | `definitions-evaluated--{type}--{modelId}` | Per behavior |
| `workflows-evaluated/`    | `workflows-evaluated--{workflowId}`        | Per workflow |
| `workflow-runs/`          | `workflow-runs--{workflowId}`              | Per workflow |
| `auto-definitions/`       | `auto-definitions`                         | Single shard |
| `audit/`                  | `audit`                                    | Single shard |
| `telemetry/`              | `telemetry`                                | Single shard |
| `logs/`                   | `logs`                                     | Single shard |
| `files/`                  | `files`                                    | Single shard |

Behavior-scoped subdirectories (`data/`, `outputs/`, `definitions-evaluated/`)
get a shard per behavior. Low-cardinality ones (`audit/`, `telemetry/`, etc.)
get one shard each, since they are small and rarely written concurrently.

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

**Scoped pull** (`pullChanged` with `context.models`): read the relevant
behavior shard(s) from `_index/`. With `_meta.json` at version 2, no monolith
fallback is needed.

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

These rules are convention only; the interface cannot express memory use.
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

**Before migration:** When `_meta.json` is missing or `version: 1`,
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

1. **Before and after the write.** `markDirty` fires before the cache write,
   and again once the write or removal has landed, including one that throws
   part-way (swamp-club#2421). At the first call the file is not on disk yet,
   so extensions MUST NOT act on `relPath` synchronously. Record it as a hint
   for the next `pushChanged`. A push that starts between the two calls can
   upload the old bytes, or re-upload a file about to be removed; the second
   call marks the path again, so a push MUST NOT drop a mark recorded after it
   started.
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

#### `clearDirty()` contract

`clearDirty(relPaths)` is optional (swamp-club#4091). Core calls it after it
undoes writes it had marked: a push refused because its model lock was lost
discards the refused versions and puts back the datastore's copy of each file
(see "Lock Breakglass" below). The marks those writes left would make the next
push delete the new lock holder's files under a marked directory and upload a
stale `latest` marker over the holder's.

1. **Exact keys only.** A mark is dropped when its key equals one of
   `relPaths`. A parent's or child's mark is a different key and stays.
2. **Only marks made before the call.** A `markDirty` that starts during or
   after the call keeps its mark. Snapshot the marks to drop when the call
   begins, as a push snapshots the marks it walks.
3. **Bulk and overflow stay.** Neither flag is cleared.
4. **Nothing remote.** No remote read or write, and no pull watermark change.
5. **Keys as `markDirty` received them**: cache-relative, forward-slash, with
   the namespace prefix when there is one.
6. **Idempotent.** An unmarked path is ignored.

Core treats the method's presence as the capability. `createInMemoryRemote`
models it, and the conformance suite's `clear-dirty` case holds an adapter to
it. `@swamp/s3-datastore` and `@swamp/gcs-datastore` do not implement it yet.

#### `repairUnpushedFiles()` contract

`repairUnpushedFiles({ namespace, dryRun, exact, signal })` is optional
(swamp-club#4112). It recovers files written into the cache behind the sync
service and never marked, which no push sends: before swamp-club#4100 was
fixed, `datastore setup extension` could copy `.swamp/` into a cache whose
sidecar was clean, push nothing and delete the source. A bare `markDirty()`
is not a safe recovery. Its bulk walk drops the pending per-path marks
(recorded deletions among them) and uploads stale copies over newer remote
ones. Marking each file overflows the dirty-path cap into a walk that deletes
remote keys the cache never pulled. So the extension finds and uploads the
files itself, shaped like `repairNamespaceContamination`.

1. **Unpushed** means a regular file (`lstat`; a symlink is never followed)
   that passes exactly the push walk's filter, lies under `{namespace}/` (or
   anywhere outside a foreign namespace's directory when there is none), is
   absent from both the live remote index and the last-synced index, and is not
   recorded as peer-deleted (rule 10). A file in the last-synced index but gone
   from the remote is a peer's deletion, not unpushed.
2. **Local versions the remote lacks are reported, never uploaded.**
   `alreadyPresent` counts files absent from last-synced whose key the remote
   holds, as an entry or an unindexed object, with other bytes. Two counts
   compare with the last-synced index, never the live remote, so a stale copy
   is not a local change:
   - `locallyModified` counts files that differ from their last-synced entry;
   - `unknown` counts entries with no sha256 whose size matches and mtime does
     not, when `exact` cannot settle them.

   `peerDeleted` counts files recorded as peer-deleted (rule 10).
   `remoteMovedOn` counts last-synced keys the remote has since changed, for
   information only. Each count is computed on its own.
3. **`dryRun` mutates nothing** and finds unindexed objects with one listing
   of the namespace prefix.
4. **`exact`** hashes a file whose mtime differs from its last-synced
   `localMtime`, and settles an `unknown` entry by a streamed hash of the remote
   object when the remote entry is unchanged since last-synced.
5. **Shard index only.** A v1 monolith is refused, pointing at `swamp datastore
   sync --pull` and then `swamp datastore migrate-index`.
6. **Create-only uploads.** Each unpushed file is uploaded with a conditional
   create that records its sha256 (S3 `If-None-Match: *`, GCS
   `ifGenerationMatch=0`). Index entries for the created files are committed
   in batches through the shard compare-and-swap. There is never an
   unconditional write: an endpoint without conditional create rejects. A 409
   conflict, or a refused create that left no object, is retried up to a fixed
   limit.
7. **Refused creates are settled in the same run.** An object at the key whose
   sha256 matches the local file is an earlier upload of ours, and is indexed.
   Any other object is `alreadyPresent`, and the remote is left as it is.
8. **Pending work is untouched.** Nothing is deleted. Dirty state is never set
   or cleared, so an upload helper that marks the cache dirty is not reused; it
   is read only to report `pendingChanges`. The sync fingerprint (commit
   sequence, index ETag, last-verified time) never advances. The uploaded
   entries are merged into the on-disk last-synced index.
9. **Failures.** Without a last-synced index, reject rather than guess.
   Batches already committed stay committed.
10. **Peer deletions are recorded.** A pull drops a key a peer deleted from
    the last-synced index but may keep the local copy: releases up to
    2026.10.01 never removed copies, and current ones keep an edited or marked
    copy, or every copy when the peer deleted the last file in scope. That
    copy is then absent from both indexes, like a file written behind the sync
    service, and uploading it would bring the peer's delete back to every
    cache. So an extension that implements the method also records, whenever
    any operation drops a key from the last-synced index while a regular file
    stays at its path, that key in a peer-deleted record persisted in the
    cache (an internal file the push walk skips). It forgets a key once the
    remote holds it again or the local file is gone. A path under a file that
    replaced its directory has no file: that error is absence, not a failure,
    or every later pull fails on it. A recorded file counts in
    `peerDeleted`, never in `unpushed`, and is never uploaded. A delete this
    cache pushed leaves no local file, so it is not recorded, unless the push
    deleted a file still on disk (a directory taken as absent).

Limits: a delete pulled before the extension kept the peer-deleted record left
none, so a copy an earlier release kept still reads as unpushed. A file pulled
only by a models-scoped pull is recorded in last-synced
only once the extension merges scoped pulls into `.datastore-index.json`.
Files the remote already holds with other bytes are reported, never recovered.
If a peer's unconditional upload overwrites a key just created and the peer's
commit then fails, the index entry describes the peer's bytes.

`createInMemoryRemote` models the method; the conformance suite's
`repair-unpushed` cases hold an adapter to it. `@swamp/s3-datastore` and
`@swamp/gcs-datastore` implement it from `2026.10.30.1`
(`UNPUSHED_REPAIR_MIN_EXTENSION_VERSION`). That release also records scoped
pulls in last-synced and keeps the commit sequence monotonic
when `migrate-index` or contamination repair rebuilds the index.

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
for a write or remove and `markDirty()` for bulk. It keeps the timing (a signal
before each write and one once it has landed) and the order of bulk and
per-path signals, and never batches or deduplicates.
`commit` waits for any stage still in flight, runs once, and spends the unit
even when it fails.

Repositories route their signal through `withChangeSignalled`
(`src/infrastructure/persistence/unit_of_work_scope.ts`), which sends each
change through `signalChange` before the write runs and, on v2, again once it
has settled, even when it throws (swamp-club#2421). The signal before keeps a
v3 unit's pre-write check and leaves a path marked if the process dies
mid-write. The signal after is skipped for a hook that requires a unit (v3):
the commit-log unit already holds the change. The data and output
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
unit is bound to the repository's own hook instance in the unit-of-work binding
registry (see "v3 commit-log unit of work" below; until swamp-club#3240 only the
legacy adapter could bind a unit). A unit belongs
to one repository context, so a second context in the same process (side-by-side
repos, namespace migration) never hands it its changes. Otherwise the repository
calls its hook as before, and with no hook (filesystem datastores) it does
nothing. The scope is an `AsyncLocalStorage` store, so concurrent operations
each see their own unit, and a promise started inside a scope keeps it after the
scope returns. A write that lands after its unit committed is rejected. No
production code opens a scope yet (pinned empty in
`integration/datastore_write_seams_rules_test.ts`): the flush paths still push,
and nothing else changes. Phase 2 opens scopes from use cases.

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
  commit is a Phase 3 decision. `root.checkpoint({ signal })` passes the
  signal to the option and resolves with what it resolved with, so a caller
  that bounds the push can abort it and read the count of files pushed
  (swamp-club#3192). `currentRootUnitOfWork(markDirty)` returns the root
  opened around the current call over that exact hook (a nested call's
  child sees the outer root), for code that publishes through its
  operation's root without being handed it.
- **CLI commands in root units (swamp-club#3033).** Every CLI write command
  runs its write section in `runCommandInRootUnit`
  (`src/cli/command_root_unit.ts`), whose flush is the push the command made
  before, at the same point:
  - Behavior-lock commands split `ModelLockResult.flush()` into `push()` and
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
  is the post-run push under the gate's shared mode. Each step's behavior lock
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
  handlers that push only after a successful reply (behavior, vault and workflow
  create, edit and delete, and `vault.migrate`) run their work in a root whose
  flush pushes only once that reply was sent. A root always commits there,
  because those handlers answer their own failures, so the flush checks the
  reply rather than the outcome. `model.method.run` runs the run in a root
  whose flush is its push under the gate's shared mode, once the run completed
  (a use case that reports an error still completes). A run that took behavior
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
  - Serve `model.method.run` makes the behavior lock's push its root's flush on
    every outcome and releases the lock after the root. The reply, telemetry,
    cancel or run deregistration and stream terminal keep their place: before
    a lock's push, and around the no-lock push as before.
  - The CLI commands that pushed only at the `flushDatastoreSync()` teardown
    (workflow delete, data gc, data prune, run gc, the `--all` evaluates,
    model validate with check options, datastore compact) run in
    `runInCoordinatorRoot` (`src/cli/coordinator_root.ts`), whose flush is
    the global lock's coordinator push (`pushGlobalLockAtEnd`). As at
    teardown, a push timeout is thrown after a completed command and dropped
    after a failed one. `workflow evaluate` with dynamic behavior references
    gives that push to the root it already opens, since a second root would
    nest. The teardown stays as a safety net and finds nothing left to flush.
  - Per-step behavior locks inside a workflow run keep `ModelLockResult.flush()`
    (push, then release): the step's lock owns its push and release, and Phase
    3 replaces behavior locks with leases.
  - The push functions live in `src/infrastructure/persistence/push_paths.ts`
    (`pushNamespace`, `pushNamespaceCounted`, `pushModelLockScope`,
    `pushGlobalLockAtEnd`); commands
    and handlers pass them as a flush or checkpoint and never call
    `pushChanged` themselves. `PINNED_DIRECT_PUSHES`
    (`integration/datastore_write_seams_rules_test.ts`) lists every production
    `pushChanged` call: the push paths, the coordinator, and the deliberate
    exceptions (`datastore sync`, `datastore setup`'s migration push, serve
    start-up and token GC, serve background GC). In
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
    root's flush: serve bookkeeping GC, server-token GC and serve shutdown's
    run interrupts (swamp-club#3252). The rest run in a
    root with no flush, which forwards each mark to the hook at once and
    pushes nothing, as before: the device-auth mint, `access.reload` and the
    grant commit (their writes, before the root `stageWritesThenPush` already
    opens for the push), serve boot reconciliation and its continuous tick,
    the OAuth collective refresh's token
    updates and revokes, `model.validate` (whose behavior checks receive the
    hooked repositories), `run.doctor`'s fix, worker data-plane writes and
    capability deletes, and the CLI's
    `workflow cancel`, `workflow recover`, `behavior cancel` and `run doctor`.
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
(`behavior create`, `workflow create`, `vault create`, `vault migrate` on the
CLI), read-only contexts, and commands with no repository context. Their writes
have no hook to bind to, so nothing changes for them.

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
- The serve start-up definition migration, which marks each moved file by path
  (`serveCommand` in `src/cli/commands/serve.ts`).
- The namespace catalog export, marked by path after it is written before a
  push (`writeCatalogExportIfNeeded` in `src/cli/repo_context.ts`).

`buildMarkDirtyHook` in the same file is pinned too, but it is the hook itself,
not a hand mark.

Serve's device auth, grant tracking and access reload stage their marks
through a root (swamp-club#3034).

**The extension lockfile publishes through a root's checkpoint
(swamp-club#3192).** `ManagedLockfileTransaction`
(`src/libswamp/extensions/managed_lockfile_transaction.ts`) runs each
outermost `run` inside a root unit of work, which its `inRoot` option opens
around the lock's acquire and release. A nested `run` joins the outer one and
its root. Its publish, `createRootLockfileSync`, stages one write of exactly
the lockfile into that root (found with `currentRootUnitOfWork` by hook
identity) and pushes at the root's checkpoint, bounded by the datastore's sync
timeout, before the global lock is released. With `mustUpload`, a checkpoint
that reports sending nothing rejects. A publish with no root throws
`LockfilePublishWiringError` rather than push by hand. It is never wrapped as
an unpublished change or deferred to a warning, so a wiring mistake cannot
read as a datastore failure. The roots have no flush, so the checkpoint is the only
push:

- CLI (`buildManagedLockfileTransaction` in `src/cli/managed_config_sync.ts`):
  a root over the transaction's own mark hook per outermost run, whose
  checkpoint is `pushNamespaceCounted`. It is per run, not per command,
  because the extension commands resolve the datastore only on their first
  lockfile use. A CLI `extension rm` or `update` therefore opens two: the
  refresh before it reads the lockfile, and the change.
- Serve (`extensionLockfileTransaction` in
  `src/serve/handlers/admin_handlers.ts`): a root over `repoContext.markDirty`
  itself, inside the handler's exclusive sync gate, with the same checkpoint.

The pending record, the replay of an earlier unpublished change, the CLI's
`throw` and serve's `defer` on a failed publish, and the errors and codes are
the transaction's own and did not change. swamp-club#2865 has the reasoning.

**Serve handler obligation.** Serve code never calls a bare `markDirty()`.
Mutations that go through repositories with per-path `markDirty` wired
(behavior, workflow, data, output, definition and vault config repos) rely on
the repositories' signals. This covers the mutation handlers, the OAuth
server-token mint in `device_auth_handler.ts`, and `access.reload`, which
reconciles grant files through the definition and data repos. `vault.create`,
`vault.edit` and `vault.migrate` write through serve's shared vault config
repository (swamp-club#2995). `vault.migrate` removes the old config through it
too, so the scoped push deletes the remote copy. Otherwise the config poller
would bring it back as a second config with the same name. The per-path signals
are enough, and they drive the extension's scoped walk, which detects deletions
by absence on disk (rule 2). A bare `markDirty()` sets `bulkInvalidated` in the
extension and overrides the per-path signal. That has two costs:

- **Dropped deletions.** The full walk skips deletion detection unless the
  per-path set overflowed, so remote deletions are silently lost
  (swamp-club#2273).
- **A full-cache push.** The push rebuilds the index from every remote shard
  and hashes every cached file. On a cache filled by pulling, a change to a few
  files then costs time proportional to the whole cache. On the login mint this
  made every `swamp auth server-login` slower as the datastore grew
  (swamp-club#2408), and every vault or access change did the same
  (swamp-club#2415).

The repositories used to mark a path dirty only before they wrote it, so a push
could land between a repository's mark and its write. That push found the path
absent (or its old bytes), treated it as a delete (or uploaded the old bytes)
and cleared the mark, and the writer's own push then had nothing to upload.
Serve's gate now keeps run pushes (shared mode) out of every handler mutation
(exclusive mode), so a run finishing at the same moment can no
longer do this to a gated handler (swamp-club#2405). Concurrent runs still
share the gate and can still do it to each other. The OAuth mint and
`access.reload` also re-mark their paths, by path, after the writes and just
before `pushChanged()`: the mint for the token's definition file and data
folder, `access.reload` for each grant definition it created and each grant data
folder it wrote. A reload that changes nothing marks nothing, so its push takes
the fast path. With an extension older than 2026.10.24.2, a push already
running when the re-mark lands still clears it, because that extension resets
the whole dirty set when a push completes.
swamp-club#2421 has two halves. Core now marks before and after every
repository write and remove (`withChangeSignalled`), so a push that cleared
the first mark mid-write leaves the second one for the next push. The
extension half ships in `@swamp/s3-datastore` and `@swamp/gcs-datastore`
2026.10.24.2 (swamp-club#3860): each mark gives its path a new generation, a
push snapshots the marks it walks, and its commit clears only those whose
generation is unchanged, so a mark made while a push runs survives it. A push
no longer bulk-marks itself, so a failed scoped push keeps its path marks and
its recorded deletes (swamp-club#2907). A file that vanishes mid-walk is
skipped and stays marked, a dangling symlink is skipped, and atomic-write
temp files are never walked. With an older extension, a push already running
when the second mark lands can still clear it. The re-marks above stay: they
mark again just before the push they precede.

**Data versions written under a behavior lock (swamp-club#3146).** Concurrent
runs of one serve process share its sync service, so another run's push can
clear the marks of a version a step just wrote, and a pull (another run's
step-start pull, or the poller) can put the remote's older `latest` marker back
over the step's unpushed one. Both lost versions silently. The lock's push now
publishes what the work under it wrote and checks it landed:

- Each step and method run reports the data versions it wrote: the step's
  saved artifacts, the versions a failed in-process method left
  (`error.dataHandles`), and those a worker wrote before its dispatch failed,
  which the data plane records per dispatch and the dispatch error carries as
  `writtenVersions`. The list reaches the lock's push in process only
  (`StepLockResult.flush(written)`, `ModelLockResult.pushWritten`, and
  `ModelMethodRunDeps.onWrittenVersions` for method runs), never the event
  stream.
- Before each push, per data name, the highest written version still on disk
  has its `latest` marker moved forward again if a pull reverted it
  (`UnifiedDataRepository.reassertLatestVersion`, never lowering it), and its
  version directory and marker are staged again, after the write, so a commit
  that cleared the earlier marks cannot drop them. A version deleted, garbage
  collected or rolled back on purpose is skipped.
- After the push, while the behavior lock is still held, the push reads the
  version's `metadata.yaml` and the `latest` marker back with `fetchContent`. If
  either is missing or behind it repeats, up to `PUBLISH_ATTEMPTS` rounds, then
  fails with `UnpublishedDataVersionError`. A step or method run that already
  failed keeps its own error and logs this one; a serve method run, which
  answers its client before it pushes, logs it. A read that fails or times out
  leaves the push unverified, with a warning, rather than failing work whose
  push succeeded. The reads run eight at a time. A namespaced datastore whose
  root data is still migrating pushes nothing on the first round and converges
  on the next, because each round marks again. A sync service without
  `fetchContent` gets one unverified round.

What stays exposed until the S3/GCS extensions clear only the marks a push
handled and stop overwriting paths with a pending mark:

- In serve and in a CLI workflow run (swamp-club#3860), the run lanes keep a
  run pull out of every run push, so a pull can no longer revert a marker,
  locally or on the remote, after a push verified it. Two processes sharing one
  cache (a CLI next to serve, or two CLI runs) are not covered: there a pull can
  still do both.
- Run records, evaluated definitions, output records, definition YAML and
  appends to an existing version can still be reverted locally by an
  overlapping pull; only data versions are verified.
- A published version a peer's GC or a 404 cleanup drops from the remote index
  can be deleted locally by a pull despite a directory mark, and the push then
  treats it as removed on purpose.
- A worker data-plane request still running when a failed dispatch's bounded
  wait (`DISPATCH_WRITES_SETTLE_TIMEOUT_MS`) expires is not reported.

**Writes outside a hooked repository.** Some serve mutations write cache files
that no hooked repository covers. Each marks exactly those files, by path, after
writing:

- The extension handlers (`extension.install`, `pull`, `rm`, `update`) change
  the config-tier lockfile inside a managed lockfile transaction, which stages
  exactly the lockfile into the root unit of work it opens for each run (the
  handlers themselves run outside any root) and pushes at that root's
  checkpoint under the datastore global lock (see
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
transaction, which stages the config-tier lockfile by path into its root and
pushes it at the root's checkpoint, bounded by the datastore's sync timeout,
instead of the bulk mark that
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
  each step's behavior-lock pull and flush push (serve passes
  `acquireModelLocks` a `wrapSync` hook, normally through `createStepLockHook`),
  and the post-run and post-resume pushes of `workflow.run`, `workflow.resume`,
  `model.method.run`, scheduled, webhook and auto-resumed runs. Shared holders
  exclude poller pulls and handler mutations but not each other, so fan-out
  workflows keep their parallel uploads. The `wrapSync` hook covers only the
  sync calls, never the behavior-lock wait.
- **Run lanes** inside the shared mode (`RunSyncLanes`, swamp-club#3146): run
  pulls and run pushes exclude each other, first come first served, while
  holders of one lane run together. Without them a step-start pull that read
  the remote's older `latest` marker before another run's push committed wrote
  it over the local marker after that push had verified it, and the next upload
  of the marker published the older version again. A lane wait degrades like
  the gate after `GATE_WAIT_TIMEOUT_MS`. A behavior lock's last publish attempt
  runs alone: `wrapSync` is called with `push-alone` and serve takes the
  exclusive mode (`withRunSyncGate`), so a run whose earlier attempts other
  pushes undid still publishes under heavy fan-out.

The fitness test in `integration/serve_deps_rules_test.ts` fails the build if a
serve function pushes outside the gate: a raw push outside a
`withSharedSyncGate` span in a function not gated at dispatch, or an
`acquireModelLocks` call without `wrapSync`. The only exemptions are pinned in
`UNGATED_PUSH_HANDLERS`: startup hydration and the gate's own plumbing.
`createStepLockHook` and `executeWorkflowWithLocks` take the gate as a required
parameter, so the compiler also catches callers outside `src/serve`, such as the
scheduler in `src/cli/commands/serve.ts`.

**A CLI workflow run gates its own steps (swamp-club#3860).** The steps of one
`swamp workflow run` or `swamp workflow resume` share that command's sync
service, so the same undo happens inside a single run: a parallel step's commit
clears the marks another step just staged, and before #3860 nothing kept the
step's last publish attempt apart from its siblings. Each command now builds its
step lock hook with `workflowStepLockHook` (`src/cli/commands/workflow_run.ts`),
which creates one gate per command and passes it to `createStepLockHook`. A
run's steps take the shared mode in their lanes, and a lock's last publish
attempt takes the exclusive mode, as in serve. The gate is per command, so two
CLI processes on one repository still do not exclude each other. A fitness rule
in `integration/serve_deps_rules_test.ts` pins that every CLI step lock hook is
built this way. Since the last attempt normally runs with no other sync in the
process (a gate wait that times out goes ahead ungated),
`UnpublishedDataVersionError` names the likely causes left: another swamp
process using the repository, or a datastore that did not keep the files.

Six properties of the gate are easy to misread:

- **Not reentrant.** Acquiring it inside an exclusively gated handler waits on
  itself until `GATE_WAIT_TIMEOUT_MS`. A second fitness rule forbids a
  dispatch-gated handler from taking the shared mode or building a step-lock
  hook. `workflow.approve` launches auto-resume detached and never awaits it.
- **Lock order: behavior lock before gate, never the reverse.** A run step holds
  its behavior lock while it waits for the gate. That is safe only because no
  gate holder ever waits on a behavior lock: no dispatch-gated handler takes
  one, and libswamp takes no datastore locks. Keep it that way.
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
  the pre-gate path instead of stalling the server. A poller never falls back:
  it skips the cycle, so the pull side of the race never runs ungated. Runs wait
  on a poller only during its escalated cycle, and only for as long as the
  pushes already ahead of it (at most `GATE_WAIT_TIMEOUT_MS`).

**Sync is not a content-integrity tool.** The fingerprint detects index changes,
not per-file corruption. A damaged cache file (bit rot, a truncated write after
a crash) can pass the fast path if the index is unchanged. Integrity is the
verifier's job: use `DatastoreVerifier.verify()`, or `rm -rf` the cache and
re-pull.

### v3 domain model (datastore rework Phase 3)

v3 replaces "write a file, mark it dirty, push later" with explicit commits. A
single writer records each commit in `commits.db`, and content is stored as
immutable, content-addressed chunks. The CLI's embedded datastore service is
the writer in solo mode, and the elected `swamp serve` leader in team mode.
swamp-club#3233 adds the domain model this builds on, in
`src/domain/datastore_v3/`. It is pure, in-memory domain code, and nothing in
production imports it yet: `integration/datastore_v3_rules_test.ts` pins its
importers to an empty list. It is a bounded context of its own, beside
`src/domain/datastore/`, because it builds on the `models`, `data` and
`workflows` contexts, and those already import `datastore`: inside it, the
model would close three context cycles
(`integration/architecture_boundary_test.ts`). swamp-club#3236 adds the
commit store (see "v3 commit store" below), swamp-club#3237 the chunk store
("v3 chunk storage"), swamp-club#3240 the commit-log unit of work ("v3
commit-log unit of work") and swamp-club#3239 the read model ("v3 read
model"), all dormant. The opt-in is a later issue.

**Ubiquitous language.**

- **Partition**: the storage of one aggregate instance. Consistency between
  partitions is eventual.
- **Commit**: one transaction on one partition. Its ops apply together or not
  at all.
- **seq**: a partition's commit counter. It has no gaps: a partition accepts
  only its current seq plus one.
- **Intent**: the domain operation an op performs (`data.save`,
  `grant.revoke`, …). Serve authorises on the intent, never on the path.
- **Op**: one change in a commit: `put`, `tombstone`, `data-version` or
  `lease`.
- **Record key**: the namespace-relative path an op projects to, in today's
  cache layout. It is used only to materialise real files.
- **Blob**: content stored as chunks, referenced by `{ sha256, size }`, plus
  `parts` when it spans more than one chunk.
- **Chunk**: an immutable piece of content addressed by its SHA-256.
- **Fence**: a lease's monotonic number. A writer whose fence is stale loses.
- **txnId**: the id a commit's group keeps from when it forms: its commit
  outbox entry's key. A retry carries the same one, so the commit lands once.
- **High-water mark**: the greatest version a data name ever had. It never
  decreases, and it is the floor for new versions: a v3 write allocates above
  it (swamp-club#3532).
- **Removed versions**: the versions a data name recorded and then removed,
  kept per name as merged ranges. None is ever recorded again.
- **File access**: what a put records about its file besides the bytes
  (swamp-club#3693): `executable`, `private` or `private-executable`, absent
  for a plain file. See "What a materialised file keeps".

**Partitions are aggregates.** A partition key is built only by
`partitionOf()` (`partition_key.ts`) from the identity of the aggregate it
stores. A fitness rule rejects partition-key literals anywhere else.

| Aggregate | Partition key | Contention |
|---|---|---|
| `Model`: data names and versions, outputs, the evaluated definition. Grants, groups, server tokens, enrollment tokens and workers are behaviors of their `swamp/*` types. | `model--{type}--{modelId}` | Real: a lease (Phase 5) |
| `WorkflowRun`, with its jobs and steps | `run--{workflowId}--{runId}` | None: each run gets a new id |
| `Definition`: a behavior, workflow or vault under managed config, with its evaluated workflow | `config--{model\|workflow\|vault}--{name}` | Real: optimistic concurrency (`expect`) |
| The managed-config extension lockfile | `config--lockfile--upstream_extensions` | Real: optimistic concurrency (`expect`) |
| `AutoDefinition` | `definition--{id}` | None: each gets a new id |

Content chunks contend with nothing, because a chunk's identity is its
SHA-256.

**Ops and the commit envelope.**

- **`Commit`** (`commit.ts`) carries:
  - `v: 3`, the `seq`, the partition and the namespace;
  - the `txnId` and the writer (`host`, `pid`, `instance`);
  - optional `executedAt`, `clockOffsetMs`, `principal` (set by serve only)
    and `fence`;
  - `at`, and between 1 and `MAX_COMMIT_OPS` (10,000) ops.
- **Ops** (`op.ts`) are built by factories, never as literals.
  - **`put`** carries a `BlobRef` or up to 8 KiB of inline content, as
    canonical base64. `putOp()` computes the SHA-256 of inline content. The
    serialized form leaves that digest out, and `Commit.fromJSON` recomputes
    it, so a stored digest can never disagree with its bytes.
  - **`tombstone`** names one key; there are no prefix tombstones.
  - **`data-version`** carries the version's `DataMetadata`, and is allowed
    only in a model partition.
  - **`lease`** carries a holder and a fence.
- **The intent's partition.** Every `put` and `tombstone` intent must belong
  to the commit's partition (`intentPartition`).

**The partition's rules.** `Partition.append` (`partition.ts`) keeps these.
It is synchronous, and a refused commit leaves the partition unchanged:

- **Partition, then duplicate.** A commit for another partition is refused
  first. A commit whose `txnId` the partition holds is then a no-op, checked
  before seq, so a retry of a commit that landed is harmless even though its
  seq is now behind. Identity is the txnId alone: the payload is not
  compared.
- **seq has no gaps.**
- **Fences never go down.** A commit whose fence is below the partition's
  highest is refused (`stale-fence`). A lease op carries a model lease's
  fence, counted per partition apart from the writer's (swamp-club#4121): one
  below the partition's lease fence is refused (`stale-lease`), and the two
  never compare. Once a partition has seen a
  fence, a commit without one is refused too (`unfenced`), so a writer cannot
  slip past fencing by leaving it out. Every v3 writer holds a fence: the
  writer lease under `_control/writer/` carries it in solo mode
  (swamp-club#3359, **v3 writer lease**), and the leader lease in team mode
  (swamp-club#3234,
  `design/enablers/datastore-litestream.md`). Only a partition that has never
  seen a fence accepts an unfenced commit.
- **`expect` must hold.**
  - `put` with `expect: "absent"` creates only.
  - `put` with `expect: { sha256 }` edits the version it was loaded from.
  - `tombstone` with `expect: "present"` removes only a record that exists.
  - Ops in one commit see each other's effects in order.
- **A data version is recorded once** (swamp-club#3250 and swamp-club#3532;
  they replaced "data versions only grow" from swamp-club#3233).
  - A `data-version` op's version must not be live for its name, or the
    commit is refused with `version-live`: two writers claiming the same
    live version are refused.
  - Nor may it be a version the name recorded and then removed, or the
    commit is refused with `version-reused`, so one version number never
    names two contents, even on a clone that pulled the old one. A versioned
    `data.delete` or `data.gc` tombstone of a live version adds it to the
    name's removed versions, which snapshots keep (as `removed` ranges, absent
    when none, so older snapshots still restore). The field came with
    `commits.db` schema 6: a swamp at schema 5 would reject it as unknown
    and call the store corrupt, so it refuses the store as newer instead
    (`datastore_v3_schema_newer`). Every checkout of a v3 datastore upgrades
    together.
  - Versions may still arrive out of order: parallel writers of one name,
    and a deferred version promoted after a higher one committed, record a
    version below the high-water mark that was never recorded.
  - A rebuild replays stored commits without the `version-reused` check: a
    store written before it may hold a reused version, and its commits were
    accepted under the rules of their time. Every other rule still applies.
  - The one exception is an append: a `data-version` op may re-record a live
    version when a `data.append` put for that name and version comes earlier
    in the same commit. Each such put lets one op through, so a save of a
    live version ahead of an append in the commit is still refused. Its
    metadata (the new size) replaces the version's. The append's
    `metadata.yaml` put carries `expect: { sha256 }` of the metadata it
    replaces, so a version another writer recorded under the same number
    refuses the append (`expect-failed`) instead of being overwritten.
  - A tombstone whose intent is `data.delete` or `data.gc` with a version
    removes that version. A delete of a whole name lists each version it has
    seen as its own versioned tombstone, so a version written concurrently
    survives. A version-less `data.delete` is only for keys that carry no
    version (the latest marker, the name directory).
  - A rename is one model-partition commit: a `data.rename` put, a
    `data-version` op for the new name, and a `data-version` op for the old
    name's marker version (the version carrying `renamedTo`), which is not
    live.
  - Each name's latest is its greatest live version, so exactly one latest
    per name holds by construction. The partition reads names and versions
    from intents and metadata, never by parsing a record key.

**Decisions.** The commit store, the chunk store and the opt-in build on
these.

1. **From staged changes to commits.** A path alone cannot become a commit:
   the commit needs the intent serve authorises on and the content the
   partition records. Repositories on a v3 datastore stage typed changes
   (`TypedChange`: a partition and an op, or a partition and a put whose
   content the unit stores at commit) through `CommitLogUnitOfWork`
   (`commit_log_unit_of_work.ts`). It is a sibling port that extends
   `UnitOfWork` with `stageOp`, `stagedOps` and `checkpoint`. `StagedChange`,
   its callers and the legacy adapter are unchanged.
2. **How a commit-log unit claims a repository context.** Before
   swamp-club#3240 `signalChange` staged into the ambient unit only when
   `legacyUnitOfWorkTarget(uow)` was the repository's own hook, which
   recognised legacy units alone. A binding registry (`UnitOfWorkBinding`)
   generalises it: each adapter binds the units it builds to the hook of the
   context they serve, and `signalChange` asks the registry. The legacy
   adapter becomes one registrant and the commit-log adapter another.
3. **Unscoped writes are refused on v3.** On v2, a hooked write outside every
   unit still marks the hook (route 2 in `signalChange`); its removal is
   deferred. A v3 datastore has no such fallback, so the commit-log adapter
   refuses a write outside a unit rather than drop it. That includes a hooked
   repository write inside the CLI's managed-lockfile root, which is bound to
   the transaction's own hook (swamp-club#3192), so such a write would count
   as unscoped. The lockfile's own write is a typed `lockfile.write` op in
   that root.
4. **Abandon discards.** A legacy unit's changes have already reached the
   hook, so it flushes on abandon. A commit-log unit discards its staged ops
   instead. Content it already wrote as chunks stays as unreferenced chunks,
   which chunk garbage collection reclaims; a chunk is never referenced
   before the commit that names it lands.
5. **Run outcomes.** A workflow run's unit commits its partitions when the
   run ends `completed`, `failed`, `suspended` or `cancelled`:
   - a suspended run must be durable to resume;
   - a cancelled or failed run's record is its outcome.

   A unit ended by a throw or an early stop discards, except a `completed`
   stream followed by `return()`, which counts as success. A use case that
   reports an `error` commits since swamp-club#3279, which reversed this
   part of the decision: a failed method run reports one, and v2 publishes
   its record. The risk is that a half-updated aggregate, such as a run
   record a persistence error left `running`, becomes durable history, as
   v2 publishes it. `completed` is
   the status `WorkflowRun` records as `succeeded` (swamp-club#3257). An
   `interrupted` run does not commit through its own unit: the run's unit
   never ends that way, since shutdown and the reapers record it from
   another path.

   Since swamp-club#3587 the run also checkpoints as it saves its record
   (decision 6), so a run is committed up to its last checkpoint and
   only the writes after it are discarded: by an early stop, a throw, a
   refusal or a crash. A run whose consumer stops before an outcome
   therefore stays committed as `running`, as v2 leaves its file; serve
   lives on after a client disconnects, so such a run is settled when
   serve restarts, as on v2.
6. **Checkpoints.** `checkpoint()` commits each partition touched so far, in
   the order of decision 7, and keeps the unit open. Later changes to the
   same partitions go into later commits. A workflow run checkpoints as it
   saves its record (`WorkflowRunCheckpointer`, swamp-club#3587): a save
   checkpoints at once when none started in the last two seconds
   (`RUN_CHECKPOINT_INTERVAL_MS`), and otherwise one trailing checkpoint
   starts when that interval ends, so the latest save lands within about
   two seconds and a crash loses at most that much of the run. One per save
   would store the whole record each time, and the record grows with every
   step: a 200-step run stored 80 MiB of chunks instead of 0.86 MiB
   (`scripts/bench_v3_workflow_checkpoint.ts`). A checkpoint
   (`checkpointFrom`) hands what the run's open units have staged up to the
   root, and the root checkpoints. Each staged batch is whole, so a
   checkpoint never splits a record; a batch a step still running has
   staged commits with it, as its file is on disk on v2, and that step's
   record says `running`.
7. **No atomicity across partitions.** Each partition commits on its own. A
   workflow run that writes several behaviors commits the data partitions
   first and the run record last, so a run record never names data that has
   not landed. A refused data partition holds the run record back until the
   run is saved again with the steps that wrote it failed ("Run records and
   refusals" in "v3 commit-log unit of work", swamp-club#3257).

**Decisions found while building the model.**

- **Key encoding.** The type and name segments are percent-encoded, keeping `@`:
  `model--swamp%2Fgrant--<id>`. Ids are lowercased, so one aggregate never
  splits into two partitions by letter case. A normalized behavior type keeps
  `/` and `@`, and a definition name may hold `/` (scoped `@collective/name`) or
  `--`, so flattening `/` to `-` would give `a-b/c` and `a/b-c` one key.
  `partitionOf` takes a `ModelType` and uses its normalized form, so every
  spelling of a type gives one key. `@swamp/grant` and `swamp/grant` are
  distinct normalized types, and so distinct partitions, as their paths are
  today.
- **No ULIDs.** Every id swamp generates is `crypto.randomUUID()` (UUID v4,
  122 random bits), which already cannot collide, and the run, workflow and
  data id schemas require a UUID. A partition orders its commits by seq, so
  ids need not sort by time. `WorkflowRunFactory`, `DefinitionFactory` and
  `ModelOutputFactory` (`identity_factories.ts`) reuse that generator.
- **Version numbers never go back** (swamp-club#3532). swamp-club#3250 let v3
  follow v2's allocation, `max(existing) + 1` on disk, which reused a number
  after `delete(name)`, `data prune`, retention or a top-version delete, and
  let a writer behind on catch-up re-create a deleted version. Allocation now
  reads the floor from the commit store, which is current under the writer
  lease: `max(versions on disk, the name's high-water mark, the greatest
  version this process handed out) + 1`, with the `mkdir` claim as before.
  The in-process part covers versions staged but not committed yet (in the
  same unit, a sibling unit or a deferred write). The seam is the unit's
  version-floor source (`versionFloorSource`), found the way `stageTyped`
  finds its stager, so hookless repositories reach it too, and
  `CommitSink.dataHighWater` reads the mark, rebuilding a partition another
  process changed. Out-of-order arrival stays legal, and `version-reused`
  backs the allocation up.
- **Aggregate-specific rules stay with their aggregate.**
  - A partition sees op content as opaque bytes.
  - `WorkflowRun` keeps its own status-transition and step-ownership rules
    and enforces them before it builds ops.
  - Admin-only changes to grants and groups are enforced by serve, which
    authorises on the intent.
- **Renames span two partitions.** A definition partition is keyed by name,
  because the files are laid out by name and `expect: "absent"` on the name
  catches concurrent creates. A rename (vault edit can rename) is two
  commits, in order:
  1. a `definition.rename-to` put with `expect: "absent"` in the new name's
     partition;
  2. a `definition.rename-from` tombstone with `expect: "present"` in the old
     one.

  A crash between them leaves both names until a repair. Readers resolve the
  definition by its id.
- **The lockfile is a partition.** The managed-config extension lockfile is
  datastore-synced today and has real contention, so it is a single-instance
  partition written by `lockfile.write` under optimistic concurrency.
- **What stays outside the commit log.** These writes get no intent, because
  the datastore never syncs them:
  - bundles and pulled extension sources (`ALWAYS_LOCAL_SUBDIRS`,
    swamp-club#2612);
  - the repo marker and datastore config;
  - sources;
  - vault secrets, which go to the vault provider;
  - control-plane store keys (signal waits, heartbeats, webhook state, and
    serve's audit events);
  - the stream directories `audit/`, `telemetry/`, `logs/` and `files/`, and
    run logs, which stay repo-local (swamp-club#3278, "v3 stream
    directories").
- **Authorisation requirements for the serve wiring.** Serve authorises each
  forwarded op on its intent, and these bindings are enforced by
  swamp-club#3915 ("Team mode: serve's datastore API" below), against the
  write-path audit that the staging gates run:
  - **Key to aggregate.** A put's or tombstone's record key must fall under
    the projected paths of its intent's aggregate. Otherwise a principal
    allowed to save data on one behavior could write any other aggregate's
    file, such as a grant's. Since swamp-club#3256 the binding also covers
    ownership: the read model keeps a file whose newest live put is
    another partition's (a same-key rename), so a principal who could put
    at another aggregate's key could also stop that aggregate's tombstone
    from removing the file in every checkout.
  - **Definition kind and behavior type.** A managed-config definition intent
    names its kind and name, not its behavior type
    (`config--model--{name}`), so same-named definitions of two behavior
    types share one partition. Their record keys differ by type directory,
    so the records never collide, but serve cannot tell the two apart when
    it authorises an intent. The binding must take the type from the key or
    add it to the intent.
  - **Op kind to intent kind.** Which intents may ride a tombstone, and which
    a put, is not a simple verb split. A versioned `data.delete` rewrites the
    name's latest marker (a put), a definition delete keeps a file that
    another entity shares (a put), and `grant.revoke` writes a new grant
    version (a put). The table comes from that audit.
  - **`data-version` ops.** These carry no intent, so they must be tied to a
    `data.save`, `data.append` (or rename) intent for the same name and
    version in the same commit, or get an intent of their own.
  - **`lease` ops.** These carry no intent either. Only the lease machinery
    (Phase 5) may write them; a client-forwarded commit carrying one must be
    refused.
- **The stream directories.** `audit/`, `telemetry/`, `logs/` and `files/`
  are in `DEFAULT_DATASTORE_SUBDIRS`, which swamp-club#3233 read as "synced
  today", with an open requirement that the opt-in give them a v3 home.
  swamp-club#3278 found that nothing writes them through the datastore, so
  they stay repo-local on v3, as on v2 ("v3 stream directories").

### v3 chunk storage (`storage/1`)

swamp-club#3237 adds where v3 content lives: the `storage/1` contract that a
datastore extension implements, the core chunk store built on it, a
filesystem reference implementation and a conformance suite. All of it is
dormant until the v3 opt-in. `integration/datastore_v3_rules_test.ts` pins
importers of the filesystem storage, and production calls of a provider's
`storage()`, to empty lists. The chunk store sits in `src/domain/datastore_v3/`,
so the rule that keeps that model dormant covers it too.

**Ubiquitous language.**

- **Storage**: a backend's `storage/1` implementation (`DatastoreStorage`,
  `src/domain/datastore/datastore_storage.ts`), returned by the optional
  `DatastoreProvider.storage()`.
- **Chunk store**: the core domain service (`ChunkStore`,
  `src/domain/datastore_v3/chunk_store.ts`) that cuts content into chunks,
  uploads them, and reads them back verified.
- **Part**: one chunk of content stored as several, listed in its `BlobRef`.
- **Storage namespace**: the repository's namespace slug, or `_default` for an
  unnamespaced datastore: one whose commits carry the empty namespace (`""`
  in `commits.db`), whether a solo repository or a team datastore served with
  no namespace. No slug can start with `_` (`NAMESPACE_PATTERN` in
  `src/domain/data/namespace.ts`), so the two cannot collide.
- **Torn chunk** (swamp-club#3617): a chunk stored with fewer (or other)
  bytes than its size, as a crash leaves a file whose rename reached the disk
  before its content. On a storage that reads sizes it counts as missing.
- **Chunk barrier** (swamp-club#3617): what makes a commit group's chunks
  durable before the commit is prepared or appended: the file syncs of its
  new chunks, their renames, then the directory syncs that make the names of
  every chunk it names durable (the **chunk directory barrier**).
- **Chunk batch** (swamp-club#3617): the chunks one commit group stores or
  names (`ChunkBatch`, from `ChunkStore.beginBatch`), given one chunk
  barrier together.

**The contract.** v3 keeps commits in `commits.db`, which Litestream
replicates with its own clients, so object storage holds chunks and nothing
else. The contract is therefore chunk-shaped, not a general byte store. An
extension implements one small, verifiable thing, and it can batch `has`. The
contract also leaves `list` and the refresh to the extension. Every method
takes an `AbortSignal` and must reject when it aborts.

| Member | Purpose |
|---|---|
| `contract` | `"storage/1"`. The chunk store refuses any other value. |
| `capabilities()` | `{ maxChunkBytes, touch }` |
| `has(ns, hashes)` | The subset of `hashes` stored. The chunk store checks it before uploading. |
| `put(ns, sha256, bytes)` | Atomic, and idempotent by hash. Replaces the chunk and sets `lastModified` to now. |
| `get(ns, sha256)` | The bytes, or null only when the chunk is absent. |
| `touch?(ns, hashes)` | Refreshes `lastModified`, and returns the hashes it did not find. |
| `list(ns)` | Every chunk, with its `lastModified`. |
| `delete(ns, sha256)` | Idempotent. |

`touch`, `list` and `lastModified` are the primitives chunk garbage collection
uses, with the commit store's chunk index (see "v3 chunk garbage
collection").

**What the earlier seven-method draft had, and why it was dropped.**

- **Range reads.** A slice of a chunk cannot be checked against the chunk's
  SHA-256, so a ranged read would hand on unverified bytes. Core reads whole
  chunks, and chunking itself gives random access: a reader fetches only the
  parts that cover the range it wants.
- **Streaming bodies.** A chunk is at most 16 MiB, and core must hash a whole
  chunk before it knows the chunk's key. Bodies are `Uint8Array`.
- **`listOlderThan`.** No backend filters a listing by date on the server, so
  `list` returns `lastModified` and core filters.

**Capabilities and their fallbacks.**

- **`maxChunkBytes`**: core cuts chunks of `min(16 MiB, maxChunkBytes)`. The
  same content can therefore be cut differently on two backends. Every
  reference stays readable on both, because its parts are listed; only dedup
  across backends is lost.
- **`touch`**: without it, core puts a chunk it found present again, which
  refreshes `lastModified` just as `touch` would. The same happens with any
  hash `touch` reports missing, which covers a chunk deleted between `has` and
  `touch`. A chunk a commit is about to name is therefore always present and
  fresh.

**Key layout.** Chunks sit under the datastore root, beside `_control/` and
`_litestream/`. They are namespaced, because dedup is per namespace:

```
<prefix>/_blobs/<namespace>/sha256/<first two hex>/<sha256>
```

**Content spanning several chunks.** `BlobRef.sha256` is always the SHA-256 of
the whole content, so `PutOp.sha256` and a put's `expect` keep meaning "the
record's bytes". Content stored as one chunk has no `parts`, and that chunk's
key is `sha256`. Empty content is one empty chunk. Content stored as several
chunks lists them in order, as `parts: [{ sha256, size }]`. JSON without parts
is unchanged.

A manifest chunk was the alternative, and it was rejected. With the parts
listed in the reference, a later GC finds every chunk still in use from the
commits alone, with no extra fetch. With 16 MiB parts, the list costs about
6 KB per GiB of content.

**What core verifies.** On read, the chunk store checks each chunk's length,
then its SHA-256, before handing on any of its bytes. The length is checked
against the size the reference records, not against this backend's
`maxChunkBytes`, because a reference cut on another backend may hold larger
parts. For content in several chunks, it also checks the
SHA-256 of the whole content when the read ends. A mismatch errors the stream
with `ChunkIntegrityError`, and a missing chunk errors it with
`ChunkMissingError`. A `ChunkIntegrityError` names the failing chunk
(`namespace`, `sha256`) when a chunk's length or SHA-256 is wrong; it names
none when every chunk matched and only the whole content's digest did not.
A consumer keeps what a read yields only once the read ends cleanly.

**Optional capabilities beyond `storage/1`** (swamp-club#3617), each an
interface with a type guard in `datastore_storage.ts` beside `TempFileSweeper`.
A storage whose puts are atomic at the object level (a bucket) cannot tear a
chunk and offers none of them; `FileSystemStorage` offers all four.

| Capability | Method | Used for |
|---|---|---|
| `ChunkStatReader` | `statChunks(ns, hashes)` | Sizes and mtimes without reading bytes, so a torn chunk counts as missing |
| `ChunkStaging` | `stageChunks(ns)` | A `ChunkStage` for one commit group: `put(sha256, bytes)` writes a temp file beside the chunk, unsynced and unseen by readers (a hash staged already is skipped); `commit()` syncs every staged file, then renames each into place; `discard()` removes what was not committed |
| `ChunkDirectorySync` | `syncChunkDirectories(ns, hashes)` | The chunk directory barrier; may skip chunks the storage knows durable |
| `ChunkQuarantine` | `quarantineChunk(ns, sha256)` | Moving a chunk aside before deciding to delete it (`read`, `remove`, `putBack` on the handle) |

With `statChunks`, `ChunkStore.missing`, `refresh` and the store-before-write
check are size-aware: a chunk at the wrong size is missing, so a write puts it
again. `ChunkStore` also has `stat`, `syncStored` (the directory barrier
alone, a no-op without the capability), `beginBatch` (a `ChunkBatch`, below),
and, for the read model's checkout-copy guard,
`refOf` (cuts content exactly as `write` does, storing nothing), `putParts`
(puts listed parts straight from a byte-range source with no dedupe, skipping
a part whose bytes no longer match its name; a refused put throws
`ChunkPutError`) and `verifyParts` (reads and hashes stored parts).

**One barrier per commit group** (swamp-club#3617). `ChunkStore.write` takes
an optional `ChunkBatch`. With one, a new chunk goes into the batch: on a
storage with `ChunkStaging` it is staged and stored only when the batch
commits, so no reference to it may be committed before then; elsewhere it is
put at once. A chunk found present (at its size, and touched) is not put; the
batch covers it, and `include` adds the chunks of content stored earlier (a
retry's reused op). `ChunkBatch.commit` is the chunk barrier: the stage's
commit (every new chunk's file synced, then renamed), then one
`syncChunkDirectories` over every chunk the batch covers, new or found
present. A failed commit stores nothing more, and nothing the batch covers
may be committed. `discard` removes whatever was staged and not committed,
and is called whatever happened.

**Damage of the right size is not repaired by writes.** A write trusts its
presence check: a chunk present at its size is refreshed, not uploaded again,
so one damaged in place with the right length stays damaged, and every read of
it fails. A `put` always replaces the chunk, so deleting it, or putting it
again, repairs it. The read model's guard puts such chunks again from a
checkout file in replays, and serve's chunk GC verify pass finds them
("v3 chunk garbage collection").

**For extension authors.** `FileSystemStorage`
(`src/infrastructure/persistence/fs_datastore_storage.ts`) is the reference
implementation. `stageChunks` gives a stage whose `put` creates a temp file
(`createNew`) beside the chunk, writes it whole and closes it unsynced; its
`commit` reopens and syncs every staged file, 64 at a time, then renames each
into place, so a chunk's name never points at bytes a power loss could tear.
Syncing closed files before any rename lets the syncs coalesce: on macOS each
is an `F_FULLFSYNC`, a drive-cache flush, unless the ordering barrier applies
(below). A failed commit removes every
staged file it did not rename; chunks renamed before the failure stay,
harmless because no commit names them yet. `put` is a stage of one, so a
lone put still syncs its file before its rename. When a put fails and the
chunk in place already holds exactly its bytes (a concurrent put of the same
hash won the rename, which Windows refuses to share), the chunk is only
refreshed; otherwise the put throws, never leaving a damaged chunk in place.

`syncChunkDirectories` syncs the shard directory of each chunk not known
durable, 64 at a time, and `sha256/`, the namespace directory, `_blobs/` and
the datastore root once per process, whoever created them, with concurrent
callers sharing one sync. A put that creates a shard or namespace tree drops
the ancestors it created from that memo, so the next barrier syncs them
again. A process-wide memo (`DURABLE_CHUNKS`, by chunk path, at most 100,000
entries before it starts over) records the chunks whose names this process
made durable, so a dedupe hit on one costs no directory sync. A sync marks
its chunks with a token of its own and, when it ends, marks durable only
those still holding that token: a put (each rename), a quarantine, a
`putBack` or a delete by this process drops a chunk from the memo, so a sync
that such a change overtakes marks nothing for it, and a sync that fails
marks nothing. A chunk another process stored, found by a dedupe hit, is
synced the first time this process names it, once per process. Two narrow
gaps are accepted: a dedupe hit on a chunk an older swamp wrote, unsynced,
earlier in this boot is trusted at its size though its bytes may not be on
disk yet; and when another process creates a shard after this process
synced `sha256/`, then crashes before its own barrier, a put here that
dedupes into that shard does not resync `sha256/`. A directory fsync that
fails (`syncDirectory`), EIO included, is swallowed as SQLite does, so a
barrier cannot report a lost directory entry. `quarantineChunk` renames
a chunk to a `.<uuid>.tmp` name in its shard and sets its mtime to now, so
`list` skips it and `removeStaleTempFiles` removes it after the grace period.

**The macOS ordering barrier** (swamp-club#3737). The chunk barrier needs
ordering, not a drive-cache flush: a chunk on the disk no later than the
commit naming it. `commits.db` itself only gets a plain `fsync` (below), so
`F_FULLFSYNC` made the chunk more durable than its commit. On macOS a storage
given `orderedBefore` (the `commits.db` its chunks are named by) syncs chunk
temp files, shard directories and their ancestors with `F_BARRIERFSYNC`
instead, when `_blobs/` and that `commits.db` are on the same device: writes
before the barrier reach the disk before any written to that device after
it. Deno does not expose it, so `barrierSync`
(`src/infrastructure/persistence/barrier_sync.ts`) opens the path read-only
through libc over FFI (`libSystem.B.dylib`, loaded once per process; the
compiled binary has `--allow-ffi`) and calls `fcntl` off the event loop, so
the 64 parallel syncs still overlap. Any failure (libc that will not load, a
path that will not open, a volume that refuses the call, such as a network
filesystem) falls back to the full sync for that call and records the device
for the process (`FULL_SYNC_DEVICES`), so its later syncs go straight to the
full sync; nothing falls back to no sync. A nonblocking FFI call cannot read
`errno`, so an I/O error takes the fallback too, which reports it.
`openV3Datastore` passes `orderedBefore` only for an unreplicated filesystem
datastore (`v3ChunksOrderedBefore`): while replicating, Litestream ships the
commit to the replica before a barriered chunk need be on the disk, so a power
loss could leave the replica naming a lost chunk, and every sync stays full
whatever device the checkout's copy is on. One narrow gap is accepted: when
replication is first turned on, a commit appended just before, its chunk
ordered but perhaps still in the drive cache, can be seeded into the replica
before the drive flushes it. Linux and Windows sync as before.
It validates the namespace and hash before building any path, and uses mtime
as `lastModified`. `assertStorageConformance` in `@swamp-club/swamp-testing`
checks an implementation. `createInMemoryRemote({ storage: true })` provides a
conforming in-memory one. The S3 and GCS implementations are a later
swamp-extensions change.

**The v2 write-sync policy** (swamp-club#4032). Durable v2 data writes
(swamp-club#4017) use the same barrier where it is safe. A repository's sync
policy is its `AtomicWriteSync` hooks (`ordered_sync.ts`): `fullWriteSync`
(the defaults), or `orderedWriteSync`, which on macOS syncs a file or
directory with `F_BARRIERFSYNC` when it is on the catalog database's device,
and in full otherwise. A path on another device (a directory symlinked onto
another volume) or one whose device cannot be looked up is synced in full. A
volume that refuses the barrier is remembered for the process
(`REFUSED_DEVICES`) and synced in full from then on; nothing falls back to no
sync. Elsewhere `orderedWriteSync` is `fullWriteSync`. `createRepositoryContext`
decides the policy once, from the datastore resolver
(`selectDurableWriteSync`): ordered for the built-in filesystem datastore on
the v2 engine with no namespace whose data directory is the repo's own
`.swamp/data` (as the default datastore, or a filesystem datastore whose
`directories` keep data local), and for a context with no resolver. Only
there do the catalog (`catalogDbPath`) and the `latest` markers share the
content's tree, with nothing replicating it, so a version's files and
directory entries reach the disk no later than the marker and the catalog row
written after them. Everything else syncs in full: a custom-path or
namespaced filesystem datastore (its catalog stays in `.swamp/data`, possibly
on another drive), an extension datastore's cache (a push could ship a
version before the barrier puts it on disk, as `v3ChunksOrderedBefore`
guards), v3 (its filter-local versions, swamp-club#4019), and a context given
its own catalog store. The repository exposes its policy as `writeSync`.
`allocateVersion` hands a streaming writer the policy's file sync
(`syncContent`), so `DataWriter.writeStream` syncs its handle the same way.
`WorkflowExecutionService` takes the context's `writeSync` and passes it to
every repository it builds (its own, its step executor's and a nested
workflow's service); `serve_deps_rules_test.ts` checks each construction site
passes it. The per-model lock's directory creation, the refused-push restore
and the libswamp direct construction sites (`data delete`, `rename`, `prune`,
`gc`, `model delete`) keep the full sync. On macOS a durable write to the
default datastore is therefore ordered, not flushed: a power cut can lose the
newest versions, but never publishes one whose content is missing.

### v3 commit store (datastore rework Phase 3)

swamp-club#3236 adds `commits.db`, the store that keeps every partition's
commits and enforces the partition rules in storage. It is dormant: nothing in
production opens it, and `integration/datastore_v3_rules_test.ts` keeps every
importer of `src/domain/datastore_v3/` and `src/infrastructure/datastore_v3/`
inside those two directories.

**Port and adapter.**

- `CommitStore` (`src/domain/datastore_v3/commit_store.ts`) is the repository
  port for partitions:
  - `append(commit)` returns `appended` with the commit's seq, or
    `duplicate` with the seq an earlier commit with that txnId landed at.
  - `readPartition(namespace, partition, fromSeq, limit)` reads commits in
    seq order.
  - `head(namespace, partition)` returns the seq and highest fence.
  - `changesSince(cursor, limit)` reads the store-wide change feed.
  - `compactionStatus`, `compactHistory` and `readCompactedBase` compact
    history and read the compacted base (swamp-club#3258, "v3 history
    compaction" below). `changesSince` and `readPartition` reject with
    `CommitsCompactedError` below the compaction point.
  - `close()` lets queued appends finish, then every other call rejects.
- `SqliteCommitStore` (`src/infrastructure/datastore_v3/sqlite_commit_store.ts`)
  implements it over `node:sqlite`, the binding `_catalog.db` uses.
- It is core's own store, not an extension contract. `commits/1`, for
  backends that are themselves the commit store, is a Phase 8 item.

**The rules stay in the aggregate.** An append never re-implements a rule. It
rebuilds the `Partition` and calls `Partition.append` inside the transaction,
so a refusal is the domain's `CommitRejectedError` and writes nothing. The
unique keys below back the seq and txnId rules up in SQL. A damaged store
raises `CommitStoreCorruptError`, naming the namespace, partition and seq, so
it is never reported as a refusal of the new commit. A store is damaged when a
stored commit does not parse, does not match its row's seq, namespace,
partition or txnId, or breaks a rule against the commits before it; when a
snapshot is invalid; when a head row disagrees with its commits; or when a
txnId the partition has applied has no stored commit.
Stored rows are read through `Commit.fromJSON`, so they pass the same checks
as a commit a client sends.

**Schema.** Version 1, in `PRAGMA user_version`. Migrations are an ordered
list in the store: migration `i` takes version `i` to `i + 1`, a new one is
appended, and a shipped one is never edited. A database at a newer version is
refused (`upgrade swamp`) rather than read with the wrong expectations.

| Table | Key | Holds |
|---|---|---|
| `commits` | `cursor` (`AUTOINCREMENT`); unique `(namespace, partition, seq)` and `(namespace, partition, txn_id)` | The commit's JSON (`Commit.toJSON`, inline digests left out) and the lookup columns `txn_id`, `fence` and `at` |
| `partition_heads` | `(namespace, partition)` | The seq and highest fence, so an append never scans |
| `partition_snapshots` | `(namespace, partition)` | The partition's latest snapshot and its seq |

**One transaction per commit.** An append runs synchronously from
`BEGIN IMMEDIATE` to `COMMIT`. It takes the write lock up front, because a
deferred `BEGIN` in WAL mode can fail on a stale snapshot even with
`busy_timeout`, as `_catalog.db` did (swamp-club#2671). Inside it the store:

1. reads the head row and compares its seq with the rebuilt partition's;
2. applies the commit with `Partition.append`;
3. writes the commit row, the head row (its fence read from the partition)
   and, on every 1,000th commit, a snapshot.

A refusal rolls back and leaves the rebuilt partition unchanged. Any other
failure rolls back and drops the rebuilt partition, which may be ahead of the
file. Because the append is synchronous, it blocks the event loop for its
`fsync`.

**Group commit (swamp-club#3915).** Once serve writes for a team, many
appends arrive together, so the store bounds the blocking per burst rather
than per commit. Appends queued while a transaction runs share the next
`BEGIN IMMEDIATE … COMMIT`, up to `GROUP_COMMIT_MAX_COMMITS` (64), and the
group stops taking commits once rebuilding its partitions has taken
`GROUP_COMMIT_MAX_WAIT_MS` (50 ms). Each commit runs in its own savepoint:

- a refusal rolls back that commit alone, and a duplicate writes nothing;
- a stale head, or any failure other than a refusal, ends the group at that
  commit. The stale commit is retried alone through the head check below,
  and the commits after it go to the next transaction, so order and cursors
  are exactly those of one append at a time.

Any other queued operation (a fence raise, compaction, truncation, a
high-water read) closes the open group, so nothing is reordered around it. A
group of one is today's path. The outbox's `prepare` (also
`synchronous=FULL`) is grouped the same way: the prepares made in one
microtask are written in one transaction, a savepoint each. A burst of N
forwarded commits therefore pays two fsyncs, not 2N.
`src/infrastructure/datastore_v3/sqlite_commit_store_group_commit_property_test.ts`
appends random bursts (valid, duplicate, seq-gap, stale-fence, unfenced,
expect-failed and failing-after-writing commits) concurrently to a grouped
store and one at a time to an ungrouped one, and requires identical outcomes
and identical rows. Measured on an Apple M5 Max
(`scripts/bench_v3_serve_datastore_api.ts`, A/A spread 1.06×): a burst of 32
appends takes 1.4 ms grouped and 3.5 ms ungrouped; a solo append is unchanged
at about 0.09 ms. macOS `fsync` is cheap, so the gap is wider on Linux.

**Rebuilding a partition.** Each store queues its appends one at a time. The
queue rebuilds a partition, which is asynchronous because `Commit.fromJSON`
recomputes inline digests, before the transaction starts. It never rebuilds
inside one.

- **From a snapshot.** `Partition.snapshot()` gives the partition's state
  as plain data: seq, fence, lease holder, record digests, and each data
  name's live versions and high-water mark. `Partition.restore()` refuses a
  value that breaks the partition's invariants. The store writes a snapshot
  every 1,000 commits of a partition, in the append's transaction, and
  rebuilds from the latest one plus the commits after it.
- **No txnIds in the snapshot.** They grow with every commit the partition
  ever had, so a snapshot holding them would rewrite more of the WAL that
  Litestream replicates every 1,000 commits. The rest of a snapshot grows only
  with the partition's live state. Instead, `restore` takes a synchronous,
  exact lookup for txnIds at or before the snapshot's seq, and
  `Partition.append` uses it in its duplicate check, so the rule stays in the
  aggregate. The store answers the lookup from the unique `txn_id` index,
  bounded by the snapshot's seq so that the commits it replays after the
  snapshot are not taken for retries of themselves. A lookup that missed a
  txnId would let a retry apply twice.
- **Measured** on an Apple M5 Max with a model partition of 10,999 commits
  (`scripts/bench_commit_store.ts`). Each commit is an inline put and a
  data-version, plus a delete every tenth:

  | | Time |
  |---|---|
  | Replay from seq 1 | 268 ms |
  | Snapshot plus the 999 commits after it | 35 ms |
  | Writing a snapshot (once per 1,000 appends) | 2 ms |
  | Appending to a cached partition | 0.07 ms |

  About 80% of a full replay is `Commit.fromJSON` recomputing inline digests.
  Replay grows with the partition, and a short-lived CLI command pays it on
  its first append to that partition, so the store snapshots.
- **Cache.** Each store keeps rebuilt partitions in an LRU of 1,024 entries.
  Serve is long-lived and every workflow run is a new partition, so the
  number of cached partitions is bounded. When an append writes a snapshot,
  the cached partition is replaced by one restored from it, so it holds at
  most the snapshot interval of txnIds; older ones resolve through the
  bounded lookup above (swamp-club#3915). A busy partition no longer grows
  while it stays cached: after 5,000 appends with an interval of 1,000 it
  holds at most 1,000 txnIds, where it held 5,000.
- **Head check.** A cached partition whose seq differs from the head row was
  overtaken by another connection. The store drops it, rebuilds and retries
  once. A second writer is a bug the writer lease prevents, but the
  store stays correct. If the partition is stale again straight after the
  rebuild, the store compares the head row with the last stored commit while
  it holds the write lock. A mismatch means damage, and the store raises
  `CommitStoreCorruptError`.

**Change cursor.** `commits.cursor` is an `AUTOINCREMENT` key, so a value is
never reused even after a later prune deletes rows. `changesSince(cursor)`
returns rows above it in cursor order. Rows appear in cursor order only
because one writer serializes appends: no reader can see cursor `n + 1`
committed before `n`. The read model and the Phase 5 commit feed rely on
that.

**SQLite settings.**

- WAL, `synchronous=FULL` (a commit is durable when append returns), a
  5-second `busy_timeout`, and no foreign keys (the schema has none).
- Never a forced checkpoint: Litestream replicates the WAL, and
  `catalog_store.ts`'s `wal_checkpoint(TRUNCATE)` made the replica 11 times
  larger (`datastore-litestream.md`). A replicated copy turns auto-checkpoint
  off, so only Litestream checkpoints it (swamp-club#3935, "Verifying the
  replica" in `datastore-litestream.md`); any other `commits.db` keeps
  SQLite's default. A fitness rule refuses `wal_checkpoint` and
  `wal_autocheckpoint` in v3 code but for that one pinned site.
- Solo mode keeps one idle Litestream sidecar across write commands. A
  sidecar per command never compacts, so a day's replica of 252 objects took
  18–121 s to restore against 1.1–5.7 s compacted. A writer closes
  `commits.db` while its sidecar still holds it (sync, close, then stop), or
  the next sidecar uploads a full snapshot (Phase 4A in
  `datastore-litestream.md`).
- One connection per store, and one writing process per file.

**One `commits.db` per datastore.** Namespaces share one database, keyed by a
`namespace` column, rather than one database each.

- The Litestream record puts the replica beside `_control/` at
  `_litestream/<fence>/`, and the writer lease under `_control/writer/`
  carries one fence per datastore. One database matches one fence and one
  sidecar. In solo mode the path's fence is the one at which the checkout's
  replication lineage began (Phase 4A in `datastore-litestream.md`).
- Serve handles several namespaces with one connection and one sidecar, not
  one of each per namespace.
- Failover restores one database.
- One database per datastore, but one copy per machine while replicating
  (swamp-club#3482, Phase 4D2): each checkout keeps its own `commits.db`
  under `.swamp/_datastore_v3_copies/<datastore hash>/`, restored from the
  replica and replicated by its writer. Chunks, the format marker and the
  lease stay in the datastore. `v3CommitsDbPath` is the only place that
  decides which file a checkout opens (a fitness rule pins it), and without
  replication it is the datastore's own, as before.
- The cost: restoring one namespace restores them all, and a busy namespace
  grows the shared file. Namespaces that share a datastore already share its
  bucket and its writer, so that is accepted.
- An unnamespaced datastore's commits have namespace `""`. Its chunks live
  under `_blobs/_default/` (swamp-club#3237, "v3 chunk storage" above).

**Large changes.** A commit carries at most `MAX_COMMIT_OPS` (10,000) ops.
The commit-log unit splits a partition's larger change sets across several
commits, between batches (swamp-club#3250, "v3 commit-log unit of work"
below).

### v3 commit-log unit of work (datastore rework Phase 3)

swamp-club#3240 implements decisions 1 to 7 of "v3 domain model" above. The
commit-log unit is dormant: `integration/datastore_v3_rules_test.ts` (rule 5)
keeps every production file outside the v3 directories from importing it, and
only tests open it until the v3 opt-in. The binding registry is the one change
it shares with v2.

**The binding registry.** `unitOfWorkBinding`
(`src/infrastructure/persistence/unit_of_work_binding.ts`) implements the
`UnitOfWorkBinding` port (`src/domain/datastore/unit_of_work.ts`). The port
lives in the generic datastore context, because persistence may not import the
dormant v3 context. It holds two weak maps:

- `bind(uow, hook)` / `boundHook(uow)`: which repository context a unit
  serves. The legacy adapter binds every unit it builds over a hook, and the
  commit-log adapter binds its own. Identity decides, so a wrapper of a hook
  never matches. `legacyUnitOfWorkTarget` stays as the legacy-only view.
- `requireUnit(hook)` / `requiresUnit(hook)`: a context that has no route 2.
  `runInCommitLogRoot` marks its context's hook, and `createRepositoryContext`
  marks a v3 context's when it builds it (swamp-club#3279), so a write before
  any root opens is refused too. A mark is permanent for the process, so a hook
  instance must never be shared between a v2 and a v3 context. A legacy unit
  forwards each change to the hook, which would be route 2 by another name:
  the legacy adapter refuses to build one over a marked hook, and
  `signalChange` refuses to stage a marked hook's write into one built
  before the mark.

`signalChange` routes a hooked write in this order: into the ambient unit when
it is bound to the write's hook; otherwise, when the hook requires a unit,
refuse with `UnscopedWriteRefusedError` before anything is marked or written
(decision 3); otherwise route 2, exactly as before. That covers the CLI's
managed-lockfile root (swamp-club#3192): a v3 repository write inside it meets
a root bound to the transaction's own hook, and is refused.
`integration/datastore_write_seams_rules_test.ts` pins every `bind`,
`boundHook`, `requireUnit` and `legacyUnitOfWorkTarget` caller.

**Typed changes and content.** A `TypedChange` is either an op built by the
op factories, or a pending put: intent, key, optional `expect` and a
`ContentSource`. A put whose content needs a chunk cannot be built before the
chunk is stored (`putOp` takes its `BlobRef`), so the unit stores content when
it commits, and an abandoned unit stores nothing. A `ContentSource` is bytes,
or a function returning a fresh stream each time it is called (a repository
passes "open the file I just wrote"), so large content is never held in
memory between staging and commit. The unit reads a stream a piece at a
time until it ends or holds more than `MAX_INLINE_BYTES`: content that ends
within the limit is inlined, anything longer goes, with what was already
read, through `ChunkStore.write`. Bytes are copied when staged. A retry calls the source
again. A source is read at commit and at most once: a retry reuses the
content stored the first time. Before reading it, the unit drops a stream put
that a later put or tombstone of the same key with no `expect` supersedes,
among the unflushed batches and the pending groups not being appended whose
put is not stored yet (swamp-club#3250); a group emptied so is dropped, since a
commit carries an op. A stream put superseded while its group is being
appended cannot leave that group; the append skips it, also when its stream
fails because the file is gone, and commits nothing when no op is left. So a
repository may rewrite or remove a file it staged
as a stream, provided it stages the change that does so; until then the file
must stay readable and unchanged. `stage(StagedChange)`, the
path-only form, is refused with `PathOnlyChangeRefusedError`: there is no
path-to-op guessing. Changes are checked where they are staged (the
partition matches the intent, a pending put's key and `expect` build a valid
put, at most `MAX_COMMIT_OPS` per partition in one `stageOps` batch, no
`lease` ops, which only the lease machinery writes), so a bad change fails at the call that
made it rather than blocking the partitions after it at commit.

**Commit order and failure.** `commit` and `checkpoint` group the changes by
partition, in first-touched order with workflow-run partitions last
(decision 7). For each partition the unit stores its content first, so no
commit names a missing chunk, then builds one `Commit`: `seq` is the
partition's head plus one, read when it appends; `txnId` is fixed when the
group forms; plus the writer, the fence when one is given, and `at`. The head
read and the append run under a per-partition lock keyed by sink, namespace
and partition, so two units in one process never take the same seq; the lock
is released on every outcome and its entry dropped when its queue drains.

**The chunk barrier** (swamp-club#3617). `appendGroup` stores the group's
content into one `ChunkBatch` (`ChunkStore.beginBatch`) and commits the batch
before the partition lock: a commit is never prepared or appended while a
power loss could lose the bytes or the rename of a chunk it names. On a
storage that stages chunks, the group's new chunks have their files synced
together, then are renamed, then one directory sync phase covers every chunk
the group names, stored now, found present, or reused by a retry
(`include`). A failed barrier fails the group as a failed store does, and a
retry stores again whatever it did not store. The batch is discarded
whatever happened. Chunks stored again later (the overlap branch's restore
before the append, and the post-landing restore) go through
`restoreMissingChunks`, which runs a batch of its own, committed only when it
stored something. Nothing is synced for a group whose content is all inline,
and only the stage's file syncs (no directory syncs) on a storage without
`ChunkDirectorySync`; a storage with neither capability puts each chunk at
once.

What it costs, vs main (swamp-club#3617). Main synced no chunk, so every
millisecond here is new. In-process bench (`scripts/bench_v3_chunk_barrier.ts`:
the real `FileSystemStorage`, `ChunkStore` and commit-log unit on a temp
directory, 16 KiB blobs of one chunk each, medians of 2 runs of 9 with an A/A
control), main at 270eb2fe6 against the barrier:

| Case | macOS main | macOS barrier | Linux main | Linux barrier |
|---|---|---|---|---|
| 1 new chunk | 0.5 ms | 8.4 ms | 1.1 ms | 2.3 ms |
| 10 new chunks | 2.8 ms | 21.0 ms | 5.3 ms | 7.5 ms |
| 200 new chunks | 52 ms | 181 ms | 79 ms | 104 ms |
| 200 dedupes, chunks another process stored | 18 ms | 28 ms | 30 ms | 34 ms |
| 200 dedupes, chunks this process stored | 18 ms | 22 ms | 30 ms | 32 ms |

swamp-uat#496 vs main, real CLI, 3 samples a run:

| Line | macOS main | macOS barrier | Linux main | Linux barrier |
|---|---|---|---|---|
| v3 write (`model method run`) | 566 ms | 762 ms | 551 ms | 550 ms |
| v3 first clone (1000 items) | 4430 ms | 4463 ms | 5736 ms | 5949 ms |
| v3 delete visibility | 1071 ms | 1197 ms | 1101 ms | 1066 ms |

A command that stores a new non-inline chunk pays one file sync and one
directory sync. On macOS `FsFile.sync()` is `F_FULLFSYNC`, which waits for the
whole drive cache, so its cost depends on what every process wrote just
before: about 10 to 25 ms on an idle Mac, and 200 ms or more when other
processes keep the disk busy (the macOS uat#496 figures above were taken with
other processes writing 1 to 2 GB/s; a direct A/B gave +217 ms). Linux figures
are from a Docker Desktop VM (ext4 volume), whose cheap fsync understates bare
metal; no bare-metal figure was taken.

The ordering barrier (swamp-club#3737) on macOS arm64 (APFS), against the
#3617 barrier on main at 55c5a07e9 and the swamp before it (270eb2fe6). In
process, the same bench, medians of 3 interleaved runs of 9 with an A/A
control, on an idle disk and with `dd` rewriting a 2 GiB file throughout:

| Case | before #3617 | main | ordering barrier |
|---|---|---|---|
| 1 new chunk, idle | 0.5 ms | 8.5 ms | 1.6 ms |
| 10 new chunks, idle | 2.7 ms | 20.5 ms | 5.0 ms |
| 200 new chunks, idle | 51 ms | 135 ms | 66 ms |
| 1 new chunk, under load | 0.5 ms | 34 ms | 3.6 ms |
| 10 new chunks, under load | 3.0 ms | 76 ms | 8.2 ms |
| 200 new chunks, under load | 54 ms | 348 ms | 80 ms |

The uat#496 v3 write line (`model method run` of `shell-echo`) stores no
chunk: its content is all inline, so it never reached the barrier, and it
reads the same on main, the ordering barrier, and a build with every chunk
sync removed (536, 542 and 540 ms, medians of 6 interleaved runs, idle). The
same line with an 18 KiB random output, so each run stores new chunks, on
the compiled binaries, 9 rounds in rotated order: idle, 598 ms on main,
578 ms with the ordering barrier, 574 ms with no chunk sync, the barrier
ahead of main in every round (median gap 12 ms). Under the `dd` load, with
other processes also loading the machine, 1688, 1415 and 1252 ms, the barrier
ahead of main in each of 6 rounds. Linux and Windows take the same path as
before.

- **No atomicity across partitions.** When a partition fails, the partitions
  before it stay committed and the ones after it are not tried. A refusal is
  the exception: the flush goes on past it (below).
- **Pending groups.** A partition whose commit failed stays pending with its
  txnId. The unit's next `checkpoint`, or its `commit`, rebuilds it at the
  current head with the same txnId, so a commit that had landed is reported
  `duplicate` and lands once. `commit` ends the unit whether or not it
  succeeds (the `UnitOfWork` contract), so what is still pending when the
  unit's own commit fails is reported failed and dropped with it, outbox
  entries included (**v3 commit outbox**); a caller that must retry
  checkpoints first. A retry older than `OUTBOX_RETRY_BOUND_MS` is refused
  (`retry-expired`) before it is appended.
- **Refusals.** The refused partition's changes are dropped: they can never
  land as they are, and keeping them would block every partition staged
  after them. The flush goes on to the other partitions, then throws one
  `PartitionsRefusedError` (swamp-club#3257). It is a `CommitRejectedError`
  with the first refusal's reason, its message carries each refusal's, and
  it lists every refusal not yet acknowledged, earlier flushes' included,
  each with the data versions its changes recorded. Every flush throws it
  until the refusals are acknowledged, so none is cleared unseen. When
  another failure stops the flush after a refusal (a transient append
  error, or a second `seq-gap`), the refusal is thrown with that failure as
  its `cause`, and the failed partition stays pending. A `seq-gap` is not a
  refusal: another append moved the head first, so the append is rebuilt at
  the new head once more in the same flush, and if that also meets a gap the
  partition stays pending for the next checkpoint and the flush stops.
- **Splits (swamp-club#3250).** A partition holding more than
  `MAX_COMMIT_OPS` changes in one flush forms several groups, split between
  `stageOps` batches, so one batch always lands in one commit. Each split has
  its own txnId and commits in order. A refused split drops the splits of its
  partition formed in the same flush, which were staged after it; a batch
  staged after that flush forms its own group and commits on its own. Splits
  give up the single commit: when a later split fails, the earlier ones stay
  landed, and between two splits a reader can see part of the operation (a
  name's version tombstones without its latest-marker change). The final
  state is the same. When a later split is refused, the earlier ones keep
  what they recorded: a stream put elided because a tombstone in the refused
  split superseded it leaves its version recorded with `metadata.yaml` and no
  `raw`. That is v2's own failure mode for a crash between its metadata and
  content writes; the next save or delete of the name settles it. The issue asked for the unit to refuse more changes
  until a checkpoint; splitting at group formation keeps child units
  all-or-nothing and needs no caller to checkpoint.
- **Abandon** discards staged and pending changes (decision 4). A
  checkpoint already in progress finishes first, so what it commits stays
  committed. Chunks already stored stay for chunk garbage collection.
- **Run records and refusals (swamp-club#3257).** A run record never names
  data whose partition was refused. The issue offered two ways: hold the run
  record back (or commit it with the step failed), or have the record name
  only versions that landed. This takes the first, with the step failed:
  - Naming only landed versions would make the committed record differ from
    the local file, which every read-model gate compares by bytes; would
    leave the step `succeeded` with its provenance silently gone, though
    later steps may have read that data; and the run cannot know at save
    time what will land, only at commit.
  - A run's record is rewritten whole on each save, so a save after a
    refusal still names what it refused. So the unit holds every run
    partition back for the rest of its life once a non-run partition is
    refused, not for one flush, and keeps it pending rather than dropping
    it, so the run's snapshot is not lost with it.
  - `acknowledgeRefusals()` releases them. A root that ends without it
    throws the refusal again, and its held run records are lost with it, as
    on any failed commit. The local record stays, still naming the refused
    data.
  - `runInCommitLogRoot`'s `onRefused` settles a refusal at the root, where
    a checkpoint is possible (a use case's unit is a child and cannot): a
    root that commits checkpoints first (again, up to three times, after a
    transient failure, so a refusal behind it is still met there) and, on a
    refusal, runs `onRefused` with itself ambient, acknowledges, commits,
    then throws the refusal. A step's failure reason carries the refusals'
    messages, not the held-run list.
    `reconcileRefusedRuns` (`refused_run_records.ts`) is the callback for a
    workflow run: it saves each held run again with
    `WorkflowRun.failStepsNamingRefusedData`, which fails the steps whose
    data artifacts name a refused version (by data id and version, which
    both the refusal and the step record), their jobs, and a succeeded run
    (also when only a workflow-scope report artifact names one). A
    suspended or cancelled run keeps its status. The re-save supersedes the
    held record, so the store, and every later save of the run, records
    those steps failed. The refusals `onRefused` sees are all that
    acknowledging clears. When `onRefused` throws, the refusal is logged
    and the root is discarded.
  - A run's root on a v3 context passes it (swamp-club#3279, "v3 opt-in").
- **Checkpoint** commits what is staged so far and keeps the unit open
  (decision 6).

**The outbox seam.** The unit appends through a `CommitSink`
(`append` and `head`). A v3 datastore's sink also carries the commit outbox
(`outbox`), which makes each commit durable across a crash until it lands;
a bare `CommitStore` carries none and prepares nothing. See **v3 commit
outbox**.

**Roots, children and run outcomes.** `runInCommitLogRoot(repoContext,
options, fn)` mirrors `runInRootUnitOfWork`: it refuses a context without a
hook, marks the hook with `requireUnit`, and runs `fn` with the root ambient.
Opened inside an open commit-log unit for the same hook it is a child: its
`commit` hands its batches, in order and one by one, to the root, its `abandon`
discards them (and refuses changes staged after it), and `checkpoint` on it throws. A root's checkpoint commits what has
been handed to it so far. The root ends as its `disposition` option decides,
the way `pushWhen` decides a legacy root's push: by default it commits when
`fn` resolves and discards when it throws. `runOutcomeDisposition` is
decision 5 for a workflow run: commit when the run ends `completed`,
`failed`, `suspended` or `cancelled`, discard on a throw. A failed or
cancelled run must resolve with its status, not throw, or its record is
discarded, back to what its last checkpoint committed (decision 6).
`withUnitOfWork` (`src/libswamp/unit_of_work.ts`) ends a v3
unit, which `takesTypedChanges` tells apart, as decision 5 says
(swamp-club#3257): it commits once the stream yields `completed`,
`suspended`, `cancelled` or, since swamp-club#3279, a reported `error`,
including when the consumer then stops with `return()`, and abandons on a
throw or a stop before any of them. A legacy unit ends as before. The v3
opt-in opens roots that follow their v2 push policy instead of
`runOutcomeDisposition` ("v3 opt-in"). `result()` stops at
`completed`, before the executor's last save of the run, so a run read
that way commits the record as the run last saved it, still `running`, as
v2 leaves the local file; the CLI and serve drain the stream.

**The v2 gate.** `integration/usecase_sync_characterization_routing_test.ts`
recorded today's routing before the registry landed (a root, a use-case
child, a nested root over another hook, a wrapped hook, a unit no adapter
bound, and the lockfile root), and every existing characterization and
root-unit suite passed unchanged after it. A temporary route recorder over
the whole test suite gave the same set of route-1 and route-2 writes before
and after.

### v3 repository staging (datastore rework Phase 3)

swamp-club#3250 makes the data and output repositories stage typed changes
when they run on v3, for every write they make. It is the first of three
repository staging groups; definition, workflow and evaluated staging, and
run and vault config staging, add builders to the same route. It is dormant:
nothing reaches it until a hook requires a unit, which only a commit-log root
marks. Nothing changes on v2: the builders never run there.

**The shared route: two calls.** The issue sketched one pre-write call with a
lazy builder, `signalChange(markDirty, pathChange, () => typedChanges)`. The
typed changes cannot be built before the write: the version is allocated by
it, the content and metadata are written by it, and whether the latest marker
moved is decided by it. Moving the call after the write would change v2's
pre-write signal timing. So a repository makes two calls
(`src/infrastructure/persistence/unit_of_work_scope.ts`):

1. **Before the write**, `signalChange(markDirty, pathChange, { typed: true })`
   as today. On v2 the option changes nothing. In a unit bound to the hook
   that takes typed changes, the path change is checked (a write outside a
   bound unit is still refused before anything is written) but not staged,
   since a commit-log unit refuses path-only changes. A repository that has no
   builders yet leaves the option out, so its path change still reaches the
   unit and is refused there (`PathOnlyChangeRefusedError`).
2. **After the write**, `stageTyped(markDirty, build)`, once per batch. It
   returns at once when there is no hook or the hook does not require a unit
   (every v2 context), so `build` never runs and nothing is read. In a bound
   unit that takes typed changes it runs `build` and stages the result as one
   `stageOps` batch. On a v3 hook with no such unit ambient it throws
   `UnscopedWriteRefusedError` rather than drop the change.

Which units take typed changes is a persistence-only registry beside the
binding (`typedStagers` in `unit_of_work_binding.ts`): the commit-log adapter
registers each unit it builds. It lives there, not in the domain port, so the
`datastore` context never depends on `datastore_v3`, and persistence never
imports the commit-log unit. `integration/datastore_write_seams_rules_test.ts`
pins the registry's callers, and rule 7 accepts `stageTyped(this.markDirty,
…)` beside `signalChange`. `integration/datastore_v3_rules_test.ts` pins the
new imports of `src/domain/datastore_v3/` from persistence: type-only ones in
the route, and the repositories' builders.

**The change factory.** `ModelChanges` (`src/domain/datastore_v3/
repository_changes.ts`) builds every typed change from what a repository
already has: behavior type and id, data name, version, output file. It derives
the partition with `partitionOf` and builds intents with `createIntent` and
`modelRef`; record keys come from segments in today's layout, never from an
OS path. After a write, the repository reads back what it wrote (on v3 only,
inside `build`): the metadata bytes and parsed metadata, the content as bytes
up to `MAX_INLINE_BYTES` and as a stream that opens the file at commit above
it, and the latest marker's bytes.

**Batches.** Each version is its own batch (its puts and `data-version`, or its
two tombstones), and each latest-marker change is its own, so no write path
builds a batch over `MAX_COMMIT_OPS` and a large removal splits between
versions ("Splits" above). A rename is one batch, so it lands in one commit.

**The mapping.** Every write of the data repository
(`unified_data_repository.ts`), and what it stages after it:

| Write | Typed changes |
|---|---|
| `save`, `finalizeVersion` | `data.save`: puts of `raw` and `metadata.yaml`, the `data-version` op, and a put of the latest marker when the marker now names the version. Staged before the write-time prune, so a failed prune never leaves the version local-only |
| write-time prune (`pruneExcessVersions`) | Per pruned version, `data.gc` tombstones of `raw` and `metadata.yaml` with the version |
| `append` | `data.append`: puts of `raw` and `metadata.yaml` (expecting the digest of the metadata it rewrote) and a `data-version` op re-recording the live version it extended |
| `delete(version)` | `data.delete` tombstones of the version's two files, then the marker as the delete left it: a put of the lowered latest or of `NO_PROMOTED_VERSION`, or a version-less `data.delete` tombstone when the name directory went |
| `delete(name)`, `data prune` | Per version listed before the removal, `data.delete` tombstones with its version; then a version-less `data.delete` tombstone of the marker |
| `removeLatestMarker` (expiry) | A version-less `data.gc` tombstone of the marker: the read model drops the name's rows and keeps its versions |
| `rename` | One batch with `data.rename` intents (naming both names): the new name's version files and `data-version`, its marker when it moved, the old name's marker version (`renamedTo`) and its marker. The inner save stages nothing of its own; its prune stages as above. A rollback stages the new name's marker as it left it |
| `collectGarbage` | Per removed version, `data.gc` tombstones with the version, staged after the parallel removals; then the marker as GC left it |
| `saveDeferred`, deferred `allocateVersion`, `finalizeVersionDeferred` | Nothing: a deferred version reaches v3 when it is promoted |
| `advanceLatestMarkers` | Per promoted version, as `save`; a version whose metadata is gone stages its `raw` and marker but no `data-version`, as its catalog row is dropped |
| `rollbackVersions` | Versioned `data.delete` tombstones (harmless for a version never promoted) and the marker as the rollback left it |
| orphan reclaim | A version a dead process had promoted (its marker names it) stages as a promotion; a removed orphan stages `data.gc` tombstones, and an emptied name's marker as it was left |

The output repository (`yaml_output_repository.ts`) stages an `output.save`
put of a record's YAML after `save`, and an `output.delete` tombstone after
removing one (`delete`, `deleteOlderThan`, `deleteByMethodLifetime`). A record
that never parsed has no output id, so no repository ever put it, and its
removal stages nothing. Run logs have no typed change: they are local-only
(swamp-club#3257, below), and their removals inside a datastore declare
`typed` so they are not refused.

**The `bulk` mapping.** Neither repository stages a `bulk` change on v2. Their
directory marks (a data name's or a version's directory) become per-key
changes: a version directory holds exactly `raw` and `metadata.yaml`, and a
name directory those of each version plus `latest`. There are no prefix
tombstones.

**Staging errors are never only logged.** Staging runs outside the catch blocks
that log and continue (`advanceLatestMarkers`, `rollbackVersions`, GC's
`allSettled` batches), so a v3 refusal surfaces. `advanceLatestMarkers` and
`rollbackVersions` collect them and throw after every receipt (one error, or
an `AggregateError`), so one refusal stops no other promotion. Two places log
one instead, because an earlier error is already on its way to the caller: a
rollback inside a failed `saveDeferred` or deferred `allocateVersion`, and
the rollback of a failed rename. That error fails the operation either way.
The first applies on v3 only: on v2 a failed write's rollback runs exactly as
before, and its own error still reaches the caller.

An append's metadata `expect` needs the digest of the file it rewrites, read
before the write. `typedStagingActive(markDirty)` says whether `stageTyped`
would run its builder now, so only v3 reads it; rule 7 accepts it beside the
other two calls.

**Chunk GC's post-commit check (swamp-club#3249).** Every commit a unit lands
runs `restoreMissingChunks` for each blob put it names, a retry that reused
a stored op included, so no landed commit names a chunk a racing sweep
deleted. The check reads a put's source again only when one of its chunks is
missing: the one exception to "read at most once", for repair after a GC
race. A file-backed source reopens the file the repository wrote; when the
file has changed since, the content no longer gives the same `BlobRef` and
the commit fails loudly rather than store other bytes. A superseded put that
the unit dropped never commits, so it needs no check.

**The gate.** `integration/datastore_v3_repository_staging_test.ts` runs the
real repositories on v3 in a commit-log root over `SqliteCommitStore` and
filesystem `storage/1`, solo and namespaced, and catches up a read model into
a second directory. Its files and `_catalog_v3.db` must equal what the
repositories wrote, for every path above. That includes version reuse,
out-of-order writers, a late version below a rename marker, an append after a
top delete, a save pruned in the same unit, and a use case's child unit. GC
and `delete(name)` above `MAX_COMMIT_OPS` split into two commits, in a root
and in a child.

#### Definition, workflow and evaluated repositories (swamp-club#3256)

The second staging group: `yaml_definition_repository.ts`,
`yaml_workflow_repository.ts`, `yaml_evaluated_definition_repository.ts` and
`yaml_evaluated_workflow_repository.ts` stage typed changes for every write
they make on v3, through the same two calls. v2 does not change: every read
a typed change needs and every builder runs only behind `typedStagingActive`
or inside `stageTyped`.

**Which writes are datastore writes.** Every one of these repositories gets
the context's hook, including definitions and workflows without managed
config, whose repo-local `models/` and `workflows/` paths the hook simply
never sends. Direct execution also builds a definition repository over the
auto-definitions directory as its primary directory. So each written or
removed file is classified by the directory it is in, not by the
repository's role (`config_staging.ts`):

- inside the managed config base, a managed-config definition or workflow,
  in `config--{model|workflow}--{name}` (and a vault config in
  `config--vault--{name}`, swamp-club#3257);
- inside a directory named `auto-definitions`, an auto-definition, in
  `definition--{id}`;
- anywhere else, a git-tracked file, which stages nothing. Its path change
  is declared `typed`, so a v3 unit does not refuse it either.

Evaluated definitions and workflows are always datastore files. The tier
comes from the default datastore layout (`DEFAULT_DATASTORE_SUBDIRS`);
honouring a repository's configured `directories` and `exclude` is left to
the opt-in. A record key is the file's path under the namespace root, from
its own tier's base (`config/models/...`, `config/workflows/...`,
`auto-definitions/...`, `definitions-evaluated/...`,
`workflows-evaluated/...`), never rebuilt from a name, so a file a cached
lookup found outside its type directory keeps its real key.

**The mapping.**

| Write | Typed changes |
|---|---|
| Definition or workflow `save`, managed config, name unchanged | `definition.create` put expecting the key absent; or `definition.edit` expecting the replaced file's digest, or absent when the file moved here from another key of the same name (a legacy uuid path), with a `definition.edit` tombstone of that key expecting it present. An unchanged save that does not write stages nothing |
| Definition or workflow `save` that renames | Batch 1: `definition.rename-to` put in the new name's partition, always expecting the key absent. Batch 2: `definition.rename-from` tombstones, expecting present, of the keys the save removed in the old name's partition, and of the target key itself when both names are stored at the same uuid path |
| Definition `save` into or out of auto-definitions | `auto-definition.save` put (no precondition) of the written file, `auto-definition.delete` tombstones of removed auto-definition files, and `definition.delete` tombstones (expecting present) of removed managed-config files |
| Definition or workflow `delete` | Per partition, `definition.delete` or `auto-definition.delete` tombstones of the files it removed, without a precondition. A removed file whose name is unknown stages nothing |
| Evaluated definition `save`, `delete` | `evaluated-definition.save` put and `.delete` tombstones in the behavior's partition, without a precondition |
| Evaluated definition `clearAll` | Per file, read before the removal, an `evaluated-definition.delete` tombstone in the behavior its raw `type` and `id` name |
| Evaluated workflow `save` | `evaluated-workflow.save` put in the workflow name's partition, and tombstones of removed files of that name; then, as later batches, tombstones of removed files, or of a same-key target, that declared another name, in that name's partition |
| Evaluated workflow `delete`, `clear` | `evaluated-workflow.delete` tombstones in the partition of each file's declared name; `clear` also tombstones run snapshots |
| `saveForRun`, `deleteForRun` | `run-snapshot.save` put and `.delete` tombstone in `run--{workflowId}--{runId}` |

Before a write, the repository reads (on v3 only) the bytes and the raw
`id`, `name` and `type` of each file the write replaces or removes: the
digest for an edit's precondition, and the name that tells a rename apart.
A fresh repository's id cache is cold, which is how every CLI command
builds one, so the name never comes from the cache. The definition
repository reads before `readMergeSource`, which removes a corrupt target.
Definition puts pass bytes, never a stream: a put with an `expect` never
supersedes an earlier stream put of its key, so a definition saved twice in
one unit would otherwise read the second save's bytes for the first put.
`cleanupOldPaths` returns the paths it removed, and staging runs outside its
catch blocks, so a refusal surfaces and a failed removal is never
tombstoned.

**Preconditions.** Only authored managed-config definitions and workflows
carry them, so a concurrent edit or create from another checkout is refused
(`expect-failed`) rather than silently overwritten. A create expects the
key absent and an edit the replaced bytes' digest. A delete expects nothing
from the repository, so a local file out of step with the store stays
deletable; a user's delete of a definition another checkout changed expects
the version the user started from (below; a tombstone may expect `present`
or a digest since commit store schema 11, swamp-club#4097).

**The version an edit started from (swamp-club#4097).** The repository reads
its prior after the command's catch-up, which has already written another
member's change over the checkout's file, so that prior would let a stale
edit through: two checkouts load `deploy`, A saves, and B's later save
expects A's bytes and replaces them. So each checkout keeps its
`ConfigEditBases` in the read model's state (`config_edit_bases`, state
schema 9): for every managed-config record a catch-up rewrote or removed
with another writer's bytes, the digest the checkout's file held before
(`SqliteReadModel` reads it just before it writes or removes the file, in
the catch-up's transaction). Only the first commit in a catch-up that
changes a record's bytes counts, since a later one replaces a version the
catch-up itself wrote; a commit that leaves the bytes as they are (the
checkout's own, replayed by its next command), a file the guard keeps, and
a record the checkout held no file for record nothing, so a freshly joined
checkout's edits start from the head. The first recorded base wins. A base holds
across commands, a reset included, until the user loads the definition
(`behavior`/`model`, `workflow` or `vault get`, or an editor-mode `edit`,
which copies the checkout's current file into the editor: `markConfigLoaded`) or a user's
edit in the checkout commits the record (a system rewrite leaves
it), so retrying a refused edit unchanged is
refused again, and a command in between that reads something else does not
move the base. Inside a user's edit or delete (`runAsUserConfigEdit`, opened
by the CLI's `behavior`/`model`, `workflow` and `vault` edit and delete or
remove commands), the commit-log unit replaces a `definition.edit` put's expectation, or
gives a `definition.delete` tombstone one, with that base. Outside it
(a type upgrade's rewrite, a migration, an adoption, serve's own handlers)
the save-time prior stands: those writes have no version a user started
from, and serve's files are always the head. A rename's or move's
tombstone of the old key expects the base too.

The unit commits each partition on its own, so a refusal at commit comes
after the command's other partitions landed: a behavior delete removes its
outputs and data, and a workflow delete its runs, before the definition's
tombstone. So every user delete, and every edit whose content came on stdin, first
checks its target (`assertConfigEditCurrent`, `startConfigEdit`,
`CommitLogEngine.staleConfigEdits`): a base of
the definition's partition that is no longer the commit store's version
refuses the command with `config_edit_conflict` before it changes
anything; a rename then never creates its new name.

The extension lockfile's put expects the lockfile record the commit store
held when the transaction hydrated (`CommitLogEngine.storedVersion`,
`SqliteCommitStore.recordSha256`; not the read model, which applies this
process's own earlier commits only at its next catch-up, nor the checkout's
file, which may be out of step), then each version the transaction
published. It is a race check: a
lockfile change merges entries into the caught-up file, so only a change
another checkout landed meanwhile is refused, and the transaction records
the change as unpublished for the next extension command to replay.

A refusal of any of these is the user's error `config_edit_conflict`
(`ConfigEditConflictError`, `configEditConflictOf`), translated where it is
shown: the CLI's error output (log mode: one line; `--json`: `code` and
`conflicts`, each `{kind, name?, key, changedBy?, changedAt?}`) and serve's
reply for a write whose commit failed (`replicationErrorForClient`). It
names the definition (or the lockfile), who changed it (the commit's
principal, else its writer's host: solo commits carry no principal) and
when, from the last 200 commits of the partition or serve's
`precondition_failed` reply, and says how to go on: load it again,
re-apply the change and save again, or for the lockfile pull and retry.
The refused edit's file is put back by the dropped-work recovery
(swamp-club#3553).

An editor-mode `edit` (swamp-club#4107) is a user's edit like a piped one.
It loads the definition, opens the editor on a private temp copy, and once
the editor closes saves the copy through the same path as stdin: the same
validation, rename rules (a rename made in the editor is allowed) and
`assertConfigEditCurrent` check, inside `runAsUserConfigEdit`. The editor
runs before the command opens its unit of work, so no root is held while a
person edits; a change another member commits meanwhile refuses the save.
An unchanged copy saves nothing; a refused save keeps the copy and names it.
Swamp waits for every editor (GUI editors get their wait flag) and refuses
launchers such as `xdg-open` that return at once. Only files that are not
stored records (an extension workflow's source, a legacy link) still open in
place, and nothing is committed for them.

Limits:

- A tombstone of a move from a legacy key expects only `present`, so it
  cannot detect a stale edit of the file it replaces.
- A local file out of step with the store (a hand edit, a write by a
  hook-less command) makes the next save's precondition fail until the read
  model catches the file up. A rename of a name v3 never saw lands its first
  commit and refuses its second.
- A base is set only by a catch-up. An edit prepared from a file older
  than the checkout's (copied out before an earlier `get`, say) starts from
  the version the checkout last showed, not from that file.
- An edit sent with `--server` reaches serve's own handler, whose base is
  serve's file at save time: only a change another writer lands between
  that read and the commit refuses it. Team members edit through
  serve-mode checkouts (#3985), which keep their own base.
- A delete forwarded to a serve older than schema 11 is refused by that
  serve's parser and nothing is written: upgrade serve first.
- v2 `managedConfig` has no preconditions: the last writer wins.

Auto-definitions, evaluated definitions and workflows, and run snapshots
carry none: every direct execution rewrites an auto-definition, and the
others are derived files that hook-less commands also write.

**Renames.** A rename spans two partitions, so it is two batches, and the
unit commits partitions in the order each was first touched, so the new
name lands first. No use case touches the old name's partition earlier in
the same unit, which that order relies on;
`integration/datastore_v3_config_staging_test.ts` pins it. A crash between
the two commits leaves both names, and the definition resolves by id. For a
same-key rename the store holds two live records of one key, and the read
model's ownership rule ("Keys two partitions write" in "v3 read model")
keeps the file with the new name's bytes.

The two commits are not atomic, so another checkout can edit the old name
between them. Its edit expects the bytes the old partition still holds, so
it lands. For a same-key rename the old name's edit is then the newest put
of the key, and the rename's tombstone, which follows it, removes the file
while the new name's record stays live. Replaying the feed gives the same
result, so every checkout agrees, and the next save of the new name
restores the file. This is accepted: the same race loses one of the two
changes on v2, and closing it needs a commit spanning both partitions.

**Directory removals.** `clearAll`, `clear` and `deleteForRun` remove whole
directories. On v3 each lists its files first and stages one tombstone per
file, finding each partition from the raw YAML fields (and a legacy file
name's uuid), never a schema parse, so a file another swamp version wrote
is still found. A file that names no valid aggregate (a missing or
non-UUID id, an invalid behavior type), or a run directory that is not a
UUID, stages nothing: no repository ever put it, and run GC must not abort
on a stray directory. Neither `clearAll` nor `clear` has a production
caller.

**Writers with no hook.** These write the same files through repositories
built without a hook: CLI `behavior create` and `behavior edit` and `workflow
create`, `behavior evaluate` and `workflow evaluate`, and serve's
`migrateGrantDefinitions`. On v3 their typed changes stage
into the commit-log unit around them (swamp-club#3279, "v3 opt-in"), and
`runManagedConfigMutation` stages no bulk change there: it has no sync
service.

**The gate.** `integration/datastore_v3_config_staging_test.ts` runs the
four repositories on v3 in a commit-log root, solo and namespaced, and
compares a caught-up read model's files with theirs for every path above:
including same-key renames, a cold repository's rename, a save across
tiers, a git-tracked write that stages nothing, and run snapshot removals
of a stray and an empty run directory. It also covers a rename's commit
order and crash states, a stale edit, a concurrent create, and a file out
of step. Dropping any staged change fails it.

#### Workflow run and vault config repositories (swamp-club#3257)

The third staging group: `yaml_workflow_run_repository.ts` and
`yaml_vault_config_repository.ts` stage typed changes for every write they
make on v3, through the same two calls. v2 does not change: every read a
typed change needs runs behind `typedStagingActive`, and every builder
inside `stageTyped`.

**The mapping.**

| Write | Typed changes |
|---|---|
| Run `save` | A `run.create` put of the record when the file was new, else `run.update`, in `run--{workflowId}--{runId}`, with no precondition. The content is a stream of the written file |
| Run `deleteAllByWorkflowId` | One `run.delete` tombstone per run record the directory held, listed before the removal, each its own batch |
| Run `deleteOlderThan` (GC) | A `run.delete` tombstone of each record it removes, terminal or unparseable; a dry run stages nothing |
| Vault `save` | #3256's `definitionSaveBatches` with kind `vault`: a `definition.create` expecting the key absent, a `definition.edit` expecting the replaced bytes' digest, or a rename as two partitions (the path is by id, so a vault rename is always a same-key rename). A save of the bytes the file already held stages nothing |
| Vault `delete` | A `definition.delete` tombstone in the partition of the name the file declared, when the removal happened |

The record key is the file's path under the namespace root:
`workflow-runs/{workflowId}/workflow-run-{runId}.yaml` and
`config/vaults/{type}/{id}.yaml`.

**Run records.**

- A run is saved many times in one unit, so its record is a stream put
  with no `expect`: the unit elides each earlier save still unread, and a
  flush commits the last one, under that save's intent (`run.update` after a
  `run.create` in the same unit). A put with an `expect` is never elided.
- No precondition: a run has one writer at a time under its lock, and
  cancel, recovery and the reapers rewrite the record as well as the run,
  so a digest would refuse the next save whenever the local file is out of
  step with the store.
- Removals find runs by directory and file name. A workflow or run id that
  is not a UUID stages nothing (no repository put it), so GC never aborts on
  a stray file. A record a hook-less write truncated is still tombstoned.
- Run logs and the run indexes (`.runs-index.json`) are local-only: the
  executor writes the log under the repository's own `.swamp`, whatever the
  datastore, and the indexes are a local cache. Neither stages anything;
  run GC and `deleteAllByWorkflowId` remove logs where runs write them
  (swamp-club#3266) with no signal.
- A run's snapshot is #3256's (`run-snapshot.*`, same partition).

**The `bulk` mapping.** Neither repository stages a `bulk` change on v2.
`deleteAllByWorkflowId`'s directory removal, the only directory mark,
becomes one tombstone per run record listed before the removal.

**Vault configs.**

- Only managed config makes a vault config a datastore file. A repo-local
  `vaults/` file is git-tracked and stages nothing, which includes the
  default vault `repo init` writes (swamp-club#3259): a new repository has
  no config tier. A default vault saved under managed config names no host
  path, so none reaches a commit.
- The typed change carries exactly the YAML the repository wrote. Secrets
  are the vault provider's, written under `.swamp/secrets` with no hook, so
  none ever reaches a typed change. A registry vault type that keeps a
  token in its config file already syncs it on v2; v3 carries no more.
- A migration to another type saves the new type's path (a create) and
  deletes the old one, both in the vault name's partition.

**Writers with no hook.** These write vault configs without a hook: `repo
init` (repo-local, as above), `datastore setup`
(`src/libswamp/datastores/setup.ts`, `src/cli/commands/datastore_setup.ts`),
the CLI's fallback repository in `src/cli/mod.ts`, serve
(`src/cli/commands/serve.ts`), and the `vault create` and `vault edit`
fallbacks when no repository is injected. Inside a v3 root their typed
changes stage into it (swamp-club#3279, "v3 opt-in"); `repo init` and
`datastore setup` run before any v3 datastore exists.

**The gate.** `integration/datastore_v3_run_staging_test.ts` runs the run
repository on v3 in a commit-log root, solo and namespaced, and compares a
caught-up read model's run records with the repository's for every path
above. It also runs the `workflowRun` use case on a v3 context: the unit
commits a succeeded, failed, suspended and cancelled run and discards an
early stop; and after a real `version-live` refusal and an `expect-failed`
one, the committed record has the step that wrote the refused data failed,
as does a later unit's save of the run. Without `onRefused` no run record
commits. `integration/datastore_v3_vault_staging_test.ts` covers create,
edit, an unchanged save, a rename's commit order, a migration, the default
vault, delete, a stale edit, a secret and a repo-local config that commit
nothing, and v2 reading no file. Dropping any staged change or rule fails a
gate.

### v3 read model (datastore rework Phase 3)

swamp-club#3239 adds the read model: it brings one checkout's local files, a
v3 catalog and an index of live records up to date with `commits.db`. It is
dormant: nothing in production opens it, and
`integration/datastore_v3_rules_test.ts` keeps it inside the v3 directories.

**Ubiquitous language.**

- **Read model**: the local files, catalog and index that behavior code, CEL
  `.path` and queries read. It is a cache of the commits, rebuilt from them.
- **Cursor**: how far this checkout has caught up with the store-wide change
  feed (`changesSince`).
- **Applied seq**: the last seq of a partition this checkout applied.
- **Live-record index**: each partition's present records, with their digest
  and `BlobRef` (or an inline marker). `chunksInUse` gives the chunks behind
  one checkout's present records. Chunk garbage collection does not use it:
  a checkout catching up from the start needs every chunk any commit names
  (see "v3 chunk garbage collection").
- **Checkout-copy guard** (swamp-club#3617): the check before an overwrite or
  removal that stores again, from the checkout file, committed chunks only
  that file may still hold whole ("Failures" below).
- **At-risk copy**: a checkout file the guard moved aside into
  `_read_model_v3/at-risk/` because the storage refused its chunks.
- **Unreadable record**: a key whose put could not be materialised because a
  chunk is missing, torn or damaged; its file is absent and reads of it fail
  loudly.
- **Removal candidate**: a key a reset keeps in `load_touched_keys`, for a
  compacted-base load to remove when the base does not show it.

**Port and adapter.** `ReadModel` (`src/domain/datastore_v3/read_model.ts`)
has `catchUp`, `catchUpPartition`, `liveRecords`, `chunksInUse` and `close`.
`SqliteReadModel` (`src/infrastructure/datastore_v3/sqlite_read_model.ts`)
implements it. It reads commits only through the `CommitStore` port, and a
fitness rule keeps `sqlite_commit_store.ts` the only code that writes the
commit tables or opens `commits.db`.

**Who writes local files in Phase 3.** Repositories keep writing local files
exactly as today. The read model applies commits to the same files, and
applying a commit twice changes nothing, so applying one this process just
made rewrites the same bytes. Moving repositories to materialiser-only writes,
with a fitness rule against repository file writes, is a later step. The read
model never calls a repository, and the commit-log unit of work never calls
the read model.

**What a materialised file keeps** (swamp-club#3693). Its bytes, and its
file access: whether it is executable (any execute bit on the writer's
file) and whether it is private (no group or other bits). Never a full
POSIX mode, an owner or umask bits. The writer records the access from the
stat it already takes when it stages a data version's content file
(`rawSource` in `unified_data_repository.ts`); metadata, markers, outputs,
definitions, runs and lockfiles are always plain. Every checkout derives the
mode from the one its own umask gave the new temp file
(`modeWithAccess`, `file_access.ts`): executable adds an execute bit
wherever a read bit is set, private keeps only the owner's bits, so a 0755
output is 0755 under umask 022 and a 0600 file never widens. The read model
applies it on every path that writes a file: a commit, the compacted base, the
check after a reboot and an unreadable record's retry, so the access is kept
wherever the read model keeps a put's content (`live_records`,
`load_records`, `unreadable_records`, `base_records`). A file the
checkout-copy guard keeps for its bytes is rewritten through a temp file
when its access differs, never chmodded by path. Only a put that records an access corrects a kept
file: a plain put, which every put before this change is, keeps whatever
mode the file has, as before. Private means no group or other bits, so a
writer whose umask is 077 records every output as private, and a group-only
file (0640, 0750) is plain or executable and takes the reader's umask.
Windows keeps no modes: a Windows writer records none and a Windows
checkout applies none. A rename of
a data name copies the bytes into a new plain file (`saveVersion`), so the
renamed versions are plain, locally as everywhere.

The field came with `commits.db` schema 7 (`base_records.access`): a swamp
at schema 6 would reject a put's `access` as an unknown field and call the
store corrupt, so it refuses the store as newer instead
(`datastore_v3_schema_newer`). The commit outbox, which holds the same commit
bodies, goes to schema 4 for the same reason, and `_read_model_v3.db` to
schema 7. All three are one-way. A plain put serializes as before, so commits
written before them read as plain files.

**Where its state lives.** Everything the read model keeps is in
`.swamp/_read_model_v3/`, built from the repository with
`readModelStateDir(repoDir)` (`swampPath`), never from the datastore resolver:

| File | Holds |
|---|---|
| `_catalog_v3.db` | The v3 catalog |
| `_read_model_v3.db` | The cursor, each partition's applied seq, the live-record index, and each data name's live versions with their metadata; since schema 5 (swamp-club#3617, one-way) `unreadable_records`, `at_risk_copies` and `written_files`; since schema 6 (swamp-club#3691) `checkout_filter`, which a reset never clears; since schema 7 (swamp-club#3693, one-way) the file access of each live, staged and unreadable record |
| `read_model.lock` | The lock that serializes catch-ups across processes |
| `at-risk/<storage namespace>/<sha256>` | Checkout files moved aside by the checkout-copy guard (swamp-club#3617) |

The issue that planned this suggested `_catalog_v3.db` beside `commits.db`.
It lives in the checkout instead, for two reasons:

- **The state is per checkout.** Several repositories can share one
  datastore. If they shared a cursor, the first to catch up would move it for
  all of them, and the others would never apply those commits. Today's
  `_catalog.db` is per repository for the same reason (`catalogDbPath`).
- **Record keys cannot reach it.** In solo layout the cache root is `.swamp/`
  itself, so a record key could name a file there. `_read_model_v3` is no
  datastore subdirectory, and the key guard below refuses every key whose
  first segment is not one. It is never synced: sync routes only datastore
  subdirectories, and a fitness rule keeps `_read_model_v3` out of
  `DEFAULT_DATASTORE_SUBDIRS` and `ALWAYS_LOCAL_SUBDIRS`. Git ignores it
  through `repo init`'s managed `.swamp/` entry.

**The v3 catalog.** `_catalog_v3.db` is opened with the existing
`CatalogStore`, unchanged, so it has the schema and query API data query
already uses, and no v2 code changes. Switching data query to it is the
opt-in's job. Rows are built from a version's metadata field for field as the
v2 repository's `catalogUpsert` builds them, with the behavior type and id from
the partition key. One difference: v3 keeps a version's tags in key order
(`dataVersionOp`), so the `tags` JSON can list keys in a different order than
v2 wrote them, with the same meaning.

**Commits to catalog changes.** `projectCatalog`
(`src/domain/datastore_v3/catalog_projection.ts`) is a pure domain service. It
reads names and versions from intents and metadata, never from record keys,
and gives the catalog actions v2 takes for the same change:

| Op | Catalog actions |
|---|---|
| `data-version` | Upsert the version's row. For a rename marker (`lifecycle: deleted` with `renamedTo`), remove the name's rows and forward it, as `rename()` does |
| Versioned `data.delete` or `data.gc` tombstone | Remove the version's row, then reconcile the name, as `delete(version)` and `collectGarbage` do: no live version left removes the name and its forward; a rename marker on top removes the name and forwards it; otherwise the greatest live version's row is upserted again, which restores a row an earlier rename removed |
| Version-less `data.gc` | Expiry (`removeLatestMarker`): remove the name's rows; its versions stay. An expiry after a versioned tombstone of the name in the same commit wins, as `delete(version)` then `removeLatestMarker` would; a versioned tombstone after it reconciles the name again |
| Version-less `data.delete` | Nothing: a delete of a whole name lists each version as its own tombstone |

The version-less tombstone rows are a contract with the commit-log unit of
work, which builds the ops: v2 expiry must become a version-less `data.gc`.
`integration/datastore_v3_read_model_v2_oracle_test.ts` holds the projection
to v2: a v2 repository saves, deletes, renames, expires and garbage-collects,
each step's file changes become one commit, and the read model's files and
catalog must equal v2's.

**Applying a commit.** Commits are applied in landing order. A commit at or
below its partition's applied seq is skipped (`catchUpPartition` applied it
already). Within one partition, positions in the change feed grow with seqs,
so that alone keeps a catch-up from rolling a file back to an older put of
the same partition. Across partitions it does not: see "Keys two partitions
write" below. A commit's
ops see each other's effects, so only each key's last put or tombstone is
materialised, removals before writes, so a removal can clear the path a write
needs (a put of `data/x` beside a tombstone of `data/x/y`). Effects come in a
fixed order:

1. **Files.** A put is written under the namespace's cache root: inline
   bytes, or streamed from `ChunkStore.read`. The content goes to a temp file
   that is renamed into place, so a reader sees the old file or the new one.
   It is not synced: see "Durability across reboots" below. A tombstone
   removes the file, ignores one already gone, and removes empty directories
   up to the root. A directory at a tombstoned key (a name directory) is
   removed only when empty. Every path passes `assertContainedPath` and the
   symlink check `assertSafePath` makes; within one exclusive section a
   directory's real path and whether it is a directory are looked up once
   (`PathCache`), and forgotten whenever the read model removes anything.
   The temp file gets the put's file access before the rename (see below).
2. **Catalog.** The projection's actions.
3. **State.** One transaction holds the index changes, the live versions, the
   ownership of each file the commit wrote or removed, the keys it wrote or
   removed without a sync, the partition's applied seq and, from `catchUp`,
   the cursor. Neither the cursor nor an applied seq moves back.

Commits are applied a page at a time (`pageSize`, 500 by default): each
commit's state transaction is a savepoint in one transaction for the page,
which commits after the page's files are written. An apply error at commit k
keeps the commits before it, and the error is rethrown. The page's catalog
actions are held and applied in one catalog transaction after its files and
before its state (swamp-club#3803); a crash between the two leaves the catalog
ahead, and the page is applied again. A removed version recomputes its
group's latest flags in one SQL statement, from the group's maxima, rather
than reading the group's rows.

**Net replay (swamp-club#3803).** A catch-up from the start of the feed (a
first clone, a restore, a rebuild after a reset) reads the feed once first, up
to a bound fixed then, and runs `decideFile` over each key's changes to find
the content still on disk at the end (`NetReplayPlanner` in
`materialisation.ts`). The replay then leaves off disk a write a later change
up to the bound replaces or removes, and a removal of a file it never wrote.
Ownership, the record index, catalog actions and the cursor are recorded as
in a full replay, and the path checks run for every change. A key skips writes
only when its top directory was absent before the catch-up and no other key
the first pass read is its path prefix or lies under it, so its file can never
decide another key's file and directory conflict. A recovery, a partition
catch-up and the rest of a catch-up that meets a compacted base after it has
applied commits replay in full, and so does one resumed after a crash: from
the bound on, every file is where a full replay leaves it. On the dogfood
repos a clone wrote 13.7k files instead of 40-48k.

**Netted base load (swamp-club#3916).** A net catch-up that meets a compacted
base before applying anything plans the base and the tail after it together.
After staging the base, it seeds a `NetReplayPlanner` with each staged file's
ownership (`seed`), reads the tail once from the point to a bound, and lets
the load leave off disk each base file a later tail change replaces or
removes, under the same directory and prefix rules. The same plan is the
tail replay's net plan, so the replay also skips the removal of a file the
load never wrote. The state, index and catalog take the whole base as
before. A skipped file always has a later tail change at or below the bound,
which the replay applies after the load: a crash in between resumes the
replay at the point, where that change still is. A load retried after a
crash finds its own written directories present, and loads those in full. A
property test (`datastore_v3_net_replay_property_test.ts`) holds a netted
base load plus tail to a full one, with crashes at the load's barrier and in
the tail.

**Readers of a checkout another process writes.** A reader skips catch-up
there, since the writer's files are newer than the commits it would replay,
but only once the read model is complete. Until then a catch-up is running or
was cut short and the files may be between two commits, so the reader waits
for `read_model.lock`, the OS lock every catch-up holds and a crashed process
releases, up to the lock timeout, then finishes the catch-up if the read model
is still incomplete. A wait that runs out fails with
`datastore_v3_read_model_busy` (exit 75) and reads nothing.

Each effect is idempotent, so catching up again from the unchanged cursor
redoes the effects of a crash anywhere. That is not always a repair on its
own: a replay can overwrite the only good copy of a chunk the datastore lost
or tore, and a commit whose chunk is gone cannot be materialised. The
checkout-copy guard and unreadable records (under "Failures" below) cover
those; what neither can repair is reported by `doctor datastores`. The index
and the cursor are never ahead of the files. Calls queue in the process, and an exclusive OS lock on
`read_model.lock` serializes processes, so a slow catch-up cannot rewrite a
file a faster one has removed.

**Durability across reboots (swamp-club#3337).** The read model must never
trust a commit's files while a crash, power loss included, could have lost
them: a checkout would then believe it is current with a missing or empty
file, and never repair it. Syncing every file as it was written held that,
but on macOS `FsFile.sync()` is `F_FULLFSYNC`, a full drive-cache flush: a
fresh checkout of 1,000 items took 26 s against v2's 1.1 s. Syncing a page's
files and directories together at one barrier brought that to 5.6 s, still
about 5x v2, since a 1,000-item clone has some 3,000 files and 2,000 new
directories to sync and the flushes only partly coalesce.

So the catch-up does not sync files at all. A written file can be lost only
to an OS crash or a power loss, and either one ends the boot: until then the
page cache holds what was written, whatever happens to the process. The
state records each key a catch-up wrote or removed (`unsynced_keys`) and the
boot it ran in (`unsynced_boot`, from `boot_identity.ts`). On the first
exclusive section in a
later boot, every listed file is checked against the state: a present file
must be a regular file with the live record's SHA-256, an absent one must be
gone (a directory left at a removed name is fine; the key of an unreadable
record is expected absent). If all match, they survived the reboot and are on
disk, and the list is cleared.

A file that does not match is rewritten in place (swamp-club#3617), not by a
reset. Each listed key resolves through the same path checks a catch-up uses
(`#target`); one expected absent is removed, one expected present is written
from the live record's `BlobRef`, or for inline content from the commit at
the file's ownership mark (read once per mark, its SHA-256 verified). Every
removal and write goes through the checkout-copy guard and one
`DurableWriteBatch` with sync, then one barrier, then the list is cleared, and
the catch-up goes on from the cursor. The state is reset and every commit
applied again only when that cannot be done: a listed key with no live record
(`expect: unknown`), a key `#target` refuses, inline content the commit no
longer holds, or any other error. `CheckoutCopyAtRiskError` and an abort
propagate instead. The check runs first in the exclusive section, before the
catalog generation check, so a reset that check makes cannot drop the list
unchecked. On a storage that reads sizes, a listed file that matches has its
committed chunks guarded too, so a chunk torn in the same crash is put again
from the checkout (on a bucket, which cannot tear a chunk, it is not).

The boot must be named by the kernel, never by the clock: the boot time
(now less the uptime) shifts when the clock steps within one boot, which
would look like a reboot, and the check would read the files back from the
page cache, pass, and stop watching them. So the identity is
`/proc/sys/kernel/random/boot_id` on Linux and the `kern.bootsessionuuid`
sysctl on macOS, read once per process. Where neither is available
(Windows), or it cannot be read, the catch-up syncs its files at each
page's barrier instead and lists nothing; a list left by an earlier boot is
then not trusted, and every commit is applied again, synced.

The released binary is compiled with granular `--allow-*` flags, and Deno
refuses any read under `/proc` without `--allow-all`, however narrow the read
grant. Until swamp-club#3418 the Linux binary therefore named no boot and
synced every file, about 5,000 fsyncs for a 1,000-item first clone, while
tests and source runs under `-A` read the id fine. When Deno refuses the read,
the id is now read by running `/bin/cat` (or `/usr/bin/cat`), as macOS runs
`sysctl`, with a 2 s timeout; only a UUID is accepted, and any failure names
no boot, so the catch-up syncs as before. The boot is read once per process.
`integration/datastore_v3_boot_identity_grant_test.ts` reads it on Linux
under the grant `scripts/compile.ts` names, so a change to that grant is
tested too.

The cost moves to the first open after a reboot: it hashes every file
written since the list was last cleared, holding the read model's lock. The
list is bounded by the checkout's keys, but a long-running `serve` can
leave most of its cache on it. A listed file the state shows present with no
live record for its owner cannot be checked, so it resets the state; it is
logged as such. A key the writer had already overwritten is written twice,
still cheaper than a reset.

What this does not cover: anything that loses page-cache writes without
ending the boot. A disk detached mid-write, a write-back I/O error (which,
with no fsync, nobody sees), a filesystem forced to shut down and remounted,
an NFS server that loses its cache, or a VM restored from a snapshot can all
lose unsynced files while the boot id stays the same, and the read model
will not notice. The check runs at the start of an
exclusive section, so an index read (`liveRecords`, `chunksInUse`) before
the first catch-up of a new boot is not covered by it. Serve's
`syncUnsyncedFiles` opens such a section too, so its reboot check runs
without the `anotherProcessWritesCheckout` gate a catch-up has; the window is
narrow, since serve holds the writer lock then and the check runs once per
boot. A commit whose apply
fails is not recorded, so the files it wrote before failing are not listed:
until its retry rewrites them, a reboot can leave one torn. `commits.db` keeps
`synchronous=FULL` and stays the source of truth. On macOS that is a plain
`fsync`, not `F_FULLFSYNC`: `node:sqlite` runs with `PRAGMA fullfsync=0` and
`checkpoint_fullfsync=0`, and swamp sets neither (swamp-club#3617 checked
this; changing it is out of scope). The compacted-base load
and recovery's sweep still sync their files at a barrier
(`DurableWriteBatch`): they are rare. They keep `F_FULLFSYNC`; only the chunk
storage uses `F_BARRIERFSYNC` (swamp-club#3737).

**Keys two partitions write (swamp-club#3256).** A same-key definition
rename (two names that are not filename-safe, both stored at the
definition's uuid path) puts the new name's record at a key the old name's
partition then tombstones. `catchUpPartition` applies one partition's
commits ahead of the change feed, so a later `catchUp` can apply the old
name's earlier put after the new name's, and the tombstone after both. The
file must follow the feed, not the order commits are applied in.

`readPartition` returns each commit with its feed position, as
`changesSince` does. The state (schema 2, `materialised_keys`) records, for
each file, the partition whose put it shows (the owner), that put's
position (the mark), and whether it is present:

- a put writes the file only when the key has no ownership or its position
  is greater than the mark, then becomes the owner;
- a tombstone removes the file only while it is present and owned by the
  tombstoning partition, and keeps the mark, so an older put of another
  partition cannot bring it back. A key with no ownership is removed as
  before (no put of it was applied, or it is a name directory).

The result is that of applying the feed in order: a file holds its latest
put in feed order, unless a later tombstone from that put's own partition
removed it. A key only one partition writes behaves exactly as before, as
its positions grow and it has one owner. The decision reads the ownership
from before the commit, and the state is replaced only after every file, so
a retry after a crash decides the same way. Schema 2's migration clears the
catalog generation, so a state built under schema 1, whose files have no
ownership, is reset and replayed. A path conflict still depends on what is
on disk, so it is not independent of order across partitions; config keys
cannot form one. `integration/datastore_v3_read_model_shared_key_test.ts`
checks that random mixes of store and partition catch-ups end in the state
in-order replay gives, and in the state the rule above describes.

The live-record index stays per partition, so it can hold a record whose
file another partition owns, or an orphan: a same-key rename whose second
commit never landed leaves the old name's record live, while the file holds
the new name's bytes. Deleting the new name removes the file regardless.
The orphan stays live until someone tombstones it by hand. Chunk GC is
unaffected: definition records are small and inline.

**The key guard.** Serve does not yet bind a record key to its aggregate's
paths ("Authorisation requirements" above), and in team mode other
principals write commits. The read model therefore writes or removes a key
only when its first segment is a datastore-synced subdirectory
(`DEFAULT_DATASTORE_SUBDIRS` without `ALWAYS_LOCAL_SUBDIRS`), it names no
catalog database (`_catalog*.db` and its side files), and it does not land in
the state directory (`record_path_guard.ts`). That check is lexical, so
after `assertSafePath` the read model also refuses a key whose resolved path
lands in the state directory: a symlink already in the cache could lead
there. A refused key is logged and not materialised, but it is still
indexed, so the index stays exact for chunk GC.

**What is never projected** (swamp-club#3691). Every checkout materialises
every namespace, and other checkouts (or an older swamp on the same
datastore) can commit what this one would refuse, so the read model checks
each key against the checkout it projects into (`ReadModelCheckout`: its
namespace and its `datastoreKeyFilter`, passed by `openV3Datastore`).
`unprojectedReason` leaves a key alone when:

- **`reserved`**: its namespace is a reserved name
  (`isUnprojectedNamespace`), whose cache root `.swamp/<name>/` is a
  directory swamp keeps its own files in. Warned once per namespace.
- **`local`**: it is a key of the solo namespace, or of the checkout's own
  namespace, that the checkout's `directories` or `exclude` leave out. The
  solo cache root is `.swamp/`, so such a key's path is the checkout's local
  tier, which another checkout with more directories commits to. Two
  checkouts of one namespace with different directories also stamp their
  catalog rows with the same identity. Logged at debug level only, since it
  is expected on every such commit.

The check sits at the top of `#target`, so all four callers skip the key
(`#checkUnsyncedAfterReboot`, `#materialise`, `#loadFiles`,
`#retryUnreadableRecords`), and it follows the refused-key path: no file
written or removed, no file ownership, not in the touched or unsynced keys,
while the record stays in the records index and the cursor and applied seq
move past it, so history, chunk GC and compaction inputs stay whole. A
listed unsynced key that is now unprojected is skipped after a reboot rather
than triggering a reset, and an unreadable record of one is dropped. Catalog
actions of every kind (upsert, remove-name, remove-version, forward,
end-forward) for such a key are dropped by `ProjectedCatalog`
(`v3_catalog.ts`), a wrapper around the read model's catalog that maps each
action to its row's record key (`catalogRowRecordKey`; a name-wide action
maps to the name's latest marker), so one place covers both applied commits
and the compacted base. Another checkout's commit can then neither add,
change nor remove a file or row this checkout keeps for itself.

So in a checkout whose directories leave out a subdirectory, the solo
namespace's and its own namespace's records in that subdirectory are
invisible there by design, and a reserved namespace's records are invisible
in every checkout. Catalog rows of a reserved namespace written before this
fix stay, but read as empty: the v3 foreign-content fetcher ("v3 opt-in")
refuses a reserved namespace.

**The checkout filter is fixed** (swamp-club#3691). Which keys are `local`
depends on the checkout's `directories` and `exclude`, and a rebuild under a
new filter would lose the checkout's file ownership and local-tier rows, so
there is no re-projection. Read-model state schema 6 adds a single-row
`checkout_filter` table holding the filter inputs the projection was built
with: the configured directories, sorted and deduplicated (`null` for the
default set, so a swamp that changes the default does not refuse its own
checkouts), and the exclude patterns, as JSON. The exclude patterns are
read as the matcher reads them (trimmed, blank and comment lines dropped).
Without a `!` pattern every match excludes, so they are deduplicated and
sorted and a reordering opens; with one, the last match wins, so they keep
their order and a reordering is refused. It is its own table,
not `meta`, so a reset never clears it, and an older swamp refuses the newer
state with its upgrade message rather than dropping it.
`openV3Datastore`, the one production opener every v3 path uses, checks it
first (`assertCheckoutFilterUnchanged`), before the read model opens, catches
up, loads or recovers a writer. Inputs that differ throw
`V3CheckoutFilterChangedError` (`datastore_v3_directories_changed`): changing
directories on an existing v3 checkout is not supported yet. The filter
lives in the committed `.swamp.yaml`, so one edit refuses every existing
checkout of the repository on its next command, solo checkouts included.
The message says so, and offers first to restore the previous directories
and exclude patterns, then a fresh checkout, naming the local-only files
(the subdirectories this checkout keeps local, and anything its exclude
patterns keep out) that a fresh checkout will not have, since they were
never committed, so they can be copied out first. Nothing is changed. A state with no row (a projection from
before the fix) is stamped with the current inputs. `doctor datastores`
reports the refusal as a failing `v3_directories` check
(`v3CheckoutFilterRefusal`, which reads the state read-only and stamps
nothing) and skips the checks that would open the checkout.

**Materialised subdirectories stay in their cache root** (swamp-club#3691).
A first-level materialised subdirectory such as `.swamp/data` that is a
symlink or a Windows junction to somewhere outside `.swamp` would fail every
catch-up of a commit under it with a `PathTraversalError`, while the writer
went on committing what the read model cannot apply.
`assertV3CacheSubdirsContained` (`cache_root_containment.ts`) checks, by real
path rather than `lstat`, that each such subdirectory resolves inside its
cache root: every one under the checkout's own namespace's root, and those
the checkout's `directories` admit under the solo root. A link that stays
inside is allowed; a dangling one is refused. v3 filesystem setup refuses
before it starts, and a v3 context or `holdV3Writer` refuses to open before
recovery and catch-up, each with a message saying to replace the link with
a real directory (code `datastore_v3_cache_root_escape`). An escape deeper in the cache still fails catch-up with
`PathTraversalError`, a deliberate, tested behaviour.

**Departures from swamp-club#3691's proposals.**

- The local tier is protected by filtering (the issue's option 2), not by
  refusing a namespaced checkout beside a solo one, or checkouts with
  different directories: no valid setup is refused.
- `migrateFromSymlinks`, bundle eviction and the solo recovery sweep are
  unchanged rather than taught to skip namespace cache roots. With the
  read-model guard no reserved namespace's cache root is ever written, so
  they cannot meet its records; a sweep skip would also have disabled the
  solo namespace's own recovery.
- Reserved names come from a domain list guarded by a rules test, not
  derived from `SWAMP_SUBDIRS` (layering, see "Reserved namespace names").
- `hydrateForeignRecord` keeps its early return for a record whose
  attributes are already filled: `fromRow` no longer fills a foreign row from
  the reader's own path, so filled attributes are the right ones.
- Changing directories on a v3 checkout is refused, not re-projected.

**Path conflicts.** A file and a directory claiming one path (a put of
`data/x` where `data/x/y` exists, or of `data/x/y` where `data/x` is a
file) can never succeed, and in team mode another principal could cause one.
Retrying would block every later commit, and with them chunk GC, so a put
that conflicts is logged and skipped like a refused key, and stays indexed. A
tombstone under a file has nothing to remove.

**Spellings that alias** (swamp-club#3939). On a case- or
normalisation-insensitive filesystem (APFS, NTFS), a key nothing owns can
reach another key's file: `VPC/1/raw` reaches `vpc/1/raw`. The read model
neither removes nor writes through such a key. For a put or tombstone of a
key with no file of its own on disk (no put of it owned one, or its own
tombstone removed it) whose path nonetheless reaches a file, it reads the
spelling that file has on disk. Every key that folds to that spelling
(case-folded and composed, NFC) reaches the same file, whichever spelling
created it, so the file is another key's when such a key, other than this
one, has a present file or the same commit already decided one. The change
is then logged and skipped, and stays indexed (`aliased_skipped` in the
catch-up span). The present keys are looked up by folded spelling in the
read model state, through an index built on first use and kept in step as
commits are applied. A key reached through another spelling of a directory
only, such as `vpc/2` under `VPC/`, names no other key's file and is written,
so a recovery replay gives it back its ownership. This holds for every
checkout, solo ones included, since the same replay runs everywhere.

The check costs nothing where nothing folds. The read model probes its state
directory once, inside its exclusive section (`spelling_folding.ts`), and
each cache root on the same device takes the result:

- `off`: neither an upper-case nor a decomposed spelling reaches the probe
  file. The check is skipped, so a replay on Linux is unchanged.
- `canonical`: a spelling reaches it, and `realPath` gives the name on
  disk. The spelling on disk is the file's real path below the root, which
  the key guards already resolved, so nothing is listed.
- `list`: a spelling reaches it but `realPath` echoes the spelling given (as
  on HFS+, which stores names decomposed), the probe failed, or the root is
  on another device. The spelling on disk is read from the directory
  listings, each segment matched as listed or case-folded and composed.

Listings are cached for one apply page and dropped whenever a write adds a
name, so a replay over files already on disk lists each directory once at
most. Two limits remain. A compacted base load writes keys that own their
files, so it is not checked, and two owned keys that differ only in case
inside one base still share a file on such a filesystem. Case folding set per
directory below a cache root (ext4's `chattr +F`, NTFS's `fsutil file
setCaseSensitiveInfo`) is not detected: the probe of the state directory
answers for the whole device.

**Failures.** Any other failure throws `ReadModelApplyError`, naming the
namespace, partition and seq, and leaves the cursor before the commit, so the
next catch-up tries it again. Causes are a `BlobRef` with a `legacyKey` (no
migration writes those yet), a write error, and a missing or damaged chunk in
a commit at or below the compaction point (below). An
abort stops between commits or during a chunk read, and leaves no partial
file. Waiting for another process to release `read_model.lock` is not
abortable: the OS lock has no abort hook.

**The checkout-copy guard** (swamp-club#3617). A checkout file can hold the
only good copy of a committed chunk the datastore lost or tore in a crash, and
a replay over it (a reset, a recovery, the reboot check) would destroy it.
So before the read model overwrites or removes a file, `#guardExisting` runs,
from `#writeContent` and `#removeRecord`, every overwrite and removal path:

- It looks only at a regular file over `MAX_INLINE_BYTES` (8 KiB; smaller
  content is inline in its commit) that this exclusive section has not
  written or guarded already. The file is streamed once and cut as the chunk
  store cuts content (`refOf`). A file that already holds the content about
  to be written is left in place and the write skipped.
- **Files it wrote are not read again.** After each write of a blob over
  `MAX_INLINE_BYTES` the read model records, in `written_files`, the blob and
  the file's inode, device, size, and modification and change times, from the
  temp file's own stat before the rename, checked against a stat of the path
  after it, so a file another process renamed in between is never taken for
  its own. A later guard outside a replay whose stat of the file still shows
  all of them uses the blob's parts instead of reading the file, unless the
  write about to happen is of that same blob: whether a file already holds
  the content is only decided by reading it. Any write, truncation,
  replacement or `utime` changes the stat, so a file another process changed
  is read as before. A reset clears the table, a removal forgets its row, and
  a platform without inode numbers records nothing. Nor does Windows, where
  Deno reports an NTFS file id only as a number that loses its low bits past
  2^53 (and SQLite cannot read such a number back): there the guard neither
  records nor looks up a written file, so a row an older release wrote is
  never read (swamp-club#3788).
- **At-risk parts** are the file's parts the storage does not hold: absent,
  or at the wrong size on a storage that reads sizes. In a replay (a section
  that began with a reset, or a recovery) on such a storage, parts held at the
  right size are read and hashed too (`verifyParts`), so same-size damage is
  found there; in an ordinary catch-up it is not, and only serve's GC verify
  finds it.
- Only parts a stored commit, the compacted base or a pending outbox entry
  names count: `V3Datastore` supplies the outbox's references united with
  `commitStore.referencedChunks(ns, hashes, NOT_RELEASED)`, the outbox asked
  first: a writer prepares in the outbox, appends to commits.db, then settles
  the entry, so asking commits.db first could miss a commit that lands
  between the two lookups. `NOT_RELEASED`
  is the maximum date, so released chunks never count, and a lagging checkout
  uploads nothing compaction released.
- They are put again from the file (`putParts`, no dedupe), then given the
  chunk directory barrier.
- On a storage that cannot read sizes (a bucket, whose puts cannot tear a
  chunk) the guard runs only for removals (the reboot check's included, through
  `#removeRecord`) and in replays, using one batched `has` per file; the reboot
  check's rewrites and the files it finds matching are not guarded there, so an
  ordinary catch-up makes no extra requests per file. The trade-off: a chunk lost from a bucket by
  external damage is not protected when a normal catch-up overwrites the file.
  A file the guard skipped so is not marked guarded, so a later removal of it
  in the same section still reads it. And when a write's chunks then cannot
  be read (`ChunkMissingError`, `ChunkIntegrityError`), the failed write left
  the file as it was, and the guard reads it then: a file that holds the
  content about to be written is the only copy of a chunk the storage lost,
  so it stays, and the record is not unreadable.
- A file left in place because it already holds the content is synced, and
  its directory with it, when the section's batch syncs: when the boot cannot
  be named ("Durability across reboots"), no reboot check will cover it.

**At-risk copies.** When the storage refuses a put (not an abort), the file
is moved aside rather than failing the section: renamed into
`_read_model_v3/at-risk/<storage namespace>/<sha256>` (the whole file's
SHA-256; a copy already recorded at that name only removes the file, once
its size and SHA-256 show the same bytes: a copy made by hard link, below,
shares its inode with a checkout file, so an edit there in place changes
it while it still bears the old name), the
at-risk and source directories synced, and an `at_risk_copies` row recorded,
keyed by (namespace, sha256). The overwrite or removal then goes on. Across
devices (`EXDEV`) the file is copied through a synced temp file and removed,
while all copies so far stay within 1 GiB (`DEFAULT_AT_RISK_COPY_BYTES`).
Copies made by rename on the same device are not capped: they take no new
space, and their count is bounded by the distinct content refused, one copy
per (namespace, sha256).
Only when the file can be neither moved nor copied, or the cap would be
passed, does the section throw `CheckoutCopyAtRiskError`, naming the file,
the cause and the way out; nothing was overwritten. A warning is logged once
per process.

A file that already holds the content about to be written is not moved: no
write will overwrite it, and the record stays readable. When the storage
refuses its chunks, the file stays in place and a copy goes aside instead,
at the same `at-risk/<storage namespace>/<sha256>` name (one already there
is kept only when its SHA-256 matches): a hard link, which
takes no space (a put refused for want of space is the likely case), synced
since the checkout's bytes may never have been; where the link fails
(across devices), a durable copy, within the same cap. The copy's directory,
`at-risk/` and the state directory are synced and an `at_risk_copies` row
recorded, so the retry below stores the chunks once the storage takes them.
A copy that cannot be made is only logged: the file stays, and the next
guard of it tries again.

At the start of every applying section, up to 8 rows, least
recently tried first and each at most hourly, are retried: a copy whose
referenced parts are stored, or no longer referenced, is deleted unread. On a
storage that reads sizes, the referenced parts held at the right size are read
and hashed too (`verifyParts`), so a copy moved aside for same-size damage is
kept until the damaged parts are stored again from it;
otherwise the copy's SHA-256 is checked against its name, its parts are put
from it, then it and its row are deleted. A copy whose hash no longer matches
its name (a hard link whose checkout file was edited in place) cannot store
the content it is named for: it and its row are deleted with a warning. A
copy gone (deleted by hand) deletes its row. Copies a crash left without a
row are adopted first, and the `.<uuid>.tmp` files a crash mid-copy left
there are removed once an hour old (`AT_RISK_TEMP_GRACE_MS`), unless this
process is still writing them. Once a put is refused as unauthorised, no copy is
tried again in that process. Unauthorised is read from the error's
structure, through up to four `cause`s: Deno's `PermissionDenied`, an HTTP
status of 401 or 403 (`status`, `statusCode`, `httpStatusCode`,
`$metadata.httpStatusCode`, `response.status`, a numeric `code`), or an
access-denied code or name such as S3's `AccessDenied`. A message alone
counts only when it names both the status and the refusal, so a 403 that is
merely part of a key or a size does not. A reset keeps the rows: they are
files, not a cache of the commits. A read-only member's copies stay until a
command with put rights runs, or the user deletes the directory, as doctor
advises.

**Unreadable records** (swamp-club#3617). A put whose chunks cannot be read
(`ChunkMissingError`, `ChunkIntegrityError`) no longer wedges the catch-up:
the key's old file is removed (through the guard), its ownership still
advances, later commits apply, and an `unreadable_records` row is written in
the commit's savepoint with the first bad chunk, the reason (`missing`, which
includes torn, or `damaged`) and the chunk's size and mtime at the time. A
`ChunkIntegrityError` that names its chunk gives the chunk at once, with no
part read again: `missing` when the storage counts it missing (absent, or at
the wrong size), else `damaged`. A row
is forgotten only when a later commit decides to write or remove that key; a
reset clears them all. A warning, with advice by record kind
(`unreadableRecordAdvice`), is logged once per process per key. At the end of
each catch-up up to 32 rows, least recently tried first, are tried again:
on a storage that reads sizes only once the chunk's size or mtime changed,
elsewhere hourly; and only while the key's ownership still shows the row's
put. A write that succeeds deletes the row and lists the key unsynced, in
one transaction. A retry that fails records the chunk that failed this time,
with its reason, size and mtime now, so the next retry waits on the chunk
that is failing, not on one that came back; a failure that names no chunk
keeps the row as it was. A `ChunkIntegrityError` whose parts all verify (no part
missing or damaged, so the row names no chunk) has nothing to watch: it is
retried hourly for as long as the row lives, until a later commit decides the
key or a reset clears it, each retry reading the whole content. Two
exceptions:

- A commit at or below the compaction point (`CommitStore.compactionPoint()`)
  rethrows as before, so the catch-up loads the newer compacted base rather
  than skipping a commit that is gone.
- The compacted-base load never rethrows: no commit is left to retry from.
  Its unreadable records take the `load_files` mark as their position and are
  written in the `finishLoad` transaction.

**Loud reads.** A record whose file is absent must not read as absent. The
`UnreadableContentLookup` port (`datastore_sync_service.ts`, beside
`HydrateFileHook`) takes the content path a repository read and returns the
`UserError` to throw, or undefined. On v3 it is
`unreadableContentLookup` (`unreadable_content_lookup.ts`) over the read
model, which builds `UnreadableRecordError` (code
`datastore_v3_record_unreadable`) naming the chunk and the advice. The
unified data repository consults it only in the not-found branches of
`getContent` and `getContentStream`. It travels on `RepositoryFactoryConfig`
and `RepositoryContext` (`unreadableContent`) wherever `hydrateFile` goes:
`v3RepositoryFactoryConfig`, the execution service, workflow run, resume,
evaluate and history, serve's deps and workflow handlers, and the behavior output data, logs,
evaluate and validate factories. `hydrateFile` stays undefined on v3.

A lookup that fails throws a `UserError` naming the path; it no longer warns
and reads as absent, since it runs only after a read found no file, and a
record it could not check reading as absent is the silent "no data" it exists
to end. A closed read model (a command shutting down) still reads as absent.

The port also has an optional `under(absDir)`: the unreadable records under a
directory (`UnreadableContentEntry`: the path spelled under the directory the
caller gave, the error a read of it throws, and the advice), for a read that
cannot name the file it wants and for listings. On v3 it is backed by
`SqliteReadModel.unreadableRecordsUnder(namespace, keyPrefix)`, one range
scan of the `unreadable_records` primary key (empty once the read model is
closed), with each directory mapped as a path is (solo and namespaced, with
the symlink fallback). `unreadable_records.ts` holds the repositories' side:
`unreadableRecordsUnder`, `warnUnreadableLeftOut` and `mayBeUnreadableError`.

**Single-record reads that fail loudly** (`datastore_v3_record_unreadable`)
instead of finding nothing:

- Workflow runs: `YamlWorkflowRunRepository.findById`, and `findGlobalById`
  when no workflow directory has the run's file, through one prefix query
  over `workflow-runs/` (so a workflow whose every run is unreadable, and
  which has no directory, is found too).
- Auto-definitions (`YamlDefinitionRepository`): `findByName`'s secondary
  path after every other search misses; `findByNameGlobal` through one prefix
  query over the auto-definitions directory, which also finds a type that is
  neither registered nor has a directory; `findById` and `findByIdGlobal` of
  an auto-definition stored under `<id>.yaml`.
- Evaluated definitions: `findByNameWithProvenance` and `findByName` (the
  name path), `findById` (the legacy UUID path), and `findByNameGlobal`.
- Evaluated workflows: `YamlEvaluatedWorkflowRepository`'s
  `findByNameWithProvenance`, the `--last-evaluated` cache, wired in
  `WorkflowExecutionService`.
- Outputs: `findLatestByDefinition` fails with the record's error when an
  unreadable output of the definition started after the latest readable one
  (an output's file name carries its definition and start), and answers with
  the readable one when the unreadable ones are older. `findById(type, method,
  id)`: an output id is not in its file name, and the read model keeps an
  unreadable record's key and chunk, not its id, so the lookup cannot tell an
  unreadable output's id from a mistyped one. A miss where the method has
  unreadable outputs fails with `mayBeUnreadableError`: the id was not found,
  and these unreadable records may be it, with code `not_found`, not
  `datastore_v3_record_unreadable`, since a mistyped id is no read of them. A
  miss with none is still null.
- Definitions by id and by name throw a record's error only when the record
  is the one asked for: its file name is `<id>.yaml` or `<name>.yaml`. Any
  other miss is null; a by-id miss of an auto-definition only warns naming
  the unreadable ones it cannot tell from its id, so a mistyped id or name
  never fails naming other records.

They are wired through `createRepositoryContext` (its output repository
included), so the CLI, serve and libswamp code using `repoContext.*` get
them; `createWorkflowHistoryGetDeps`, `createDataGetDeps` and
`createDataListDeps` pass the lookup to the run and auto-definition
repositories they build, and `createModelOutputGetDeps`,
`createModelMethodHistoryLogsDeps`, `createModelOutputDataDeps`,
`createModelOutputLogsDeps` and `createWorkflowHistoryLogsDeps` to theirs,
when their caller passes it. Three callers build `createModelOutputGetDeps`
from the repository directory alone, and so stay quiet about an unreadable
record: `model output search`'s preview and its selected output, and
`model method history search`'s selected output (pinned in
`PINNED_WITHOUT_DEFINITION_REPO`,
`integration/model_output_deps_wiring_rules_test.ts`).

**Listings keep their results**, so their output and `--json` shape are
unchanged, and `warnUnreadableLeftOut` logs one warning per listing naming
the unreadable records under the listed directory and the way out; a record
is named once per process, so serve's repeated sweeps do not repeat it. A
query that fails is a warning too, since the readable records listed are
still right. Runs: `findAllByWorkflowId`, `findAllSummariesByWorkflowId`,
`findLatestByWorkflowId` (a run id is random, so it answers with the latest
readable run), `findAllGlobal`, `findAllGlobalSince`, `findGlobalByStatus`,
`findAllSummariesFromIndex`, `findSummariesByStatus`, `runIndexSnapshot`.
Outputs: `findAll`, `findByDefinition` (only that definition's records),
`findAllGlobal` (so `model output get <id>` by id prints not-found plus the
warning), `findAllGlobalSince` (only records whose file-name start is in the
window, or that name none). Definitions: `findAllIncludingAutoGlobal`, a
`findByIdGlobal` miss, and serve's definition index whenever a request lists an
auto-definitions directory again (`DefinitionIdIndex`, swamp-club#3968).
Evaluated definitions: `findAll`, `findAllGlobal`.
Serve's loops over `findAllForType` that read each record with
`getContent` leave a record whose content is unreadable out with a warning
naming it, as `readStoredGrants` does, so one torn bookkeeping record never
stops the rest: `loadAttrsForType` (the boot sweep of leases, pending
dispatches and workers), `WorkerGateway`'s token scan (every enrollment), and
the `access.grant.list` and `access.group.list` handlers. A read of one named
record stays loud.

**Deliberately not loud:**

- `WorkflowExecutionService` builds its own evaluated-definition, output and
  auto-definition repositories without the lookup. The evaluated definition
  there is a cache: when it is absent the run evaluates afresh and saves it,
  which writes the record again and heals it; a loud read would turn that
  into a failed run. `--last-evaluated` in `model method run` reads through
  `repoContext.evaluatedDefinitionRepo`, which is loud.
- GC, prune and delete (`libswamp/data/gc.ts`, `prune.ts`, `run_gc.ts`,
  `workflows/delete.ts`, `models/delete.ts`), and `listRunIds`,
  `listRunIdsForWorkflow` and `listWorkflowIds`, which only they use: they
  are how an unreadable record is removed, so failing on it would block the
  removal.
- `DataQueryService.querySync` and `getContentSync`: the sync API cannot
  await the lookup. The only production `querySync` caller, `model_resolver`
  `listVersions`, reads versions and records, never content; every
  production `getContentSync` read of datastore content runs after the async
  `ensureContentLocal` or `ensureRowContent`, which is loud. A loud
  `querySync` over attributes would need a synchronous lookup.
- libswamp's fallback data repositories (`data/get.ts`, `list.ts`,
  `versions.ts`, `rename.ts` with none injected): every CLI and serve caller
  injects `repoContext.unifiedDataRepo`, which carries the lookup. The
  repo-local `YamlDefinitionRepository` of `versions.ts` and `rename.ts` is
  pinned in `datastore_sync_rules_test.ts`
  (`PINNED_REPO_LOCAL_AUTO_DEFINITION_READERS`); the CLI and serve callers of
  both inject `repoContext.definitionRepo` instead, pinned in
  `model_output_deps_wiring_rules_test.ts`. `reports/search.ts` reads
  only data metadata and `models/`, never datastore content.
- Run snapshots (`YamlEvaluatedWorkflowRepository.findByRunId`, read by
  approve, reject, cancel, resume, approvals and the nested cascades): every
  reader settles against the workflow definition when the snapshot cannot
  be read, so a loud read would change only the log line.
- `YamlOutputRepository.findByIds`: the orphaned-run reaper and `model
  cancel` read it as evidence, where a missing record means none; failing
  them would stop the reaping and cancelling that clear the runs.
- Primary definitions (`models/`) are repo-local, never datastore records,
  so `YamlDefinitionRepository.findAll` and `findAllGlobal` need no warning.
- An auto-definition stored under its name, looked up by id (`findById(type,
  id)`), reads as not found: the id is not in its file name, and callers such
  as `getModelName` probe every type by id, so failing on any unreadable
  auto-definition of a type would break lookups of other types' definitions.
  `findByIdGlobal` warns instead.

**Reading the index.** `liveRecords` and `chunksInUse` reject with
`ReadModelIncompleteError` until a `catchUp` has reached the end of the
change feed since the state was built or last reset. Until then the index can
hold only part of the live records: after a reset, `catchUpPartition` fills
one partition, and a replay cut short by an error or an abort fills the
first commits. Chunk GC must never take such a partial set for the chunks to
keep. Once complete, the index stays complete up to the cursor. The
completeness check and the index read share one SQLite snapshot, so a reset
another process commits in between cannot hand back a partial index.

**Rebuilds.** The state records the catalog's generation, and the read model
marks the catalog populated (`CatalogStore.markPopulated`) when it takes it
over. It resets its state and replays every commit when the generation
differs (a schema change rebuilds the file empty, and `invalidate()` advances
it) or the catalog is not marked populated. The second check catches a
`_catalog_v3.db` that was deleted and created afresh: a new file always
starts at generation 1, the same as the one the state may have recorded.

A reset keeps **removal candidates** (swamp-club#3617): every key the state
shows present is copied into `load_touched_keys`, and so are the unsynced
keys when their list was written in another boot or the current one cannot
be named (within one boot the list names this boot's removals, which stay
done). A compacted-base load that follows removes the candidates the base does
not show, so a removal a crash undid is redone even when the commit that made
it was compacted away. A catch-up that reaches the end of the feed forgets
them (`markComplete`); with no compacted history the replay applies the
tombstone itself. The section that began with the reset is a replay for the guard.

**Known limit.** A retry whose preparation fails restores the run from a snapshot
that still holds the cleared decision. That record is refused, since serve no
longer holds the decision, and the run stays `running` until it is recovered or
cancelled.

**Run control in a serve-mode checkout (swamp-club#4245).** `workflow approve`,
`reject` and `signal` go to serve's handlers, as `--server` does
(`SERVE_UPSTREAM_COMMANDS`), so they need serve to answer: an unreachable serve
is an error, never a local write. `workflow cancel --run` stays local for a run
in this checkout's run tracker and goes to serve for any other, since a member's
pid means nothing on another machine. pid means nothing on another machine. An offline decision cannot be serve's, so
these commands do not work offline. Serve does not resume a run it does not drive:
approving or signalling one leaves it for its owner, and the approve reply says so
(`ownerResumes`). A signal's outcome lives in serve's control plane: a checkout's
wait store takes it from `GET signal-outcomes/{waitId}` (read on the workflow), and
keeps a copy, so its run can resume. A follower forwards that read to its leader,
since one behind it would answer that there is none. No answer is never final: the
next read asks again, and an outcome serve holds beats one kept locally. A local
timeout needs no outcome on serve, and is judged on the member's clock.

**Evaluations serve runs.** Serve runs `--last-evaluated` only with an
evaluation it wrote itself (`EvaluationTrust`,
`src/infrastructure/datastore_v3/trusted_evaluations.ts`): the read model
records each live record's writer (schema 8), the principal of the forwarded
commit that put it or none, and an evaluation a forwarded commit wrote, or
whose writer is unknown (rows from before schema 8, a compacted base), is
refused with a request to evaluate on serve. The bytes parsed are the ones
whose writer was checked. A serve-mode checkout applies the same rule to its own
`--last-evaluated` (`lastEvaluatedStands`): it uses only an evaluation serve or
its own member wrote, and otherwise evaluates again; it refuses if any key the
repository could read holds another writer's record. The run replays the bytes
that were checked, never a later read. A run log is read and appended to only under the
repo's own run-log directories, whatever path a record holds.

**Proof of possession.** A commit may name a chunk only when one of these
holds:

- its bytes arrived and hashed in the same request;
- the caller uploaded it with `PUT chunks/{sha256}` within the GC grace
  window, as recorded in the upload ledger;
- a partition the caller may read already references it.

Otherwise the commit is refused (`chunk_not_provided`). Without this rule, a
caller who knew only a hash could commit a reference to it and then read the
bytes. `chunks/has` and `GET chunks/{sha256}` apply the same rule: an
unreadable chunk reads as missing.

`chunk_partitions` (`commits.db` schema 8, backfilled from `commits` and
`base_records`) records which partitions reference each chunk, for
`partitionsReferencing`. A chunk in a behavior's partition needs both `read`
on its data and on the behavior, since the partition holds both.

A whole partition (catch-up, and the partitions that vouch for a chunk) is
read as conservatively as its identity allows (`partitionReadAccessOf`). A
behavior definition's config partition names neither the behavior's type
nor its tags, since same-named definitions of several types share it, so it
is decided on a resource that carries neither: a deny conditioned on either
fails closed. An auto-definition's partition names neither its type nor its
name, so reading it needs admin.

A partition's identity alone cannot be as strict as the changes feed, which
decides each op: a control-plane definition can share its name, and so its
config partition, with an ordinary one (swamp-club#3938). So catch-up also
filters each commit of the page as the changes feed does (`head` still says
where the partition ends), and a behavior definition's config partition
vouches for a chunk only through a record in it that names the chunk now and
that the caller may read, decided by the type its key names
(`definitionRecordReadAccessOf`): `admin` for a control-plane or restricted
type. A chunk only an overwritten or deleted definition named is therefore
not vouched for by that partition: a non-admin gets 404 for it, and a client
uploads it again to name it. A read model still being built vouches for
nothing.

**The compacted base** (swamp-club#4006). A checkout whose feed cursor is
below the compaction point loads the base instead of the commits, and serve
sends it per caller, never as a copy of its tables. `GET base` pages
`readCompactedBase` and keeps an entry only when the caller may read it:

- a record, and a file's ownership (by its owner partition), by its
  partition and key (`baseRecordReadAccessOf`), since a compacted record no
  longer carries the intent that wrote it. A behavior's data key needs read
  on its data, an output or evaluated definition read on the behavior, a
  config record what `definitionAccessOf` decides for the type its key
  names (a rename's key too), a run read on its workflow, an
  auto-definition what its op needs, the lockfile nothing. A behavior key no
  intent writes needs admin and both reads. The list always holds what
  `readAccessOf` needs of the op that wrote the key, so the base is never
  read more loosely than the feed
  (`commit_authorization_property_test.ts` checks this for every intent kind
  and key);
- a data name's versions, catalog rows and forward by read on the
  behavior's data (`baseDataReadAccessOf`);
- a partition in its own section when the caller may read it whole
  (`partitionReadAccessOf`), and otherwise just before the first entry of it
  the caller may read, once per request. Partitions are paged before
  records, so this is how a record of a partition the caller may read only
  part of (a behavior whose data it may read but not its outputs, a config
  partition same-named definitions share) arrives with its compacted seq.
  The entry carries each data name's version marks (its high-water mark and
  removed versions) from serve's partition as it stands now, when the caller
  may read its data: a mark only grows, so the copy never hands out a
  version serve already used, and its version history can show the gaps any
  follower shows.

The feed decides a whole commit and hides it when any of its ops is
unreadable. The base decides each record on its own, so a readable record a
hidden commit wrote reaches the caller and the rest of that commit does not.
That is the one difference, and it shows only what the caller may read.

Each request scans at most `MAX_BASE_SCAN` (10,000) entries, kept or
filtered, and `next` moves past filtered ones. A page holds entries of one
compaction point; when the point moves mid-request the page ends there, and
the next reports the new point. A token serve never handed out is `400
invalid_request`, and a partition read below its compacted seq answers `410`
with the partition's compacted `seq` beside the point, so a reader that holds
the base reads on after it.

**Uploading a chunk needs write access to its partition.** An upload spends
serve's storage and the caller's quota, so `PUT chunks/{sha256}` names the
partition it is for and needs that partition's least write access
(`partitionWriteAccessOf`): `run` on a behavior or a workflow, `write` on a
workflow or vault config, and `admin` for a behavior definition's partition
(it names no type), an auto-definition's, the lockfile and control-plane
behaviors. With no partition it needs `admin`. It is decided before anything
is reserved or read (`403 forbidden` otherwise); what a commit may name the
chunk for is decided on the commit.

The upload ledger (`src/infrastructure/datastore_v3/upload_ledger.ts`) lives
in memory and is bounded. It caps a principal's uploaded bytes no commit
references at 2 GiB, and its uploads no commit references at 20,000: once a
commit references a chunk, it stops counting toward both, and still holds
for a retried commit until its grace window ends. Every upload, a `PUT` or a
chunk a commit carries, is reserved before its bytes are read and recorded
once stored, and a reservation counts toward every cap from the moment it is
granted. Requests in flight together therefore cannot pass a cap, and a
commit refused after its content arrived cannot leave unbounded content
behind; a reservation never recorded is cancelled. The whole ledger holds at
most 200,000 entries and reservations. At that bound a reservation makes
room from the oldest entry a commit already references: a retry of that
commit is answered before proof of possession, and a new commit naming the
chunk carries it again unless a partition the caller may read vouches for
it; with none, from the oldest upload of the
principal holding the most unreferenced uploads, and when that is the caller
(or it ties), the caller is refused with `429 upload_quota_exceeded`. So one
principal's uploads never push out a lighter principal's. A restart forgets
the ledger, so a client uploads again.

**Memory and limits.** `storage/1` puts and gets whole chunks, so serve holds
at most one chunk (16 MiB) per request (a commit's carried chunks are
verified and staged one at a time), with at most 8 chunk requests per
principal in flight. Streaming a chunk to storage without holding it needs a
streaming `storage/1`, which the S3 and GCS stores would implement too. The
other limits are constants, with no flags:

- an envelope of at most 4 MiB, read before anything else;
- `MAX_COMMIT_OPS` ops and 1,024 carried chunks per commit, and a body of
  at most 1 GiB; at most 1,024 named chunks it does not carry, since each is
  checked under the forwarded-commit lock every caller shares. That cap is
  checked against the envelope's `chunks` before any carried chunk is read;
- pages of at most 1,000 commits;
- at most 10,000 feed rows scanned per changes request. The returned cursor
  moves past filtered rows, so a caller who may read nothing still advances.

**Replies.**

| Situation | Reply |
|---|---|
| The partition's head moved | `409 {code: stale_seq, seq}`: catch up and retry |
| A record the content was checked against changed | `409 {code: content_changed}`: check again and retry |
| A put's content is refused | `403 {code: forbidden, reason: content-refused, opIndex, message}` |
| An op's `expect` failed | `409 {code: precondition_failed, key, seq, changedBy, changedAt}`, worded like a rejected `git push` |
| A txnId landed as another commit | `409 txn_id_reused` |
| A named chunk is not stored | `409 {code: chunk_missing, missing}` |
| Fenced, or the lease lost | `409 datastore_v3_writer_fenced` |
| Storage unreachable, partly committed, or replication unconfirmed | `503` with the code `replicationErrorForClient` keeps |
| A cursor or seq below the compaction point | `410 {code: commits_compacted, point}`, with the partition's compacted `seq` for a partition read |
| A binding or authorisation refusal | `403 {code, reason, opIndex}` |
| A malformed envelope, op or chunk | `400`; an oversized one `413` |

A commit with no put or tombstone (serve's own lease commits) is shown in
the changes feed only to a caller who may read its partition.

`changedBy` is the principal of the newest of the last 200 commits that
touched the key (its writer's host when it has none). Any other failure is a
`500` with no detail. Each route is reported in spans under its template
(`src/serve/datastore_routes.ts`).

**Testing.**

- `integration/serve_datastore_api_test.ts` drives a port-0 server over a
  real v3 repository with an in-process client, covering commit, has, Range,
  catch-up, changes, stamping, every 409 shape, a hash mismatch, a hash-only
  reference, a plain-data grant, the policy reload and a non-v3 server.
- The mapped error codes are unit-tested in `src/serve/datastore_api_test.ts`.
- The lock routes are driven in `integration/serve_datastore_locks_test.ts`
  (authorisation, keys, TTLs, holder privacy, serve's own lock behind a
  lease); the leases' expiry, renewal, caps and shutdown are unit-tested in
  `src/serve/datastore_locks_test.ts`.
- The authoriser has unit tests for every intent kind and for each binding,
  plus a property test that no key of another aggregate binds.

When the CLI drives this API (the serve-upstream issue), its UAT should
cover three adversarial cases: a forged principal, a hash-only chunk
reference and a revoked grant.

The CLI's side, which drives this API, is "Team mode: the CLI's serve
upstream" below. Its UAT, including these three cases, belongs to the
team-mode UAT item (`p5-uat`).

### Team mode: the CLI's serve upstream (datastore rework Phase 5)

swamp-club#3985 makes a checkout write a v3 datastore through serve's
datastore API instead of its storage. A laptop or a CI job then holds a serve
token and no storage credentials. Everything above the datastore service is
unchanged: commands, output, the projection with real file paths, the catalog,
the outbox and the read model's catch-up.

**When it applies.** `resolveDatastoreForRepo` (`src/cli/repo_context.ts`)
picks serve mode when all three hold:

- the checkout's `.swamp.yaml` datastore says `format: 3`, which setup writes
  for every v3 datastore and clones carry, so a v2 datastore with a serve
  address for `--server` runs never changes. A `SWAMP_DATASTORE` override
  names a datastore to open directly, so it never takes serve mode
  (`markerSaysV3`);
- a serve address resolves as `--server` runs resolve it (`SWAMP_SERVE_URL`,
  `SWAMP_SERVER_URL`, then `serverAddress` in `.swamp.yaml`);
- the command takes serve mode. `SERVE_UPSTREAM_COMMANDS`
  (`src/cli/serve_upstream.ts`) answers for every top-level command, and a
  rules test fails when a command has no row. `serve`, `worker`, `init`,
  `repo`, `doctor datastores` and the `datastore` family (except `type`) bind
  storage on purpose and keep today's path.

With no serve address, the path is exactly today's.

**Routing.** An address from the environment or `.swamp.yaml` used to send
every command with a `--server` flag to serve over its WebSocket API. In a
serve-mode checkout, the data-plane families (`SERVE_UPSTREAM_LOCAL_FAMILIES`:
`model`, `behavior`, `data`, `workflow`, `vault`, `report`, `summarise`) now
run locally, with serve as the datastore's upstream (`setImplicitServeRouting`
in `src/cli/remote_run.ts`, set at startup). Only an explicit `--server` still
runs them on serve. The control plane (`access`, `audit`, `doctor`,
`datastore`, …) administers serve itself and keeps that routing. A v2 checkout
is unchanged.

**Tokens.** The token comes only from sources bound to the address:
`servers.json`'s entry for it, `SWAMP_SERVER_TOKEN` when `SWAMP_SERVER_URL`
names it, and `SWAMP_SERVER_TOKEN_FILE` only when an environment address names
it. A `serverAddress` in a cloned repository's `.swamp.yaml` never receives a
token that was meant for another server; when `SWAMP_SERVER_TOKEN_FILE` is set
but withheld and no other source has a token, the CLI warns once and serve's 401
says why, naming `SWAMP_SERVE_URL` as the way to send it. A missing token sends
no header, so serve's 401 gives the `swamp auth server-login` hint, and
`--auth-mode none` works without one.

**The binding.** Serve mode is decided from `.swamp.yaml` before the config
resolves, so an extension datastore's type is never resolved or installed and
its provider is never built (`serveUpstreamRoot` in `resolveDatastoreConfig`).
Its credentials are never read. `bindV3ServeUpstream`
(`src/infrastructure/datastore_v3/serve_upstream_binding.ts`) binds the
checkout's local root. The format guard
records the config as v3 (`recordServeUpstreamFormat`); serve's `409
datastore_not_v3` stands in for the marker check. The checkout gets a local
root, `.swamp/_datastore_v3_copies/serve-<hash of address and namespace>`,
which the v3 helpers open as they open a filesystem datastore. Its locks are
file locks under the root, whatever the datastore's type
(`setV3BucketLockRoot`). It holds:

- `commits.db`, a **follower copy** of serve's commit log;
- `serve_upstream.db`, serve-mode state: the changes-feed cursor and the head
  serve last reported per partition. It is a file of its own, so the commit
  store's schema is unchanged and a solo checkout never opens it;
- `_blobs/`, the chunk cache.

**One copy per checkout, reset when the token or its access changes.** Serve filters what
each caller may read, so a copy is one caller's view. `serve_upstream.db`
records a fingerprint of the token the copy was built with (its SHA-256, never
the token). Binding with another token resets the copy before anything
catches up from it (`resetCopyForCaller`), under the root's writer lease,
which every writer of the checkout holds for its whole command; a read-only
command takes it too, waiting up to the lock timeout and otherwise failing as
writer-busy:

1. An outbox that still holds entries refuses the switch
   (`datastore_v3_serve_copy_holds_unlanded`): they are the previous caller's
   writes, not yet settled with serve. A writing command with the previous
   token settles them.
2. The serve-mode state forgets its cursor, the feed anchor and serve's heads
   and is marked resetting, so a reset cut short runs again on the next bind.
3. `commits.db` and the outbox are removed, and the new fingerprint recorded.

The chunk cache stays: it is content-addressed, and only chunks the new copy's
commits name, which serve let this caller reference, are read from it.

A reset also gives the copy a new id (below), so the checkout's projection is
rebuilt from the new copy.

**Reset when the caller's read access changes** (swamp-club#4089). A member's
grants change more often than their token, and a copy built under old grants
goes stale both ways: a widened grant never brings back the compacted records
it now allows (they are in no commit to read again, and the base was loaded
under the old grants), and a narrowed grant leaves records the member may no
longer read in the copy and the checkout's files. So serve names the caller's
read access on every datastore API reply to an authenticated caller, refusals
included, in the `x-swamp-datastore-access` header:

- It is a SHA-256 over what decides the caller's reads
  (`GrantBasedAccessDecisionService.readAccessFingerprint`,
  `src/domain/access/read_access_fingerprint.ts`): the principal, the
  collectives and IdP groups it authenticated with, its groups in the policy
  snapshot, and every grant for those subjects that names `read` or `admin`
  (the only actions the read filter decides, and no other action implies
  either), reduced to the fields a decision reads (id, state, subject,
  effect, actions, selector, methods, condition) and sorted, and serve's
  restricted behavior types (`--restricted-model-types`), whose definitions
  only an admin may read: a restart with another list changes what a member
  may read without changing a grant. Control-plane types are code constants,
  so they change only with a release, which bumps the fingerprint's format.
  Other subjects' grants, timestamps, authorship and the snapshot's version
  are left out, so a reload that does not touch the caller keeps it. It is cached per caller
  for each snapshot. Serve takes it before it answers the request, so a
  reload while it answers shows as a change on the next reply (which resets
  the copy), never as the access of a copy filtered under the old grants.
  When it cannot be taken, the reply names none rather than failing.
- With `--auth-mode none` it is the constant `unrestricted`; a caller with no
  principal or policy gets `none`.

The client reads it on every reply after the log id check
(`ServeDatastoreClient.checkAccess`, `serveAccessCheck`), and
`serve_upstream.db` records two values: the access the copy was built under
(the first one a copy sees after it is made or reset) and the access serve
sent. Once serve sends one other than the built one, that mismatch sticks
until the copy is reset: the copy took that reply, so a later reply under the
built access (replicas that disagree, in turn) does not make it current again.
A value not shaped like a fingerprint is ignored. A different one does
not interrupt the command that sees it, since serve already filters its
replies: the command warns once that the next command rebuilds the copy (or,
within the cooldown below, that a later one does); a later command whose
binding already found the mismatch says why it waits instead.
The next command's binding then resets the copy as a token switch does
(`resetCopyForCaller`, `accessResetDue`), with these differences:

- **Unlanded writes wait.** An outbox that still holds entries defers the
  reset with a warning instead of refusing, since the member cannot return to
  the old grants to settle them. A writing command lands them as it would
  anyway, and the next command resets. An entry serve refuses with a 403 (a
  narrowing that took the caller's `write`) is dropped by recovery like any
  refused entry, so a refusal cannot hold the reset off for good; if an
  earlier attempt landed it, the next catch-up brings it back.
- **A busy checkout waits.** The reset takes the copy's writer lease without
  waiting: when another command of the checkout is writing, this command
  warns and reads the copy as it is, rather than waiting the lock timeout and
  failing as writer-busy. The first command after that writer finishes
  resets. A token switch still waits for the lease, since a copy built for
  another caller is never read.
- **A cooldown.** Serve replicas behind a load balancer hold their own policy
  snapshot and reload it separately, so while two disagree a member's replies
  name two fingerprints in turn. A change seen within
  `ACCESS_RESET_COOLDOWN_MS` (10 minutes) of the last reset for access only
  warns that the replicas may disagree; the first command after it resets if
  the access still differs. A reset recorded in the future (the clock moved
  back) holds nothing off. The cooldown applies to a narrowing too: one made
  within 10 minutes of an earlier reset for access (a grant widened, then
  narrowed again) leaves the records it revokes in the copy and the
  checkout's files until the cooldown ends. Serve filters every reply under
  the narrowed access meanwhile.

A serve too old to send the header leaves both values unrecorded, and the
copy behaves as before: only a token switch resets it. A copy that read the
feed before any access was recorded (made by an older swamp, or through such a
serve) records its build access as unknown when a fingerprint first arrives,
so it is rebuilt once rather than adopting access it was not built under. This is freshness,
not safety, so unlike the log id its absence is never refused. A grant change
therefore takes effect in the copy from the second command after it: the
first sees it, the second resets.

**A reset never loses another command's pages.** A read-only command catches
the copy up without the writer lease, so another command can reset the copy
while it pages the feed: its commits then went into the replaced
`commits.db`. Each `ServeUpstreamState` handle remembers the copy id it opened
under, and every write of the catch-up (the feed cursor and anchor, serve's
heads, a loaded base, the log id, the access seen) checks it in the same
transaction. The handle opens before the copy's `commits.db`, so the files a
command reads are never a newer copy's than the id it holds, and a handle
opened while another command is partway through a reset holds no id at all:
the files it opened may be the ones that reset removes. A copy reset since refuses them
(`datastore_v3_serve_copy_replaced`): the command fails and says to run it
again, and the new copy reads from the start.

A reset removes what a narrowed grant no longer allows from this checkout's
copy and files. Serve cannot reach copies made elsewhere before the
narrowing, such as another checkout of the same member that has not run a
command since, or files copied off the machine.

Resource attributes decide reads too: a behavior renamed under a name-pattern
grant, or a tag changed under a tag-conditioned grant. Those are content, not
access, so no access fingerprint can see them, and a copy keeps what it
already holds of such a behavior. Moving the copy aside loads it afresh.

**The projection follows the view.** The projection, the v3 catalog and the
read model's state are one per checkout, while the log they are built from
changes with the token, the serve address or namespace (another root), or a
switch between serve mode and the solo datastore. Built from one log and
caught up from another, a projection shows records the new view does not
hold, and its cursor is the other log's, so the new log's commits may never
apply. So the checkout records the view its projection was built from in
`checkout_view.json` in its read-model state directory: a serve root, the
copy's id and the token fingerprint, or the solo datastore's path and
namespace. The copy's id is random, made with the copy's `serve_upstream.db`
(swamp-club#4049), so a copy moved aside and started afresh at the same root
is another view; every reset takes a new one (swamp-club#4089), so a reset for
a change of access, which keeps the token, is another view too. A view
recorded before copies had ids is rebuilt once.
`v3RepositoryFactoryConfig` opens the handle (after the copy is current) and,
before any recovery or catch-up, rebuilds the projection when the recorded
view differs or a rebuild did not finish (`alignCheckoutView`):

1. When the recorded view was a serve copy at another root, that copy's outbox
   must be empty, or the switch is refused with the same code: a writing
   command with the previous address, namespace and token settles it. A solo
   datastore's outbox is landed by any writer of that datastore, so it does
   not hold the switch.
2. The record is marked rebuilding.
3. `recoverInterruptedWriter(0)` on the new view's handle clears the catalog,
   resets the read model's state, replays the new log and removes every
   projected file no commit owns; the run indexes are removed.
4. The new view is recorded.

It runs under the writer lease of the new view's datastore: a writer already
holds it, and a read-only command takes it, waiting up to the lock timeout,
since it must never read another view's projection. On a solo datastore that
lease is datastore-wide, so the rebuild waits for any checkout's writer. The
rebuild only reads the commit log; it writes nothing but this checkout's
files, catalog and read-model state. A checkout with no view recorded keeps
its projection when it opens solo (every checkout from before this change)
and is rebuilt once when it opens through serve.

Known limits: the lease keeps writers out, not readers. A process of this
checkout already reading under the old view keeps its own handle on the old
`commits.db` (POSIX keeps a removed file for open handles), and its catch-up
can put the old view's files back into the projection. Two processes of one
checkout under different tokens or views at once are not supported. The read
model's `at-risk/` copies (swamp-club#3617) survive a rebuild, so they may
hold bytes of the previous view; no command reads them as records.

The registry (`serve_upstream_registry.ts`) tells the helpers the root's
upstream is serve. `v3ReplicaFor` answers none for it, so there is no restore,
lineage or Litestream sidecar. The local root's own lease serialises this
machine's processes; it is never the bucket's writer lease. The end-of-command
retention pass is skipped, because serve keeps the datastore.

**Follower mode.** Serve filters single commits a caller may not read, so the
seqs a caller sees of a partition can have permanent holes. A store opened
with `follower: true` (`SqliteCommitStore`, `SqliteReadModel`, which only the
serve binding opens: a rules test pins it) appends through
`Partition.appendObserved`:

- it accepts any later seq;
- it leaves `expect`, `version-live` and `version-reused` to serve, which
  judged them against the commits the follower cannot see;
- it skips the local writer-fence check, because serve's commits carry serve's
  fences.

Duplicates, the partition rule and the fence ordering still hold. One file is
always opened in the same mode.

**Writing.** `createServeCommitSink` (`serve_commit_sink.ts`) is the outbox
sink over a commit store whose append forwards to serve, so the outbox still
makes each commit durable until it lands.

1. A commit is built on the higher of the copy's head and serve's recorded
   head.
2. `chunks/has` names what serve lacks. Up to 1,024 of those ride in the
   frame from the cache; any more go first as `PUT chunks/{sha256}?partition=`.
   No checkout upload ever omits the partition, so none needs `admin`.
3. The envelope carries `expectedSeq`, `txnId` and `ops` only.
4. On `{seq}`, or a duplicate's, the copy reads the partition from serve and
   stores serve's stamped commit, never the one built locally.
5. On `409 stale_seq`, serve's head is recorded and the partition read, and
   the unit builds the commit again on the new head under the same txnId (up
   to `SERVE_SEQ_GAP_ATTEMPTS`).
6. On `chunk_missing`, the named chunks are sent once more.

`holdV3Writer` catches the copy up from serve before a command writes.

**Model locks.** A checkout picks a behavior's next data version from its
own copy. Two machines' local file locks therefore let both pick the same
version: the second commit meets `409 stale_seq`, is rebuilt on the new head
with the same version numbers, and serve refuses it as `version-live`, after
the method's side effects have run. So in serve mode `createModelLock`,
`createWorkflowRunLock` and `acquireModelLocks`' per-model locks are serve's
own locks, held through its lock routes (`ServeLock`,
`src/infrastructure/datastore_v3/serve_lock.ts`; serve's side is
`DatastoreLockLeases`, `src/serve/datastore_locks.ts`). The global datastore
lock stays a local file lock.

These routes are the base model leases (`p5-leases`, swamp-club#4121) extend,
not a second mechanism beside them: a lease carries a fencing token that serve
checks on each commit the holder forwards, and a lapse cancels the holder's
run, on the same `locks` routes and the same lease records. "Fenced leases"
below describes them.

- **The lock.** A lease is the lock serve's own handlers take for the key
  (`createModelLock` or `createWorkflowRunLock` on serve's datastore), taken
  without waiting (`FileLock.tryAcquire`) and held for the caller until it is
  released, its TTL passes without a renewal, or serve shuts down
  (`dispose`, after the run drain). A checkout's work and serve's own runs on
  one behavior therefore exclude each other. One lease per key at most.
- **The key.** `lockKey` is `data/{type}/{id}/.lock` or
  `workflow-run-claims/{runId}/.lock`, without a namespace (the route names
  it). It is parsed and made canonical before anything is decided: the type
  normalized, ids lowercase UUIDs, and a type holding a control character or
  a path character (`\`, `:`, `%`, …) refused. Anything else is `400`.
- **Authorisation.** What a write to the aggregate's partition needs at least
  (`partitionWriteAccessOf`), through serve's decision service with its audit
  on refusal: `run` on `model:<name>` (`admin` for a control-plane or
  `--restricted-model-types` type), and for a run's claim `run` on its
  workflow. A behavior or run serve does not know is decided on its id, so
  only a wildcard grant holds it. A renewal is authorised again, and a
  refused one ends the lease. Only the principal holding a lease renews or
  releases it; to anyone else it is `404`.
- **Bounds.** `ttlMs` between 5 s and 120 s (30 s by default); one request
  waits at serve at most 10 s (`waitMs`), so a waiting client asks again
  rather than polls; at most 256 leases per principal (`429
  too_many_leases`). The routes are rate-limited like the others.
- **What a refusal tells.** `409 lock_held` says only `heldBy`: `caller`
  (another command of the same principal), `other` (another principal) or
  `serve` (serve's own work), never who. `swamp datastore lock status` on
  serve shows serve's process as the holder of every lease, as for its own
  runs.
- **The client.** `ServeLock` asks with `waitMs` up to the time left (at most
  half the request timeout) until the lock timeout, then throws
  `LockTimeoutError`. It renews at a third of the TTL; a renewal serve
  answers `404` stops the heartbeat and logs that the lease expired. Release
  is idempotent, and a release serve cannot be told of is left to the TTL.
  `inspect` reports only this process's own hold, and `forceRelease` is
  always false: serve's locks are never broken from a checkout. Serve
  unreachable while acquiring is `ServeUnreachableError` (exit 75), before
  the command's action runs.
- **Catch-up under the lock.** Once the lease is taken, every handle the
  process opened on the copy catches up from serve, read model included
  (`catchUpV3HandlesAt`), before `acquire` resolves; `holdV3Writer`'s
  catch-up ran before the lock was taken. The work under the lock therefore
  allocates versions after every version another machine wrote.
- **Held until the commit lands.** `model method run` releases its locks in
  `runCommandInRootUnit` after the root unit has ended, and the root's commit
  appends through the serve sink, which forwards it and waits for serve's
  `{seq}`. The lock is therefore held until the commit is at serve. A commit
  left in the outbox (the connection lost after the request may have reached
  serve) is re-sent by a later recovery outside any lock.

**Fenced leases** (swamp-club#4121). A checkout asks for a lease with
`fenced: true`; an older serve ignores the field and grants an unfenced lease,
which behaves as above.

- **The fence.** Read under the lock: one above the partition's lease fence
  (`Partition.leaseFence`, which only lease ops raise) and every fence this
  leader issued for the key, so a lease never reuses a fence, across a
  takeover too. A behavior's lease covers its partition
  (`model--{type}--{id}`), a run's claim the run's (`lockTargetOfPartition`).
- **The floor.** A behavior's lease also returns each data name's high-water
  mark and removed versions (`SqliteCommitStore.leaseMarks`), even to a
  caller with `run` but no `read` on the data: names and numbers, never
  content. The holder registers the lease (`serve_lease_registry.ts`) and its
  unit allocates above the floor (the serve sink's `dataHighWater`), so a
  version written by a commit its copy never saw is not picked again. Each
  commit that lands under the lease raises its floor, in the process and in
  an explicit lease's record, by the versions it recorded: a caller without
  `read` never sees its own commits in its copy either. The floor is not
  paged: the client reads a granted lease under the page cap
  (`SERVE_LEASE_REPLY_MAX_BYTES`, the cap the compacted base sends the same
  names under), not the small reply cap, and `leaseMarks` reads the names
  (`Partition.dataNameMarks`) without building a partition snapshot
  (swamp-club#4166).
- **The commit.** The envelope names the lease by id (`lease`), never its
  fence; a client's commit carrying a lease op is still refused. Under the
  forwarded lock serve judges it: a named lease must be live, fenced, the
  caller's and cover exactly this partition, and a partition a live fenced
  lease covers takes only commits that name it. A run's claim is the
  exception: it is held only for a load, decision and save while the run's
  owner checkpoints its record throughout, so a claim refuses no unleased
  commit. Serve then stamps a lease op
  (`holder` the lease id, `fence` its fence) after the client's ops; a retry
  is compared without it. Anything else is `409 commit_lease-lost`, which
  never says whose lease holds the partition. Partitions no fenced lease
  covers keep the rules above. A command's lease is the leader's memory, so
  a takeover ends it; an explicit lease is kept across one ("Leases kept
  across a takeover" below). The partition's lease fence is the durable
  backstop.
- **Older readers.** A swamp before #4121 judges a lease op's fence against
  the writer fence and would refuse the commit. Every request names what the
  client's copy understands (`x-swamp-datastore-features: lease-ops`), and
  serve leaves lease ops out of the commits it sends a client that does not
  name it, so that client reads exactly what its own rules accept. The
  `commits.subscribe` feed applies the same rule to the features its
  subscribe payload names (swamp-club#4168); a follower names `lease-ops`.
  Serve's lease op does not count toward `MAX_COMMIT_OPS`: a writer fills a
  commit before it knows whether serve will add one.
- **A lapse.** The holder measures the lease from its last renewal on its
  own monotonic clock. A renewal serve answers `404` or `403`, or none
  before that deadline, lapses the lease: `ServeLock`'s `onLost` fires once,
  the lease leaves the registry, and `acquireModelLocks`' `leaseLost` aborts.
  `model method run` aborts its run with the lapse as the cancel cause; a CLI
  `workflow run` or `resume` aborts the run's signal, which a step on a
  worker follows. A commit sent naming the lease after it ended is refused;
  writes staged before the lapse and flushed after it name no lease, and
  land only if no other lease covers the partition, under the seq and
  version checks. A
  workflow step under a lease at serve checkpoints its writes before it
  releases the lock, so they reach serve naming the lease.
- **Lock status.** `GET locks?prefix=` lists the leases serve holds on locks
  the caller could take, each decided without a refusal audit: `lockKey`,
  `heldBy` (`caller` or `other`, never who) and `expiresAt`, at most 512 with
  `truncated` past it. A follower refuses it: leases are the leader's.
  `swamp datastore lock status` in a serve-mode checkout reports them as
  `serve_lease` events.
- **Explicit leases.** `swamp model lease acquire <behavior> --for
  <duration>` (and `release`, `status`; `swamp behavior lease` too) takes a
  fenced lease for a command's TTL, records it, then renews it with `holdMs`
  (5 s to 24 h, `MAX_HOLD_MS`, swamp-club#4195: long enough to check a lease
  out before working offline), which makes it explicit: serve holds it for
  its hold between renewals. A reply lost on the way strands the lease for
  the short TTL only; acquiring again changes the hold. The checkout records it in its local root
  (`model_leases.json`, `explicit_model_leases.ts`). Every command renews it
  when it binds serve and registers it, so each of its commits to the
  behavior names the lease, a read-kind method's lockless save included. A
  lease whose renewal fails (a serve blip) is registered from the record,
  unconfirmed (swamp-club#4167): serve, never the record, decides whether
  it is live, and a commit serve refuses as `lease-lost` under an
  unconfirmed lease is sent again under no lease, as an outbox recovery
  is. A commit refused under a lease serve renewed or granted is the
  caller's. A
  command that takes the behavior's lock adopts it under a lock local to the
  checkout instead of asking again, leaving it held when it ends. A lease
  no command renews within its hold lapses at serve. It ends on `release` or once its hold passes unrenewed.
- **Leases kept across a takeover** (swamp-club#4195). The leader keeps
  every explicit lease in the shared control plane
  (`control_plane_lease_store.ts`, `persisted_lease.ts`); a command's lease
  is never kept. Each leader writes under its own prefix,
  `leases/<leaderFence>/<sha256 of the lock key>`, named by its writer-lease
  fence. A record holds the lease's id, lock key, principal, fence and
  hold, the hold left when it was written and the writing leader's time:
  never a deadline another node's clock judges alone.
  - Written on acquire (a record that cannot be written refuses the lease,
    `503 lease_not_kept`), rewritten on renew (a failed write keeps the
    lease and is logged), deleted on release, expiry and forced release.
    Shutdown (`dispose`, a lost lead) never writes or deletes one, so a
    leader stopping after a takeover leaves its successor's records alone.
  - A leader adopts (`DatastoreLockLeases.adopt`) at boot, before serve
    listens, and on every later takeover in `onLead`. It reads the highest
    complete prefix at or below its own fence (prefixes compared as
    numbers; complete means its `complete` marker is there), copies every
    record under its own prefix, writes its own marker, then deletes the
    lower prefixes, marker first; an expired record is removed from its
    own prefix as it is adopted. A crash before the marker leaves a prefix
    the next leader skips. A leader deposed before it noticed writes into
    its own prefix, which no later leader reads. A store that fails during
    adoption is tried again with backoff, lease requests waiting meanwhile:
    never served with leases left unadopted.
  - While a kept lease is not adopted, serve's own runs do not take its
    key's lock: they lock apart from the lease API, so each waits at the
    own-lock gate (`own_lock_gate.ts`, `DatastoreLockLeases.whenAdopted`)
    for that key, every key while the kept leases cannot be read, and gets
    a lock timeout if it is still pending when the lock wait ends. A run
    never runs on a behavior someone still holds a kept lease on.
  - An adopted lease takes the node's local lock for its key, keeps its id,
    principal, fence and hold, and ends when its hold left passes, with
    `WRITER_LEASE_CLOCK_SKEW_MS` allowed in the holder's favour. A lease
    whose partition fence is already above its own was superseded and is
    dropped. One whose local lock cannot be taken yet (a run of the
    leader before, not past its TTL) keeps its record: adoption is tried
    again with backoff until the lock frees or the lease expires, never
    costing its holder the lease.
  - Until adoption ends, lease requests and commits answer `503
    serve_not_leader`, so no caller takes an adopted key first. The
    holder's renewal then finds its lease, and `fencedLeaseOn` refuses
    another caller's unleased commit as before the takeover. Gating every
    commit, not only those an unadopted lease covers, is deliberate: a
    control plane that cannot list is the storage chunks live on, so
    commits would fail anyway, and correctness comes before availability.
- **Forced release** (swamp-club#4195). `swamp datastore lock release
  --force --behavior <type/id>` on a serve-mode checkout asks serve to end
  the explicit lease on that behavior, whoever holds it (`DELETE locks`
  with `{lockKey}`, `admin` only). Its record is deleted; no fence is
  raised: serve already answers `commit_lease-lost` to any commit naming an
  ended lease, so the absent holder's queued work is later sent under no
  lease and rebased, never applied over newer data. If the record cannot
  be removed (three tries), the lease has still ended at serve, but a
  takeover could adopt it again: serve answers 503
  `lease_record_not_removed` (audited as a failure), the CLI exits 75, and
  forcing the release again removes the leftover record. `swamp datastore
  status --server` lists the explicit leases the node holds
  (`explicitLeases`: lock key, holder, expiry), for admins; a follower
  holds none.

`integration/serve_upstream_lock_test.ts` runs two checkouts, each in a
Worker as a machine of its own, saving ten versions each of one behavior's
data at once under its lock, and a checkout's saves interleaved with serve's
own: every version lands, numbered 1 to N. With the serve lock replaced by the
local one both fail with `version-live`, as the live test did.

**Catch-up.** `ServeCatchUp` (`serve_catch_up.ts`) pages `GET changes` from
the stored cursor and appends each commit verbatim. The cursor moves only once
a page is in the copy, so a crash between the two re-reads a page, whose
commits are then duplicates. When a commit arrives past the copy's head + 1,
the partition is read from serve first (`partitions/{p}/commits?after=`). That
brings back commits hidden from the caller before a grant changed, and records
serve's head. A page that is filtered to nothing still moves on by the limit
it was read at, because serve's own log has no holes.

**Catching up past compaction** (swamp-club#4006). A feed read that serve
answers `410` (a fresh copy of a compacted datastore, or one left behind the
point) loads serve's base, and the feed then reads on from the point. One
load of a copy runs at a time: in a process by a chain per copy, across
processes under the copy's writer lease (which a writing command already
holds, and a read-only one takes for the load). A load that gets the lease
after another command loaded a base covering serve's point does nothing.

1. Any `base_staging-*.db` a cut-off load left is removed, and the base is
   paged into a staging file of its own beside the copy
   (`ObservedBaseStaging`), each page in one transaction. Every reply is checked as the feed's are: the log id
   first, then each entry's shape and namespace (`observedBaseEntryFromJSON`),
   under the page byte limit, asked again at half the entries when too large.
2. Pages of two compaction points are parts of two bases: the load starts
   again, at most three times, then fails for this command.
3. `installObservedBase` (follower stores only) finishes the staging file and
   installs it in one write transaction, as a restore installs a file: each
   partition's head at its compacted seq with a snapshot there, built from
   its records, versions and serve's marks; the compaction point the higher
   of serve's and the copy's last cursor plus one, so base ownership marks
   sort before every later append and a read model at any older cursor loads
   the base; the file's own rows (log id, writer fence, owner) carried over.
   A staging file gone from its path is refused, never installed as an
   empty store.
4. Only then does `serve_upstream.db` record the load (`recordBaseLoaded`):
   the cursor at exactly serve's point (the install replaced every commit
   the copy held, so the feed reads those past the point again), the anchor
   forgotten (a compacted commit cannot be asked for), the base's point,
   each compacted seq a head serve reported. A feed page applied under
   another base point (another process loaded a base meanwhile) does not
   move the cursor; the feed reads on from the base's.

A load cut off before the install leaves the copy as it was and only the
staging file, which the next load removes. One cut off between the install
and the record leaves the cursor below the point, so the next catch-up meets
the `410` and loads again: a half-loaded copy never reads as current. The
load writes only the copy, under the copy's own lease, never the
datastore's writer lease or a direct writer's hold, so a claimed datastore
(swamp-club#4063) loads as any other.
The log id and the anchor of the next page applied guard the copy as before.
A serve with no base route answers `404`, and the copy keeps the
`commits_compacted` refusal.

A partition read (a write's catch-up, or a gap in the feed) that meets a
partition compacted past the copy's head reads on from the compacted seq
`410` names only when the base the copy loaded covers serve's point: that
base held what was compacted, and a partition it held nothing of was one
this caller could not read. Otherwise (no base loaded, or serve compacted
again since) the copy loads the base first, so commits compacted away are
read only from a base, never skipped.

**One serve's log.** The copy is keyed only by address and namespace. Its
cursor is a position in one serve's log, so swamp-club#4049 checks that
whatever answers at the address still serves that log. Without the check, a
serve re-pointed at another bucket, a fresh deployment, or one restored from
an older backup mixed silently into the copy. Two checks cover the two ways
that happens.

- **The log id: another log.** `commits.db` holds a random id for its log,
  minted when the log is created (schema 9, minted by the migration for an
  existing log). It moves with the log, so a failover, a Litestream restore
  and a restore from backup keep it, while a fresh deployment or another
  bucket has another. Serve sends it on every datastore API reply to an
  authenticated caller, refusals included, in the `x-swamp-datastore-log`
  header. It says nothing of the log's content, so it goes to every caller,
  whatever its grants.
  - The copy records the first id serve names in `serve_upstream.db`.
  - Every later reply is checked before it is read (`serveLogCheck`, on the
    copy's serve client). Another id is refused, before anything is applied
    or sent on.
  - A success that names no id comes from a serve too old to send one. It is
    refused with `serve_upstream_upgrade_required`, never left unchecked.
  - A copy from before log ids records the first id it sees, and the anchor
    checks below guard that first contact.
  - A reset, to another token or for a change of access, clears the recorded
    id with the rest of the copy.
  - Only a log id can tell a moved serve from a revoked grant. Serve answers
    404 both for a partition the caller may no longer read and for one it
    has never heard of, and after a move, every partition of the old log is
    one the new serve has never heard of.
- **The feed anchor and partition head: the same log rolled back.** A
  restore of the log to an earlier point keeps its id, so these checks catch
  it.
  - Each applied page records its last commit's identity (namespace,
    partition, seq, `txnId`) beside the cursor in `serve_upstream.db`.
    Before every feed catch-up, serve is asked for the commit at that
    position (`partitions/{p}/commits?after=seq-1`, limit 1).
  - A partition catch-up, on a write's stale seq or when a recovery looks
    for a commit, reads from the copy's head commit (`after=head-1`) in its
    first request and compares that commit's `txnId`. This catches a log
    restored behind the copy in one partition, where the feed anchor's
    partition is still intact.
- **A follower behind the copy.** Every partition read names the seq the
  copy holds in that partition (`held`). A team follower whose own copy
  holds less, as a node restarted after a takeover does until its leader
  feed catches it up, waits for its feed (`FollowerFeed.caughtUp`, bounded
  by the feed barrier). The wait asks the leader for its head after the read
  arrived, never sharing an ask made before it: that head may predate a
  commit the copy holds. Reads that arrive while one ask is in flight share
  the next. If the follower is still behind and its feed is live or was
  within the last 30 seconds, it refuses with a `503` `serve_follower_behind`
  and `Retry-After: 1` (`ServeFollowerBehindError`, exit 75: nothing
  changed, retry). It never answers with a head that reads as a rewind. A
  follower that holds the head its leader named answers as the leader would,
  so a log genuinely behind the copy is still refused below. A follower with
  no leader feed, or one whose feed has not been live for 30 seconds, cannot
  tell catching up from such a log, so it answers as before, as it does a
  read that names no `held` (from a CLI before it) (swamp-club#4254).
- **Refused.** Another log id, a head below the commit's seq, or another
  `txnId` at that seq fails the command with `serve_upstream_diverged`.
  - It is a user error, not exit 75.
  - The message names the address and the copy's directory, and says to
    start a fresh copy by moving the directory aside, so commits not yet sent
    stay in the moved copy's outbox. The fresh copy has a new copy id, so
    the checkout's projection is rebuilt from it before anything is read.
  - The copy is never re-synced on its own: one that holds commits serve
    lost may be what a restore needs.
  - A commit that met the refusal after a stale seq never landed, so its
    unit fails with the refusal rather than as a commit that may land.
  - A commit serve accepted, whose catch-up then finds the divergence, has
    landed, so the command succeeds and warns, and the next command is
    refused.
- **Not checked by the anchor and head checks.** Within one log, some cases
  cannot be told from a rollback, so they are not refused. Another log is
  still refused by its id.
  - a commit serve now withholds from the caller;
  - a partition the caller may no longer read (404);
  - an anchor serve has compacted (410), where the next page applied records
    another anchor;
  - a head whose `txnId` the copy has compacted, where only the seq is
    compared;
  - a copy whose feed has never carried a commit, which has no anchor and
    nothing to mix.

  A 410 at exactly the copy's head on a partition catch-up reads on from the
  head without the check, so the check adds no 410 to the write path.
- **Not checked at all.** Lock requests (`serve_lock.ts`) use a client of
  their own, so their replies are not checked. A lock taken on another serve
  changes no data, and the command's first catch-up or write is refused.
  Restoring a log from a backup taken before its schema-9 migration mints a
  new id, so that restore is refused as another log.

**Serve's replies are untrusted.** The address can come from a committed
`.swamp.yaml` `serverAddress` that the person running the command never
chose, so swamp-club#4062 treats what serve answers as input to check, not as
the copy's truth.

- **Namespace.** A feed page holding a commit outside the copy's namespace
  (the v3 datastore's, empty for a solo one) is refused whole, before any of
  it is applied and before the cursor moves. A partition read already refused
  a commit of another namespace or partition, with the same error.
- **Size.** Every reply is read under a byte limit, counted as the body
  arrives and never taken from `Content-Length`. Past it the body is
  cancelled and the read fails with `reply_too_large`.

  | Reply                         | Limit                                            |
  | ----------------------------- | ------------------------------------------------ |
  | Chunk                         | `CHUNK_BYTES` (16 MiB), or the range for a 206   |
  | Error body                    | 64 KiB, then the status alone maps               |
  | Other small JSON (has, locks) | 1 MiB                                            |
  | Page of more than one commit  | 64 MiB                                           |
  | Page of one commit            | `MAX_WRITTEN_COMMIT_REPLY_BYTES` (about 350 MiB) |
  | Page of the compacted base    | 64 MiB, asked again at half the entries          |

  No byte limit both bounds memory and fits every real page of 1000
  commits, so a page too large is asked again at half the limit, logged at
  debug, down to one commit: at most ten retries from 1000. The smaller
  limit carries over to the rest of that read. The one-commit limit is the
  largest commit serve writes: its own runs commit through the commit-log
  unit of work, which splits only at `MAX_COMMIT_OPS`, so that commit is
  larger than any a client can post (an envelope of at most 4 MiB). It is
  computed from the most inline content, the longest key and the longest
  intent strings. Blob part lists, data-version tag values and
  control-character keys have no length limit, so a pathological commit can
  still pass it and is refused rather than read. A byte bound in serve's
  unit of work would close that.

**Run index.** The read model's catch-up rewrites run records directly, and
the run index trusted itself while its count matched. So a run another
writer changed kept its old status in `workflow run search`, on serve after a
forwarded commit and in any catching-up checkout. The read model now reports
the record keys each page rewrote or removed (`recordsChanged`), and the
checkout drops those runs' index entries (`dropRunIndexEntries`), which the
next read repairs.

**Chunks.** `CachedServeStorage` is the cache, a `FileSystemStorage`, with
`ServeChunkStorage` (serve's chunk endpoints as `storage/1`) behind it.

- Puts land in the cache with its staging and barrier.
- `get` and `has` fall back to serve, and a chunk read from serve is kept.
  `GET chunks/{sha256}` is hash-checked.
- `list` and `delete` are the cache's, so the local sweep keeps the cache
  bounded.

`ServeChunkStorage` passes `storage_conformance.ts`
(`integration/serve_datastore_storage_conformance_test.ts`) with these
declared unsupported, each with its reason:

- `list` and `delete`: serve has no route for them, and chunk collection is
  serve's;
- other namespaces: one API is bound to its datastore's namespace.

It also differs from a bucket's storage in four ways, which the checkout path
never relies on:

- an uncommitted chunk is visible only to the principal that uploaded it;
- it is visible only while its upload-ledger entry lasts;
- puts count against the caller's upload quota;
- a put with no partition needs `admin`.

**Errors.** Each reply maps to the error the solo path gives the same failure
(`serve_upstream_errors.ts`):

| Serve's reply | The CLI's error | Exit |
|---|---|---|
| Unreachable when the command starts, copy has read the feed | offline mode ("Working offline" below): allowed work is queued and the command succeeds | 0 |
| Unreachable when the command starts, the work needs a lease the checkout does not hold | `datastore_v3_offline_lease_required`, nothing ran | 75 |
| Unreachable when the command starts, a definition edit | `datastore_v3_offline_config_edit`, naming the definition by kind and name, nothing changed | 75 |
| Unreachable when the command starts, a copy that never read serve's feed | `datastore_v3_serve_unreachable` (`ServeNeverReadError`): an empty copy would pass for an empty datastore, so nothing is read or changed | 75 |
| Unreachable mid-command, request never sent | `datastore_v3_serve_unreachable`, outbox entry discarded, nothing changed (the offline rules never judged this command's work) | 75 |
| Unreachable after the request may have reached serve | outbox entry kept; the next recovery settles or re-sends it | 1 (may land) |
| `401` | the `swamp auth server-login --server …` hint | 1 |
| `409 stale_seq` | caught up and retried | — |
| `409 precondition_failed` | `config_edit_conflict` for a managed-config definition or the lockfile (swamp-club#4097); otherwise serve's "changed by … at …" message, as a local expect-failed | 1 |
| `409 datastore_v3_writer_fenced` | the same code | 1 |
| `503` storage unreachable, writer busy, replication | the same code (serve now answers storage-unreachable and writer-busy as 503, not 500) | 75 |
| `403` | serve's message and the op's index | 1 |
| `410 commits_compacted` | serve's compacted base is loaded; a serve with no base route keeps the refusal | 1 (old serve) |

A read that cannot reach serve uses the copy as it is and warns that it may be
out of date; in json mode it says so as a `datastore_offline` notice on
stderr, as a writing command does. A write never falls back to storage. An entry that may have
reached serve keeps its outbox entry even when its unit fails
(swamp-club#4195); it was discarded before.

**Recovery.** `recoverV3Outbox` lands a serve-mode checkout's entries through
the sink's forwarding store (`forwarded`). An entry whose txnId has landed at
serve is settled once the partition is read. One whose base moved, or that
serve answers with a moved head, is dropped as `head-moved`, as a local one
is: building it again on the newer head let a put or tombstone with no
`expect` overwrite another writer's newer record (swamp-club#4121). An entry
records the fenced lease it was built under (the outbox's `lease_id` and
`lease_fence`, schema 5) and is resent naming it. Once that lease has ended,
usually with the process that held it, the entry is sent again under no
lease: its head has not moved, so nothing was written since, and the head
check is then its only guard (a later lease that committed nothing to the
partition does not stop it). Serve refuses
that only while another holder's lease covers the partition; the entry is
then left for a later recovery (marked left, so the floor never drops it),
with its unit's run entries, so a run record never lands without its data
commit. A lease serve reports as superseded (`stale-lease`) drops the entry
as `lease-superseded`. Entries queued offline follow their own rules
("Working offline" below).

**Working offline** (swamp-club#4195). A serve-mode checkout keeps working
while serve is unreachable, within these rules (`offline_write_policy.ts`,
`serve_offline.ts`).

- **Entered at a command's start only.** The writer hold's catch-up is the
  one place offline mode begins, and only on `ServeUnreachableError` with a
  copy that has read the feed (a never-read copy still refuses with exit
  75). The command warns once that it works from the copy, naming the last
  contact with serve. Offline mode is sticky: it lasts the whole command,
  its commits queue even if serve comes back, and the next command sends
  them. A command that started online and then loses serve fails as before
  (exit 75): the rules never judged its work.
- **Reads and read-kind methods** (`read`, `list`) run from the copy. What
  they record (run records, outputs, data versions) is queued: none of it
  conflicts, or it is rebased.
- **A method or workflow step that changes things** runs only on a
  behavior whose explicit lease the checkout recorded
  (`model_leases.json`), taken while online, and only while that lease has
  not ended by serve's clock: its `expiresAt` must be later than serve's
  now (the local clock plus the last measured offset) plus
  `WRITER_LEASE_CLOCK_SKEW_MS`. Without one it is refused before it starts
  with `datastore_v3_offline_lease_required` (exit 75), naming `swamp
  behavior lease acquire <name> --for <duration>`. Methods with no declared
  kind count as changing things. `model method run` and each workflow step
  are judged before they start; `integration/offline_entry_points_rules_test.ts`
  classifies every command that takes the writer hold.
- **Definition edits** are refused with `datastore_v3_offline_config_edit`
  (exit 75): whether an edit is stale is serve's to decide (swamp-club#4097).
- **The lock offline.** A behavior's lock is the checkout's local lock. A
  recorded explicit lease is adopted with it, never renewed or caught up,
  and still registered, so queued commits record it; the run is cancelled
  if the lease's end (corrected for the offset and skew) passes. A
  read-kind run takes the local lock only.
- **The backstop.** The serve sink judges each queued commit by its
  partition (`checkOfflineCommit`): run and auto-definition partitions
  queue; config and the lockfile never do; a behavior's partition needs a
  live lease or a read-kind run the command entry registered.
- **Queued, not sent.** An allowed commit goes to the outbox marked
  `offline` and the command succeeds (exit 0), warning once that the work
  is saved in this checkout and will be sent by the next command that
  reaches serve. Version numbers count queued entries, so two offline
  commands, or two commits to one partition in one unit, never share a
  version or seq (an indexed `outbox_versions` table, not every entry's
  body). Chunk reads use the local cache only. A later command, offline or
  online, reads what an earlier one queued: the data repository writes the
  version's files and catalog row before the commit is queued, and a
  catch-up that does not hold the queued commit leaves them in place. The
  existing config a managed-config checkout has not adopted waits for the
  next writing command that reaches serve.
- **Leases while offline.** A command does not renew the checkout's
  explicit leases with serve unreachable: it says so once, and each holds
  until its recorded end.
- **Serve's clock.** Every reply's `Date` header measures serve's clock
  against the local one (half the round trip plus a second of uncertainty);
  the last contact and offset are saved in the serve-mode state once per
  command. Each serve-mode commit carries `executedAt` and `clockOffsetMs`
  in the outbox. The commit envelope is unchanged, so no client puts a time
  on a commit serve stores, and an older serve takes the commit as before.

**Outbox states** (schema 6, `state` and `reason`). An entry with no state
is pending, as before. `offline`: queued while serve was unreachable. No
drop rule takes it (`stale-fence`, `overtaken`, `abandoned`, `expired`,
`head-moved`, `unit-dropped` and the 7-day retry bound all skip it): it may
be the only record of a change a run made to real infrastructure.
`rejected`: the flush could not land it; kept and reported with its reason.
`quarantined`: serve refused it for a grant the caller lacks; kept for an
admin. An entry the sink is about to queue is prepared already marked
`offline`, so a process that dies before the queue's own mark never leaves
it pending. An entry its unit gave up (`abandoned_at`) is dropped as
abandoned whatever its state: it was never acknowledged, its caller was
told it failed, so it is never flushed later. The schema-6 backfill skips
a body that is not valid JSON, so one damaged entry leaves the migration
standing and is listed unreadable. An unreadable row with a state is kept, never discarded; an
unreadable pending one is dropped, as before. An older swamp refuses a
schema-6 outbox (`datastore_v3_outbox_schema_newer`).

Only pending and `offline` entries hold a copy's reset (a token, address,
namespace or access change, `ServeCopyHoldsUnlandedCommitsError`): they can
still land. `rejected` and `quarantined` entries never land again, so they
do not hold it; the reset empties the outbox in place around them
(`resetKeepingKept`: the fence chain and the sweep start over), never
removing the file while it keeps any.

**The flush** (`offline_flush.ts`). It runs inside the outbox recovery, so
only under the writer hold: read-only commands never flush. Once serve is
reachable, entries go in outbox order, one at a time, each built under its
original txnId, so a flush cut off part-way settles what landed and never
lands an entry twice.

- **Rebased, always.** Every entry that records a data version goes
  through `rebaseOfflineCommits` (`offline_rebase.ts`), even when its base
  did not move: each version it writes anew is renumbered onto the end of
  its name (the lowest just above the high-water mark, unless already
  above it), rewritten everywhere it appears (record keys, intents,
  metadata and `metadata.yaml`, the latest marker), and its metadata
  `createdAt` becomes the corrected time it ran. Nothing committed is
  renumbered. A renumbered version never lands on a number another entry
  of the partition still holds queued, so a queued number never names two
  versions (without another writer meanwhile nothing moves; after one, the
  skipped numbers stay empty). Runs, outputs and auto-definitions pass
  through.
- **Later entries follow earlier ones.** Entries are sent one at a time,
  so each landed entry hands what it renumbered, the metadata digests it
  rewrote and the corrected `createdAt` of its versions (the rebase's
  `OfflineRebaseCarry`) to the partition's later entries: a removal or an
  append of a version an earlier offline entry wrote names that version as
  it landed, and an append's `expect` follows the rewritten metadata. The
  carry is recorded with the landed entry (`outbox_landed_offline.carry`),
  so a flush cut off between two entries still remaps the second in a
  later command; it is kept while the partition has an entry queued
  offline, past the txnId retention. An entry a cut-off flush landed but
  never recorded is recorded by the next recovery, its carry read by
  pairing its queued commit with the one serve holds under its txnId.
  Without this a removal of a version the checkout renumbered would delete
  another writer's version that took its queued number.
- **Latest** ("Latest after a rebase" in `design/primitives/data.md`,
  `latest_choice.ts`). An offline write becomes latest only when it was
  observed more than 5 minutes (`LATEST_WINDOW_MS`) after the current
  latest. It is judged only against versions the offline writer could not
  have seen: ones that landed after its entry's base and are not this
  checkout's own offline work, landed by this flush or an earlier one
  (`outbox_landed_offline`, kept for the txnId retention). A restatement
  is never the checkout's own, even inside its own commit: it stands for
  another writer's version and competes with that version's observation
  time, so every later entry of the flush is judged against it too. Each
  entry that leaves latest in place restates it, so latest is right after
  every commit of the flush, including one cut off part-way; deferring one
  restatement to the last entry would leave the wrong latest readable in
  between. A write's observation time is its `executedAt` corrected by the
  recorded offset; a committed version's is the earlier of its
  serve-stamped commit time and its `createdAt` (once compaction removed
  the commit, `createdAt` alone, the writer's clock), followed through any
  restatement to its source. Otherwise the current latest stays: the commit
  restates it as a new highest version (a put of the same chunk, its
  metadata with the new version and the reserved tag `_swamp.restates`
  naming the version whose content it holds, the data-version op and the
  latest marker), so the highest live version is latest for every reader.
  A latest that was renamed or has a lifecycle state is not restated. One
  whose content serve will not let the flusher name (`403
  chunk_not_provided` on a commit that restates it) is sent again without
  the restatement: the rebased version then becomes latest and the report
  says so. Keep-last-N collection does not count restatements.
- **Under its lease** while serve still holds it. One that lapsed, was
  released or force-released, or was superseded is sent under no lease,
  rebased: never applied over what landed meanwhile. Refused because
  another holder's lease covers the behavior now, it stays `offline` for a
  later flush.
- **A removal whose target changed** (its version no longer live, or its
  record's digest moved) is `rejected`, with the rest of its commit.
- **Refused for a grant** (`403` with reason `forbidden`) is
  `quarantined`; refused for its content (`content-refused`, a forwarded
  run's outputs) is `rejected`.
- **Serve unreachable again** stops the flush; the rest stays `offline`.
- **An error of the entry's own** (a chunk missing from the checkout's
  cache, content that does not check, a commit that cannot be rebuilt)
  makes it `rejected`, and the flush goes on. Any other local failure (a
  full disk, a refused permission) stops the flush and the entry stays
  `offline`, tried again by a later command.
- An entry that may have reached serve and is still unsettled past the
  8-day txnId retention (`COMPACTED_TXN_RETENTION_MS`) cannot be settled
  by txnId: it is `rejected` (possible duplicate), never resent blind.
- Each command reports once what its flush did: versions rebased, which
  version holds each name's latest once the flush ends (`latestAtEnd`),
  entries rejected or quarantined.

**Quarantine.** A quarantined entry is deposited with serve, with its
chunks: a revoked principal cannot `PUT chunks`, so serve keeps both in the
control plane under `quarantine/<txnId>`, with the depositing principal and
the reason. Serve stamps the caller as the principal and runs
`authorizeCommit` again, taking the deposit only when that refuses it as
`forbidden`, so the route is not a drop box for anything else; it refuses a
txnId that already landed (`quarantine_landed`, 409), whose acceptance would
record another commit's seq against it; and it keeps one only
when the caller may read the commit's partition, as `GET
partitions/{p}/commits` decides (`quarantine_not_readable`, 403,
otherwise): a caller with no stake in a behavior cannot fill the shared
caps with changes refused by construction. Deposits are capped at 32 MiB of
chunks per deposit (`MAX_QUARANTINE_DEPOSIT_BYTES`, far below
`MAX_COMMIT_BODY_BYTES`, since a control-plane put holds the object in
memory), 32 held and 128 MiB held per principal
(`MAX_QUARANTINED_BYTES_PER_PRINCIPAL`), and 1024 held in all; an accepted
or discarded change frees its share. A larger commit stays quarantined in
the checkout only. `swamp
datastore status` lists the checkout's `offline`, `rejected` and
`quarantined` entries; with `--server`, an admin also sees serve's
quarantine. `swamp datastore quarantine accept <txn_id>` (`admin` only)
moves the commit's chunks into chunk storage and applies it through the
normal commit path, rebased, with its content bindings checked again. The
admin's authority answers only for the write grant the author lacked:
everything the commit carries or names (expression, vault and data
references) is judged with the author's access as serve knows it now: the
principal it is stamped as, with the groups serve itself keeps for it,
read from the current policy. The identity-provider groups and collectives
the author's token carried at deposit are kept in the record for the audit
trail only: serve cannot read them again for someone else, so they are
never lent from the past. A change the author may not make that way is
refused (`quarantine_content_refused`, 403, audited) and stays held for an
admin to discard. A chunk the deposit did not carry is the rebase restating
the current latest: the author must be able to read it, as a forwarded
commit's possession is proven, or the accept answers `chunk_not_provided`
and lands the change without the restatement, its version then latest, as
a member's own flush does. A non-admin accept is refused and audited, as a
non-admin discard or forced release is. The commit's principal stays the
original author; the accepting admin is
recorded in the quarantine record (kept, marked accepted) and the serve
audit log, never on the commit: `Commit.fromJSON` refuses unknown fields,
and older checkouts and followers read commits from the feed. The member's
next command settles its entry by txnId and says it was accepted at
serve.

A change that must not land is discarded instead: `swamp datastore
quarantine discard <txn_id>` (`admin` only, audited as
`datastore.quarantine.discard` whether it is allowed or refused). Serve
removes the held content and keeps the record under
`quarantine-discarded/<txnId>`, marked discarded with the admin and when;
only held records count against the caps, so a discard frees room for
other deposits. Discarding twice answers a duplicate; an accepted change
cannot be discarded (`quarantine_accepted`) and a discarded one cannot be
accepted (`quarantine_discarded`). Accept and discard run one at a time
with deposits, so they never both act on one change. The member's next
command asks serve what became of each quarantined entry
(`GET quarantine/<txnId>`, answered only to its author or an admin) and
keeps a discarded one as `rejected` with the reason "discarded at serve by
an admin": kept, never sent again.

**Limits (later items).**

- A base load has no bound on its number of pages, as the feed has none:
  a hostile serve can grow the staging file on disk.
- A grant widened after a copy loaded the base brings back the compacted
  records it now allows only through a reset of the copy (swamp-club#4089,
  "Reset when the caller's read access changes" above): the second command
  after the change, or later within the cooldown.
- A command's lease lives in the leader's memory: a takeover ends it and
  cancels its run. Explicit leases are kept ("Leases kept across a
  takeover").
- Recovering an explicit lease from a member who never came back is an
  admin's forced release; nothing ends it sooner than its hold of up to
  24 h.
- Without `managedConfig`, behavior definitions are repository files
  (`models/`), not datastore records. Serve judges a forwarded run's step
  outputs against its own checkout's definitions, so a workflow run on a
  behavior defined only in the client is refused (`403`). The run serve
  already recorded then stays `running` until serve's next start marks it
  `interrupted`. Teams run with `managedConfig`, whose definitions,
  workflows, vault configs and lockfile are datastore records every member
  shares and whose edits are refused when stale (`config_edit_conflict`,
  swamp-club#4097); without it, teams sync `models/` to serve's checkout
  (git) first.
- Per-file config is `p5-config`. The live feed is `commits.subscribe`
  ("Team mode: forwarding and the commit feed"): `workflow run` and
  `model method run` on a serve-mode checkout watch it while they run, and
  catch up through the changes feed when it brings commits.
- `swamp datastore claim` and `release` follow in "Team mode: claiming a
  datastore".

**Testing.**

- Each adapter has unit tests: the client, the errors, the sink, catch-up,
  the storage and the serve-mode state.
- Property tests cover `appendObserved` and the follower stores, against
  gapped sequences.
- `integration/serve_upstream_test.ts` drives real checkouts against a port-0
  serve with admin and member tokens, compares them with a solo checkout, and
  proves storage and its lease are never touched.
- `integration/serve_upstream_compacted_base_test.ts` loads serve's base into
  a fresh copy and one left behind, with scoped grants, a load cut off
  part-way, a serve moved after a load and a claimed datastore;
  `integration/serve_datastore_base_test.ts` drives `GET base`'s filtering.
- The error rules are each red-checked.
- `integration/serve_v3_offline_flush_test.ts` reaches serve through a
  proxy it takes down and brings back: a write under a lease lands with its
  fence; two offline commands never share a version; work without a lease
  is refused before it starts while reads and read-kind methods run; an
  offline definition edit is refused; read-only commands never flush; the
  three `latest` outcomes with serve's clock shifted; a lease ended while
  offline lands after another member's write, rebased and unleased; a flush
  cut off after a send resumes without duplicates. Property tests
  (`offline_rebase_property_test.ts`) check that a rebase never renumbers a
  committed version, that queued versions never collide, and that two
  members flushing in either order never leave latest more than 5 minutes
  behind the newest observation. `integration/serve_v3_team_mode_test.ts`
  takes over from a leader while a member holds an explicit lease (Workers
  as machines): the lease survives and its renewal succeeds.

### Team mode: leader election and followers (datastore rework Phase 5)

Before swamp-club#4096 a v3 serve ran single-instance: a second serve node
waited out the lock timeout and failed with `datastore_v3_writer_busy`, and
serve kept its control plane in its checkout, where no other node could see
it (swamp-club#3962). Now every serve node behind one address shares the
datastore, and the writer lease elects the leader.

**Roles.** The node that holds the datastore's writer lease leads: it writes,
runs work and keeps the leader's timers. The others follow. Serve asks for
its hold with `followV3Lease`: `holdV3Writer` (`follow: true`) tries the
lease once, without the lock timeout, and a busy lease leaves the node
following, its copy made current for reads (`followV3Datastore`). Nothing is
recovered, marked or replicated by a follower.

- `ServeLeadership` (`src/serve/serve_leadership.ts`) tracks the role. On
  every tick (10 s) a follower tries the lease once and, when it is busy,
  restores its copy from the published lineage when it is behind
  (`refreshV3FollowerCopy`) and reads the leader record. A follower that
  wins takes the writer's full hold path: restore the latest replicated
  state, raise the fence, check the claim, recover the outbox and start a
  lineage at its fence.
- A leader whose lease another node took over (a higher fence) does not
  follow: it stops (`onLostLead`). Its role changes first, so its gates
  refuse, and serve shuts down as on SIGTERM: it takes no more work, its
  queued webhook runs stay pending for the leader to replay, its timers
  stop, and it exits 75 for its supervisor to start it again as a fresh
  follower. No state of its time as leader (queues, timers, runs, its
  instance id) carries into following. Team mode needs a supervisor that
  restarts serve: the Docker image's restart policy, systemd, launchd or
  Kubernetes.
- The lease and its fence alone decide who commits. The leader record
  (`leader/current` in the control plane: instance, fence, node address,
  since) only names the leader to followers, so a stale record can name the
  wrong node but never lets a follower write. The node address is the
  listener's (`scheme://host:port`); a wildcard or loopback bind address
  names nothing another host can reach, so the record leaves it out unless
  the node advertises one (`--advertise-address`, swamp-club#4120), which
  the record names instead. Serve warns at start-up when the advertised
address is plain http to a host that is not loopback: the peer key and
forwarded credentials would cross the network unencrypted.
- A node takes the lead in order: it records itself, does the leader's work
  (below), and only then changes its role, which opens its request gates, so
  what it settles and sweeps on taking the lead is never work it has just
  accepted. A node whose record cannot be written does not lead yet: the
  next tick retries the record, not the lease. A node that took the lease at
  boot writes its record before it listens or settles anything. A node that
  boots following has its gates closed from the first request, before its
  leadership exists.

**What a follower refuses.** Since swamp-club#4120 a follower forwards
each of these to the leader ("Team mode: forwarding and the commit feed")
and refuses only when no leader can be reached. Writes it cannot forward
are refused with `serve_not_leader` (`ServeNotLeaderError`, exit 75:
nothing was taken, so a retry is safe), in one place per surface:

- WebSocket requests: `followerRefusal` (`src/serve/follower_requests.ts`)
  before the handler runs, so no step's side effect happens first. Every
  dispatched request is either in `FOLLOWER_REFUSED_REQUESTS` or
  `FOLLOWER_READ_REQUESTS` (`integration/serve_follower_requests_rules_test.ts`);
  an unknown request is refused. The error frame names the leader.
- The datastore API: every write after authentication, as a 503 with
  `Retry-After` and the leader. A chunk check (`has`) is a read. The CLI's
  serve upstream maps it to `ServeNotLeaderError` and does not retry or
  redirect. A partition read from a caller whose copy holds more of the
  partition than this follower's is refused as behind
  (`serve_follower_behind`, see "Team mode: the CLI's serve upstream"), after
  authentication and the read check (swamp-club#4254).
- Readiness: a node that starts as a follower with a leader feed reports
  `/ready` only once its copy holds the head the leader names
  (`awaitFirstFollowerCatchUp`, `src/serve/follower_ready.ts`). It stops
  trying after 30 seconds, so with a last feed check in flight the wait can
  reach about 35, and it stops at once if it takes the lead or shuts down. A node
  restored from the bucket after a takeover can trail the members' copies,
  and the team address would otherwise route them to it (swamp-club#4254).
- Webhooks: a verified delivery gets a 503 with `Retry-After`, naming no
  leader. Cron fires are left to the leader (the fire dedup answers
  "claimed by another instance"), as they are by a leader whose lease was
  taken over before its next tick.
- Workers: enrollment is refused with `serve_not_leader` before the token
  is redeemed. Workers retry any code outside
  `PERMANENT_ENROLLMENT_ERROR_CODES`, so they reach the leader.
- The HTTP signal and cancel routes: after authentication, as the
  datastore API (`followerHttpRefusal`).
- Commits: `refuseV3FollowerWrite` in the handle's `assertWriterCurrent`,
  the choke point local units and forwarded commits share, is the backstop
  for a node that holds no lease. A node whose lease was taken over is
  refused as fenced (`datastore_v3_writer_fenced`, exit 1) instead: a commit
  that reaches it ran its request's work first, so a blind retry is not
  safe, and "nothing was changed" would not be true.

A follower answers reads from its own copy only while it is fresh: one that
went three ticks (30 s) without a refresh refuses reads with the same code,
so a revoked grant stops allowing reads on a follower within that bound.

A follower's access policy follows its copy (swamp-club#4207). On a bucket
the leader's commits land in the follower's own `commits.db` before its read
model catches up, so `ServeCommitEffects` applies a commit's effects (the
catalog rebuild, the policy reload) only after the read model holds it. A
policy reloaded earlier would miss the grants those commits carry. Three
further rules keep a read from being filtered under a policy older than the
commits it pages:

- **Bounded pages.** A follower pages `GET changes` and `commits.subscribe`
  only to the last commit whose effects it applied
  (`ServeCommitEffects.appliedCursor`). A cursor never moves past a commit
  filtered under an older policy. Filtering by a grant that denies is still
  correct, and the cursor moves past those commits.
- **Replaced copy.** A lineage restore replaces the copy (a failover does
  this). The follower then goes on answering reads under the policy it last
  loaded, still bounded, and reloads once the refresh has rebuilt the read
  model. Reads continue through a takeover. A node that takes the lead on a
  copy replaced while it followed reloads its policy.
- **Unknown policy.** While a reload that access commits or a replaced copy
  asked for has failed and not yet succeeded, the follower refuses reads with
  the stale follower's retryable `503`. `wireFollowerPolicy` composes the
  effects, the bounded feed and this gate for serve.

**The leader's work.** Retention, server token GC, the continuation sweep,
v3 maintenance and the Litestream sidecar upkeep start only on the leader; a
follower starts them when it first leads. Grant config (`admins` and the
grant files) is applied only by the node that leads: at boot, and when it
takes the lead, where it re-reads its grant sources as they are then
(`GrantsDirectoryPoller.reconcileNow`), never its boot snapshot, which
would bring back a grant revoked since. It then waits, bounded by the lock
timeout, for the grant commits to be replicated and published
(swamp-club#4207). A follower restores the published head, and one restored
without the grants would start with none. A node without the lease defers its
grants poller's reconcile (`"deferred"`), so the change is tried again at
the next poll and applied once it leads. A follower's collective refresh
writes nothing and still updates its own connections. A peer reconciliation
judged gone has its claim released once it is settled, since in team mode a
live peer keeps its instance id. When a node takes the lead
it settles what the nodes before it left (`settleLeftRuns`, the remote
reconciliation and the pending-run replay). The continuation sweep, the
reconciliation tick, cron fires and the grants poller check the lease on
each pass, so a leader whose lease was taken over does nothing in the time
before it notices and stops.

**The control plane.** Serve's control plane on a v3 datastore is
`v3ServeControlPlaneAt`: the datastore-wide control plane's namespaced
records (`ns/<namespace>/`, `ns/_/` solo), on a bucket and on a filesystem
datastore alike, beside but never among the lease's `writer/` records.
Heartbeats, active and pending runs, continuation and reconciliation claims,
fire records, token secrets, dashboard sessions and the leader record live
there, so `hasRemoteControlPlane` holds on every v3 serve and v2 HA's
machinery runs unchanged. A local resume takes its continuation claim there
too. The issue recommended records in `commits.db` instead; the `ns/` store
was chosen because followers must write their own heartbeats, it needs no
schema bump, and heartbeats do not go through Litestream. Settlements are
commits under the leader's fence, so a zombie leader cannot land them, and
the shared records need no fencing.

On its first start after the upgrade a checkout moves what its serve kept
in `.swamp/_control/` into the shared store, once
(`importCheckoutControlPlane`): pending runs, fire records, schedule pauses,
dashboard sessions, audit events kept in the control plane, and token
secrets as a set: the checkout claims the key slot atomically and moves its
values only when the store keeps its key. A local command that opens serve's
store runs the same import first, so a token command run before serve
restarts cannot make a key that strands the checkout's tokens. A
second checkout whose serve minted tokens under its own key keeps them in
its checkout, with a warning: they must be minted again. Local commands
that write what serve reads (`access token mint`, `rotate`, `reveal`,
`worker token create`, `workflow schedule pause` and `resume`) use the same
store (`localServeControlPlane`). Records are created only where absent, so nodes upgrading
together overwrite nothing. Token secrets now live in the bucket, as v2 HA's
do: anyone who can read the bucket's control plane can read them unless
serve.yaml names an external `token-secrets` key. Serve says so at every start on a v3
datastore while the key is the co-located one (`coLocatedTokenKeyWarning`),
and says nothing once a `token-secrets` block keeps it in a vault.

**Judging other instances.** Only the leader runs work, so in team mode a
run any other serve instance left `running` is dead whatever its heartbeat
says: a demoted leader still heartbeats, but its commits are fenced.
`teamModeRunLiveness` gives the boot reaper an `isAlive` that is true only
for the leader itself, with `judgeForeignRows` so a tracker row another
instance left (#3962's quick restart, a row reopened under the old instance
id) is judged rather than trusted. Remote reconciliation counts a peer gone
when its heartbeat is stale or it still records active runs; a follower
records none, so its heartbeat is left alone. A peer the leader record names at a
fence above this node's is never gone: it took the lead from this node,
which has not noticed yet. Runs a CLI command started
carry no serve instance id and keep their pid check.

**Claims.** `datastore claim` names serve's address, and every node is
started with that `--address`, so a takeover is no change of owner. A node
with another `--address` is refused at start, follower or not, before it
waits (`datastore_claimed`).

**Known limits.**

- A step a remote worker runs for a leader that then loses the lead may
  finish on the worker; its result reaches the old leader, which cannot
  commit it, and the new leader settles the run `interrupted`. Forwarding
  results to the new leader is not done yet.
- A follower whose commit feed is down restores its whole copy when the
  published head moved (about 4.5 s per GB). Litestream follow mode as a
  warm standby is a later step.
- A team runs one build on every node. A follower restores the leader's
  `commits.db`, and a follower whose commit store schema is older than the
  leader's refuses the restored copy ("upgrade swamp"), so it cannot follow
  until it is upgraded. Until it restores, a copy it already holds keeps
  following the feed, which leaves out the lease ops it would refuse
  (swamp-club#4168).
- A serve that loses its lease exits 75, single-node too: one stalled past
  its lease's TTL, so that another writer such as a CLI command took the
  lease, stops rather than following. Run under a supervisor, it starts
  again as a follower and leads once the lease is free. Before team mode it
  kept running with every commit refused until its renewal took the lease
  back.
- A single serve that starts while another writer, such as a CLI command,
  holds the lease no longer waits the lock timeout for it: it follows, and
  refuses writes with `serve_not_leader` until a tick takes the lease (up
  to 10 s after the other writer is done).
- The reconciliation tick and cron fires also check the live lease, so a
  leader whose lease was taken over and has not ticked since neither judges
  the new leader gone nor claims a fire.

### Team mode: forwarding and the commit feed (datastore rework Phase 5)

Before swamp-club#4120 a follower refused every write, so behind a load
balancer about half of a two-node team's writes failed and were retried,
and a follower's copy lagged the leader by up to a tick.

**An advertised address.** `serve --advertise-address <url>`
(`SWAMP_SERVE_ADVERTISE_ADDRESS`, `advertise-address:` in `serve.yaml`) is
this node's own http(s) origin as the team's other nodes reach it
(`normalizeAdvertiseAddress`: no path, query, credentials or wildcard host;
an explicit loopback address is accepted for a team on one host). The
leader record names it in place of the listener's address. A node that
advertises itself also trusts the team's names for Origin and Host checks:
the shared `--address`, which a forwarded browser session's Origin names,
and its own advertised address, which a follower forwarding to it puts in
Host. `serve --ca-cert` (`SWAMP_CA_CERT`, `tls.ca-cert`) adds the CA
certificates a node trusts when it calls the leader, as clients' `--ca-cert`
does.

**Proxy, don't impersonate.** A follower passes each write to the leader
with the caller's own credential, and the leader authenticates and
authorises the caller itself. A follower never asserts who the caller is,
so a compromised or misconfigured follower has no more access than its
callers. The leader record carries a proof, an HMAC of its instance, fence,
address and start under the team's peer key (below): a follower forwards
only to the address of a record that holds it, so whoever can write the
shared control plane, but not read the peer key, cannot redirect callers'
credentials to an address of their own. A record without it names the
leader but no address, and the follower refuses as before. `LeaderLink`
(`src/serve/leader_link.ts`) holds one HTTP client
per leader address, replaced when the record names another node; HTTP/2
carries every forwarded HTTP request over one connection. Every forward,
HTTP or WebSocket, carries the team's peer token in `x-swamp-team-peer`
(the follower drops one a caller sent); a leader that verifies it against
its cached key treats the follower as a trusted proxy for that request and
keys its IP burst, rate limits and audit on the last `X-Forwarded-For`
entry, the caller's address as the follower set it
(`requestClientAddress`, swamp-club#4148). Without it, every connection a
follower forwards would spend the follower IP's 50-per-minute upgrade
budget on the leader, and a busy follower would see 429s on its forwards
and its own feed. A peer upgrade is checked before the IP burst, so a
follower's feed reconnects never spend it; a peer token that fails counts
against the burst and the per-credential limit. One place per surface
replaces the refusal:

- WebSocket requests: at upgrade the follower keeps the caller's credential
  (the bearer token, from whichever transport carried it, or the dashboard
  session cookie with its Origin) as connection-private state
  (`forwardCredentialOf`, read before the upgrade closes the request's
  headers). `FollowerForwarder` (`src/serve/follower_forwarder.ts`) opens
  one socket to the leader per client connection with it, on the first
  request the follower does not answer, and relays frames by id both ways.
  A cancel for a forwarded request, and one for a run id the follower does
  not have, goes to the leader. `FOLLOWER_FORWARDED_REQUESTS` (formerly
  `FOLLOWER_REFUSED_REQUESTS`) adds `run.attach`: runs execute only on the
  leader. Gates that run first on the follower (request limits, restricted
  commands) use its own fresh policy; the leader checks again, so they can
  only refuse, never widen.
- The datastore API, HTTP signal and cancel: after the follower
  authenticated the caller, the request goes to the leader unchanged, with
  `X-Forwarded-For` set to the caller's address (after the caller's own
  only when the follower runs with `--trust-proxy`, so a caller cannot name
  the address it is limited by). The leader reads the follower's entry
  when the team forwarding header verifies, so `--trust-proxy` is needed
  only for the load balancer in front of the nodes.
- Webhooks: the follower passes the delivery on as it came, raw body and
  headers, right after its size-limited read and before it verifies the
  signature or runs any extension hook. The leader verifies it with its own
  endpoint config, so the team's nodes need the same webhook config.
- Workers: a worker's connection to a follower is relayed whole to the
  leader from its first RPC frame (its enrollment), so it joins the
  leader's pool. Its data-plane requests (`/data`, `/bundle`) are forwarded
  too: its session credentials live in the leader's memory.

**A takeover mid-request.** A forward that never reached the leader (no
address, connect, DNS or TLS failure) gets today's refusal. One that failed
after the request was sent gets the same code with `inFlight: true` and a
message that it may already have run. The follower never retries either.
The leader's own session closes (4003 revoked, 4002 expired) close the
client's connection the same way.

**`commits.subscribe`.** A WebSocket subscription on serve's commit log
from a cursor (`src/serve/handlers/commit_feed_handlers.ts`). It reads the
log with `changesSince`, then waits on the store's head-moved signal
(`SqliteCommitStore.onHeadMoved`) and sends each batch as it lands,
filtered per caller exactly as `GET changes` is: `CommitReadFilter`
(`src/serve/commit_read_filter.ts`), the changes feed's filter taken out
of the datastore API, built afresh per batch so a changed grant takes
effect on the next one. A subscriber names what its copy understands in
the payload's `features` (at most 16), as a datastore API request names it in
`x-swamp-datastore-features`: lease ops reach only a subscriber that names
`lease-ops`. A frame with no commits goes out at least every
5 s, so a subscriber tells a quiet feed from a dead one. A cursor below the
compaction point ends the stream with `commits_compacted` (load the base,
as for the 410); a subscriber further behind than its socket can buffer is
ended with a resumable `commits_lagged`. A subscription on a follower ends
with `serve_not_leader` once the follower's copy goes stale, as a new one
would be refused. `commits.head` answers the last
cursor the feed may send. A replicating leader sends only what it
published (`v3CommitFeedSource`'s bound): a commit not yet replicated could
be lost to a failover, and a node that applied it would hold a commit the
next leader never had. Confirmed writes publish at once; background commits
reach the feed with the next probe (at most 30 s), never later than the
lineage restore would have brought them.

**Followers follow the feed.** A follower subscribes to the leader with the
team's peer key (`TeamPeerKey`, `src/serve/peer_auth.ts`): one random key per
namespace in serve's encrypted control-plane vault, so a `token-secrets` key
protects it as it protects token secrets. A node reads the key at most every
10 s, whether the read finds the key, finds none or fails, and peer checks
made while a read runs wait for it, so failed peer tokens cannot drive vault
reads (swamp-club#4153). It uses the key it last read for at most 60 s more
while vault reads fail, so a key deleted during an outage stops verifying.
With the default co-located key, anyone who can read and write the datastore
can read the peer key and so sign a leader record of their own, which
followers would forward callers' credentials to: a team-mode serve (one with
`--advertise-address`, or one that finds another node leading) says so in its
start-up warning about the co-located key, and recommends the `token-secrets`
block. It is a warning, never a refusal, so a single node and existing
deployments keep working. A leader record is also trusted only at the lease's
current fence: a record an earlier leader signed, written back after a
takeover, gets nothing forwarded to its address, and the follower refuses
until the leader records itself at its fence. A peer socket may only read the
feed and its head; it skips the per-caller grant filter but keeps the
namespace one, cancels nothing but its own requests, and is refused everywhere
else, HTTP included, where the key is an unknown token. `FollowerFeed`
(`src/serve/follower_feed.ts`) applies each batch to the copy
(`applyV3LeaderChanges`): on a replicating datastore it appends each commit at
the leader's own cursor (`SqliteCommitStore.appendFromLeader`, so a cursor a
client read from either node names the same commit), then catches the read
model up; on one that does not replicate every node opens the same
`commits.db`, so it only catches the read model up. Every frame marks the copy
fresh (`ServeLeadership.markRefreshed`). Each apply step is tied to the socket
that delivered it: one the previous socket queued applies nothing and marks
nothing fresh once the follower follows another leader, and the tick stops the
feed before it restores, so nothing of the old socket is queued behind the
restore (swamp-club#4148). While the feed is current for the leader the record
names, a tick restores nothing. A new leader (another instance or fence), a
disconnect, a gap, a divergent commit (`FeedDivergedError`) or a compacted
cursor stops it: the next tick restores from the published lineage, which
holds everything the feed sent, and follows again from there. The 30 s
staleness bound stays. Before a forwarded write's last reply goes back, the
follower waits (at most 5 s, and not at all while its feed is down) until its
copy holds the leader's head, so the caller reads its own write from that node
next.

**Commit effects replace the pollers.** `ServeCommitEffects`
(`src/serve/serve_commit_effects.ts`) watches every commit landing in a
node's copy and classifies it by partition (`commitEffectOf`): a
definition or runtime record rebuilds the catalog; a grant, group, token or
worker reloads the access policy; the config or the extension lockfile runs
the config check (`ConfigPoller.pollNow`). A copy replaced behind what was
read refreshes everything. Before this, a follower loaded its policy once,
at boot, so a grant revoked on the leader went on allowing access on a
follower.

**Serve-mode checkouts.** `workflow run` and `model method run` on a
serve-mode checkout watch serve's feed while they run (`watchV3ServeFeeds`,
stopped when the datastores close). The watch is a wake-up: when a frame
brings commits, the checkout's own catch-up reads them through the changes
feed, with its filtering, base loads and gaps. Short commands need nothing
new; serve never watches.

Such a catch-up can run while one of the command's units is open, and the
feed brings back the commits the command itself sent, a mid-run checkpoint
among them (swamp-club#4249). The checkout's files already hold those
changes, or newer versions the open unit wrote since, which its own commit
reads from the files. So the handle notes the txnId of every commit it sends
to serve, before sending it, and while a unit of the checkout is open the
read model applies such a commit to its state and catalog but leaves its
files alone (`holdsOwnWork`). Noting it before the send covers a frame that
brings the commit back before serve's reply does. A txnId is forgotten once
the read model has committed the page that applied its commit
(`ownWorkApplied`), so the set holds only commits not applied yet, however
long the command runs. The note is in this process only: a second write
command in the checkout waits for the checkout's writer lease, and a reader
whose index is complete does not replay. Before, a frame bringing a workflow run's
first checkpoint could put the record back to `running` after the run saved
it `suspended`: the root committed `running` while the command printed
`suspended`, and serve refused to approve the run. Dropped work is recovered
only while no unit is open, so its replay still puts back every file.

**Testing.** `integration/serve_v3_team_forwarding_test.ts` (a commit
through a follower lands as the caller; the leader decides; an unreachable
and a lost leader), `integration/serve_v3_team_ws_forwarding_test.ts`
(streams, cancels, an in-flight drop, a revoked session, a worker relay),
`integration/serve_v3_commit_feed_test.ts` (filtering, resume, compaction,
peers, a follower applying the feed),
`integration/serve_upstream_own_commit_replay_test.ts` (a catch-up while a
run's root is open leaves the run's later save for the root to commit, also
when it meets the checkpoint before serve's reply; a dropped save is still
put back to the checkpoint), and
unit tests beside each module.

### Team mode: claiming a datastore (datastore rework Phase 5)

Before swamp-club#4063, a v3 datastore that serve wrote could still be written
directly by any checkout holding storage credentials. The fenced writer lease
kept the log consistent, but a direct write skipped serve's authorisation:
grants, content checks and principal stamping. `swamp datastore claim` makes
serve the datastore's owner, and direct writers refuse.

**The owner record.** The owner is a one-row table in `commits.db`,
`datastore_owner`: serve's address, normalized as clients compare it
(`normalizeOwnerAddress` in `src/domain/datastore_v3/datastore_owner.ts`, no
credentials, query or fragment), the time of the claim, and the log's
high-water mark when it was written (the claim's log position, its
checkpoint). No SQLite checkpoint is forced: a replicated `commits.db` leaves
checkpoints to Litestream. The owner is serve's address, not one serve
process, so every node behind that address writes as the owner and a
failover is not a change of owner.

The table came with schema 10 (a no-op migration), so every swamp older than
this change refuses a datastore this binary has opened with
`datastore_v3_schema_newer` rather than writing past a claim it cannot see.
The upgrade is one-way: every checkout of the datastore upgrades together.
The earlier design put the owner in `_meta.json` with a compare-and-swap.
That needs a conditional write from every storage provider, and binaries
between swamp-club#4049 and this change would ignore it.

**Writing the claim.** `SqliteCommitStore.claimOwner(fence, owner)` and
`releaseOwner(fence)` write in their own `BEGIN IMMEDIATE` transaction and
check the writer fence inside it, as appends do: a writer that lost its lease
can neither claim nor release. A serve-mode copy is never claimed.

- With serve stopped, `swamp datastore claim --address <url>` (and
  `release`) takes the writer lease itself, in serve's checkout or any
  checkout bound to the storage. It catches the commit log up, then writes the
  owner. The closing sync replicates the row before the lease is let go.
- With serve running, the same commands go to serve (`--server`, or the
  address the environment or `.swamp.yaml` names, as `datastore status`
  routes) as `datastore.claim` and `datastore.release`. These are admin-only
  control-plane requests (`admin` on `access:*`), audited with the claimed
  address (normalized, so no credential reaches the audit log). Serve writes
  under its own fence and confirms the row replicated before it answers
  (`v3ClaimCommitLog` with `confirmReplicated`): the row is not a commit and
  moves no high-water mark, so the per-request confirmation would skip it.
- Claiming again for the owner's address writes nothing but confirms the
  claim as it stands is replicated (so a retry after a claim that was written
  but not confirmed is not acknowledged unconfirmed), and likewise a release
  of an unclaimed datastore. Another address is refused with
  `datastore_claimed` until the claim is released. A release removes a claim
  row it cannot read, and a claimer's hold never reads it.
- A serve records its own address, `serve --address` (`SWAMP_SERVE_ADDRESS`,
  `address:` in `serve.yaml`), and refuses a claim naming another, or any
  claim when it was started without one.

**Refusing direct writers.** `takeV3WriterHold`
(`src/infrastructure/datastore_v3/v3_repo_context.ts`) reads the owner after
it holds the lease and, on a bucket, once the copy is current, and before
outbox and interrupted-writer recovery lands anything. A claim that lands
while a writer waits for the lease is therefore seen, and the claim itself
needs the lease, so a writer that took it earlier commits before the claim,
never after. A refused writer gets `DatastoreClaimedError`
(`datastore_claimed`, a user error, exit 1). It names the owner and says to
set `serverAddress` or `SWAMP_SERVE_URL` and run `swamp auth server-login`.

- The hold's policy is `V3OwnerCheck`: a direct writer (the default) is
  refused, `datastore claim` and `release` pass as `claimer`, and serve's
  lifetime hold passes its `--address`. Serve writes a claimed datastore only
  when its address is the owner's, so a second serve, such as one started on a
  laptop holding credentials, is refused like any direct writer. An owner
  serve started without `--address` refuses to start and says to pass it.
- Serve checks the claim again before a commit whenever its fence moved since
  the claim last named it (a retake after a lost lease, or a move of the
  lease). A claim for another address written while serve's lease had lapsed
  stops serve committing until it is restarted with that address or the claim
  is released.
- A writer does not wait for a lease serve holds to be told so: before the
  lease it reads the claim from the file (the shared `commits.db`, or a
  bucket checkout's last copy, `SqliteCommitStore.peekOwner`, read-only). When
  that shows a claim it may not write under, it takes the lease without
  waiting, and a busy lease is refused at once with `datastore_claimed`
  instead of `datastore_v3_writer_busy` after the lock timeout. A free lease
  goes on to the check under it, which decides. A bucket checkout's copy can
  predate a release, so there the refusal says the claim was seen in this
  checkout's last copy while another process held the lease, and to run the
  command again once it is done.
- Reads stay allowed: read-only opens take no writer hold.
- Serve-mode checkouts are unaffected: they never write storage, and serve
  writes as the owner.
- A checkout's commits still in its outbox when the claim lands stay there:
  its next direct write is refused before recovery lands them. Moving to serve
  does not carry them over: a serve-mode checkout has a copy root of its own
  and never reads the old copy's outbox. So on a replicated checkout the
  refusal says how many such commits there are and the outbox they stay in
  (`countPendingOutboxEntries`, read-only), that they land only after a
  release and a direct command, and that they are not sent through serve. To
  keep them, release, run a command directly, then claim again, or redo the
  work through serve. The refused command itself still changed nothing. On a filesystem datastore the
  outbox sits beside the shared `commits.db`, so the claim's own hold lands a
  dead writer's prepared commits before the claim.

**Releasing.** `swamp datastore release` removes the row, and direct
writing works again. With the owner serve gone for good, a direct release
with serve stopped is the way out: it needs only the writer lease, which the
dead serve's lease expires into. To move the owner to a new address, release,
then claim for the new one.

**What a claim cannot do.** It makes direct writers refuse honestly. It
cannot stop a modified client that holds storage credentials, and a direct
release needs nothing a laptop with credentials lacks. Removing storage
credentials from laptops and CI is the operator's step.

**Testing.** `integration/datastore_v3_claim_test.ts` covers the refusal,
reads, the owner and other serves, release, a claim through serve's handler
while serve holds the lease, and serve stopping after a claim for another
address under a moved fence. Its two race tests run the other writer in a
Worker: one holds the lease when the claim is asked for and commits before it,
and one waits for the lease while the claim lands and is refused, which fails
when the check moves before the lease. `datastore_v3_litestream_restore_test.ts`
checks that a claim reaches the next machine's restore, and
`datastore_v3_outbox_test.ts` that a dead writer's prepared commit lands
before the claim and nothing after it.

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

**An export speaks only for its own namespace** (swamp-club#3636). Each row
carries a `namespace` field, and the catalog key starts with it, so a row that
named another namespace would replace that namespace's rows — the reader's own
among them, with its tags (`_swamp.sensitiveFields` included), latest flags and
provenance. Readers trust `namespace` to tell their own rows from foreign ones:
`data.latest` resolves sensitive vault references only for own rows, and serve
GC reaps only own rows. So the pull enforces the rule in three places:

- `parseForeignNamespaces` (`src/domain/data/foreign_catalog_export.ts`)
  checks `--namespaces` before the provider is contacted. Each value must be
  shaped like a namespace, and none may be the reader's own namespace, taken
  from `namespaceFromResolver` (the value that stamps its own rows).
- `storeForeignCatalogEntries` ignores any entry the provider returns for a
  namespace that was not requested. Of each export, it keeps only the rows whose
  `namespace` is the pulled namespace (`acceptForeignExportRows`), dropping rows
  that claim the reader's namespace, the empty solo namespace or a third one,
  and it warns with the count. The JSON output reports dropped rows per namespace
  as `rejectedRows` and ignored exports as `ignored`.
- `bulkUpsertForeign` refuses an empty namespace, and any row whose namespace
  differs from the one it is storing, before it writes anything.

The rule stops one namespace's export from speaking for another. It does not
protect against anyone who can write into the reader's own bucket prefix: that
prefix is guarded by the datastore's access control (bucket policies), not by
swamp. Rows forged into a catalog before the rule existed stay until the catalog
is rebuilt: delete `.swamp/data/_catalog.db` so the next query backfills it from
disk, then pull again.

**On-demand content fetch** (Phase 6d): when a cross-namespace CEL expression
reads `attributes` whose content is not local, the `DataQueryService` calls
`fetchForeignContent` through the `ForeignContentFetcher` its data repository
carries (`UnifiedDataRepository.fetchForeignContent`). The fetcher travels with
the repository, as the lazy-hydration hook does, so a query service built from
a repo context's repository can fetch wherever it is built: every repo context
constructor wires it from the sync service, and the paths that build a
repository of their own (workflow runs, `workflow evaluate`, `behavior
evaluate`, `behavior validate`) are handed it.

Every reader hydrates a foreign JSON record: `query()` (before projection, so a
`select` over `attributes` sees them, and after the `include` filter, so a
record the caller may not read is never fetched; a `select` that reads no
`attributes` fetches nothing) and `getLatestRecord`, which serves a
namespace-prefixed `data.latest()`.

The path fetched is built from the foreign row's namespace, behavior type,
behavior id, data name and version. Those fields are the other namespace's to
write, so a row is fetched only when each is a plain path segment: one holding
`..`, a separator or nothing at all could name an object outside that
namespace's data tree, and is left with empty attributes. On v2 a `select` that
reads `content` rather than `attributes` still sees no bytes for a foreign
record (on v3 the local fetcher fills it: "Reading another namespace" under
"v3 opt-in", swamp-club#3691), and
a predicate over a foreign record's `attributes` is matched before hydration,
against empty attributes.

A fetched body is cached in memory by the service, up to a fixed number of
bodies, and never persisted. Missing content or an error leaves attributes
empty and is not cached, so the next read tries again.

Foreign attributes are returned as stored. Sensitive fields holding vault
references are not resolved: the record's tags and values are the other
namespace's to write, and must not choose which of the reader's secrets are
read.

**CLI**: `swamp datastore catalog pull --namespaces infra,security` pulls
foreign catalog metadata from those namespaces.

### Reading one remote file (`fetchContent`)

Every other read in the sync contract replaces the local copy: `pullChanged` and
`hydrateFile` write into the cache and overwrite a local file that differs from
the remote, including one with a change not pushed yet. `fetchForeignContent`
writes nothing, but it always prefixes its key with a namespace and is for
another namespace's data. `fetchContent` is the read that leaves the cache
alone, for a caller that has to compare its cached copy of a file with the
remote one before acting on it (swamp-club#3159):

```typescript
fetchContent?(relPath: string, options?: DatastoreSyncOptions): Promise<Uint8Array | null>;
```

- It resolves to the file's bytes, or `null` when the remote has no such file.
  Any other failure rejects, so a caller never mistakes an unreachable remote
  for a deleted file.
- It writes nothing locally: no cache file is created, replaced or removed, and
  no dirty state or pull watermark changes. A differing local file is neither
  returned nor consulted, and its pending push stays pending.
- `relPath` is cache-relative and forward-slash-normalized, as for `hydrateFile`.
  The cache mirrors the remote layout (see
  [Namespace prefixing](#namespace-prefixing-giga-swamp)), so with a namespace
  the path already starts with `{namespace}/` and the implementation must not
  add it again. `options.namespace` is the calling repository's namespace; when
  it is unset the datastore has none and the path is read from its root.
- A `relPath` that is absolute or has a `..` segment is rejected.
- The returned bytes must not be kept in instance state, since the sync service
  lives as long as a `swamp serve` process. The whole file is held in memory, so
  the method is meant for small files such as run records.

The method is optional and has no `SyncCapabilities` flag: core treats its
presence as the capability. `swamp serve` calls it to compare its copy of a
run record with the remote one before it resumes a suspended run by itself
(`runRecordCurrencyOver` in `src/cli/repo_context.ts`, swamp-club#3108; see
"Continuation claims" in `design/primitives/workflows.md`). `assertSyncServiceRoundTripConformance` checks an
implementation with its `fetch-content`, `fetch-content-error` and
`fetch-content-namespace` cases, and
`createInMemoryRemote` implements the method for tests.

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
2. **Behavior runs / workflow runs**: `acquireModelLocks` does a scoped pull via
   `pullChanged({ context })`. It reads the partition file, sees `raw` missing
   locally, and downloads it. A read or list run pulls the same way without the
   lock (`pullModelsUnlocked`, see "Lock Lifecycle"). That pull covers only the
   step's own behavior, so it is not what makes another behavior's data
   readable; see "Expression reads" below.
3. **`data get` and `data query` (read-only, no sync)**: every read of a
   content file goes through the repository's content-ensuring step (below),
   which downloads a missing `raw` through the `HydrateFileHook`. `data query`
   reaches it through `DataQueryService.query()` (see "`getContentSync`
   limitation" below).
4. **Expression reads**: before a CEL expression is evaluated, its context
   downloads the content the expression reads synchronously (see "Expression
   reads" below).

#### Content-ensuring step

`UnifiedDataRepository.ensureContentLocal()` makes a version's `raw` local and
current before it is read; `getContent()`, `stream()` and `append()` go through
it (swamp-club#3178). With a `HydrateFileHook`:

- A missing `raw` is downloaded.
- A `raw` shorter than the size its `metadata.yaml` records (or the size the
  caller passes, such as a catalog row's) is downloaded again, replacing the
  local copy. `append()` rewrites the latest version's `raw` in place, and a
  metadata-only pull brings the new `metadata.yaml` but skips the `raw`, so
  the old bytes would otherwise be served as current. A local write never
  leaves `raw` short: `append()` writes `raw` before `metadata.yaml`, and
  `save()` writes `metadata.yaml` first while `raw` is still absent.
- A copy still short after the download is the remote's own (another host's
  push uploaded the metadata but not yet the content). It is accepted and used
  for `ACCEPTED_SHORT_CONTENT_TTL_MS` (30 s) per repository instance, then
  downloaded again on the next read. `isContentAcceptedSync()` tells
  synchronous readers whether a short local copy is the accepted one.
- `append()` refuses to append unless the content is current, so it never
  writes after a missing or stale prefix.

The result is `current`, `acceptedShort` or `missing`. Without a hook the step
reports `current` without looking, and callers read the file as before. The
locked repo contexts wire the hook for any custom datastore whose provider
implements `hydrateFile`, whatever its `hydrationStrategy`, so the size check
applies there too; it costs a stat (and a metadata read when the caller has no
size), and a download only for a missing or short `raw`.

Limits: a size check catches growth only, so a reused version number whose new
content is the same size or larger is not detected. And if a metadata-only pull
overwrote an unpushed local `metadata.yaml` for a version number that collided
across hosts (behavior locks prevent this), the size check would replace the
unpushed `raw` too.

#### Expression reads

The behavior map's `model.<name>.resource` and `model.<name>.file` and
`file.contents()` read the cache synchronously, so they cannot download
(swamp-club#3179). Before an expression is evaluated, the data namespace's
`prepare(expression)` makes their content local:

- `analyzeExpression()` reports, as `syncDataReads`, which behaviors the
  expression reads through those readers (by name or definition id, dot or
  bracket, through `cel.bind` aliases) and which of `resource` and `file` it
  reads. `model.<name>.execution` (run outputs) is not lazily hydrated and is
  left out.
- For each, the latest text resources (other content types are never read) or
  the files of the specs read are ensured, each read once per context.
- If the behavior's maps were already loaded empty by an earlier synchronous
  read, the items whose content changed are updated in place. Records a step
  merged in during the run were written locally, so they are never changed.
- A download error fails the evaluation, as it fails `data get`.

`CelEvaluator.evaluateAsync()` calls `prepare` before every expression. The
synchronous passes call it first too: the available-expression pass at step
execution (`execution_service.ts`) and `workflow evaluate`'s evaluation loop and
forEach expansion (`libswamp/workflows/evaluate.ts`).
`createWorkflowEvaluateDeps()` takes the repository context's hook, so `swamp
workflow evaluate` and serve's evaluate handler never save an empty value into
the evaluated workflow. `prepare` also resolves the definitions behind the
behavior names an expression passes to the data accessors (swamp-club#3029); in
a light context, which has no behavior map, that is all it does.

Not covered: a behavior named by a computed key (`model[self.name]`), and data
the behavior map finds by orphan recovery (`findAllGlobalSync`, data under other
coordinates tagged with the behavior's name).

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
- Core verifies a `true` result. If the path is inside the cache and no file
  is there, the wrapper logs a warning and rejects with
  `HydrateContractViolationError`, which names the datastore type, the
  cache-relative path it was given and the absolute path core read
  (swamp-club#2477). A datastore that hydrates to the wrong place therefore
  fails as a contract violation, not as a bare "No such file or directory".
  Paths outside the cache are not checked.
- Implementations MUST write atomically (tmp + rename) so concurrent readers
  never see a partial file.
- Implementations MUST replace a file that already exists at the path with
  the remote's copy: core hydrates a local `raw` that is shorter than its
  metadata records (see "Content-ensuring step"). One that skips existing
  files leaves the stale copy, which core then uses as the remote's short copy
  for `ACCEPTED_SHORT_CONTENT_TTL_MS`.

#### `getContentSync` limitation

`getContentSync()` is synchronous and cannot call the async `HydrateFileHook`.
Its callers:

- `data_record_mapper.ts` (`fromRow`): loads attributes/content for query
  predicates, `select` projections and results. A body shorter than the row's
  size that the repository has not accepted is reported as missing and not
  parsed, so the async query downloads it (swamp-club#3178).
- `model_resolver.ts` (`dataToRecord`): runs after `prepare` (the behavior map)
  or `ensureContentLocal()` (`data.latest()`).
- `data_query_service.ts` (`projectedContent`): the `querySync()` projection
  path, which cannot download.
- The composite and in-memory repositories, which delegate to it.

`integration/content_read_path_rules_test.ts` pins these callers and every
function that opens a content file by its path, so a new reader that skips the
content-ensuring step fails a test.

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

`querySync()`, behind CEL `data.query()` in a synchronous context, cannot
download. The `model_resolver.ts` path relies on `prepare` (see "Expression
reads"), not on the scoped pull, which covers only the step's own behavior.

`DataQueryService.getLatestRecord()`, the lookup behind `data.latest()`, checks
that a catalog row still has content before trusting it while the catalog is
unpopulated (every datastore sync invalidates it). The check uses the async
`getContent()`, so on a lazy-hydration datastore it downloads the `raw` file
instead of mistaking a metadata-only row for a stale one. A row whose content
is also absent remotely is still stale (swamp-club#2288). Before it maps the
row it returns, on every branch, it ensures the row's content with the row's
size, so its attributes are never read from a missing or stale body
(swamp-club#3179).

`DataRecord.path` from `data.latest()` / `data.version()` must name a present,
current file, so those lookups ensure the content with the record's size. If
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

> **Extension design.** This and the next three sections describe the
> `@swamp/s3-datastore` extension; none of it is implemented in this repo.

A metadata index (`.datastore-index.json`) tracks every file in the S3 bucket.
It is a JSON manifest mapping relative paths to size and last-modified time. It
is fetched once per command, with a short local cache TTL to avoid refetching
during rapid command sequences.

### Change Detection

> **Extension design** (`@swamp/s3-datastore`), not implemented in this repo.

Changes are detected by comparing `stat.size` and `stat.mtime`:

- **Pull**: downloads remote-index files that are missing locally or differ in
  size.
- **Push**: uploads cache files that are new or differ from the index in size or
  mtime.

There is no content hashing. The write paths (`atomicWriteTextFile`,
`Deno.writeFile`) always update mtime, so rewrites are detected even when size
is unchanged.

### Transfer Concurrency

> **Extension design** (`@swamp/s3-datastore`), not implemented in this repo.

Pull and push transfer files concurrently in bounded batches. Overlapping S3
round trips speeds up syncs with many files; the limit avoids overloading the
network or hitting S3 rate limits.

### Offline Operation

> **Extension design** (`@swamp/s3-datastore`), not implemented in this repo.
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
clear stale global locks seen while taking per-behavior locks (see "Lock
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

> **Extension design.** The S3 mechanism below is the
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

A new lockfile exists before its content is written, and a heartbeat that
rewrites the lockfile in place (an older swamp's, or the Windows fallback when a
rename is refused; otherwise the file is replaced whole, see "Hand-offs and
re-keying") leaves it briefly empty, so a reader can find a held lock's file
empty or partial. A lockfile that exists but cannot be read therefore counts as
held until its mtime is older than the TTL. `readLockFileState` in
`file_lock.ts` is the one definition of that rule: the acquire path backs off,
`inspect()` returns a placeholder `LockInfo` with an unknown holder and no
nonce, marked `holderUnknown`, and the structural drain (`waitForPerModelLocks`)
counts the lock as held. `swamp datastore lock release` does not call
`forceRelease` on a `holderUnknown` lock: it reports that the lock is being
written and to retry. `swamp datastore lock status` shows a global lock in that
state as locked without a PID or hostname; its per-behavior scan
(`scanModelLocks`) still skips an unreadable per-behavior lock file. Reading
such a file as no lock would let a writer and a structural command run at the
same time (swamp-club#3148).

With a `namespace` set, `datastoreGlobalLockOptions` returns
`{ lockKey: ".datastore.lock", namespace }`. `FileLock` and the remote lock
providers (S3, GCS) put the key under `{namespace}/`, at
`{datastorePath}/{namespace}/.datastore.lock`. Repos on different namespaces of
a shared datastore then never contend on structural commands, and IAM
credentials scoped to the namespace prefix can reach the lock. Only the lock
path changes; the lifecycle below is the same.

Per-behavior lock keys are namespaced too:
`{namespace}/data/{type}/{modelId}/.lock` with a namespace,
`data/{type}/{modelId}/.lock` without. The `modelLockKey()` helper in `lock.ts`
builds the key; `createModelLock` and `acquireModelLocks` read
`config.namespace` to pass it through. `parseModelLockKey` is unchanged: callers
strip the namespace from filesystem-relative paths with `stripNamespacePrefix()`
before parsing.

A workflow run's claim is a lock of its own:
`{namespace}/workflow-run-claims/{runId}/.lock`, built by `workflowRunLockKey()`
in `lock.ts` and created by `createWorkflowRunLock` in `repo_context.ts`. It
uses the per-behavior lock's retry settings, since it is held only for one load,
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
per-behavior retry settings, is named `.lock`, and sits outside `data/`. It is
taken before a per-behavior lock, never after. See "Tokens" in
`design/primitives/serve.md` for what takes it.

### Lock Timeouts and Retries

The default lock timeout is **60 seconds** (`DEFAULT_LOCK_TIMEOUT_MS`). That is
enough for most workloads, because per-step locking gives each method step
a fresh timeout.

`SWAMP_LOCK_TIMEOUT_MS` overrides it (`LOCK_TIMEOUT_ENV_VAR` in
`datastore_config.ts`). The first positive value wins:

1. Per-invocation override (internal; no CLI flag currently exposes it)
2. `SWAMP_LOCK_TIMEOUT_MS` env var (must parse as a positive integer)
3. `DEFAULT_LOCK_TIMEOUT_MS` (60,000 ms)

Invalid env values (non-numeric, zero, negative) are silently ignored.

Every lock creation site gets the resolved timeout: per-behavior locks
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

Per-behavior locks (`createModelLock`) start at 25 ms and cap at 250 ms. A
workflow step holds its behavior's lock for the whole method run, so concurrent
steps against one instance — `forEach` iterations, for example — queue on it.
Under the 1 second start a waiter slept through a release that came milliseconds
later. Under the 8 second cap the tail of a queue slept for seconds after each
release, so a 13-wide `forEach` of 0.2 s methods took 14 s instead of about 3 s
(swamp-club#2870). The cap keeps every waiter within a quarter second of the
holder letting go. The auto-definition create lock (`createAutoDefinitionLock`
in `direct_execution.ts`) starts at 25 ms for the same reason, so forEach
iterations that race to create one direct-type definition do not stall; it keeps
the default cap.

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

- **Per-behavior lock.** The key already holds the behavior type and id, so a
  namespace cannot help. The warning names the cause, concurrent runs (workflow
  steps, separate commands, serve) taking turns on one behavior instance's lock.
- **Global lock.** The warning suggests `swamp datastore namespace set` only
  when no namespace is set and another repo can reach the datastore
  (`isShareableDatastore`). Extension datastores always count as shareable.
  Filesystem datastores count as shareable unless they sit in the repo's own
  `.swamp` directory. With one repo on its own directory, the global lock
  stays silent.

A registration without `slowLockScope` logs no advice (swamp-club#2941).

**Progress lines.** Lock-wait and sync progress (`createLockProgressWriter`,
` system │ Waiting for …`) goes to stderr in log mode only, and `-q` silences
it. JSON mode has no console log output and a failing command's stderr must
stay one JSON document (see `design/surfaces/auth-gate.md`), so the writer
writes nothing there (swamp-club#3902).

### Lock Lifecycle

The sync coordinator (`datastore_sync_coordinator.ts`), a global singleton,
manages the lock lifecycle:

- `registerDatastoreSync({ service?, lock?, label?, syncTimeoutMs?,
  metadataOnly?, namespace?, slowLockScope? })`: take the lock, pull if S3.
- `flushDatastoreSync()`: push if S3, release the lock.

Per-behavior commands (`behavior run`) take only per-behavior locks, via
`acquireModelLocks`. They do not take the global lock, but `inspect()` it to
wait out any running structural command. That `inspect()` must target the
same namespaced global-lock key the structural command takes
(`datastoreGlobalLockOptions`). Otherwise, in namespaced mode, it would check a
different lock and the drain would silently do nothing. If it sees a stale
global lock, `acquireModelLocks` calls `forceRelease(expectedNonce)` to clear
it. Without that, the post-acquire TOCTOU re-check would find the same stale
lock on every pass and recurse forever.

A read or list run (`kind: "read"` or `"list"`, declared or inferred from the
method name) takes no lock while it runs, so a read never waits behind a
writer of the same behavior (swamp-club#1992). It still writes: an output
record, its method-summary report, and often a resource, as a `get` that
refreshes its resource does. `methodRunLockMode`
(`src/libswamp/models/method_run_lock_mode.ts`) picks how the CLI's
`behavior run` and both serve method-run handlers lock it (swamp-club#3934):

- On a filesystem or v3 datastore it takes no lock: a filesystem datastore has
  no push, and a v3 root commits through its commit log whatever the locks.
  Nor does it on a v2 extension datastore whose provider builds no sync
  service, which has nothing to pull or publish through.
- On a v2 extension datastore the model lock is the only path that pulls before
  a run and publishes what it wrote, and each clone numbers data versions from
  its own cache. So the run pulls the behavior without the lock first
  (`pullModelsUnlocked`), runs unlocked, and then tries to take the lock only to
  publish (`acquirePublishLocksOrDefer`). The pull never waits and never fails
  the run: while a structural command holds the global lock, while a run on this
  host holds the behavior's lock (it writes into the same cache, and a pull
  would overwrite its unpublished files with the datastore's older copies), or
  when the pull fails (an unreachable remote), the run uses this host's cache,
  and the publish check still refuses a version another clone wrote. A holder on
  another host does not share the cache, so the pull goes ahead. A global lock
  past its TTL is force-released, as a waiting run does, so a crashed structural
  command does not hold reads off.
- The publish never waits on a writer. `acquireModelLocks` with `failIfBusy`
  gives up at once while the global lock is held, and after
  `READ_PUBLISH_LOCK_WAIT_MS` (two seconds, one retry) while another run
  holds the per-model lock. Then the run records the versions it wrote
  beside the cache (`<cache>.pending-publish/`, one file per run, which no
  push walks), logs that the next run to lock the behavior on this host
  publishes them, and succeeds. A nested run whose parent holds the lock
  defers the same way, and the parent's push publishes its data.
- With the lock, the publish pulls the behavior, as a mutating run's lock does.
  The pull replaces with the datastore's copy every version another clone wrote
  under the same number while the run was unlocked, so a version whose local
  data id is no longer the one the run wrote was another clone's: it is not
  pushed, and the rest are. On a lazy cache its content is read back from the
  datastore over this host's copy, never removed: the run's write left it
  marked, and a push deletes the remote copy of a marked file missing here. If
  it cannot be read back, nothing is pushed, and the run's own such versions are
  recorded beside the deferred ones, so the next lock finds them replaced again
  and reads their content back before it pushes; a pull alone would not, since
  their metadata is already current. The push then throws
  `DataVersionConflictError` (`datastore_data_version_conflict`), which says
  this host now holds the datastore's copy. Because the cache holds what the
  datastore holds for the behavior under its lock, a push that walks a marked
  directory deletes and rolls back none of another clone's versions, whether or
  not the sync service can clear its marks. The conflict does not fail the run:
  the method's work is done and its other versions were published, unless
  publishing them failed too, which the conflict then carries and which decides
  the run as it would without the conflict. Every run writes a version of each
  built-in method-summary report, so failing would fail any read that overlaps
  another clone's run of the same behavior. The CLI logs it at warn and exits
  with the method's own status; serve, which has answered its client before it
  publishes, logs it at warn too.
- The CLI logs the publish and its locks under the `datastore.lock` category,
  not the run's own: without `--log` the run's category reaches only the run log
  file, and the publish runs after the method has finished writing it. In JSON
  mode, where no log reaches the console, a read or list run's result waits for
  its publish and lists what it left on this host in `unpublishedVersions`
  (`dataName`, `version`, and `reason`: `conflict`, `unauthorized`, or
  `deferred` while another run holds the lock); the field is absent when nothing
  was left.
- A refusal of the credentials (HTTP 401 or 403, an access-denied code, read by
  `isDatastoreAuthorizationError`), whether taking the publish lock, pulling
  under it or pushing, does not fail a read or list run either: read-only
  credentials never stopped a read before reads published. The CLI warns that
  the data stays on this host only, and records nothing for a later lock, which
  the same credentials would be refused again. Any other failure, such as an
  unreachable datastore, still fails the run, and a mutating run whose
  credentials are refused fails as before.
- Every push made under a behavior's lock with a repository context also
  publishes the versions earlier runs deferred for it, with the same
  data-id check, and removes their records once the datastore confirms
  them; a failed push keeps them. A deferred version another clone also
  wrote is dropped with a warning, and one the datastore does not confirm
  keeps its record for the next lock: neither fails the current run, whose
  own versions alone decide its outcome. A run's own version whose metadata
  cannot be read fails the publish rather than being left out. A version no
  longer on this host is dropped, and a record naming another behavior's
  versions too waits for a lock that holds them all.
- A run that wrote no data version takes no publish lock. When the CLI publish
  fails other than by a conflict, a refusal of the credentials or a busy lock
  (an unreachable remote), a run that succeeded fails with that error, or with
  `datastore_publish_failed` for an untyped one; a run that failed keeps its own
  error and logs that its data was not published.

Until it is published, a read run's data sits in the cache like any other
unpublished write. Another run's push from this host uploads it without the
check above: the S3 and GCS extensions push every marked path whatever the
push's model scope, and a full walk uploads any cache file the remote lacks
or holds differently, marked or not. A deferral lengthens that window, and
defers exactly when another clone is writing the behavior. Closing it needs
the extensions to make every remote write conditional on the copy this host
last synced; that work is tracked separately.

Workflow commands (`workflow run`, `workflow resume`) and serve-hosted workflow
runs do not lock up front. A `StepLockHook` callback injected into the
workflow engine takes per-behavior locks per step. Each method step takes its
lock before running and releases it in a finally block afterwards. This avoids
deadlock when a method starts a subprocess `swamp behavior run` on a
behavior the parent workflow would otherwise hold.

A run that lent its locks to a shell command or a dispatch takes them back
when that hop ends, before it writes: it re-keys each lock and waits for a
structural command still working under the old nonce (see "Hand-offs and
re-keying" under "Parent-Process Lock Awareness"). This is the one place a
lock holder waits on the global lock while holding a per-behavior lock.

Parallel steps on different behaviors lock independently. Parallel steps on the
same behavior serialize at the lock, which is correct since concurrent writes to
one behavior are unsafe. The coordinator gives each acquisition a unique key
(with a random ID suffix), so parallel steps on the same behavior do not
overwrite each other's entries.

Because per-behavior lock keys are namespace-scoped, `waitForPerModelLocks` uses
`stripNamespacePrefix` to match locks in the repo's namespace. The walk starts
at the datastore root and sees other namespaces' locks, but the prefix check
filters them out, so only this namespace's per-behavior locks are drained.

#### Symmetric Drain (structural commands)

Structural commands (`requireInitializedRepo`) take the global lock with a
**symmetric drain**: `waitForPerModelLocks` runs once before and once after
acquiring it.

1. **First drain (pre-acquire).** Wait for per-behavior locks visible at command
   start to be released. A writer past its own TOCTOU recheck (in
   `acquireModelLocks`) is committed to writing and must be allowed to finish.
2. **Acquire global lock.** From here, any writer that runs `inspect()` on the
   global lock sees it held and backs off.
3. **Second drain (post-acquire).** Wait for per-behavior locks that slipped
   past the first drain: writers that inspected the global lock between the
   first drain and the acquire, saw it free, and took a per-behavior lock.

The second drain closes the TOCTOU window on the other side. Without it, a
writer can:

1. Inspect global → not held (deleter has not yet acquired)
2. Take per-behavior lock
3. Pass its TOCTOU recheck → not held (deleter still has not acquired)
4. Begin writing a new version directory

…while the deleter finishes its first drain, takes the global lock, and runs
`Deno.remove(dataNameDir, { recursive: true })`. The recursive remove races the
writer's new version subdirectory and fails with ENOTEMPTY (Linux:
`os error 39`, macOS: `os error 66`), as in swamp-club#234.

The second drain also records, in the global lock's file, the nonces of the
locks it skips, and ends only on a scan that confirms the recorded list, so a
holder that takes one of them back waits for this command ("Hand-offs and
re-keying").

The second drain sees the writer's per-behavior lock and waits until the writer
commits or releases on its own recheck before structural work starts. The
writer's recheck runs right after it takes the per-behavior lock, before any
data I/O, so no window remains for it to write unseen by the second drain.

> **Maintainer note.** Both drain calls are required. The two sites cite each
> other (`src/cli/repo_context.ts:requireInitializedRepo` ↔ this section) so
> anyone removing one wait sees the contract first. If
> you change this lifecycle, update both.

Caveat: `waitForPerModelLocks` scans only the local filesystem. Custom (S3,
distributed) datastores rely on their own `DistributedLock` semantics instead.

#### Parent-Process Lock Awareness

A workflow shell step can run a nested `swamp` command (e.g.
`swamp extension push`) while the step's own per-behavior lock is held. If the
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
  pid from the first time it takes a per-behavior lock (`acquireModelLocks`).
  Until then it keeps the value it inherited, so through a swamp that takes
  no locks (e.g. a read-only `behavior run`) it still names the real lock
  holder.
- `SWAMP_LOCK_HOLDER_TOKENS`, set per spawn and never written to a swamp's
  own process env (a dispatch runner is started with one, below):
  comma-separated `<pid>:<nonce>+<nonce>` entries naming the per-behavior locks
  held for the run that started the child. A nonce is the one each lock file
  already records, and a listed nonce is what the child skips on. The pid
  says which swamp above the child an entry speaks for; a lock handed over a
  worker dispatch or a `--server` request (below) is listed under the pid
  that handed it on, which need not be its holder. The shell behavior
  adds `LockHolderMarker.childLockEnv()` to the child's env: the inherited
  entries plus one for its own pid. That entry lists the locks held by the
  `runHolding` scope (an `AsyncLocalStorage` scope) the spawn runs in, and is
  empty when that run holds none. Each locked execution runs in its scope: a
  workflow step's method (`execution_service.ts`, from `StepLockHook`'s
  `heldLockIds`; a hook that leaves them out runs the step outside any scope,
  so its children fall back to the pid match rather than wait on the step's
  own lock), and a CLI or `swamp serve` method run
  (`runUnderModelLocks`, `src/cli/repo_context.ts`). Scopes nest, so
  `runModel()` and other in-process nesting carry the outer run's locks.
  `integration/model_lock_scope_rules_test.ts` pins the model-run sites.

A run requested through `--server` crosses no process boundary to inherit
through. When a step runs `swamp behavior run --server` (or
`workflow run` / `workflow resume`), the requested run starts in a request
handler, outside the step's scope, so on its own it would tell its children
only about its own locks and they would wait on the step's (swamp-club#2982).
Instead the client sends the list it would hand a child
(`forwardedLockTokens()`) as `lockHolderTokens` in the `workflow.run`,
`model.method.run` and `workflow.resume` payloads (`src/cli/remote_run.ts`),
and serve runs each of those requests inside `runAdoptingForwardedLocks` at
its dispatch site in `src/serve/connection.ts`, under which the run's and its
steps' own scopes nest.

`LockHolderMarker.runAdopting` adopts every well-formed nonce in the list,
whichever pid its entry names (swamp-club#3096). The step holding the lock may
be a step of this serve, of a local `swamp workflow run` between serve and
the client, or of a swamp on another host sharing the datastore, so serve has
no way to check that the client holds what it names. With no usable nonce the
request runs as before. A list longer than `MAX_FORWARDED_LOCK_TOKENS_LENGTH`
(16,384 characters, also the schema's limit) is not sent, and that request
runs as before. Older clients send nothing and older servers drop the field.

That makes a lock nonce a bearer capability for as long as its lock is held:
whoever knows it can have a nested structural swamp skip that lock.

- A nonce is readable in its lock file, by anyone who can read the datastore,
  and in the env of every shell step command below the lock.
- A client cannot tell a loopback from a remote server, so the pids and
  nonces above it reach any server it runs against, and a dispatch carries
  them to the worker it lands on.
- Serve adopts a list from any client it lets request a run. It does not ask
  who the client is beyond that. A serve started with `--auth-mode none`
  authenticates nobody, so there anyone who can reach the port and knows a
  live nonce can have a nested structural swamp under a run they request skip
  that lock, and work on the datastore while the lock's run is still writing.
- A nonce stops working when its lock is released, since every acquisition
  writes a new one, and when the hop it was lent to ends, since the holder
  then re-keys the lock (see "Hand-offs and re-keying" below).

A detached request (`swamp workflow run --server --detach`, swamp-club#1090)
sends no list. Forwarding says the requested run stays under the step that holds
the locks, and a detached run outlives that step: with the list, a nested swamp
under it could skip a lock its step is still writing under. Without it the
detached run waits on that lock like any other run, until the step that
requested it ends. A step that detaches a run needing the step's own behavior
and then keeps working makes that run wait, and it fails with a lock timeout if
the step outlasts the wait; nothing is attached to see that except the run's
record.

Locally this gives a client no more than it has, since a shell method's
explicit env already overrides `SWAMP_LOCK_HOLDER_TOKENS` for its child. What
it adds is serve doing so on a client's behalf, which is accepted in exchange
for the cases ancestry cannot connect.

A process that adopts must name the locks of every step it runs inside the
adopted scope: a step whose hook leaves out `heldLockIds` would run in the
adopted scope rather than outside any, and its nested swamp would wait on the
step's own lock. Serve is the only adopter
(`integration/model_lock_scope_rules_test.ts`) and takes every step lock
through `createStepLockHook`, which names them
(`integration/serve_deps_rules_test.ts`, `src/serve/deps_test.ts`).

Before publishing, the marker captures what the process inherited.
`waitForPerModelLocks` skips a lock file whose `nonce` is listed in
`SWAMP_LOCK_HOLDER_TOKENS`, whatever its `pid` and `hostname`
(swamp-club#3096): a nonce is written only to its lock file and to the
hand-down, and a lock that is released and taken again, or re-keyed when the
hop it was lent to ends, gets a new one, so a listed nonce names a lock as it
was lent to this run. That is the only rule
that holds across a worker dispatch or a `--server` request, where the holder
is not above the child and may be on another host.

A lock whose nonce is not listed falls back to process ancestry. It is an
ancestor's when its `pid` is one of the inherited ancestors and its `hostname`
is this host. If that ancestor has an entry in `SWAMP_LOCK_HOLDER_TOKENS`, the
lock is held for another of its runs and is waited on. If it has none (it
started the child outside any scope, e.g. an extension using `Deno.Command`,
or is an older swamp), or the lock file has no nonce, the lock is skipped on
the pid alone, as before. A process on another host sharing the datastore
(e.g. over NFS) can carry the same pid, so its lock is waited on. A lock file
with no `hostname` is matched on pid alone. The hostname is read when the
drain runs. If the host is renamed after an ancestor took its lock (macOS can
rename on a network change), a lock matched on the pid no longer matches and
the child waits on it until `SWAMP_LOCK_TIMEOUT_MS`; a listed nonce is
unaffected. The drain never skips its own pid on the fallback, so a structural
command still waits on in-flight writes by other runs in its own process.

The skip is what avoids the deadlock: the run that started the child holds
its lock until the child exits. The nonce list narrows it from the process to
the run (swamp-club#2955). A nested swamp under one `swamp serve` run, or
under one of several parallel workflow steps, waits on the locks the same
process holds for its other runs instead of racing their in-flight writes.
When that wait times out, the `LockTimeoutError` names the locks held for an
ancestor's other runs and says why.

A step dispatched to a remote worker runs while the orchestrator holds its
lock, and a worker is not a descendant of the orchestrator, so ancestry alone
would leave a nested structural swamp on the worker waiting on its own step's
lock (swamp-club#2983). The dispatch carries the lock holder instead. When the
orchestrator builds the request for a remote step
(`method_execution_service.ts`), `LockHolderMarker.remoteLockHolder()` returns
the orchestrator's pid, its hostname and the nonces of every lock held for the
run: those of the `runHolding` scope the dispatch is made from, which includes
any a `--server` request adopted, and those the orchestrator itself inherited
(swamp-club#3096). A swamp started from a shell step therefore hands on what
it inherited with every dispatch it makes for as long as it runs, which is
what its own drain already assumes: the run that started it holds those locks
until it exits. Nothing is sent when there are none. It travels as the
optional `lockHolder` field of `DispatchParams`, which carries at most 256
nonces (`MAX_REMOTE_LOCK_IDS`). A worker refuses a dispatch naming more, so
for a longer list the orchestrator sends no holder and logs a warning; a
nested structural swamp under that step waits, as it did before the hand-off.

The worker passes the field to `withRemoteLockHolder` when it builds the
dispatch runner's env (`buildRunnerEnvironment`,
`src/worker/dispatch_handler.ts`). The nonces go into the runner's
`SWAMP_LOCK_HOLDER_TOKENS` under the orchestrator's pid, on any host. If the
hostname is the worker's own, the pid also goes at the front of the runner's
`SWAMP_LOCK_ANCESTOR_PIDS`, which is what an older swamp under the runner
matches on; a pid from another host means nothing there and is left out. The
runner and the shell behavior then hand both down as they would an inherited
chain. The pid is never added without its tokens entry, so the nested swamp
skips the locks held for the dispatched step's run and waits on every other
lock the orchestrator holds. The field arrives over the network: the dispatch
schema bounds it and `withRemoteLockHolder` checks the pid and nonces again,
dropping anything malformed. If the orchestrator releases the step's lock
while the runner's child is still running, the nonce matches no lock file and
nothing is skipped.

##### Hand-offs and re-keying

The skip assumes the holder waits on the nested swamp and writes nothing
until it exits. That stops being true the moment the hop the lock was lent to
ends with something still running under it: a shell command that returns
after leaving a swamp in the background or killing the `--server` client it
started, a dispatch that is cancelled before the worker has killed its
runner, a worker that is lost and whose step is dispatched again
(swamp-club#3111). The holder cannot confirm that what it started is dead. A
worker kills only the runner process, a partitioned worker confirms nothing,
and a run requested over `--server` is meant to outlive a dropped socket so
its client can reattach. So the holder acts on its own lock instead.

A **hand-off** is the period a run lends its locks to one hop. The shell
behavior begins one for its command (`LockHolderMarker.beginChildHandOff`) and
the dispatcher one for each dispatch attempt (`beginLockHandOff` on
`RemoteStepRequest`, bound to the run's scope by `MethodExecutionService`).
The hop is given the lock list through the hand-off and no other way
(`integration/model_lock_scope_rules_test.ts` pins the sites). Whoever begins
a hand-off awaits its end when the hop returns, however it returns, and
before the run writes anything.

Ending a hand-off **reclaims** the locks (`reclaimModelLocks`,
`src/cli/repo_context.ts`), in two steps:

1. **Re-key.** `FileLock.rekey()` replaces each lock file with one carrying a
   fresh nonce. A swamp left over from the hop still lists the retired nonce,
   which now matches no lock file, so its next drain waits on the lock like
   any other. A retry after a lost worker is a new hand-off and carries the
   new nonce.
2. **Wait out a structural command already at work.** One that skipped the
   lock before the re-key is past its drain and cannot be stopped by it. The
   drain a structural command runs under the global lock therefore records
   the nonces it skips in that lock's file (`LockInfo.skipping`, written by
   `FileLock.publishSkipping`). After re-keying, the holder reads the global
   lock; while it is live and its list names a retired nonce the holder
   waits, re-reading the list on every poll, up to `SWAMP_LOCK_TIMEOUT_MS`.
   A global lock whose process on this host has died is not waited on: a
   shell step's timeout kills its command's whole process tree, and the
   lock file a nested structural command leaves behind lasts until its ttl.
   At the timeout it throws `LockTimeoutError` and the run fails without
   writing.

A hop the cancel stopped does not wait in the reclaim (swamp-club#3157). The
shell behavior, when its command was killed by the cancel, and the dispatcher,
when its attempt failed, end the hand-off with the run's abort signal. The locks
are re-keyed as always, and if a structural command is still working once the
signal has aborted, the reclaim rejects with an `AbortError` instead of polling
on to the timeout. The step then writes nothing to the behavior and stays
cancelled: the shell behavior throws before its writes, and a cancelled dispatch
logs the failed reclaim and keeps its cancellation. A hop that finished before
the cancel has a result to write, so its hand-off ends with no signal and waits
in full. A cancelled run with no structural command at work reclaims as usual,
and a global lock file caught mid-write is read again rather than taken for a
command at work. The signal reaches only the reclaim of the scope the hand-off
was begun in. A scope around it is another run's, which may not be cancelled and
may still write, so its reclaim waits in full.

Two orderings make this sound. The drain publishes its list and then scans
again, ending only on a scan that matches what is already published; the
holder re-keys and then reads the list. Whichever comes second sees the
other. And a drain that finds a lock it had listed re-keyed takes the nonce
out of the list before it waits on that lock, so the drain and the holder
never wait on each other. A drain that skips nothing publishes nothing and
scans once, as before.

Scopes count their live hand-offs, including those begun in scopes nested
under them, and a scope reclaims only the locks its own run took, and only
when its count returns to zero. A lock is therefore never re-keyed under a
sibling hop that still skips it. A hand-off that begins while a reclaim is in
progress waits for it, so no hop is given a nonce about to be retired, and
fails if that reclaim failed. Nonces a process only passes on (inherited from
its parent, adopted from a `--server` client, sent on with a dispatch) are
never re-keyed by it: it does not hold those locks. Their holder re-keys them
when its own hop ends, and until then it is not writing.

Every rewrite of a held lock file, the heartbeat included, replaces it
through a temp file and a rename. A reader that catches a lock file partly
written takes the lock for absent, and the holder's one read of the global
lock must not land in such a window. `release()` waits for a rewrite already
under way, so a replace can never land on a lock another process took in
between. A reader that does catch a lock file mid-write, from an older swamp
or after the Windows fallback to an in-place rewrite, counts it as held
(swamp-club#3148); the holder's reclaim then reads the global lock again
rather than proceed.

Known limits of the run-level match:

- Two parallel steps or runs that each start a nested structural command
  (e.g. `swamp data gc`) wait on each other: each holds its step lock until
  its child exits. One of them fails within a few seconds instead of both
  failing at `SWAMP_LOCK_TIMEOUT_MS`; see "Drain-Wait Markers" below. Still
  run such commands one at a time or in a step of their own.
- Re-keying covers the locks a run took and lent through a hand-off. What it
  does not cover:
  - A dispatched runner's writes are carried out by the orchestrator, under
    the step's lock, while the dispatch is still live. A swamp that the
    runner's own shell command left in the background keeps skipping that
    lock until the dispatch ends, because the runner holds no lock to re-key
    when its command returns.
  - A lock skipped on the pid alone has no nonce list to fall out of: a step
    whose hook names no locks, a child an extension started with
    `Deno.Command`, an older parent.
  - An older nested swamp publishes no `skipping` list, so a holder cannot
    see it working and does not wait for it. An older holder never re-keys.
  - A structural command that outlasts `SWAMP_LOCK_TIMEOUT_MS` fails the run
    that waits on it, and delays a cancel by up to that long.
- A lock held for another run of a swamp that is not above the child (the
  orchestrator of a worker on another host, the caller of a `--server` run)
  is waited on like any unrelated lock. When that wait times out the error
  does not say whose lock it is; only locks of same-host ancestors are named.
- A run whose lineage holds more than 256 locks hands none of them to a
  worker (see above).
- A child left running in the background after its ancestors exit can skip a
  lock taken by an unrelated process that reused an ancestor's pid on this
  host, when that ancestor named no locks. A listed nonce cannot be reused.

Keeping either value for the rest of the process's life is equivalent to
keeping it while holding locks, because a lock file carrying a pid exists only
while that process holds it. Setting the holder on acquire and clearing it on
flush is
not safe: per-step workflow locks and concurrent `swamp serve` runs hold locks
side by side in one process, and the first flush would clear the marker while
the others still held theirs (swamp-club#2659). The ancestor chain keeps a
nested swamp working when a swamp between it and the lock holder takes no
locks itself, such as a read-only `behavior run`.

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

- Re-keying (swamp-club#3111) needs both ends. A holder that predates it
  keeps its nonce for the whole hold, and a nested swamp of any version skips
  it as before. A structural command that predates it lists nothing in the
  global lock, so a newer holder re-keys and proceeds without waiting. Readers
  that predate `skipping` ignore the field. No case waits where it did not
  before.
- A worker that predates `lockHolder` ignores the field, and an orchestrator
  that predates it never sends it. A nested swamp on that worker waits on its
  step's lock, as before.
- The nonce-only skip (swamp-club#3096) takes effect only when the nested
  swamp itself has it. An older nested swamp still requires the lock's pid to
  be an ancestor's on its host, so it waits on a lock handed over from
  another host or from a swamp that is not above it, as before. An older
  worker applies a `lockHolder` only from its own host, and attributes any
  inherited nonces in it to the orchestrator's pid, which match nothing. An
  older serve adopts only the nonces it holds itself. No case waits where it
  did not before.

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

- `skipping`: the live locks the drain skips because they are named in
  `SWAMP_LOCK_HOLDER_TOKENS`, whichever process holds them, which are held
  until this drain's process exits. A lock skipped on the pid alone is left
  out: it may be held for another run and released first, so it proves no
  cycle;
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
swamp datastore lock status            # Show who holds the lock
swamp datastore lock release --force   # Delete the global lock directly
swamp datastore lock release --force --behavior type/id
                                       # Release one behavior lock
```

`--model` is the alias of `--behavior` (swamp-club#3410).

`--force` is required. Release bypasses `acquire()`/`release()` and deletes the
lock directly, for when a crashed process left a lock that has not expired.

A run may still be working under a behavior lock that was force-released. On
S3 and GCS, each clone allocates the next data version from its own cache. The
run that takes the lock next can therefore write the same version, and the old
holder's push would overwrite it. `acquireModelLocks` reads each per-model lock
with `inspect()` just after taking it, and again before each push. If the lock
is then gone, being written, or names a different holder, hostname, pid or nonce
than it did when taken, the push is refused and the run fails with
`ModelLockLostError` (`model_lock_lost`), so nothing is pushed
(swamp-club#3373). The second reading is compared with the first, not with this
process's identity, because extension locks write their own holder formats
(some a pid of 0, some a random suffix). The nonce tells apart two holds by one
process, as in serve; every extension lock keeps its nonce for a whole hold. A
lock that read nothing when taken is not checked. The refused versions stay
marked dirty, so a later push (a workflow's end-of-run push, serve's sync, a
`datastore sync`) would upload them, over the other run's after a breakglass.
A refusal therefore discards them before it throws (swamp-club#3485): each is
deleted from the cache, which moves its name's latest marker back. Core cannot
unmark a dirty path, and the extensions push a marked file that is gone locally
as a remote delete, which after a breakglass would delete the other run's
version of the same number. So each removed file, and the latest marker, is put
back as the datastore holds it, read with `fetchContent` under one 10-second
budget; a file the datastore lacks stays removed, and the first failed read ends
the restore. The lost models are then pulled, best effort, so the cache holds
the datastore's copy. A run refused while its datastore is unreachable leaves
its data on no clone. A breakglass followed by an outage before the restore,
or a sync service without `fetchContent`, can still leave a removed file that a
push-only sync turns into a delete of the other run's copy; a sync that pulls
first does not. Once the restore matched the datastore, the discard also drops
the marks the refused writes left with `clearDirty` (swamp-club#4091), so a
later push neither deletes the other run's versions under the marked data-name
directory nor uploads a stale `latest` marker; without `clearDirty` those marks
stay. A command whose own work succeeded fails with the
refusal (`runCommandInRootUnit`) rather than logging it as a push warning. A filesystem datastore has no
push and is unchanged, and v3 fences its own writer. The check and the upload
are not atomic, and the other run can push after that pull and before the
command's end-of-run push: inside either window a write can still be lost. Phase 5's model leases, or create-only writes of version keys in the
datastore extensions, close it.

### Other maintenance commands

- `swamp datastore type search`: search the registry for datastore extension
  types (`src/cli/commands/datastore_type_search.ts`).
- `swamp datastore compact`: checkpoint the WAL and vacuum `_catalog.db`
  (`datastore_compact.ts`).
- `swamp datastore claim --address <url>` and `swamp datastore release`: make
  serve a v3 datastore's owner, so direct writers refuse, and remove the
  claim (`datastore_claim.ts`, `datastore_release.ts`). See "Team mode:
  claiming a datastore".
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
  chicken-and-egg" below. Migrate pulls the `config/` tier before checking the
  migration sentinel, so a cache that predates another repo's migration sees
  it (swamp-club#2621). It pushes the migrated files at the root's checkpoint,
  then writes the sentinel and pushes it as the flush, so the datastore's
  sentinel means the migration is published; after either push fails, a
  re-run publishes it (swamp-club#3117).
- `swamp doctor datastores [--repair [-y]]`: health check with optional repair
  of catalog completeness, unmigrated root-level data, cache files the remote
  never received, and foreign namespace contamination (the last two via the
  optional `repairUnpushedFiles?()` and `repairNamespaceContamination?()` on
  `DatastoreSyncService`) (`src/cli/commands/doctor_datastores.ts`). The
  unpushed files stage (swamp-club#4112) runs just before contamination repair,
  whose wipe and re-pull of the namespace cache would destroy files the remote
  lacks. With `-y` it takes the datastore global lock (`datastoreGlobalLock`,
  with no repository context) and holds it through contamination repair, and
  no longer; a failed release warns, since the lock expires after its TTL, and
  an interrupt mid-stage likewise leaves the lock until then. Contamination
  repair checks before it changes anything, from a fresh exact dry run under
  that lock, which does not drain writers already running: a per-model run can
  still write to the cache after the check, as it could before. It refuses with
  `repair_refused` when anything is unpushed, already
  present, locally modified or unknown, or a push is pending; when that check
  fails; when the unpushed stage did not pass; and when the extension lacks the
  method. For `@swamp/s3-datastore` and `@swamp/gcs-datastore` that message names
  `UNPUSHED_REPAIR_MIN_EXTENSION_VERSION` and the `swamp extension update`
  command; any other extension is told it does not implement the method. A stale
  copy (`remoteMovedOn`) does not block, since wiping and re-pulling it is right.
  Nor does a copy a peer deleted (`peerDeleted`): older releases left many behind,
  so blocking would stall the repair. The stage's output names them and says the
  wipe removes them. A file still `unpushed` after a real repair is one the
  extension cannot index, which repeating the repair does not clear, so the output
  says to copy it out and remove it. A file a peer deleted before the extension kept
  its peer-deleted record cannot be told from a stranded one, so it reads as
  unpushed and uploading it restores it; the advisory and preview warn of this.
  The contamination stage's detection, delete and pull are bounded by the sync
  timeout, since they run under the lock. If the bounded re-pull fails, the stage
  still invalidates the workflow run indexes and catalog, because a re-run then
  finds nothing to repair. A failed dry run in a preview is reported, as with a cache
  that never pulled, the contamination preview still shows, and the command exits 1. Plain `doctor
  datastores` adds an advisory `unpushedFilesFinding` (never a failure) from a
  size-and-mtime dry run, costing one remote index read and cache walk, like the
  contamination check. On v3 it
  adds the `v3_content` check, and `--repair` restores a lost format marker
  (swamp-club#3617; "v3 opt-in" and "Format Marker"). With `--json` the v2
  repair prints one document keyed by stage (`unmigrated`, `unreadableVersions`,
  `catalog`, `duplicateLatest`, `unpushed`, `contamination`), each the stage's
  result object or null when it did not run, plus `warnings` when something about
  the run itself went wrong, such as a failed lock release, since the logger is
  silent under `--json`. `unpushed_skipped` tells a stage that was skipped from
  one that does not apply, which stays null. The stage renderers record into a
  `DatastoreRepairJsonReport` that the command prints once, also when a stage
  throws (swamp-club#4011). The
  completeness check walks the data dir every command reads
  (`resolvePath("data")`: the external path or the cache), not the repo's own
  `.swamp/data`, which holds only the catalog when the datastore lives
  elsewhere (swamp-club#3238).

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
2. Migrates existing runtime data from the current datastore to the new
   location (skipped with `--skip-migration`). The source is the current
   datastore's data: the outgoing extension datastore's cache, the root of a
   filesystem datastore outside the repo (`externalFilesystemDatastoreRoot`),
   or `.swamp/` (swamp-club#3238). A filesystem datastore root that is missing,
   or that holds none of the datastore subdirs (an unmounted mount point),
   stops setup before anything moves or `.swamp.yaml` changes; it is never
   replaced by `.swamp/`. The exception is a fresh namespace start
   (swamp-club#3301): `namespace set` before any setup points the current
   datastore at the repo's own `.swamp/<namespace>`, which holds only its
   `.namespace.json` or nothing. That root is not a mount point, so setup takes
   it as nothing to move rather than as inaccessible, provided `.swamp/` holds
   no un-namespaced records (the stream directories, the catalog and the
   instance-local config aside); otherwise it refuses and points at `namespace
   migrate --confirm`. Every setup keeps the namespace: v2 filesystem setup
   creates the datastore subdirs under `{path}/{namespace}` and registers the
   namespace there, refusing one another repo registered; extension setup
   skips only the copy into the cache. The namespace is kept with or without
   `--skip-migration`. A v2 namespaced datastore that holds
   data still moves to the new root without its namespace, as before. A
   destination whose real path is the migration
   source (for example `--path .swamp` on a repo already there) has nothing to
   move: setup skips the copy, the verification and the cleanup, and only
   writes the datastore block (swamp-club#3162). A destination inside one of
   the source's migrated subdirs is refused, since the copy would recurse into
   it. The catalog (`data/_catalog.db` and its sidecars, `CATALOG_FILES`) is a
   local index and is never copied. Neither are the stream directories
   (`REPO_LOCAL_STREAM_SUBDIRS`: `audit`, `telemetry`, `logs`, `files`) or the
   run logs (`.log` files under `outputs/` and `workflow-runs/`): their
   writers and readers only use the checkout's own `.swamp`, so setup leaves
   them there and the cleanup in step 5 keeps them (swamp-club#3281). The
   verification checks that every source
   file arrived (regular files with the same size, symlinks by existence), so
   local files a `.swamp/` destination already holds, such as method-run logs,
   do not fail it.
   Data moved from a filesystem datastore outside the repo is copied, never
   cleaned up from the old path, whatever the destination: other repositories
   may share that path, and deleting it would take their data too. The
   completed result then carries `sourceKept: true`, and log mode prints
   "Copied from" instead of "Moved from".
3. Pushes migrated data to the remote (extension datastores; skipped with
   `--skip-migration` or when there is nothing to push). The copy writes into
   the cache behind the sync service, so setup first calls `markDirty()` with
   no path. Otherwise a cache that an earlier setup or pull left clean (a
   committed `repoId` maps every clone to the same cache) takes the zero-diff
   fast path, and the push uploads none of the copied files
   (swamp-club#4100).
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

   Once `.swamp.yaml` names a different datastore, setup removes the local
   catalog so the next command rebuilds it from the new datastore. A kept
   catalog would miss whatever the new datastore already held
   (swamp-club#3238).

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

  On an extension setup, the remote may already hold a config tier, for example
  when a second repo joins a shared datastore that was migrated already. Before
  anything is copied, setup pulls the remote `config/` into the cache
  (`subdirs: ["config"]`, the namespace, and `metadataOnly` under lazy
  hydration) within the setup sync timeout (swamp-club#2844). If that pull
  fails, timeout included, setup stops: nothing is copied, pushed or cleaned
  up, and `.swamp.yaml` is not rewritten. This has to cover timeouts, because
  committing the new datastore without migrating would make a retry classify
  the tier as instance-local. `listConfigTierConflicts` then lists the local
  tier files, other than pulled extensions, that already exist in the cache,
  and `planConfigTierMerge` (`src/domain/datastore/datastore_config.ts`)
  applies the rule that the remote copy wins:
  - No clashing file is copied, so none is pushed.
  - A clashing local copy that differs stays in `.swamp/config`.
  - An identical copy is cleaned up as usual.
  - The migration sentinel always differs, so it is never kept or reported.
  - Local-only files migrate.

  The differing paths are listed in a `remote_config_tier_kept` warning, which
  appears in `warnings` in JSON output. An extension that ignores `subdirs`
  pulls everything at this point. That is still correct, only slower.

  The comparison is against the cache, so a retry after a push that failed
  can find every config file already there and copy nothing. Setup still
  pushes and cleans up in that case. Two more cases count as differing: a
  local directory where the cache has a file, and a file that cannot be read.
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
| `src/domain/datastore/datastore_format.ts` | Format marker parsing and the supported-format check; lost-marker advice and `LostDatastoreFormatMarkerError` (swamp-club#3617) |
| `src/domain/datastore/datastore_storage.ts` | `storage/1` and its optional capabilities: `TempFileSweeper`, `ChunkStatReader`, `ChunkStaging`, `ChunkDirectorySync`, `ChunkQuarantine` |
| `src/domain/datastore_v3/chunk_store.ts` | `ChunkStore`: size-aware presence, `syncStored`, `ChunkBatch` (one chunk barrier per commit group), and `refOf`/`putParts`/`verifyParts` for the checkout-copy guard |
| `src/domain/datastore_v3/chunk_collector.ts` | Chunk GC: sweep, restore, and the verify pass that moves damaged chunks aside |
| `src/domain/datastore_v3/read_model.ts` | `ReadModel` port, `UnreadableRecord`, `UnreadableRecordError`, `CheckoutCopyAtRiskError` |
| `src/domain/datastore_v3/partition_key.ts` | v3 `PartitionKey` and `partitionOf()`, the only way to build a key |
| `src/domain/datastore_v3/writer_lease.ts` | The fenced writer lease over create-only control-plane records (swamp-club#3359) |
| `src/domain/datastore_v3/record_key.ts` | v3 `RecordKey`: the cache-layout path an op projects to |
| `src/domain/datastore_v3/blob_ref.ts` | v3 `BlobRef`: content stored as a chunk |
| `src/domain/datastore_v3/intent.ts` | v3 typed intents and `intentPartition()` |
| `src/domain/datastore_v3/op.ts` | v3 ops (`put`, `tombstone`, `data-version`, `lease`) and their factories |
| `src/domain/datastore_v3/commit.ts` | v3 `Commit` envelope |
| `src/domain/datastore_v3/partition.ts` | v3 `Partition` aggregate, its commit rules, and its snapshot and restore |
| `src/domain/datastore_v3/commit_store.ts` | v3 `CommitStore` port and `CommitStoreCorruptError` |
| `src/domain/datastore_v3/identity_factories.ts` | Identity factories for runs, auto-definitions and outputs |
| `src/domain/datastore_v3/commit_log_unit_of_work.ts` | v3 `CommitLogUnitOfWork`, `TypedChange` and `ContentSource` ports |
| `src/domain/datastore/unit_of_work.ts` | `UnitOfWork`, `StagedChange` and the `UnitOfWorkBinding` port |
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
| `src/infrastructure/persistence/datastore_format_marker_reader.ts` | Reads the format marker without writing |
| `src/infrastructure/persistence/datastore_format_guard.ts` | `ensureSupportedDatastoreFormat`: read, check, debug log; `lostDatastoreFormatMarker` |
| `src/infrastructure/persistence/datastore_format_marker_writer.ts` | Durable format marker writes |
| `src/infrastructure/persistence/fs_datastore_storage.ts` | `FileSystemStorage`: staged chunks synced before their renames, chunk stats, the directory barrier and its durable-chunk memo, the macOS ordering barrier and its per-device fallback, quarantine |
| `src/infrastructure/persistence/barrier_sync.ts` | `barrierSync`: macOS `F_BARRIERFSYNC` through libc over FFI |
| `src/infrastructure/persistence/ordered_sync.ts` | The v2 write-sync policy: `fullWriteSync`, `orderedWriteSync` and its per-device fallback, `selectDurableWriteSync` |
| `src/infrastructure/persistence/sync_directory.ts` | `syncDirectory`: directory fsync shared by the read model and chunk storage |
| `src/infrastructure/datastore_v3/v3_datastore.ts` | `openV3Datastore`, `initializeV3Datastore`, `isFreshV3Skeleton`, `restoreV3FormatMarker` |
| `src/infrastructure/datastore_v3/sqlite_read_model.ts` | `SqliteReadModel`: catch-ups, the reboot check, the checkout-copy guard, at-risk copies, unreadable records |
| `src/infrastructure/datastore_v3/read_model_state.ts` | `_read_model_v3.db`: the read model's state, `unreadable_records`, `at_risk_copies`, `written_files` |
| `src/infrastructure/datastore_v3/unreadable_content_lookup.ts` | The v3 `UnreadableContentLookup` behind loud reads |
| `src/infrastructure/persistence/unreadable_records.ts` | Loud reads in the repositories: `unreadableRecordsUnder`, `warnUnreadableLeftOut` (one warning per listing), `mayBeUnreadableError` |
| `src/infrastructure/datastore_v3/v3_content_inspection.ts` | `inspectV3Content`: the read-only `v3_content` doctor check |
| `src/infrastructure/datastore_v3/interrupted_writer_recovery.ts` | The writer marker (written durably) and the interrupted-writer recovery |
| `src/infrastructure/datastore_v3/sqlite_commit_store.ts` | v3 `SqliteCommitStore`: `commits.db` over `node:sqlite` (dormant) |
| `src/infrastructure/persistence/unit_of_work_binding.ts` | The unit-of-work binding registry `signalChange` routes by |
| `src/infrastructure/datastore_v3/commit_log_unit_of_work.ts` | v3 commit-log unit of work and its `CommitSink` outbox seam |
| `src/domain/datastore_v3/commit_outbox.ts` | The commit outbox's rules: entries, the fence chain, the recovery plan, the retry bound (swamp-club#3490) |
| `src/infrastructure/datastore_v3/sqlite_commit_outbox.ts` | `SqliteCommitOutbox`: `commits-outbox.db` beside the commit store |
| `src/infrastructure/datastore_v3/outbox_commit_sink.ts` | A v3 handle's commit sink: the fenced append with the outbox |
| `src/infrastructure/datastore_v3/commit_outbox_recovery.ts` | `recoverCommitOutbox`: lands, settles or drops a dead writer's entries |
| `src/infrastructure/datastore_v3/commit_log_root.ts` | `runInCommitLogRoot` and the run-outcome disposition (dormant) |
| `src/infrastructure/datastore_v3/v3_writer_lock.ts` | The process's hold on a v3 datastore's fenced writer lease: refcount, renewal, busy and fenced errors (swamp-club#3359) |

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
| `src/cli/commands/datastore_claim.ts` | `swamp datastore claim` (direct or through serve) |
| `src/cli/commands/datastore_release.ts` | `swamp datastore release` (direct or through serve) |
| `src/cli/commands/doctor_datastores.ts` | `swamp doctor datastores` |
| `src/presentation/renderers/datastore_status.ts` | `swamp datastore status` rendering |
| `src/presentation/renderers/datastore_sync.ts` | `swamp datastore sync` rendering |
| `src/presentation/renderers/datastore_lock.ts` | `swamp datastore lock` rendering |
| `src/presentation/renderers/datastore_setup.ts` | `swamp datastore setup` rendering |
| `src/presentation/renderers/datastore_compact.ts` | `swamp datastore compact` rendering |
| `src/presentation/renderers/datastore_claim.ts` | `swamp datastore claim` rendering |
| `src/presentation/renderers/datastore_release.ts` | `swamp datastore release` rendering |
| `src/presentation/renderers/datastore_migrate_index.ts` | `swamp datastore migrate-index` rendering |
| `src/presentation/renderers/datastore_namespace_set.ts` | `swamp datastore namespace set` rendering |
| `src/presentation/renderers/datastore_namespace_unset.ts` | `swamp datastore namespace unset` rendering |
| `src/presentation/renderers/datastore_namespace_migrate.ts` | `swamp datastore namespace migrate` rendering |
| `src/presentation/renderers/datastore_namespace_list.ts` | `swamp datastore namespace list` rendering |

## Managed Config Deployment Architecture

With `managedConfig: true` in `.swamp.yaml`, behavior definitions, workflow
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
| Behavior definition create/edit | `config/models/` | `runManagedConfigMutation` (bare mark staged through the root, root pushes) | `ctx.syncService.pushChanged` |
| Behavior definition delete | `config/models/` | Per-behavior lock push as its root unit's flush, through `reportManagedConfigCleanupError` | Via per-behavior lock flush |
| Workflow definition create/edit | `config/workflows/` | `runManagedConfigMutation` (bare mark staged through the root, root pushes) | `ctx.syncService.pushChanged` |
| Vault config create/migrate | `config/vaults/` | `runManagedConfigMutation` (bare mark staged through the root, root pushes) | `ctx.syncService.pushChanged` after marking the config file (and, for migrate, the old one) |
| Extension pull/install/rm/update | `config/upstream_extensions.json` (sources stay in the repo's pulled root until swamp-club#2612) | Managed lockfile transaction: fetch, change and publish exactly the lockfile at its root's checkpoint under the global lock; none when the datastore-extension exemption records into the in-repo lockfile | Managed lockfile transaction, inside the handler's exclusive sync gate, publishing at the checkpoint of the root it opens for each run; a failed publish is logged and left pending |
| Search install, `repo upgrade`, `doctor extensions --repair` | `config/upstream_extensions.json` | Managed lockfile transaction | — |
| Auto-definitions (direct type execution) | `.swamp/auto-definitions/` (datastore subdir, not config tier) | Via flush coordinator | Via per-behavior lock flush |

A CLI config write whose push fails, or times out, exits non-zero with
`ManagedConfigUnpublishedError` (code `managed_config_unpublished`). A deferred
helper that cannot resolve the datastore after the write fails the same way,
as does a lockfile that cannot be read after the command. The local write is
kept, never rolled back, and the error names `swamp datastore sync --push` as
the retry. `behavior delete` fails this way only when its lock flush fails after
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
   config into the datastore tier and pushes; later boots the datastore's
   sentinel, pulled before the check, skips the copy, and a re-run after a
   failed push publishes the migration. Either way it sets
   `managedConfig: true` in `.swamp.yaml` if missing, so a repo joining an
   already-migrated datastore is configured too.
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
Only a lockfile change triggers it. Definition-only changes (behavior, vault or
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
