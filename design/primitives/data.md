---
audience: maintainer, operator
last-verified: 2026-09-07 @ 58652907
---

# Data

Data is what a method run produces. Every artifact is addressed by
`(type, modelId, name, version)` and never changes once written: a second write
to a name creates version 2 rather than rewriting version 1. A SQLite catalog
beside the files makes data queryable. Definitions are not data. They live
in `models/`, tracked in git, while data lives in the datastore (default
`.swamp/data/`) and is never committed.

Details live in two enablers: [data-query.md](../enablers/data-query.md) (queries
and the catalog) and [datastores.md](../enablers/datastores.md) (backends, sync,
namespaced paths, locking).

## Why

- **Immutable + versioned.** A `DataId` is a random UUID, not a content hash
  (`src/domain/data/data_id.ts`). The `(dataId, version)` pair is the stable
  identity, and a bare name resolves to `latest`. So workers can cache artifact
  bytes forever, `data.latest()` is a cheap pointer read, and workflow re-runs
  have a history to reconcile against
  ([remote-execution.md §Data semantics](../enablers/remote-execution.md#data-semantics)).
- **A catalog beside the files.** Content stays on disk; the catalog holds only
  metadata rows, so CEL predicates can be pushed down to SQL instead of walking
  the tree. It is
  local-only, not synced, and heals itself by backfilling from disk
  (`src/infrastructure/persistence/catalog_store.ts`).
- **Sensitive fields never land in data.** `sensitive` values are moved to a
  vault before serialisation and replaced with a vault expression. A redactor
  scrubs any already-known secret from the written bytes
  (`src/domain/models/data_writer.ts`). Data files can be synced, copied and
  queried freely; vault contents cannot.

## The record

A data item is the `Data` entity (`src/domain/data/data.ts`) plus its bytes,
stored as `metadata.yaml` and validated by `DataMetadataSchema`
(`src/domain/data/data_metadata.ts`). Readers get a `DataRecord`
(`src/domain/data/data_record.ts`) from the mappers in
`src/domain/data/data_record_mapper.ts`.

| Field                    | Meaning                                                                                                                                  | Source                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `type` / `modelId`       | Owning model type (directory-normalised) and definition UUID; part of the path, not of `metadata.yaml`                                   | `unified_data_repository.ts` `getDataNameDir`            |
| `name`                   | Instance name. No `..`, `/`, `\`, NUL; `latest` is reserved (any case)                                                                   | `data_metadata.ts`; `data.ts` `isReservedDataName`       |
| `id`                     | UUID shared by every version of one name                                                                                                 | `data_id.ts`                                             |
| `version`                | Positive integer from 1, allocated by `mkdir` claim                                                                                      | `unified_data_repository.ts` `atomicAllocateVersionDir`  |
| `namespace`              | Which repo wrote it in a shared datastore; `""` in solo mode. Catalog column `namespace`, `ns` in CEL                                    | `namespace.ts`; `catalog_store.ts`                       |
| `contentType`            | MIME type; always `application/json` for resources                                                                                       | `data_writer.ts` `createResourceWriter`                  |
| `lifetime`               | `Nm/h/d/w/mo/y`, `ephemeral`, `infinite`, `job`, `workflow`; zero durations become `workflow`                                            | `data_metadata.ts` `LifetimeSchema`, `normalizeLifetime` |
| `garbageCollection`      | Keep N versions (integer) or versions younger than a duration                                                                            | `data_metadata.ts` `GarbageCollectionSchema`             |
| `streaming`              | Line-oriented file written incrementally                                                                                                 | `data_writer.ts` `writeLine`                             |
| `tags`                   | String map; must contain `type`. Writers add `specName` and `modelName`                                                                  | `data_metadata.ts`; `data_writer.ts`                     |
| `ownerDefinition`        | `ownerType` (`model-method`, `workflow-step`, `manual`) + `ownerRef` (the model id); workflow provenance (below); legacy `definitionHash` | `data_metadata.ts` `OwnerDefinitionSchema`               |
| `size`, `checksum`       | Byte length and SHA-256 of `raw`                                                                                                         | `unified_data_repository.ts` `computeChecksum`           |
| `lifecycle`, `renamedTo` | `deleted` marks a tombstone; `renamedTo` makes it a forwarding tombstone                                                                 | `data.ts` `withDeletionMarker`, `withRenameMarker`       |

Workflow provenance is `workflowId`, `workflowRunId`, `workflowName`,
`jobName`, `stepName` and `source`. The optional `definitionHash` is kept only
for data already on disk.

**Kinds.** The writer sets the `type` tag: `resource` for JSON written through
`writeResource`, `file` for anything written through a `DataWriter`
(`data_writer.ts`). Other producers set their own value; reports write
`type: report` ([reports.md](../enablers/reports.md#data-persistence)).
`swamp data list --type` still accepts `log` and `data`, but no first-party
writer emits them; the old log type became `files` with `streaming: true`
([models.md §Files](./models.md#files)).

**Vary dimensions.** A definition or workflow step can declare `vary` on an
output spec (`src/domain/models/data_output_override.ts`). The runtime turns the
named inputs into a suffix (`src/domain/workflows/data_suffix.ts`
`coerceToSuffix`), and the writer stores the instance as `{name}-{suffix}`
(`data_writer.ts`, `resolvedVarySuffix`; pure form `composeDataName` in
`src/domain/data/composite_name.ts`). There is no separate dimension column.

**`latest`.** Each name directory holds a plain-text `latest` file with the
current version number. Reads without a version use it (`getLatestVersion`,
falling back to a symlink for older layouts, then a directory scan). The catalog
mirrors it as `is_latest`, and `upsertNewVersion` (`catalog_store.ts`) is
step-aware. A model-method write (`step_name = ""`) demotes every prior latest
row for the name; a workflow-step write demotes only rows with the same
`step_name` or an empty one. That leaves one `is_latest=1` row per
`(namespace, type, modelId, name, step_name)`
([data-query.md §Step-aware versioning](../enablers/data-query.md#provenance-based-filtering)).

**`ModelOutput`, the run-level record.** Every method call also writes a
`ModelOutput` (`src/domain/models/model_output.ts`) with status
(`pending|running|succeeded|failed|cancelled`), timing, error, provenance
(`triggeredBy`, workflow/run/step, `definitionHash`, `bundleFingerprint`) and
`artifacts.dataArtifacts` (a list of `{dataId, name, version, tags}`). It is YAML
under `outputs/` (`src/infrastructure/persistence/yaml_output_repository.ts`),
read with
`swamp model output ...` or `swamp model output data <output_id>`
(`src/cli/commands/model_output_data.ts`). It points at data; it is not data.

## Writing data

Methods write through two `MethodContext` functions
(`src/domain/models/model.ts`), bound to the running model by
`src/domain/models/data_writer.ts`:

- `writeResource(specName, name, data, overrides?)` checks `data` against the
  spec's Zod schema (warns, does not throw), resolves tags and policy, moves
  sensitive fields to a vault, serialises JSON and calls `repo.save`.
- `createFileWriter(specName, name, overrides?)` returns a `DataWriter` with:
  `writeAll`/`writeText` (one-shot save), `writeLine` (append, durable per
  line), `writeStream` (pipe a `ReadableStream`), and `getFilePath` + `finalize`
  (give a subprocess the real `raw` path, then seal the version).

Both reject undeclared spec names, empty names and the reserved name `latest`.

**One write, in order** (`unified_data_repository.ts` `save`):

1. Tell the sync layer the name directory is dirty.
2. Check the existing owner matches (`OwnershipValidationError` otherwise).
3. Claim the next version directory with `mkdir`, retrying up to 100 times on
   `AlreadyExists`.
4. Write `metadata.yaml` and `raw` via atomic temp-file rename.
5. Rewrite the `latest` marker.
6. Upsert the catalog row.

Streaming writers split this into `allocateVersion` (claim the directory, return
the path) and `finalizeVersion` (checksum, metadata, marker, catalog). A write
is durable once `await` returns. Nothing is held back to commit at the end, so a
method that writes and then throws keeps its writes
([remote-execution.md](../enablers/remote-execution.md#writes-are-immediately-durable-not-staged)).

**`rollbackOnFailure`.** A method definition can opt into all-or-nothing
writes. Writers then use `saveDeferred` / `finalizeVersionDeferred`: version
directory and metadata are written, but the `latest` marker is untouched and the
catalog row has `is_latest=0`. On success `advanceLatestMarkers` flips them; on
failure `rollbackVersions` removes the directories and rows
(`unified_data_repository.ts`;
[models.md §Write Atomicity](./models.md#write-atomicity-rollbackonfailure)).

**Tags** are resolved in a fixed order (`data_writer.ts`): the `type`
auto-tag, the definition's `tags`, the spec's default tags, per-call
`overrides.tags`, the `specName` and `modelName` auto-tags, then workflow step
tag overrides (which also feed `ownerDefinition.workflowRunId` etc.). Next come
runtime tags from `--tag KEY=VALUE` on `swamp model method run` /
`swamp workflow run` (`src/cli/commands/model_method_run.ts`,
`workflow_run.ts`). Last is the definition-level `dataOutputOverrides` for that
spec: lifetime, GC, tags, vary, vault name (`data_output_override.ts`).

**Sensitive fields.** For a resource spec with `{ sensitive: true }` fields or
`sensitiveOutput: true`, `processSensitiveResourceData` stores each value in a
vault and replaces it in the payload with
`${{ vault.get('<vault>', '<key>') }}`. The key is `field.vaultKey` or the
derived `type/modelId/method/spec/instance/field.path`. The vault is
`field.vaultName ?? spec.vaultName ?? default vault ?? first user vault`.
`modelRequiresVault()` (`data_writer.ts`) tells callers up front whether a
model has such a spec. With no vault configured, the write fails rather than
saving the secret. The whole serialised payload then passes through the
run's `SecretRedactor`, which also scrubs log output
(`src/domain/secrets/secret_redactor.ts`). On read, `resolveVaultRefsInData`
expands the references and registers the values with the redactor
(`data_writer.ts`, `data_record_mapper.ts`).

**Deletion by a method.** When a `delete`-kind method succeeds,
`method_execution_service.ts` writes a tombstone version (`lifecycle: deleted`)
for every declared resource: the last known attributes plus `deletedAt` /
`deletedByMethod`. `data.latest()` still returns the final state, which keeps
workflow re-runs idempotent. `context.deleteResource(name)` is the hard form and
removes every version.

## Reading data

- **CEL**: `data.latest("model", "name")`, `data.version(...)`,
  `data.query('<predicate>')` and related functions all return `DataRecord`.
  `attributes` is the parsed JSON for resources. `content` is the parsed object
  for `application/json`, and the raw text for other text types (`text/*`,
  `application/yaml`, `application/x-yaml`; `content_type.ts`,
  `data_record_mapper.ts` `parseContent`). Model names may be qualified as
  `ns:model`, or `*:model` for every namespace, except in `data.findByTag`,
  which always reads the caller's own namespace
  ([data-query.md](../enablers/data-query.md)).
- **In a method**: `context.readModelData(modelName, specName?)`,
  `context.readResource(instanceName, version?)` (the model's own resource, with
  vault references resolved) and `context.queryData(predicate, select?)`
  (`model.ts`). `DataAccessService` backs them
  (`src/domain/data/data_access_service.ts`). With a catalog, it scopes the
  predicate to the caller's namespace unless the name has one. Without a
  catalog, it walks the filesystem, and if the definition's UUID changed it
  finds data written under the old UUID: first by `modelName` tag, then, only
  when the type has a single definition, by that definition. This "orphan
  recovery" is a read-time convenience, never a delete.
- **CLI**: `swamp data get <model> <name> [--version N] [--no-content]`, or
  `--workflow <name> [--run <id>]` to read what a run produced
  (`src/domain/data/workflow_data_service.ts`). Also `swamp data list` (grouped
  by type), `swamp data versions`, `swamp data search` and
  `swamp data query '<predicate>' [--select] [--limit]`
  (`src/cli/commands/data_*.ts`). `search` takes free text plus `--type`,
  `--lifetime`, `--owner-type`, `--workflow`, `--model`, `--content-type`,
  `--since`, `--output`, `--run`, `--tag KEY=VALUE`, `--streaming`, `--limit`.
  Only `search` and `query` read the catalog. `get`, `list` and `versions` use
  the filesystem repository (`src/libswamp/data/{get,list,versions}.ts`). Every
  `swamp data` subcommand accepts `--server` to run against a serve instance.

## Versioning and lifecycle

Versions only grow; `save` never overwrites. A name's `latest` moves forward on
write, and back only when the current latest is deleted or collected (`delete`
and `collectGarbage` recompute it from the remaining directories). These remove
versions:

| Mechanism                       | Removes                                                                                  | Source                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Write-time cap (`autoGc: true`) | On each save, versions beyond an **integer** `garbageCollection` cap                     | `unified_data_repository.ts` `pruneExcessVersions`; `.swamp.yaml` `autoGc`     |
| Post-run GC (`autoGc: true`)    | After each `model method run`: the model's `collectGarbage` plus lifetime expiry of its names | `src/libswamp/models/run.ts`; `src/libswamp/data/gc.ts` `autoGc`               |
| `swamp data gc`                 | Phase 1: whole names whose `lifetime` expired. Phase 2: per-name version GC              | `src/domain/data/data_lifecycle_service.ts` `deleteExpiredData`                |
| `swamp data delete`             | One version, one name, `--prefix` many names, or `--all` for a model                     | `src/domain/data/data_delete_service.ts`; `src/libswamp/data/delete.ts`        |
| `swamp data prune`              | Every name under a `(type, modelId)` whose definition no longer resolves                 | `data_lifecycle_service.ts` `deleteOrphanedData`; `src/libswamp/data/prune.ts` |
| `swamp run gc`                  | Old `outputs/` and `workflow-runs/` records; never `data/`                               | `src/domain/data/run_lifecycle_service.ts`                                     |

Post-run GC applies both count and duration caps; its failures warn and never
fail the run. `swamp data gc` phase 2 collects by count or duration.
`swamp data delete` confirms unless `--force`/`--yes`; `--dry-run` previews
`--prefix`/`--all`. `swamp run gc` uses `.swamp.yaml` `garbageCollection`,
otherwise 30 days each.

Expiry rules (`calculateExpiration`, `isExpired`): duration lifetimes expire
at `createdAt + duration`; `infinite` never; `workflow` and `job` when the
owning workflow run record is gone; `ephemeral` never reaches the persistent
store. Lifetime expiry (phase 1, `data_lifecycle_service.ts`) skips tombstones
(`lifecycle: deleted`), so a deleted resource's final state stays until it is
explicitly removed. Phase 2 `collectGarbage` still prunes older versions under
a tombstoned name.

What each removal keeps:

- **Per-version delete** drops the directory and its catalog row, then repoints
  `latest` and re-upserts the remaining latest row. Deleting the last version
  removes the name directory and all its rows.
- **Whole-name delete, gc and prune** remove the name subtree and its catalog
  rows. No tombstone is written, and `ModelOutput` records that reference the
  artifact are left dangling.
- **`removeLatestMarker`** is a soft delete. Version directories stay on disk,
  but the marker and catalog rows go, so `latest` reads no longer see the name.
  The serve `deleteData` capability uses it with `removeLatestMarkerOnly`
  (`src/serve/capability_service.ts`).
- **`swamp data rename`** copies the latest version to the new name and writes
  a forwarding tombstone (`renamedTo`) under the old one. `findByName` follows
  the forward for reads without a version
  (`src/domain/data/data_rename_service.ts`, `unified_data_repository.ts`).

`gc`, `prune` and `delete` take the global datastore lock. On a remote
datastore they push their deletions in the same sync. `gc --dry-run` and
`prune --dry-run` use the read-only path with no lock
(`src/cli/commands/data_gc.ts`, `data_prune.ts`;
[datastores.md](../enablers/datastores.md#orphaned-data-reclamation-swamp-data-prune)).

## Where it lives

Datastore-tier layout, default root `.swamp/`. `SWAMP_SUBDIRS` also names
`definitions`, `definitions-evaluated`, `workflows`, `workflows-evaluated`,
`vault`, `secrets`, `telemetry`, `logs`, `files`, `bundles`, `vault-bundles`,
`datastore-bundles`, `report-bundles`, `auto-definitions`, `audit`,
`pulled-extensions/*` and the legacy `inputs`, `inputs-evaluated`, `resources`
(`src/infrastructure/persistence/paths.ts`;
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

- **Catalog.** `catalogDbPath` alone defines the path
  (`src/infrastructure/persistence/repository_factory.ts`): `_catalog.db` in
  the local `data/` directory, so a shared datastore never carries it. On
  open, a `CATALOG_SCHEMA_VERSION` mismatch drops the table and clears the
  `populated` flag; the next query refills it from disk (`catalog_store.ts`
  `migrateIfNeeded`). Every write path keeps one `is_latest=1` row per
  `(name, step_name)` via `upsertNewVersion` ([`latest`](#the-record)).
- **Datastores and sync.** The repository writes wherever the
  `DatastorePathResolver` points. A remote backend (S3 extension) gets a
  `markDirty` hook on its changes, is pulled when a write command starts, and is
  pushed when it flushes. The `twoPhaseSync` capability lets an extension opt
  into splitting the push into `preparePush` / `commitPush`
  (`src/cli/repo_context.ts` `flushTwoPhasePush`;
  [datastores.md](../enablers/datastores.md#two-phase-sync)). Definitions are
  never in the datastore.
- **Namespaces.** In a shared datastore each repo gets a slug
  (`swamp datastore namespace set <slug>`). The slug matches
  `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/`, is at most 64 chars and has no trailing
  `-` (`src/domain/data/namespace.ts`). `swamp datastore namespace list` shows
  the registered slugs. The resolver prefixes the datastore tier as
  `{base}/{namespace}/data/...`, and the repository stamps every catalog row
  with the same namespace (`namespaceFromResolver` keeps them in step). Other
  namespaces become queryable by pulling their catalog exports
  (`swamp datastore catalog pull`).
- **Ephemeral store.** `lifetime: ephemeral` data goes to an
  `InMemoryUnifiedDataRepository` with a `:memory:` catalog. A
  `CompositeUnifiedDataRepository` wraps it with the persistent repository,
  routes writes by lifetime and reads ephemeral first
  (`src/infrastructure/persistence/in_memory_data_repository.ts`,
  `src/domain/data/composite_data_repository.ts`). One store exists per
  workflow run or standalone method run, disposed in `finally`. It is capped at
  `DEFAULT_EPHEMERAL_MAX_BYTES` (512 MB; override with the
  `SWAMP_EPHEMERAL_BUDGET` env var) and throws `EphemeralBudgetExceededError`
  past that
  (`src/infrastructure/persistence/ephemeral_store.ts`;
  [data-query.md §Ephemeral Data](../enablers/data-query.md#ephemeral-data)).
- **Remote data plane.** Workers have no datastore configuration. Large byte
  traffic goes over HTTP to the orchestrator (`src/serve/data_plane.ts`).
  Reads use `GET /data/{type}/{modelId}/{dataName}/{version}`. Writes use
  `POST /data/resource`, `DELETE /data/resource` and the `/data/writers/...`
  routes for file writers (open, per-line append, streamed content, finalize).
  Every write is authorised against the worker's active dispatch and uses the
  same `createResourceWriter` / `createFileWriterFactory` as a local run, on the
  dispatch's own composite repository. So ephemeral data and tags behave the
  same as locally. The worker client caches
  artifact bytes by `(dataId, version)` (`src/worker/data_plane_client.ts`).
  `latest` resolution, `queryData` and `deleteData` are control-plane
  capabilities (`src/serve/capability_service.ts`). See
  [remote-execution.md](../enablers/remote-execution.md#data-plane-two-transports).

## Invariants

- A `(type, modelId, name, version)` directory is written once and never
  changed; new content is a new version. `raw` and `metadata.yaml` are written
  via atomic rename.
- Version numbers are allocated by `mkdir`, so two concurrent writers to one
  name get different versions.
- Exactly one `latest` per name on disk, and exactly one `is_latest=1` row per
  `(namespace, type, modelId, name, step_name)` in the catalog. Every mutating
  path restores both before returning: `save`, `append`, `rename`, `delete`,
  `collectGarbage` and deferred advance.
- Only the owner (same `ownerType` and `ownerRef`) may add a version to an
  existing name (`Data.isOwnedBy`, enforced in `save` and `allocateVersion`).
- `tags.type` is always present: writers set `resource` or `file`, and callers
  cannot omit it (`DataMetadataSchema`).
- Names never contain path separators, `..` or NUL, and `latest` is reserved.
  The repository also asserts that every computed path stays under its base
  directory (`assertSafePath`, `assertPathContained`).
- Sensitive values are replaced by vault references before bytes are written.
  A spec with sensitive fields and no configured vault cannot be saved.
- Catalog rows are derived state. Deleting `_catalog.db` loses no local data;
  the next query rebuilds it from `metadata.yaml`. It does drop foreign rows
  fetched by `swamp datastore catalog pull` (`catalog_store.ts`
  `bulkUpsertForeign`); pull again to restore them.
- Every public mutation that starts from a clean state (`save`, `append`,
  `delete`, `rename`, `allocateVersion`, `finalizeVersion`,
  `removeLatestMarker`) calls `markDirty` before touching disk.
  `collectGarbage` and `pruneExcessVersions` notify per removed path in their
  loops. The deferred `advanceLatestMarkers` / `rollbackVersions` do not
  notify; they rely on the earlier `saveDeferred` / `finalizeVersionDeferred`
  signal (`unified_data_repository.ts`).

## Known limits

- Write-time GC inside `save` enforces only integer version caps
  (`unified_data_repository.ts` `pruneExcessVersions`). Duration-based
  `garbageCollection` waits for the post-run `autoGc` pass or `swamp data gc`.
- `job` and `workflow` lifetimes have no dependency tracking of their own; they
  expire when the run record is gone. Such data with no `workflowRunId` never
  expires
  (`data_lifecycle_service.ts` `isExpired`).
- Deleting a name does not update the `ModelOutput` records that reference it.
- Ephemeral data does not survive workflow suspension; a resume starts a new
  in-memory store
  ([data-query.md](../enablers/data-query.md#lifecycle-scoping)).
- Cross-namespace reads (`ns:model`) need the catalog. Without it, the
  filesystem fallback logs a warning and reads the caller's own namespace
  (`data_access_service.ts`).
- `swamp data delete` and `swamp data gc` cannot reach data whose definition is
  gone. Only `swamp data prune` can, and it infers orphans: a definition missing
  during a branch switch looks orphaned
  ([datastores.md](../enablers/datastores.md#orphaned-data-reclamation-swamp-data-prune)).
- The repository constructor still defaults its namespace to solo. The in-code
  note on `FileSystemUnifiedDataRepository` says every direct construction site
  must pass the configured namespace via `namespaceFromResolver`, or it will
  stamp solo rows against namespaced paths.
