---
audience: maintainer, operator
last-verified: 2026-08-28 @ ce0ca66b
---

# Data

Data is what a method run leaves behind. Every artifact is addressed by
`(type, modelId, name, version)`, is immutable once written, is versioned by
appending — a second write to the same name creates version 2, never rewrites
version 1 — and is queryable through a SQLite catalog kept beside the files.
Definitions are **not** data: they live in `models/` and are git-tracked, while
data lives in the datastore (default `.swamp/data/`) and is never committed (see
[datastores.md](../enablers/datastores.md)).

Two enablers carry the detail this doc only points at:
[data-query.md](../enablers/data-query.md) for the query surface and the
catalog, [datastores.md](../enablers/datastores.md) for backends, sync,
namespaced paths and locking.

## Why

- **Immutable + versioned.** A `DataId` is a random UUID, not a content hash
  (`src/domain/data/data_id.ts`); the `(dataId, version)` pair is the stable
  identity and a bare name resolves to `latest`. This is what lets workers cache
  artifact bytes forever, lets `data.latest()` be a cheap pointer read, and
  gives workflow re-runs a history to reconcile against
  ([remote-execution.md §Data semantics](../enablers/remote-execution.md#data-semantics)).
- **A catalog beside the files.** Content stays on disk in the versioned layout;
  the catalog stores only metadata rows so CEL predicates can be pushed down to
  SQL instead of walking the tree. It is local-only, excluded from datastore
  sync, and self-heals by backfilling from disk
  (`src/infrastructure/persistence/catalog_store.ts`).
- **Sensitive fields never land in data.** Values marked `sensitive` are moved
  to a vault before serialisation and replaced with a vault expression; a
  redactor scrubs any already-known secret from the bytes that are written
  (`src/domain/models/data_writer.ts`). Data files are synced, copied and
  queried freely — vault contents are not.

## The record

A data item is the `Data` entity (`src/domain/data/data.ts`) plus its bytes. Its
persisted form is `metadata.yaml`, validated by `DataMetadataSchema`
(`src/domain/data/data_metadata.ts`). Readers see it as a `DataRecord`
(`src/domain/data/data_record.ts`), built by the mappers in
`src/domain/data/data_record_mapper.ts`.

| Field                    | Meaning                                                                                                                                                                                   | Source                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `type` / `modelId`       | Owning model type (directory-normalised) and definition UUID; part of the path, not of `metadata.yaml`                                                                                    | `unified_data_repository.ts` `getDataNameDir`            |
| `name`                   | Instance name. No `..`, `/`, `\`, NUL; `latest` is reserved                                                                                                                               | `data_metadata.ts`; `data.ts` `RESERVED_DATA_NAMES`      |
| `id`                     | UUID shared by every version of one name                                                                                                                                                  | `data_id.ts`                                             |
| `version`                | Positive integer, starts at 1, allocated by `mkdir` claim                                                                                                                                 | `unified_data_repository.ts` `atomicAllocateVersionDir`  |
| `namespace`              | Which repo wrote it in a shared datastore; `""` in solo mode. Catalog column `ns` in CEL                                                                                                  | `namespace.ts`; `data_access_service.ts`                 |
| `contentType`            | MIME type; resources are always `application/json`                                                                                                                                        | `data_writer.ts` `createResourceWriter`                  |
| `lifetime`               | `Nm/h/d/w/mo/y`, `ephemeral`, `infinite`, `job`, `workflow`; zero durations normalise to `workflow`                                                                                       | `data_metadata.ts` `LifetimeSchema`, `normalizeLifetime` |
| `garbageCollection`      | Keep N versions (integer) or versions younger than a duration                                                                                                                             | `data_metadata.ts` `GarbageCollectionSchema`             |
| `streaming`              | Line-oriented file written incrementally                                                                                                                                                  | `data_writer.ts` `writeLine`                             |
| `tags`                   | String map; must contain `type`. Writers add `specName` and `modelName`                                                                                                                   | `data_metadata.ts`; `data_writer.ts`                     |
| `ownerDefinition`        | `ownerType` (`model-method`, `workflow-step`, `manual`) + `ownerRef` (the model id); workflow provenance (`workflowId`, `workflowRunId`, `workflowName`, `jobName`, `stepName`, `source`) | `data_metadata.ts` `OwnerDefinitionSchema`               |
| `size`, `checksum`       | Byte length and SHA-256 of `raw`                                                                                                                                                          | `unified_data_repository.ts` `computeChecksum`           |
| `lifecycle`, `renamedTo` | `deleted` marks a tombstone; `renamedTo` makes it a forwarding tombstone                                                                                                                  | `data.ts` `withDeletionMarker`, `withRenameMarker`       |

**Kinds.** The `type` tag is set by the writer: `resource` for JSON written
through `writeResource`, `file` for anything written through a `DataWriter`
(`data_writer.ts`). Other producers stamp their own value — reports write
`type: report` ([reports.md](../enablers/reports.md#data-persistence)).
`swamp data list --type` still accepts `log` and `data` as filter values, but no
first-party writer emits them; the former dedicated log type became `files` with
`streaming: true` ([models.md §Files](./models.md#files)).

**Vary dimensions.** A definition or workflow step can declare `vary` on an
output spec (`src/domain/models/data_output_override.ts`). The runtime resolves
the named inputs to a suffix (`src/domain/workflows/data_suffix.ts`
`coerceToSuffix`) and the writer stores the instance as `{name}-{suffix}`
(`data_writer.ts`, `resolvedVarySuffix`; the pure form is `composeDataName` in
`src/domain/data/composite_name.ts`). The suffix is baked into the stored name;
there is no separate dimension column.

**`latest`.** Each name directory holds a plain-text `latest` file containing
the current version number. Reads without a version go through it
(`getLatestVersion`, with a symlink fallback for pre-text-marker layouts and a
directory scan as last resort). The catalog mirrors it as `is_latest`, kept to
exactly one row per `(namespace, type, modelId, name)` by `upsertNewVersion`
(`catalog_store.ts`).

**`ModelOutput` — the run-level record.** Every method invocation also writes a
`ModelOutput` (`src/domain/models/model_output.ts`): status
(`pending|running|succeeded|failed|cancelled`), timing, error, provenance
(`triggeredBy`, workflow/run/step, `definitionHash`, `bundleFingerprint`) and
`artifacts.dataArtifacts` — a list of `{dataId, name, version, tags}`
references. It is stored as YAML under `outputs/`
(`src/infrastructure/persistence/yaml_output_repository.ts`) and read with
`swamp model output ...` / `swamp model output data <output_id>`
(`src/cli/commands/model_output_data.ts`). It references data; it is not data.

## Writing data

Methods write through two functions on `MethodContext`
(`src/domain/models/model.ts`), both bound to the running model by
`src/domain/models/data_writer.ts`:

- `writeResource(specName, name, data, overrides?)` — validates `data` against
  the spec's Zod schema (warns, does not throw), resolves tags and policy,
  diverts sensitive fields, serialises JSON and calls `repo.save`.
- `createFileWriter(specName, name, overrides?)` — returns a `DataWriter` with
  `writeAll`/`writeText` (one-shot save), `writeLine` (append, durable per
  line), `writeStream` (pipe a `ReadableStream`), and `getFilePath` + `finalize`
  (hand a subprocess the real `raw` path, then seal the version).

Both refuse undeclared spec names, empty names and the reserved name `latest`.

**One write, in order** (`unified_data_repository.ts` `save`): notify the sync
layer the name directory is dirty → check the existing owner matches
(`OwnershipValidationError` otherwise) → claim the next version directory with
`mkdir` (retrying up to 100 times on `AlreadyExists`) → write `metadata.yaml`
and `raw` via atomic temp-file rename → rewrite the `latest` marker → upsert the
catalog row. Streaming writers split this into `allocateVersion` (claim the
directory, return the path) and `finalizeVersion` (checksum, metadata, marker,
catalog). Once `await` returns the write is durable; there is no
buffer-and-commit-at-end, and a method that writes then throws keeps its writes
([remote-execution.md](../enablers/remote-execution.md#writes-are-immediately-durable-not-staged)).

**`rollbackOnFailure`.** A method definition can opt into all-or-nothing
semantics. Writers then use `saveDeferred` / `finalizeVersionDeferred`: the
version directory and metadata are written but the `latest` marker is left alone
and the catalog row carries `is_latest=0`. On success `advanceLatestMarkers`
flips them; on failure `rollbackVersions` removes the directories and rows
(`unified_data_repository.ts`;
[models.md §Write Atomicity](./models.md#write-atomicity-rollbackonfailure)).

**Tags** are resolved in a fixed chain (`data_writer.ts`): the `type` auto-tag,
then the definition's `tags`, the spec's default tags, per-call
`overrides.tags`, the `specName` and `modelName` auto-tags, workflow step tag
overrides (which also feed `ownerDefinition.workflowRunId` etc.), runtime tags
from `--tag KEY=VALUE` on `swamp model method run` / `swamp workflow run`
(`src/cli/commands/model_method_run.ts`, `workflow_run.ts`), and finally the
definition-level `dataOutputOverrides` for that spec (lifetime, GC, tags, vary,
vault name — `data_output_override.ts`).

**Sensitive fields.** If a resource spec has `{ sensitive: true }` fields or
`sensitiveOutput: true`, `processSensitiveResourceData` stores each value in a
vault under a key derived from type/model/method/spec/instance and replaces it
in the payload with `${{ vault.get('<vault>', '<key>') }}`. With no vault
configured the write fails rather than persisting the secret. The whole
serialised payload then passes through the run's `SecretRedactor`, which also
scrubs log output (`src/domain/secrets/secret_redactor.ts`). On read,
`resolveVaultRefsInData` expands the references and registers the resolved
values with the redactor (`data_writer.ts`, `data_record_mapper.ts`).

**Deletion by a method.** After a method whose kind is `delete` succeeds,
`method_execution_service.ts` writes a tombstone version for every declared
resource: `lifecycle: deleted`, content = the last known attributes plus
`deletedAt` / `deletedByMethod`. `data.latest()` therefore still resolves the
resource's final state, which keeps workflow re-runs idempotent.
`context.deleteResource(name)` is the hard form — it removes every version.

## Reading data

- **CEL** — `data.latest("model", "name")`, `data.version(...)`,
  `data.query('<predicate>')` and friends all return `DataRecord`; `attributes`
  is the parsed JSON for resources, `content` the text for text types. Model
  names may be namespace-qualified as `ns:model`, or `*:model` to search every
  namespace ([data-query.md](../enablers/data-query.md)).
- **In a method** — `context.readModelData(modelName, specName?)` and
  `context.queryData(predicate, select?)` (`model.ts`), backed by
  `DataAccessService` (`src/domain/data/data_access_service.ts`). With a catalog
  it issues a predicate scoped to the caller's own namespace unless the name
  carries one; without a catalog it walks the filesystem and, if the
  definition's UUID changed, recovers data written under the old UUID by
  `modelName` tag ("orphan recovery" — a read-time convenience, never a delete).
- **CLI** — `swamp data get <model> <name> [--version N] [--no-content]`, or
  `--workflow <name> [--run <id>]` to read what a run produced
  (`src/domain/data/workflow_data_service.ts`); `swamp data list` (grouped by
  type), `swamp data versions`, `swamp data search` (free text and tag filters)
  and `swamp data query '<predicate>' [--select] [--limit]`
  (`src/cli/commands/data_*.ts`). All read the same catalog; `get` also accepts
  `--server` to read from a serve instance.

## Versioning and lifecycle

Versions only ever grow: `save` never overwrites, and a name's `latest` moves
forward on write and backward only when the current latest is deleted or
collected (`delete`, `collectGarbage` recompute it from the surviving
directories). What can remove versions:

| Mechanism                       | Removes                                                                                                 | Source                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Write-time cap (`autoGc: true`) | On each save, versions beyond an **integer** `garbageCollection` cap                                    | `unified_data_repository.ts` `pruneExcessVersions`; `.swamp.yaml` `autoGc`     |
| `swamp data gc`                 | Phase 1: whole names whose `lifetime` expired. Phase 2: per-name version GC by count or duration        | `src/domain/data/data_lifecycle_service.ts` `deleteExpiredData`                |
| `swamp data delete`             | One version, one name, `--prefix` many names, or `--all` for a model; confirms unless `--force`/`--yes` | `src/domain/data/data_delete_service.ts`; `src/libswamp/data/delete.ts`        |
| `swamp data prune`              | Every name under a `(type, modelId)` whose definition no longer resolves                                | `data_lifecycle_service.ts` `deleteOrphanedData`; `src/libswamp/data/prune.ts` |
| `swamp run gc`                  | Old `outputs/` and `workflow-runs/` records — never `data/`                                             | `src/domain/data/run_lifecycle_service.ts`                                     |

Expiry rules (`calculateExpiration`, `isExpired`): duration lifetimes expire at
`createdAt + duration`; `infinite` never; `workflow` and `job` expire when the
owning workflow run record no longer exists; `ephemeral` never reaches the
persistent store. Tombstones (`lifecycle: deleted`) are skipped by lifetime GC,
so a deleted resource's final state survives until explicitly removed.

What each removal preserves:

- **Per-version delete** drops the directory and its catalog row, then repoints
  `latest` and re-upserts the surviving latest row. Deleting the last version
  removes the name directory and all its rows.
- **Whole-name delete, gc and prune** remove the name subtree and its catalog
  rows outright. No tombstone is written; the `ModelOutput` records that
  reference the artifact are left untouched and will dangle.
- **`removeLatestMarker`** is a soft delete: version directories stay on disk
  but the marker and catalog rows go, so the name becomes invisible to `latest`
  reads. It is used by the serve `deleteData` capability with
  `removeLatestMarkerOnly` (`src/serve/capability_service.ts`).
- **`swamp data rename`** copies the latest version under the new name and
  writes a forwarding tombstone (`renamedTo`) under the old one; `findByName`
  follows the forward reference for version-less reads
  (`src/domain/data/data_rename_service.ts`, `unified_data_repository.ts`).

`gc`, `prune` and `delete` take the global datastore lock and, on a remote
datastore, push their deletions in the same sync
([datastores.md](../enablers/datastores.md#orphaned-data-reclamation-swamp-data-prune)).

## Where it lives

Datastore-tier layout, default root `.swamp/`
(`src/infrastructure/persistence/paths.ts` `SWAMP_SUBDIRS`;
[repo.md §Directory Structure](../surfaces/repo.md#directory-structure)):

```
data/{normalized-type}/{model-id}/{data-name}/
  1/raw                  content bytes
  1/metadata.yaml        DataMetadata
  2/...
  latest                 text file: "2"
data/_catalog.db         SQLite catalog (local tier only)
outputs/{normalized-type}/{method}/{definition-id}-{timestamp}.yaml
workflow-runs/{workflow-id}/workflow-run-{run-id}.yaml
```

- **Catalog.** `catalogDbPath`
  (`src/infrastructure/persistence/repository_factory.ts`) is the single source
  of the path: `_catalog.db` inside the _local_ `data/` directory, so a shared
  datastore never carries it. `CATALOG_SCHEMA_VERSION` is checked on open; a
  mismatch drops the table and clears the `populated` flag, and the next query
  backfills from disk (`catalog_store.ts` `migrateIfNeeded`). One `is_latest=1`
  row per name is the invariant every write path maintains through
  `upsertNewVersion`.
- **Datastores and sync.** The repository writes wherever the
  `DatastorePathResolver` points; a remote backend (S3 extension) gets a
  `markDirty` hook on every mutation and syncs the cache in two phases
  ([datastores.md](../enablers/datastores.md)). Definitions are never in the
  datastore.
- **Namespaces.** In a shared datastore each repo is assigned a slug
  (`swamp datastore namespace set <slug>`, `[a-z0-9][a-z0-9-]*`, max 64 chars —
  `src/domain/data/namespace.ts`). The resolver prefixes the datastore tier as
  `{base}/{namespace}/data/...`, and every catalog row the repository writes is
  stamped with the same namespace (`namespaceFromResolver` keeps the two in
  lockstep). Foreign namespaces become queryable by pulling their catalog
  exports (`swamp datastore catalog pull`).
- **Ephemeral store.** `lifetime: ephemeral` data goes to an
  `InMemoryUnifiedDataRepository` paired with a `:memory:` catalog, wrapped with
  the persistent repository in a `CompositeUnifiedDataRepository` that routes
  writes by lifetime and reads ephemeral-first
  (`src/infrastructure/persistence/in_memory_data_repository.ts`,
  `src/domain/data/composite_data_repository.ts`). The store is created per
  workflow run or standalone method run and disposed in `finally`; it is capped
  at `DEFAULT_EPHEMERAL_MAX_BYTES` (512 MB) and throws
  `EphemeralBudgetExceededError` beyond that
  ([data-query.md §Ephemeral Data](../enablers/data-query.md#ephemeral-data)).
- **Remote data plane.** Workers hold no datastore configuration. Byte-heavy
  traffic goes over HTTP to the orchestrator (`src/serve/data_plane.ts`):
  `GET
  /data/{type}/{modelId}/{dataName}/{version}` for reads,
  `POST /data/resource`, `DELETE /data/resource` and the `/data/writers/...`
  routes for file writers (open, per-line append, streamed content, finalize).
  Every write is authorised against the worker's active dispatch and goes
  through the same `createResourceWriter` / `createFileWriterFactory` as a local
  run, against the dispatch's own composite repository, so ephemeral data and
  tag chains behave identically. The worker client caches artifact bytes by
  `(dataId, version)` (`src/worker/data_plane_client.ts`). `latest` resolution,
  `queryData` and `deleteData` are control-plane capabilities
  (`src/serve/capability_service.ts`). See
  [remote-execution.md](../enablers/remote-execution.md#data-plane-two-transports).

## Invariants

- A `(type, modelId, name, version)` directory is written once and never
  modified; new content is a new version. `raw` and `metadata.yaml` land via
  atomic rename.
- Version numbers are allocated by `mkdir`, so two concurrent writers to the
  same name get distinct versions rather than clobbering each other.
- Exactly one `latest` per name on disk and exactly one `is_latest=1` row per
  `(namespace, type, modelId, name)` in the catalog; every mutating path
  (`save`, `append`, `rename`, `delete`, `collectGarbage`, deferred advance)
  re-establishes both before returning.
- Only the owner — same `ownerType` and `ownerRef` — may add a version to an
  existing name (`Data.isOwnedBy`, enforced in `save` and `allocateVersion`).
- `tags.type` is always present; writers set it to `resource` or `file` and
  callers cannot omit it (`DataMetadataSchema`).
- Names never contain path separators, `..` or NUL, and `latest` is reserved;
  the repository additionally asserts every computed path stays under its base
  directory (`assertSafePath`, `assertPathContained`).
- Sensitive values are replaced by vault references before bytes are written; a
  spec with sensitive fields and no configured vault cannot be persisted.
- Catalog rows are derived state. Deleting `_catalog.db` loses nothing; the next
  query rebuilds it from `metadata.yaml`.
- Every mutation under the datastore tier calls `markDirty` first, so a remote
  datastore can never miss a changed path.

## Known limits

- Write-time GC (`autoGc`) enforces only integer version caps; duration-based
  `garbageCollection` is applied by `swamp data gc` alone
  (`unified_data_repository.ts` `save`).
- `job` and `workflow` lifetimes have no dependency tracking of their own; they
  expire when the run record is gone, and data with these lifetimes but no
  `workflowRunId` is never expired (`data_lifecycle_service.ts` `isExpired`).
- Deletes of a name do not update the `ModelOutput` records that reference it.
- Ephemeral data does not survive workflow suspension: a resume creates a fresh
  in-memory store
  ([data-query.md](../enablers/data-query.md#lifecycle-scoping)).
- Cross-namespace reads (`ns:model`) need the catalog; the filesystem fallback
  logs a warning and reads the caller's own namespace instead
  (`data_access_service.ts`).
- `swamp data delete` and `swamp data gc` cannot reach data whose definition is
  gone; only `swamp data prune` can, and it is inferential — a definition absent
  during a branch switch looks orphaned
  ([datastores.md](../enablers/datastores.md#orphaned-data-reclamation-swamp-data-prune)).
- The repository constructor still defaults its namespace to solo; the in-code
  note on `FileSystemUnifiedDataRepository` records that every direct
  construction site must thread the configured namespace via
  `namespaceFromResolver` or it will stamp solo rows against namespaced paths.
