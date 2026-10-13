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
  directories. Anything unlisted stays in local `.swamp/`. Nothing writes
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

#### Reserved namespace names

Because a namespace is the outermost segment, one named after a layout directory
(`data`, `outputs`, ...) is the same directory as the solo layout's
`{base}/{subdir}/`. `RESERVED_NAMESPACE_NAMES` in `src/domain/data/namespace.ts`
is derived from `DEFAULT_DATASTORE_SUBDIRS` and `ALWAYS_LOCAL_SUBDIRS`, so a
directory added to the layout is reserved with it.

- **Claiming** a name goes through `createNamespace`, which rejects a reserved
  name. `namespace set` also rejects a name equal to one of the repo's
  configured `datastore.directories`.
- **Loading** a name already in `.swamp.yaml` goes through `restoreNamespace`,
  which does not apply the reserved rule. A repo bound to such a name before it
  was reserved, or by hand, still loads.
- For a repo loaded with a colliding name, `namespace migrate` (both
  directions), `namespace unset --migrate` and the doctor un-migrated data
  repair refuse before touching anything, and `swamp doctor datastores` reports
  a failing `reserved_namespace` check. They cannot tell the namespace directory
  from solo data. `doctor datastores --repair` skips only the un-migrated data
  repair and still runs the others. The way out is a move by hand, described in
  the swamp skill's namespaces reference.
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
from the definition. So `delete` throws `Model not found`, and `gc` only applies
each item's frozen `lifetime`/`garbageCollection` policy, never collecting
`infinite`-lifetime orphans. The rows pile up, growing the index and the sync
cost of every write.

`swamp data prune` reclaims them. It walks the data root (`findAllGlobal`),
groups by `(type, modelId)`, and checks whether each group's definition still
exists. The check uses the definition repository's `findById`, which searches
both `models/` and `.swamp/auto-definitions/`, like `swamp model get`. So
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
into `<namespace>/_control/` on a namespaced push when a namespaced v2 index
already exists (`migrateRootControlPlaneToNamespace`). A guarded binary
refuses before it pushes, but a binary older than the guard does not, so a
writer of the marker must leave no v2 namespaced index behind.

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

- In serve, the run lanes keep a run pull out of every run push, so a pull
  can no longer revert a marker, locally or on the remote, after a push
  verified it. Two processes sharing one cache (a CLI next to serve) are not
  covered: there a pull can still do both.
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
- **txnId**: the outbox entry id a commit carries. A retry carries the same
  one, so the commit lands once.
- **High-water mark**: the greatest version a data name ever had. It never
  decreases. It is not a floor for new versions: a new version only has to be
  not live (swamp-club#3250).

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
- **Fences never go down.** A commit, or a lease op, whose fence is below the
  partition's highest is refused (`stale-fence`). Once a partition has seen a
  fence, a commit without one is refused too (`unfenced`), so a writer cannot
  slip past fencing by leaving it out. Every v3 writer holds a fence: the
  solo writer lock at `_control/writer` carries it in solo mode, and the
  leader lease in team mode (swamp-club#3234,
  `design/enablers/datastore-litestream.md`). Only a partition that has never
  seen a fence accepts an unfenced commit.
- **`expect` must hold.**
  - `put` with `expect: "absent"` creates only.
  - `put` with `expect: { sha256 }` edits the version it was loaded from.
  - `tombstone` with `expect: "present"` removes only a record that exists.
  - Ops in one commit see each other's effects in order.
- **A live data version is recorded once** (swamp-club#3250; it replaced "data
  versions only grow" from swamp-club#3233).
  - A `data-version` op's version must not be live for its name, or the
    commit is refused with `version-live`. A version removed earlier may be
    recorded again, and versions may arrive out of order. This is v2 parity:
    the filesystem allocates `max(existing) + 1`, so a save after deleting a
    whole name or its top version reuses the number. Parallel writers of one
    name, and deferred promotions, also finish out of order. Two writers
    claiming the same live version are still refused.
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
6. **Checkpoints.** `checkpoint()` commits each partition touched so far, in
   the order of decision 7, and keeps the unit open. Later changes to the
   same partitions go into later commits.
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
- **Version numbers follow v2's allocation** (swamp-club#3250). swamp-club#3233
  decided versions are never reused and called that harmless for a new, empty
  v3 datastore. It is not: within one datastore a save after
  `delete(name)` (and `data prune`) or after a top-version delete reuses the
  number, a rename marker can too, and a deferred version promoted after a
  higher one committed arrives below it. Each would have been refused and
  dropped its partition's whole group. v3 therefore accepts any version not
  live. The cost is v2's: a run record that names `name@version` can point
  at the content of a later save that reused the number, and in team mode a
  writer behind on catch-up can re-create a deleted version number. The
  high-water mark stays the greatest version seen.
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
- **Authorisation requirements for the serve wiring.** Serve will authorise
  each op on its intent, and the model leaves four bindings to that issue. Each
  needs the per-repository audit of what every write stages, so none is
  enforced yet:
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
`ChunkMissingError`. A consumer keeps what a read yields only once the read
ends cleanly.

**Damaged chunks are not repaired by writes.** A write trusts `has`: a chunk
that is present is refreshed, not uploaded again, so one damaged in place after
its put (a crash that leaves a file of the right length but wrong bytes) stays
damaged, and every read of it fails. A `put` always replaces the chunk, so
deleting it, or putting it again, repairs it. Chunk garbage collection finds
and deletes damaged chunks, since it already walks every chunk.

**For extension authors.** `FileSystemStorage`
(`src/infrastructure/persistence/fs_datastore_storage.ts`) is the reference
implementation. It writes a temp file and renames it into place, validates the
namespace and hash before building any path, and uses mtime as
`lastModified`. `assertStorageConformance` in `@swamp-club/swamp-testing`
checks an implementation. `createInMemoryRemote({ storage: true })` provides a
conforming in-memory one. The S3 and GCS implementations are a later
swamp-extensions change.

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
3. writes the commit row, the head row (its fence read from the partition,
   since a lease op raises it too) and, on every 1,000th commit, a snapshot.

A refusal rolls back and leaves the rebuilt partition unchanged. Any other
failure rolls back and drops the rebuilt partition, which may be ahead of the
file. Because the append is synchronous, it blocks the event loop for its
`fsync`. That matters once serve writes through the store (Phase 5).

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
  number of cached partitions is bounded. A cached partition still collects
  the txnIds of every commit applied since its snapshot, so a very busy
  partition cached for a long time grows. Phase 5 should bound that, for
  example by re-restoring a partition from its newest snapshot.
- **Head check.** A cached partition whose seq differs from the head row was
  overtaken by another connection. The store drops it, rebuilds and retries
  once. A second writer is a bug the Phase 4 writer lock prevents, but the
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
- SQLite's default auto-checkpoint, and never a forced checkpoint. Litestream
  replicates the WAL, and `catalog_store.ts`'s `wal_checkpoint(TRUNCATE)` made
  the replica 11 times larger (`datastore-litestream.md`). A fitness rule
  refuses `wal_checkpoint` and `wal_autocheckpoint` in v3 code.
- One connection per store, and one writing process per file.

**One `commits.db` per datastore.** Namespaces share one database, keyed by a
`namespace` column, rather than one database each.

- The Litestream record puts the replica beside `_control/` at
  `_litestream/<fence>/`, and the solo writer lock at `_control/writer`
  carries one fence per datastore. One database matches one fence and one
  sidecar.
- Serve handles several namespaces with one connection and one sidecar, not
  one of each per namespace.
- Failover restores one database.
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

- **No atomicity across partitions.** When a partition fails, the partitions
  before it stay committed and the ones after it are not tried. A refusal is
  the exception: the flush goes on past it (below).
- **Pending groups.** A partition whose commit failed stays pending with its
  txnId. The unit's next `checkpoint`, or its `commit`, rebuilds it at the
  current head with the same txnId, so a commit that had landed is reported
  `duplicate` and lands once. `commit` ends the unit whether or not it
  succeeds (the `UnitOfWork` contract), so what is still pending when the
  unit's own commit fails is lost with it until the Phase 4 outbox makes it
  durable; a caller that must retry checkpoints first.
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
(`append` and `head`). Phase 3 passes the local `CommitStore`; Phase 4 passes
the outbox, which makes pending groups durable across a crash.

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
discarded. `withUnitOfWork` (`src/libswamp/unit_of_work.ts`) ends a v3
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
(`expect-failed`) rather than silently overwritten. The refusal surfaces
when the root commits, as `CommitRejectedError`. Its message names the
record key and the partition, so it is not wrapped while v3 is dormant; the
user-facing wording belongs to the opt-in. Two limits:

- A tombstone can only expect `present`, so a move from a legacy key cannot
  detect a stale edit of the file it replaces.
- A local file out of step with the store (an editor-mode edit, a hand
  edit, a write by a hook-less command) makes the next save's precondition
  fail until the read model catches the file up. A rename of a name v3
  never saw lands its first commit and refuses its second.

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
built without a hook: CLI `model create` and `model edit` and `workflow
create`, `model evaluate` and `workflow evaluate`, editor-mode `model edit`,
and serve's `migrateGrantDefinitions`. On v3 their typed changes stage into
the commit-log unit around them (swamp-club#3279, "v3 opt-in"), and
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

**Where its state lives.** Everything the read model keeps is in
`.swamp/_read_model_v3/`, built from the repository with
`readModelStateDir(repoDir)` (`swampPath`), never from the datastore resolver:

| File | Holds |
|---|---|
| `_catalog_v3.db` | The v3 catalog |
| `_read_model_v3.db` | The cursor, each partition's applied seq, the live-record index, and each data name's live versions with their metadata |
| `read_model.lock` | The lock that serializes catch-ups across processes |

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
2. **Catalog.** The projection's actions.
3. **State.** One transaction holds the index changes, the live versions, the
   ownership of each file the commit wrote or removed, the keys it wrote or
   removed without a sync, the partition's applied seq and, from `catchUp`,
   the cursor. Neither the cursor nor an applied seq moves back.

Commits are applied a page at a time (`pageSize`, 500 by default): each
commit's state transaction is a savepoint in one transaction for the page,
which commits after the page's files are written. An apply error at commit k
keeps the commits before it, and the error is rethrown.

Each effect is idempotent, so a crash anywhere is repaired by catching up
again from the unchanged cursor. The index and the cursor are never ahead of
the files. Calls queue in the process, and an exclusive OS lock on
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
gone (a directory left at a removed name is fine). If all match, they
survived the reboot and are on disk, and the list is cleared. If one does
not, the state is reset and the catch-up applies every commit again, which
rewrites and removes every file.

The boot must be named by the kernel, never by the clock: the boot time
(now less the uptime) shifts when the clock steps within one boot, which
would look like a reboot, and the check would read the files back from the
page cache, pass, and stop watching them. So the identity is
`/proc/sys/kernel/random/boot_id` on Linux and the `kern.bootsessionuuid`
sysctl on macOS, read once per process. Where neither is available
(Windows), or it cannot be read, the catch-up syncs its files at each
page's barrier instead and lists nothing; a list left by an earlier boot is
then not trusted, and every commit is applied again, synced.

The cost moves to the first open after a reboot: it hashes every file
written since the list was last cleared, holding the read model's lock. The
list is bounded by the checkout's keys, but a long-running `serve` can
leave most of its cache on it. A listed file the state shows present with no
live record for its owner cannot be checked, so it also resets the state; it
is logged as such, apart from a file that does not match.

What this does not cover: anything that loses page-cache writes without
ending the boot. A disk detached mid-write, a write-back I/O error (which,
with no fsync, nobody sees), a filesystem forced to shut down and remounted,
an NFS server that loses its cache, or a VM restored from a snapshot can all
lose unsynced files while the boot id stays the same, and the read model
will not notice. The check runs at the start of an
exclusive section, so an index read (`liveRecords`, `chunksInUse`) before
the first catch-up of a new boot is not covered by it. A commit whose apply
fails is not recorded, so the files it wrote before failing are not listed:
until its retry rewrites them, a reboot can leave one torn. `commits.db` keeps
`synchronous=FULL` and stays the source of truth. The compacted-base load
and recovery's sweep still sync their files at a barrier
(`DurableWriteBatch`): they are rare. `F_BARRIERFSYNC`, which Deno does not
expose, stays out of scope.

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

**Path conflicts.** A file and a directory claiming one path (a put of
`data/x` where `data/x/y` exists, or of `data/x/y` where `data/x` is a
file) can never succeed, and in team mode another principal could cause one.
Retrying would block every later commit, and with them chunk GC, so a put
that conflicts is logged and skipped like a refused key, and stays indexed. A
tombstone under a file has nothing to remove.

**Failures.** Any other failure throws `ReadModelApplyError`, naming the
namespace, partition and seq, and leaves the cursor before the commit, so the
next catch-up tries it again. Causes include a missing or damaged chunk (it
may not be uploaded yet), a `BlobRef` with a `legacyKey` (no migration writes
those yet), and a write error. An
abort stops between commits or during a chunk read, and leaves no partial
file. Waiting for another process to release `read_model.lock` is not
abortable: the OS lock has no abort hook.

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

**Known limits.**

- On a case-insensitive filesystem (macOS by default, Windows), two keys that
  differ only in case are one file, and a tombstone of one removes the other's
  file while the index still lists it. v2 has the same collision for data
  names that differ in case.
- A full replay needs every commit. History compaction (swamp-club#3258)
  removes old commits, and a checkout below the compaction point loads the
  compacted base instead, replacing each data name's catalog rows rather
  than writing over them ("v3 history compaction" below).
- A crash between creating a temp file and renaming it leaves a
  `.<uuid>.tmp` file beside the target, inside a synced directory, which
  sync could push. v2's `atomicWriteFile` writes the same temp files in the
  same directories, so this is shared, not new; a sweep of orphaned temp
  files would fix both. Chunk garbage collection sweeps the filesystem
  storage's own temp files under `_blobs/`, not these.

**Wired by the opt-in** (swamp-club#3279, "v3 opt-in"):

- The cache root of namespace `ns` is `.swamp/` (solo) or `.swamp/<ns>`; the
  state directory is the checkout's `.swamp/_read_model_v3/`. A context
  catches up whenever it opens; serve once, at start-up, while it holds the
  writer lock.
- Data query reads `_catalog_v3.db`: `catalogDbPath` returns it on v3.
- A configured `directories` entry named `_read_model_v3` cannot reach the
  state directory: on v3 every datastore directory resolves in the checkout
  already, and the record key guard refuses any key under it.
- A checkout applies every namespace in `commits.db`, each under its own cache
  root; its resolver and catalog queries read its own namespace.

### v3 chunk garbage collection (datastore rework Phase 3)

swamp-club#3249 reclaims chunks that no commit names: those an abandoned unit,
a refused or failed commit, or a crash between storing chunks and committing
left behind. It also finds damaged chunks and removes the filesystem storage's
orphaned temp files. It is dormant: nothing in production calls it, and
`integration/datastore_v3_rules_test.ts` (rule 8) pinned that until `swamp
datastore gc` wired it in (swamp-club#3279, "v3 opt-in").

**Ubiquitous language.**

- **Referenced chunk**: a chunk some stored commit names. A put's `BlobRef`
  names its `sha256` when it has no `parts`, otherwise each part
  (`Commit.chunkRefs`). A `legacyKey` ref is indexed by the same rule, which can
  only keep a chunk, never lose one.
- **Grace period**: how long an unreferenced chunk is kept after it was last
  stored or refreshed. 24 hours by default (`DEFAULT_CHUNK_GRACE_MS`).
- **Sweep**: one `ChunkCollector.collect` over one storage namespace.
- **Damaged chunk**: a stored chunk whose bytes do not hash to its key.

**Why the reference set is the commit log.** The read model applies each commit
in turn and reads every put's chunks as it goes, so a checkout catching up from
cursor 0 needs every chunk any commit ever named. That includes content a later
commit overwrote, and versions a delete, `data gc` or `prune` tombstoned.
Deleting such a chunk would stop a fresh catch-up at that commit with
`ChunkMissingError`. A read model's `chunksInUse` describes one checkout's
present records at its own cursor, so it cannot be the reference set.

Reclaiming superseded content (chunks only historical commits name) is history
compaction's job (swamp-club#3258, "v3 history compaction" below). After a
compaction the reference set is the surviving commits plus the compacted base,
plus chunks released within the sweep's grace period.

**The chunk index.** `commits.db` schema version 2 adds
`chunk_refs(namespace, sha256)`. Its namespace is the commit namespace (`""`
when unnamespaced). Each append writes its commit's refs in the append's own
transaction, so a refused, repeated or rolled-back append writes none. The
migration from version 1 backfills the table from the stored commits in SQL
(`json_each` over each body's ops) by the same rule. A property test checks the
index against a scan of every stored commit, built both ways.
`CommitStore.referencedChunks(namespace, hashes)` answers a batch of hashes, so a
sweep never loads a namespace's whole reference set.

**The sweep.** `ChunkCollector` (`src/domain/datastore_v3/chunk_collector.ts`)
is a domain service over the `CommitStore` and `storage/1` ports:

1. Fix `now`, and the cutoff `now - grace`.
2. When `verifyBytes` is set, verify chunks in a listing pass of their own
   (see "Damaged chunks").
3. Stream the namespace's `list` again. A chunk modified at or after the
   cutoff is kept unchecked.
4. Gather older chunks in batches of `CHUNK_COLLECTION_BATCH` (256). For each
   batch, read which are referenced. Read the rest, delete them, check their
   references again, and put back any a commit landed on (see "Races with a
   concurrent write").
5. Remove the storage's stale temp files, when it has a `TempFileSweeper`.

The report counts what was scanned, kept as referenced, deleted, restored,
kept over the read budget, kept as too new and verified. It also lists the
damaged chunks and counts the temp files removed. The
unnamespaced datastore's chunks live under `_default`. The collector maps it
with `storageNamespaceOf` and queries the index with `""`.

**Why 24 hours, and why the order matters.** A unit stores, or refreshes,
every chunk it is about to name before it commits. Writes trust `has`, and a
chunk found present is touched or put again, which moves its `lastModified`. A
chunk no commit names yet is therefore either abandoned or younger than the
unit holding it. The grace period sits far above the longest a unit lives
between storing its chunks and committing.

The cutoff is fixed before any reference is read. A commit that lands during
the sweep names chunks stored or refreshed after the cutoff, so they are never
candidates.

**Races with a concurrent write.** A writer that finds a chunk present
refreshes it (`touch`, or a put) and commits later. So a sweep can see a chunk
unreferenced and old, and a commit can land on it before the delete. The
refresh alone does not save it, because the sweep already holds the old
`lastModified`. Two halves close this without changing `storage/1`:

1. **The sweep re-checks and restores.** For each batch, the sweep reads each
   unreferenced candidate's bytes and checks their SHA-256. Then it deletes
   them and asks `referencedChunks` again for the deleted hashes. A chunk a
   commit landed on in the meantime is put back from the bytes read, and the
   report counts it as `restored`. The re-check runs for every chunk a delete
   was started for even when the sweep aborts or a delete fails part-way, with
   a signal of its own. Reads are bounded by `sweepReadBytes` (1 GiB
   by default), and at most 64 MiB of candidates is held at once. A candidate
   past the budget is kept for the next sweep, never deleted unread. A
   candidate whose bytes are damaged is deleted and reported, never put back.
2. **The writer checks after its commit lands.** In the commit-log unit
   (`appendGroup`), once an append returns `appended` or `duplicate`, the
   writer calls `has` for the chunks its commit names. It stores any missing
   ones again from the put's content source: the bytes, or the stream
   function, which can be called again. That is one `has` per stored blob, and
   nothing for inline content. A source that no longer gives the same content
   cannot repair the commit, and the unit's commit fails saying so.

Take a commit that names a chunk the sweep deletes. If it lands before the
sweep's re-check, the re-check sees the reference and puts the bytes back. If
it lands after the re-check, it landed after the delete, so the writer's
check, which runs after its commit lands, finds the chunk missing and stores
it again. Either way no stored commit is left naming a missing chunk, however
long the batch took.

One case the two halves do not cover: the writer's process dies after its
commit lands and before its check runs, while a sweep deletes one of that
commit's chunks between its reference check and the commit landing. That needs
a crash between an append returning and one `has` call, at the same time as a
sweep that holds the chunk as a candidate. Phase 4's outbox, which knows which commits it
sent, is where a recovery would re-run the check.

**Clock skew.** `lastModified` comes from the storage's clock (a file's mtime,
an object store's server time), and `now` from the collector's. A skew between
them shifts the cutoff by the same amount. Against a 24-hour grace normal skew
does not matter. Only tests should configure a grace near zero.

**The Phase 4 outbox.** A unit's pending retry calls `appendGroup` again, so
its content is stored (refreshed) again before each append, and the writer's
check runs after the append lands. The Phase 4 outbox will make a pending
commit durable, and could send it days later, after a sweep has removed its
chunks. An outbox entry must do the same: keep its content sources and run the
writer's check after it lands, or store its content again before sending.

**Damaged chunks.** `collect` can read and hash chunks within a byte budget
(`verifyBytes`, 0 by default), in a listing pass before the sweep. Whether a
commit names each damaged chunk is looked up once, after the pass. The sweep's
own reads of its candidates find damage too. A damaged chunk is deleted
whatever its age. That relies on `storage/1` requiring an atomic `put`, so a
reader never sees a chunk still being written. Once a damaged chunk is gone,
the next write of that content finds it absent and stores it again. The report
says whether a commit names it. If one does, its reads were already failing.

The verify pass has a narrower form of the race. A writer that finds a chunk
present with `touch` never replaces it, so a damaged chunk stays until the
sweep removes it. On a backend without `touch`, though, a writer puts the
chunk again, so a good put can replace the damaged chunk between the pass's
read and its delete. When that writer's commit lands after the delete, its
check stores the chunk again. When the commit lands and its check runs inside
that window, the next writer check or the next write of that content restores
it.

**Temp files.** `FileSystemStorage.removeStaleTempFiles` removes the
`.<uuid>.tmp` files a put left under `_blobs/` when it died before renaming one
into place. It removes only files older than the sweep's cutoff, so a put still
writing keeps its file. It implements `TempFileSweeper`
(`src/domain/datastore/datastore_storage.ts`), which is not part of
`storage/1`, since extension backends have no such files. `list` already skips
them. Empty shard directories are left in place. They are harmless, and
removing one would race a concurrent put's `mkdir`.

**Wired by the opt-in.** `swamp datastore gc` sweeps the checkout's namespace
with the default grace period (swamp-club#3279, "v3 opt-in"). Splitting large
`data gc` and `prune` tombstone sets across commits belongs to the data and
output staging issue.

### v3 history compaction (datastore rework Phase 3)

swamp-club#3258 lets superseded content be reclaimed. Every commit at or below
a **compaction point** is folded into a **compacted base** in `commits.db`
and deleted, so a checkout no longer needs the whole history, and chunk GC can
reclaim chunks that only deleted commits named. It is dormant: nothing in
production compacted until the opt-in wired it into the writer
(swamp-club#3279, "v3 opt-in").

**Ubiquitous language.**

- **Compaction point**: a change-feed cursor. Every commit at or below it is
  compacted. 0 before any compaction. It only moves forward.
- **Compacted base**: what a checkout holds after applying every compacted
  commit, without the files: each partition's present records (digest, and
  inline content or `BlobRef`), each data name's live versions, catalog rows
  and forward, each materialised key's ownership, and each partition's
  compacted seq.
- **Compacted seq**: a partition's last compacted commit.
- **Released chunk**: a chunk whose last reference (a stored commit or a base
  record) a compaction dropped, with the time it was released.

**Decisions** (the issue's questions, in order).

1. **One point for the whole store, not one per partition.** A checkout whose
   cursor is below the point loads the base, reconciles its files,
   `_catalog_v3.db` and state with it, then replays the commits after the
   point. A checkout at or past the point is unaffected. The read model
   catches up through the store-wide feed, and file ownership marks
   (swamp-club#3256) compare feed positions across partitions. With no commit
   at or below the point left, every later put is newer in the feed than
   every mark in the base, so ownership after a load matches a replay.
   Reconciling means:
   - the files the state shows present, that the base does not, are
     removed;
   - files the base shows present, whose put the state does not show, are
     written;
   - each data name's catalog rows and forward are replaced;
   - partitions that a partition catch-up had taken past their compacted seq
     go back to it and replay.
2. **Compacted commits are deleted**, not kept for audit with content no
   longer guaranteed. Readers would otherwise need to tell kept-but-hollow
   commits from real ones. Three things keep working without them:
   - **Retries.** Their txnIds move to `compacted_txns`, so a retry still
     returns `duplicate` with its original seq. The snapshot `priorTxn`
     lookup and the duplicate lookup read both tables.
   - **Rebuilds.** Each compacted partition gets a snapshot at its compacted
     seq when its latest is older, so a rebuild never needs a deleted commit.
   - **Head check.** It compares the head row with the larger of the last
     stored seq and the compacted seq.

   `compacted_txns` grows by one small row per commit, about 120 bytes in
   the bench below against about 2.2 KB of commit. The Phase 4 outbox bounds
   how old a retry can be, and may prune it then.

   Litestream replicates the deletes as page changes. Freed pages are reused
   and never vacuumed: `VACUUM` rewrites the whole file into the WAL.
3. **GC reference rule.** `chunk_refs` becomes a count of the stored commits,
   and the base records, that name each chunk (each commit or record counted
   once).
   - A batch adds the base's references before it drops the commits', so a
     present chunk's count never reaches zero.
   - A chunk whose count does reach zero is deleted from the index and
     recorded in `released_chunks`.
   - `referencedChunks(namespace, hashes, releasedSince)` counts a chunk
     named by a commit or a base record, or released at or after
     `releasedSince`. `ChunkCollector` passes its cutoff (`now - grace`).
     Without the argument every released chunk counts, as before.
   - Compaction forgets releases older than `releasedRetentionMs`
     (`DEFAULT_CHUNK_GRACE_MS` by default), which must be at least the
     longest grace period any sweep uses.

   #3249's guarantees are unchanged: the sweep's re-check and restore, and
   the writer's post-commit check. Compaction never names a new chunk.
4. **Races.**
   - **Compaction and appends** share the store's queue, so nothing appends
     between a batch's reads and its transaction.
   - **Feed and partition reads** read the point in the same read
     transaction as their page. A read from below it rejects with
     `CommitsCompactedError`, and the read model loads the base.
   - **A page read before a compaction stays valid.** Its commits happened.
     The chunks they name stay referenced for the grace period after their
     release.
   - **The base is read in pages,** each with the point it was read at. A
     load that sees the point move starts again.
   - **A load that fails part-way** has first recorded the keys and names it
     was about to touch (`load_touched_keys`, `load_touched_names`), so the
     next attempt, even against a newer base, reconciles what the failed one
     wrote.
   - **A GC sweep around a compaction:** a released chunk stays referenced
     for the grace period, and a present chunk's count never reaches zero.
     No checkout that finishes within the grace period can need a chunk GC
     deleted. One that takes longer fails on the missing chunk
     (`ReadModelApplyError`), keeps its cursor, and loads the newer base on
     its next catch-up.
5. **When it runs.**
   - `CompactionPolicy` (`compaction_policy.ts`) is pure. By default it
     folds at least 10,000 commits at a time, and keeps the newest 10,000
     and the last 7 days.
   - `CommitStore.compactionStatus(retention)` measures the history the
     retention allows, by count and by commit `at`. Everything from the
     first commit written at or after `since` is kept, so a writer's slow
     clock never makes a newer commit compactable.
   - `compactHistory(through)` runs on the single writer (solo, or the serve
     leader): a writing CLI command at teardown, and serve hourly
     (swamp-club#3279).
6. **Run records.** `resolveRunArtifact` (`run_artifact_resolution.ts`)
   resolves a run's `dataArtifacts` ref (dataId, name, version). It returns
   the live version only when it is evidently what the ref's producer wrote,
   and otherwise "content no longer available":
   - the version must be live, with the ref's `dataId`;
   - a ref carrying `sha256` decides by content;
   - a version that records a workflow run must name the producer's run;
   - otherwise (a method run, or report data that records no run) it must
     have been created within the producer's start and finish. An output
     that never finished resolves nothing.

   The one case left: another writer deletes and re-saves the same top
   version inside the producer's own window. That keeps the `dataId`
   (`Data.withNewVersion`), and nothing in today's ref tells the two apart.
   The opt-in closes it by recording the content's `sha256` in new refs
   (swamp-club#3279). The
   time window also assumes the producer and the writer share a clock, which
   holds while one process writes both.

**The fold.** `foldCommit` (`compaction.ts`) applies one commit to the base
with the read model's own rules, extracted to the domain so there is one
copy:

- `materialisation.ts`: final key states, the #3256 ownership rule,
  `lexicalRefusal` and `lexicalConflict`;
- `projectCatalog`;
- `catalog_state.ts`, the catalog store's semantics as a value. That includes
  ending a name's forward when an upsert becomes its latest row, as
  `CatalogStore.upsertNewVersion` does.

The base has no files, so refused keys and file/directory conflicts are judged
from key strings against the base's present files. That is what the read model
finds on a cache holding only materialised files. Like replay, a cache holding
other files can differ (see "Path conflicts" above). A key refused only by
its resolved path (a state directory placed inside a synced one) passes the
lexical check, so the load drops its ownership when the guards skip it, as a
replay records none. Catalog rows are stored as
versions and take their metadata from the live versions, which they always
equal. A row that is not live fails the batch.

**Schema.** `commits.db` version 3 adds:

- `compaction` (the point);
- `compacted_partitions`, `compacted_txns`;
- `base_records`, `base_versions`, `base_catalog`, `base_forwards`,
  `base_files`;
- `released_chunks`.

It also turns `chunk_refs` into a count, backfilled from the stored commits by
#3249's rule. `_read_model_v3.db` version 3 adds the load's staging tables
and its touched keys and names.

**Batches and crashes.** `compactHistory` folds `COMPACTION_BATCH` (250)
commits per transaction:

1. read and parse the rows, and rebuild the snapshots the batch needs,
   outside the transaction;
2. in one `BEGIN IMMEDIATE`, check the point again, fold, move the txnIds,
   drop the references, write the snapshots, delete the rows and move the
   point.

A point or a partition that changed between the two steps means another
process is writing the store, and the batch says so rather than report
damage.

A failure or a crash leaves a batch whole or absent.
`integration/datastore_v3_compaction_test.ts` stops one with an injected
failure, and with a Worker terminated inside the transaction, and compares
every table with the old state.

**Measured** on an Apple M5 Max (`scripts/bench_commit_compaction.ts`). One
model partition has 11,000 commits, each saving a new version of one of 50
names. In the "growing" history most versions stay live; in the "churning"
history each commit deletes the previous version.

| History | Batch | Mean ms per batch | Max ms | WAL bytes per batch | WAL bytes, appending as many |
|---|---|---|---|---|---|
| growing | 250 | 143 | 272 | 1.0 MB | 4.1 MB |
| growing | 1,000 | 483 | 907 | 2.9 MB | 4.2 MB |
| churning | 250 | 19 | 36 | 0.7 MB | 4.1 MB |
| churning | 1,000 | 71 | 105 | 1.4 MB | 4.2 MB |

A batch holds the write lock and the event loop for its whole fold. The fold
is cheaper for a churning history: a growing name's live versions are parsed
once per batch, and there are many more of them. 250 keeps the worst case
under about 0.3 s. A batch writes less WAL than the appends it replaces.

Over cycles of 2,000 churning appends, each followed by a compaction that kept
the newest 500 commits, `commits.db` reached 9.3 MB after 16,000 commits,
against 35.6 MB uncompacted. It keeps growing by about 120 bytes per commit:
`compacted_txns`, as above. Freed pages are reused: about 1,000 stay free.

A fresh checkout of the 11,000 churning commits took 165 s to replay them all,
most of it one durable write per file, and 0.6 s to load the base. A load
costs O(live state), not O(history).

**Done by the opt-in** (swamp-club#3279, "v3 opt-in"): compaction runs on the
writer by `DEFAULT_COMPACTION_POLICY`; run-record artifacts resolve through
`resolveRunArtifact`, and new `DataArtifactRef`s record `sha256`. **Still
open:** prune `compacted_txns` once the Phase 4 outbox bounds retry age.

### v3 stream directories (datastore rework Phase 3)

swamp-club#3278 answers where `audit/`, `telemetry/`, `logs/` and `files/`
live on v3. swamp-club#3233 recorded them as synced, append-only streams with
no v3 home. A trace of every writer and reader in `src/` shows that none of
them is written through the datastore on any backend, so the answer is that
they stay repo-local, on v3 as on v2. Nothing changes on v2.

**Ubiquitous language.**

- **Stream directory**: one of `REPO_LOCAL_STREAM_SUBDIRS`
  (`record_path_guard.ts`): `audit`, `telemetry`, `logs` and `files`. Each is
  a datastore directory by name, in `DEFAULT_DATASTORE_SUBDIRS`, with no
  writer that resolves it through the datastore.
- **Run log**: the plain-text `.log` file beside a run or output record. It is
  not in `logs/`.

**What each directory holds, and who reads it.**

| Directory | Writers | Readers | Other checkouts or nodes |
|---|---|---|---|
| `audit/` | Agent-hook command audit (`JsonlAuditRepository`, `commands-YYYY-MM-DD.jsonl`, 7-day retention) and vault audit (`JsonlVaultAuditRepository`, `vault-audit-YYYY-MM-DD.jsonl`, no retention). Both build `swampPath(repoDir, "audit")`, the checkout's own `.swamp`. | `swamp audit`, `swamp doctor audit`, `swamp vault audit-trail`, serve's `audit.timeline` and `vault.audit-trail`, all on the node's own disk. | Never shared: each serve node shows only what it recorded. |
| `telemetry/` | None in the repository. The spool is user-global (`globalTelemetryDir()`), uploaded over HTTP. `migrateRepoTelemetryToGlobal` drains a legacy repo-local spool. | `swamp telemetry stats`, over the user-global spool. | Not a datastore concern. |
| `logs/` | None. | None. | Nothing to share. |
| `files/` | None. `repo init` stopped creating it as unused (commit `b703d746`), and `DEFAULT_DATASTORE_SUBDIRS` copied it from the old subdirectory list (`153e19a5`). | None. | Nothing to share. |

Two neighbours complete the picture:

- **Run logs.** `RunFileSink` writes them under the checkout's own
  `.swamp/outputs/` and `.swamp/workflow-runs/`, beside records that do go
  to the datastore. Records store `logFile` relative to the repository. The
  logs were already local-only, by swamp-club#3257 and #3266, so another
  checkout reads the record and finds no log. Workers send their output back
  to serve, which writes it into its own run log.
- **Method file outputs** are data records under `data/` (`createFileWriterFactory`,
  `.../<version>/raw`). Their paths are never stored: CEL's `.path` is
  derived on each checkout. v3 already commits them as data, with the rule
  that chunks land before commits.

Serve's tamper-evident audit log is not in `audit/` either. `StoreSink`
writes `events/<date>/<uuid>.jsonl` objects to a control-plane store: a
dedicated audit datastore's store at `audit/<target>/`, or the main
datastore's at `_audit/<target>/`. Control-plane keys are already outside the
commit log, and `audit-wal` is always-local.

**Decisions.**

1. **The model is repo-local (option (c) of the issue) for all four.** This
   is v2 parity, not a change: a v2 datastore never holds them either.
   Neither the commit log (a) nor a separate stream area (b) has a writer to
   serve. A wish to share one, such as a cluster-wide vault audit trail, is a
   new feature with its own design, built against a real writer.
2. **No commit may materialise into a stream directory.** They are left out of
   `MATERIALISED_SUBDIRS`, so the read model's key guard and history
   compaction's fold both index such a key but never write it. In solo layout
   the cache root is `.swamp/` itself, so a key at
   `audit/commands-<date>.jsonl` would otherwise overwrite a checkout's own
   audit trail.
3. **Ordering.** No commit names a stream file, so there is nothing to order.
   Method file outputs keep data's rule.
4. **GC and compaction.** None of the four enters the commit log or
   `storage/1`, so chunk GC and compaction never touch them. Their own
   retention is unchanged: the command audit's 7 days, run GC's log sweeps,
   and serve's `retention.days`.
5. **Every backend.** The answer is the same on filesystem, S3 and GCS, so
   there is no storage format to carry into Phase 4. The S3 and GCS
   extensions' `resolveCachePath` returns `undefined`, so their sync cache is
   core's `~/.swamp/repos/<repoId>` (`resolve_datastore.ts`), never a
   checkout's `.swamp`. An extension that pointed its cache at the checkout's
   `.swamp` would be the one way v2 could sync these directories.

**Fitness rules** (`integration/datastore_v3_rules_test.ts`, rule 10):

- every stream directory is a datastore directory, not always-local, and not
  materialised;
- no production call of `resolvePath` or `dsPath` names a stream directory
  (the pinned list is empty);
- every production file that uses a stream directory's `SWAMP_SUBDIRS` name is
  pinned, so a resolver call through a variable is still reviewed.

**Left to the opt-in.**

- A writer that needs a stream directory synced gives it a v3 home first. The
  rules above fail until it does.
- v3 `datastore setup` creates and migrates nothing, the stream directories
  included (swamp-club#3279). v2 setup leaves them, and the run logs, in
  `.swamp` on every backend (swamp-club#3281); it still creates the empty
  stream directories at a new filesystem path.
- A v3 provider used as serve's dedicated audit datastore must still offer a
  control-plane store.

**Tests.** `integration/datastore_v3_stream_dirs_test.ts` runs two checkouts
on one datastore with the production writers, on v3 and on v2. The second
checkout reads none of the first's audit, vault audit or run log, and on v3
no commit names a stream key. After compaction and chunk GC the writer's files
are unchanged, and a checkout rebuilt from the compacted base holds none of
them. A commit keyed into each stream directory is indexed but never
materialised. `record_path_guard_property_test.ts` checks that every key under
a stream directory is refused, and that every other key gets the same answer
as before.

### v3 opt-in (datastore rework Phase 3)

swamp-club#3279 makes v3 usable: a new, empty filesystem datastore can be
created in the commit-log format, and every command and serve handler works on
it. Nothing changes for v2 datastores. S3, GCS and extension datastores stay
on v2 until Phase 4; multi-writer and team mode are Phase 5; migrating v2 data
is Phase 6.

**Setting it up.** `swamp datastore setup filesystem --path <dir> --format 3`.

- The `.swamp.yaml` key is `format` (2 or 3) on the `datastore:` block, and it
  is accepted only on a filesystem datastore. `format: 3` on S3, GCS or an
  extension datastore, in `.swamp.yaml` or as `--format 3` on `datastore setup
  extension`, is refused with a message naming Phase 4. Format 2 there is the
  default and is read as no key.
- The target must be absent or an empty directory, checked with `lstat`, so a
  symlinked target is refused too. The repository's current datastore must
  hold no records under its datastore directories (the stream directories and
  the catalog aside): v3 starts empty, and migrating records is Phase 6.
- Setup writes the marker `{format: 3, minReaderFormat: 3, writtenBy}` first,
  then `commits.db` and `_blobs/`, then `format: 3` into `.swamp.yaml`. A crash
  before the marker leaves an unmarked empty directory; the marker writer
  refuses to replace an existing marker. Setup creates no datastore
  subdirectory and migrates nothing.
- The checkout's own `.swamp/` is checked for records even under
  `--skip-migration`, and a current datastore that cannot be read refuses
  setup, as on v2.
- A repo already on a v3 datastore is never moved by setup, to v2 or to
  another v3: its records live in the checkout and its commit log, and
  migrating v3 data is Phase 6. A v2 setup onto a datastore that is already v3
  is refused too: v2's migration would copy the repo's records into it, where
  no v3 checkout reads them.
- The marker is written by linking a complete temp file into place, so of
  two concurrent setups exactly one creates the datastore. On a filesystem
  without hard links (exFAT, FAT32, some SMB and NFS mounts) it falls back to
  an exclusive create, written and synced; a reader may see a partial marker
  only while setup runs, and the guard refuses a garbled one. A setup that
  stopped after the marker (or after `commits.db` and `_blobs/`) leaves a
  fresh skeleton with no commits, which a re-run of setup completes.

**The marker decides the engine.** `ensureSupportedDatastoreFormat` returns
the engine (`DatastoreEngine`, `v2` or `v3`) and caches it per config object
(`checkedDatastoreEngine`). This binary reads formats 2 and 3 on a filesystem
datastore and only 2 elsewhere (`supportedDatastoreFormatsFor`), so a format-3
marker on S3 or GCS is still refused, and a binary that reads only format 2
refuses a v3 datastore. The `format` key records what setup chose; a config
whose key disagrees with the marker (or asks for 3 where no marker can be
read) is refused with `DatastoreFormatMismatchError`. A filesystem marker
that exists but cannot be read is refused
(`UnreadableDatastoreFormatMarkerError`): it could name v3. An unchecked
filesystem
config (a resolver built straight from `.swamp.yaml`) reads its marker
synchronously (`datastoreEngineOf`), so no code resolves a v3 datastore's
paths as v2. `integration/datastore_write_seams_rules_test.ts` pins every read
of the engine.

**Where records live.** A v3 datastore path holds only the marker,
`commits.db`, `_blobs/` and `_control/` (and the v2 global and per-behavior lock
files, which still order processes). Each checkout materialises records in
its own `.swamp/` (solo) or `.swamp/<namespace>`: `DefaultDatastorePathResolver`
on a v3 engine resolves every datastore directory there. The writer's
repositories write those files as they stage the change, and another
checkout's read model writes the same bytes when it catches up. The catalog is
the read model's `_catalog_v3.db`: `catalogDbPath` returns it on v3, so every
direct `createCatalogStore` caller reads it, the query service never backfills
it from disk, and repositories still write through to it, so an operation
reads what it saved before its root commits.

**One writer per datastore.** `V3WriterLock` (`v3_writer_lock.ts`) is a
`FileLock` at `<datastore>/_control/writer.lock`, taken once per process and
reference-counted across that process's roots. A writing CLI command
(`requireInitializedRepo`, `requireInitializedRepoUnlocked`) joins the hold
before it takes any other lock and keeps it until teardown; serve holds it
from start-up to shutdown. Another process that cannot take it within
`SWAMP_LOCK_TIMEOUT_MS` is refused with `V3WriterBusyError`, which names the
holder and, when that is serve, says to run the command through serve. So a
CLI write against a repository whose serve is running is refused on v3, unlike
v2. Read-only commands take it only to recover a checkout whose writer
ended without tearing down, without waiting, and release it before they read
(see **Interrupted runs**); a root that stages nothing (a dry-run `data gc`)
commits nothing and needs no lock. The writer also records
which checkout it writes (`_control/writer.checkout.json`); a reader in that
same checkout does not catch up while the writer runs, because the writer's
files there are newer than its last commit and replaying older commits over
them would undo its work; a recorded writer on this host whose pid is gone
writes nothing, whatever its TTL says. `swamp datastore lock
status|release --force` act on the writer lock on v3. A holder on another
host is treated as alive until its TTL expires, never judged by its pid,
which means nothing on this host (`FileLock`'s `sameHostPidCheck`). A holder
paused past its TTL is not fenced: its later writes are not refused. The
Phase 4 writer lease at `_control/writer`, which carries the fence every
commit names, replaces it. A read-only context stages nothing: any change
staged through it is refused (`ReadOnlyV3WriteError`), so a read-only command
that writes fails in tests rather than committing without the lock.

**Wiring.** One module outside the v3 directories opens a v3 datastore for a
repository context: `v3_repo_context.ts`. It opens one handle per checkout and
datastore per process (`openV3Datastore`: commit store, chunk store, read
model, catalog), catches the read model up whenever a context opens, and
`closeV3Datastores` closes it at CLI teardown and after serve stops.

- `createRepositoryContext` takes a `commitLog` factory on v3. It gives the
  context a hook of its own, marks it `requireUnit` before any repository can
  write, and binds the context's `CommitLogEngine` to that hook
  (`bindCommitLogEngine`). A hook is never shared between contexts.
- `runInRootUnitOfWork` and `repoUnitOfWorkFactory` find the engine through
  the context or its hook, so every CLI command, serve handler and serve
  background root that already opens a root (including the ones that hold
  only `{ markDirty }`) opens a commit-log root on v3. The root's flush still
  runs once the root has ended: on a filesystem datastore it releases the
  command's locks. A root nested in another with its own push or checkpoint is
  refused, as on v2.
- A repository built without a hook marks nothing on v2. On v3 its typed
  changes stage into the innermost open commit-log unit around the call, even
  under a use case's unbound unit, and an untyped change there is refused. The
  write-route recorder found about fifteen such writers (definition, workflow
  and vault use cases that build their own repositories, local workflow
  cancel, the orphaned-run reaper, serve's `data.delete`); this one rule covers
  them all, and v2 is untouched because no commit-log unit exists there.
- A v3 root commits when its v2 root would push: on every outcome, or only
  when the operation resolved under `pushWhen: "completed"`. A use case's
  unit commits once its stream yields an outcome, a reported `error`
  included: a failed method run reports one, and its record is what v2
  publishes too. It abandons on a throw or a stop before any outcome. This
  changes decision 5's ending of #3257, which abandoned on a reported
  `error`, so a failed run's records reach the commit log as v2 publishes
  them. A use case that reaches an outcome before its stream reports it
  calls `markOutcomeReported()`, which the v3 unit counts as one: a method
  run cancelled by its signal saves its `cancelled` record and marks the
  outcome, so its record and the outputs it wrote commit (swamp-club#3299).
  It then yields a `cancelled` event, so the CLI and serve report the
  cancellation and the command exits 1 (swamp-club#3317). Every root settles
  refusals with `reconcileRefusedRuns`;
  only a root holding a run record has anything to reconcile.
- The managed extension lockfile is committed as a typed `lockfile.write` put
  in `config--lockfile--upstream_extensions` at its transaction root's
  checkpoint (`v3_lockfile_sync.ts`), in the CLI and serve, under the global
  lock as on v2. Managed config whose `directories` or `exclude` leave
  `config` out is refused when a context opens: nothing in it would be
  committed.

**No v2 sync on v3.** A filesystem datastore has no sync service, so none of
v2's sync machinery runs: no pull or push at the locks, no sync gate, no access,
runtime or config pull in serve, no lazy hydration. `datastore sync`,
`datastore catalog pull` and `datastore migrate-index` refuse a filesystem
datastore already. On v3, `datastore namespace set|unset|migrate` refuse
too: moving existing records, or a checkout, between namespaces is Phase 6.
A namespace is chosen by running `namespace set` before `setup filesystem
--format 3`, which needs no `--skip-migration` (swamp-club#3301).
`datastore config migrate` has a v3 form of its own (below).

**Managed config on v3** (swamp-club#3300). With managedConfig on, behavior
definitions, workflows and vault configs are read from the config tier, so a
repo that turns it on must commit the config it already has, or that config
disappears from view (the default vault `repo init` writes among it).
`v3_config_adoption.ts` reads the repo-local `models/`, `workflows/` and
`vaults/` trees and commits each file into its managed-config partition as
`definition.create`, expecting its key absent, through
`definitionSaveBatches` with no priors. The file lands at the same relative
path under the config base, so a later save of it stages the same key.

- **The commit log is the migration record.** v2's sentinel file has no v3
  intent. A name is adopted only while its partition has no commit
  (`CommitStore.head`, whose rows compaction never deletes). So a re-run
  adopts nothing, a name deleted from the tier after adoption is never
  brought back, and a name another checkout committed is never overwritten.
  A file with a config-tier copy at its path is skipped before it is parsed
  or the commit log read, whatever bytes an edit has since given that copy,
  so a repo adopted long ago pays one `lstat` per file.
- **Files follow the commit.** Adoption stages its puts in a root of its own
  and writes the config-tier files only once that root has committed, so a
  tier copy always means a committed name (a copy placed there by hand
  aside). When the commit fails, nothing is written, a re-run adopts again,
  and any partition that did commit reaches the checkout at its next
  catch-up, as another checkout's commits do (for serve, at its next
  start).
- **Stale writes are refused.** A checkout whose view of the commit log is
  stale creates a key that exists, and its `absent` precondition refuses the
  commit (`ConfigAdoptionRefusedError`, a `UserError` saying to run the
  command again). The single writer lock already rules this out within one
  datastore today; the precondition is what holds once there are more
  writers.
- **Only regular files are read.** Symlinks in the repo's trees, a tree's
  root included, are neither read nor followed, so a repo-controlled link never commits bytes from
  outside the repo, and every target is checked to stay in the config base.
  Secrets are never read: only vault configs are committed.
- **The extension lockfile moves too.** Turning managedConfig on moves the
  lockfile from the repo's extension models directory to the config tier, so
  adoption commits the repo's own lockfile into the lockfile partition (a
  `lockfile.write` put, as `v3_lockfile_sync.ts` stages) while that partition
  has no commit, and writes it to `upstream_extensions.json` in the tier after
  the commit. With it, `.swamp/pulled-extensions` is copied into the managed
  root `.swamp/config/pulled-extensions` in this checkout only: pulled sources
  have no v3 intent, as after an `extension pull` on v3.
- **`datastore config migrate` on v3** runs adoption, then sets
  `managedConfig: true`. It confirms each config-tier copy against the commit
  log instead of trusting it, so a copy the log never held (left by an
  earlier setup, or placed by hand) does not stop its name being committed.
  Its JSON keeps the v2 shape (`copiedLockfile`, `copiedPulledExtensions`;
  `pushed` is false) and adds `committed` and `skipped`: files declaring no
  name, a name an earlier file of their kind declares, a path no record key
  can name, a file or directory that could not be read, or a name the commit
  log already holds with no tier copy at the file's path (another checkout's
  definition of it, or one renamed or deleted since).
- **managedConfig set by hand** in `.swamp.yaml` adopts on the first writing
  command: `requireInitializedRepo` and `requireInitializedRepoUnlocked` run
  adoption in a root of their own, with no flush (on v3 a root's flush
  releases the command's locks), before the command's own root. Adopt rather
  than refuse, because the user asked to keep what they have, and the hand
  path and `config migrate` then share one implementation. Anything that
  stops adoption there (a refusal, an unreadable file) is a warning and the
  command goes on; `config migrate` surfaces the cause. A read-only context
  cannot commit, so it warns that the config is not in the tier yet, and
  never fails the command over that check. Serve opens its context once, so a
  by-hand change made while serve runs is adopted at its next start (a CLI
  write is refused while serve holds the writer lock anyway).

**Tier rules.** A record key outside the repository's configured `directories`
or matching its `exclude` stays in the checkout and is never committed: the
commit-log unit drops it when it is staged (`datastoreKeyFilter`), as v2 never
syncs it.

**Chunk GC and compaction.** `swamp datastore gc` sweeps the namespace's
unreferenced chunks with the default grace period under the writer lock; on a
v2 datastore it reports that chunk GC applies only to v3. A writing CLI
command compacts by `DEFAULT_COMPACTION_POLICY` at teardown, while it still
holds the lock. Serve, which holds the lock for its lifetime so the CLI's
`datastore gc` cannot run beside it, compacts and then sweeps chunks every
hour (`V3MaintenanceTimer`). `datastore status` reports the format
and the commit log (commits stored, compacted through). `doctor datastores`
checks a v3 checkout; its `--repair` is refused on v3 for now, since its
repairs are v2's and take no writer lock.

**Run artifacts.** On v3 a data save reports its content's checksum, and the
`DataArtifactRef`s built from it record `sha256`. A streamed version reports
none and falls back to `resolveRunArtifact`'s run or time rule. `model output
data` and the run reads of `data get` and `data list` resolve a run's
artifacts through `resolveRunArtifact`, so a later re-save of the same version
is reported as no longer available. v2 records and outputs carry no `sha256`.

**Known limits.**

- A use case that throws, and a success-only root whose operation threw,
  commit nothing, but their repositories already wrote the writer's files and
  catalog rows. That checkout keeps them until a later write replaces them;
  no other checkout ever sees them. A process that then ends without tearing
  down has them removed by the next command (**Interrupted runs**); one that
  tears down keeps them.
- Run logs, the run index and the stream directories are the checkout's own;
  they are never committed.
- Serve's start-up migrations of legacy grant and token layouts move files on
  disk without committing them. A new v3 datastore has no legacy layout to
  migrate.
- A reader whose catch-up is already running when a writer starts in the
  same checkout can still replay a commit over a file the writer has just
  rewritten; the next write of that file restores it. The window is one
  catch-up long, on one host.

**Interrupted runs** (swamp-club#3299)**.** A run interrupted on v3 must
leave every checkout with the same records.

- *A catchable signal.* SIGINT or SIGTERM aborts the run's signal. A workflow
  run then yields `cancelled` and commits. A method run saves its
  `cancelled` record and marks its outcome (`markOutcomeReported()`, above),
  so its unit commits the record and the outputs written before the abort
  before teardown releases the writer lock. Serve's model cancel and its
  shutdown drain abort the same way. A method that ignores its signal is not
  interrupted: the run finishes and commits as usual.
- *No teardown.* A SIGKILL, a crash, or a second signal (which exits at once
  with 130, `registerShutdownHandler`'s `forceExitOnRepeat`) ends the process
  with units that never commit, so the checkout keeps files and catalog rows
  no commit names. The first writing context of a process writes
  `_read_model_v3/writer.json` (host, pid, a per-process token, and a start floored to the second
  less two seconds), and teardown removes it after every unit has ended, so a
  marker that outlives its process means the process ended without teardown.
  A signal that arrives after a command disposed its shutdown handler, and
  the hook-mode and worker exec-dispatch paths, which skip teardown, take this
  path too.
- *Recovery removes, it does not commit.* The run never completed, so its
  leftovers are removed rather than committed as recovered outputs, and the
  checkouts agree without the user doing anything: detection alone would
  leave them disagreeing. The next command in that checkout recovers when the
  marker names a process on this host that is gone (`isProcessGone`), or names this process's own pid under another token, as a restarted container's predecessor does (a
  zombie reads as alive, so the killed process must have been reaped). A
  writing command recovers under the writer lock it has just taken; a
  read-only command takes the lock without waiting (`tryAcquireV3WriterLock`)
  and skips recovery when a live process holds it, or when it holds it past
  its TTL; while it recovers it holds the lock, so a writer that starts then
  waits for the replay. Under the read model's lock, recovery deletes the
  catalog rows of the data commits carry, keeping the rows of data the
  datastore's `directories` or `exclude` keep local, which no replay could
  rebuild, and keeping the catalog marked populated, so no reader backfills
  it from disk; it then resets
  the state, replays every commit, which puts back the committed version of
  any file the writer overwrote, then removes each file in the materialised
  directories that no commit owns and that changed since the marker's start.
  Run logs, any path with a dot segment (run indexes, locks, temporary
  files, install staging), pulled extension sources under managed config
  (`config/pulled-extensions`), files the datastore's `directories` or
  `exclude` keep local, and the stream directories are never touched
  (`isCheckoutLocalKey`). The marker goes last, so a recovery cut short runs again in full.
  While the replay runs, a process reading the catalog directly sees it empty
  or partial; that lasts one recovery, after a crash, and is the price of
  never backfilling it from disk. A recovery that keeps failing (a file it
  cannot remove, say) fails each writing command with a `UserError` naming
  the marker, which a user deletes to keep the checkout's files as they are.
  A marker from another host, or one naming a process that is still
  running, is left in place: a writing command keeps it rather than writing
  its own, since its start already covers that command's writes. Serve keeps
  its marker when its shutdown drain leaves runs past the abort grace
  (`keepV3WriterMarkers`).
- The Phase 4 outbox makes an interrupted commit durable instead; this is the
  Phase 3 answer.

Serve's background writes are pinned on v3 too
(`integration/serve_v3_background_writes_test.ts`,
`serve_v3_extension_lockfile_test.ts`, `serve_v3_remote_execution_test.ts`):
boot reconciliation and the stale-record sweep, shutdown interrupts, server
token GC, the continuation sweep, webhook and scheduled runs, the worker
gateway and data plane, the device-auth mint, `access.reload`, the grants
poller, collective refresh, the extension lockfile in the CLI and serve, and
the maintenance timer.

**The gate.** `integration/usecase_v3_fixtures.ts` runs every row of the
use-case sync characterization (`usecase_sync_characterization_*_test.ts`),
CLI and serve, solo and namespaced, on a v3 checkout. After each row a second
checkout catches up and its datastore records and catalog must equal the
writer's, and no commit may name a stream directory.
`integration/datastore_v3_opt_in_test.ts` covers setup, the refusals, the
second writer, an older binary, every v2 sync path, failed runs and roots
that throw, read-your-writes, dry-run GC and run-artifact digests. Every v2 suite passes
unchanged, apart from tests that used format 3 to stand for "a newer format",
which now use 4.

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
`fetchForeignContent` through the `ForeignContentFetcher` its data repository
carries (`UnifiedDataRepository.fetchForeignContent`). The fetcher travels with
the repository, as the lazy-hydration hook does, so a query service built from
a repo context's repository can fetch wherever it is built: every repo context
constructor wires it from the sync service, and the paths that build a
repository of their own (workflow runs, `workflow evaluate`, `model evaluate`,
`model validate`) are handed it.

Every reader hydrates a foreign JSON record: `query()` (before projection, so a
`select` over `attributes` sees them, and after the `include` filter, so a
record the caller may not read is never fetched; a `select` that reads no
`attributes` fetches nothing) and `getLatestRecord`, which serves a
namespace-prefixed `data.latest()`.

The path fetched is built from the foreign row's namespace, behavior type,
behavior id, data name and version. Those fields are the other namespace's to
write, so a row is fetched only when each is a plain path segment: one holding
`..`, a separator or nothing at all could name an object outside that
namespace's data tree, and is left with empty attributes. A `select` that reads
`content` rather than `attributes` still sees no bytes for a foreign record, and
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
   locally, and downloads it. That pull covers only the step's own behavior, and
   only a method that takes a lock (a read-only method run takes none), so it
   is not what makes another behavior's data readable; see "Expression reads"
   below.
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

### Lock Lifecycle

The sync coordinator (`datastore_sync_coordinator.ts`), a global singleton,
manages the lock lifecycle:

- `registerDatastoreSync({ service?, lock?, label?, syncTimeoutMs?,
  metadataOnly?, namespace?, slowLockScope? })`: take the lock, pull if S3.
- `flushDatastoreSync()`: push if S3, release the lock.

Per-behavior commands (`model method run`) take only per-behavior locks, via
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
workflow engine takes per-behavior locks per step. Each method step takes its
lock before running and releases it in a finally block afterwards. This avoids
deadlock when a method starts a subprocess `swamp model method run` on a
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
  no locks (e.g. a read-only `model method run`) it still names the real lock
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
through. When a step runs `swamp model method run --server` (or
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
swamp datastore lock status                          # Show who holds the lock
swamp datastore lock release --force                 # Delete the global lock directly
swamp datastore lock release --force --model type/id # Release one behavior lock
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
  chicken-and-egg" below. Migrate pulls the `config/` tier before checking the
  migration sentinel, so a cache that predates another repo's migration sees
  it (swamp-club#2621). It pushes the migrated files at the root's checkpoint,
  then writes the sentinel and pushes it as the flush, so the datastore's
  sentinel means the migration is published; after either push fails, a
  re-run publishes it (swamp-club#3117).
- `swamp doctor datastores [--repair [-y]]`: health check with optional repair
  of catalog completeness, unmigrated root-level data, and foreign namespace
  contamination (the last via the optional `repairNamespaceContamination?()` on
  `DatastoreSyncService`) (`src/cli/commands/doctor_datastores.ts`). The
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
| `src/domain/datastore/datastore_format.ts` | Format marker parsing and the supported-format check |
| `src/domain/datastore_v3/partition_key.ts` | v3 `PartitionKey` and `partitionOf()`, the only way to build a key |
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
| `src/infrastructure/persistence/datastore_format_guard.ts` | `ensureSupportedDatastoreFormat`: read, check, debug log |
| `src/infrastructure/datastore_v3/sqlite_commit_store.ts` | v3 `SqliteCommitStore`: `commits.db` over `node:sqlite` (dormant) |
| `src/infrastructure/persistence/unit_of_work_binding.ts` | The unit-of-work binding registry `signalChange` routes by |
| `src/infrastructure/datastore_v3/commit_log_unit_of_work.ts` | v3 commit-log unit of work and its `CommitSink` outbox seam (dormant) |
| `src/infrastructure/datastore_v3/commit_log_root.ts` | `runInCommitLogRoot` and the run-outcome disposition (dormant) |

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
