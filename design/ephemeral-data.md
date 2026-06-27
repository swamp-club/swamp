# Ephemeral Data: In-Memory Repository Design

## Problem

Swamp defines an `"ephemeral"` lifetime for data artifacts — data that should
only exist for the duration of a method invocation or workflow execution. Today,
`"ephemeral"` is accepted by the type system and schema but **not implemented**.
The lifecycle service at `src/domain/data/data_lifecycle_service.ts:136-140` logs
a warning and returns `null`:

```typescript
if (lifetime === "ephemeral") {
  // Not implemented yet - requires tracking execution context
  logger.warn("Ephemeral lifetime is not yet implemented");
  return null;
}
```

When a user sets `lifetime: "ephemeral"` on a model output spec, the data gets
written to disk via `FileSystemUnifiedDataRepository`, stored in the SQLite
catalog, and **never cleaned up** — it behaves identically to `"infinite"`.

## Goal

Implement ephemeral data as a **global in-memory store** that:

1. Never writes to disk — content and metadata live only in memory
2. Is **indexed for search** so it behaves identically to persistent data from a
   query perspective (CEL `data.latest()`, `data.query()`, `data.search()` all
   work)
3. Is scoped to the **lifetime of the workflow run or method run** that created
   it — when that execution completes, the in-memory store is dropped
4. Is **available across remote execution** — workers dispatched by the
   orchestrator can read/write ephemeral data through the same interfaces
5. Requires **no new CEL functions** — existing `data.latest()` transparently
   resolves from the in-memory store; the engine determines whether data is
   in-memory or on disk

## Design Constraints

- Ephemeral data is the foundation for **dynamic data lookups** that models and
  workflows consume during execution (intermediate results, computed context,
  runtime-resolved references)
- The in-memory store must be a **global store**, not per-step, so that
  downstream steps in a workflow can read ephemeral data produced by upstream
  steps
- Existing `data.latest(modelName, dataName)` calls must work without
  modification — the routing between in-memory and on-disk is transparent to the
  caller
- Ephemeral data must appear in `data.query()` and `data.search()` results when
  the predicate matches

## Architecture

### Core Component: `InMemoryUnifiedDataRepository`

Create a new implementation of `UnifiedDataRepository` (defined in
`src/domain/data/repositories.ts:54-411`) that stores all data in memory.

**Location:** `src/infrastructure/persistence/in_memory_data_repository.ts`

The existing interface has ~30 methods across async operations, sync operations
(for CEL evaluation), and path/lifecycle utilities. The in-memory implementation
must satisfy the full interface.

#### Internal Storage

```
Map<string, Data>         — keyed by "{type}:{modelId}:{dataName}:{version}"
Map<string, Uint8Array>   — content bytes, same key scheme
Map<string, number>       — latest version tracker, keyed by "{type}:{modelId}:{dataName}"
```

#### Method-by-Method Implementation Notes

**Write operations:**

- `save(type, modelId, data, content)` — Store the `Data` entity and content
  bytes in the maps. Atomically update the latest version tracker. Return
  `{ version }`. Must validate ownership (compare `ownerType` + `ownerRef`)
  against existing data with the same name, throwing
  `OwnershipValidationError` (from `src/domain/data/repositories.ts:28-41`) on
  mismatch — same contract as the filesystem implementation.
- `append(type, modelId, dataName, content)` — Append bytes to existing content
  entry (concatenate `Uint8Array`). Only for `streaming: true` data.
- `allocateVersion(type, modelId, data)` — Allocate a version number and return
  it with a **synthetic content path**. The path won't be a real filesystem
  path — see "allocateVersion / finalizeVersion" section below.
- `finalizeVersion(type, modelId, data, version)` — Compute checksum (SHA-256)
  and size from the stored content bytes. Write metadata entry.

**Read operations:**

- `findByName(type, modelId, dataName, version?)` — Map lookup. If no version
  specified, use latest version tracker. Return `Data` entity or `null`.
- `findById(type, modelId, dataId, version?)` — Scan the data map for matching
  `id`. Less efficient but acceptable for in-memory store.
- `findAllForModel(type, modelId)` — Filter the data map by type and modelId,
  returning latest version of each.
- `findAllGlobal()` — Return all entries (latest version of each).
- `getContent(type, modelId, dataName, version?)` — Map lookup for content
  bytes.
- `stream(type, modelId, dataName, version?)` — Yield the full content as a
  single chunk (no need for 8KB chunking in memory).
- `listVersions(type, modelId, dataName)` — Scan the data map for all versions
  of this name, return sorted.

**Sync operations (for CEL):**

All sync methods (`findByNameSync`, `getContentSync`, `getLatestVersionSync`,
`listVersionsSync`, `findAllForModelSync`, `findAllGlobalSync`) are trivial —
they do the exact same map lookups as their async counterparts. This is a
significant advantage: the filesystem implementation reads from disk
synchronously (via `Deno.readTextFileSync` / `Deno.readFileSync`), but the
in-memory implementation has zero I/O overhead.

**Path operations:**

- `getPath(type, modelId, dataName, version)` — Return a synthetic path like
  `ephemeral://{type}/{modelId}/{dataName}/{version}`. This path is never
  accessed on disk; it exists only to satisfy the interface contract.
- `getContentPath(type, modelId, dataName, version)` — Same pattern:
  `ephemeral://{type}/{modelId}/{dataName}/{version}/raw`.

**Lifecycle operations:**

- `delete(type, modelId, dataName, version?)` — Remove from maps.
- `removeLatestMarker(type, modelId, dataName)` — Remove from latest version
  tracker.
- `collectGarbage(type, modelId, options?)` — Apply version retention per GC
  policy, same logic as filesystem.
- `rename(type, modelId, oldName, newName)` — Move entries in maps.

**Identity:**

- `nextId()` — Generate a UUID using `crypto.randomUUID()`, same as filesystem
  implementation.
- `namespace` — Accept via constructor, same as filesystem implementation.

#### The `allocateVersion` / `finalizeVersion` Pattern

The `DataWriter` (`src/domain/models/data_writer.ts`) uses a two-phase write
pattern for large files and streaming:

1. `allocateVersion()` returns a `contentPath` where the caller writes content
   directly via `Deno.open()`
2. `finalizeVersion()` reads back the content at that path to compute
   checksum/size

For the in-memory repository, this pattern needs adaptation:

- `allocateVersion()` returns a synthetic path and allocates a version number
- The `DataWriter` calls `Deno.open()` on that path — this will fail because the
  path doesn't exist on disk

**Solution:** The `DataWriter` must be made aware of the repository type. The
simplest approach: add an optional `writeContent(version: number, content: Uint8Array): void`
method to `UnifiedDataRepository`. When present, the `DataWriter` uses it
instead of direct file I/O via `Deno.open()`. The filesystem implementation does
not need to implement this — it's only needed for in-memory.

Alternatively, implement `allocateVersion` to create a real temporary file in
`Deno.makeTempFile()` and have `finalizeVersion` read the temp file, store the
content in the in-memory map, and delete the temp file. This avoids changing the
`DataWriter` interface but introduces unnecessary disk I/O for what should be a
pure in-memory operation. The first approach is preferred.

### Catalog Integration: In-Memory SQLite

Ephemeral data **must be indexed for search**. The existing `CatalogStore`
(`src/infrastructure/persistence/catalog_store.ts`) is SQLite-backed and already
supports `:memory:` databases — you can pass `":memory:"` as the `dbPath`
constructor argument and all operations work identically: schema creation,
queries, `iterate()`, transactions.

Each ephemeral data store gets its own `:memory:` `CatalogStore` instance. When
the in-memory repository's `save()` method is called, it also calls
`catalogStore.upsertNewVersion()` to index the data — same write-through pattern
as the filesystem implementation.

**Constructor:**

```typescript
const ephemeralCatalog = new CatalogStore(":memory:");
```

No code changes to `CatalogStore` are needed.

### Composite Pattern: Routing Between In-Memory and On-Disk

Create a `CompositeUnifiedDataRepository` that wraps both the filesystem
repository and the in-memory repository. It routes operations based on lifetime:

**Location:** `src/domain/data/composite_data_repository.ts`

```
CompositeUnifiedDataRepository
  ├── filesystemRepo: FileSystemUnifiedDataRepository  (persistent data)
  └── ephemeralRepo: InMemoryUnifiedDataRepository     (ephemeral data)
```

**Write routing:** When `save()` is called with a `Data` entity whose
`lifetime === "ephemeral"`, route to the ephemeral repo. Otherwise, route to the
filesystem repo.

**Read routing:** For reads like `findByName()`, check the ephemeral repo first.
If found, return it. If not found, fall back to the filesystem repo. This is
correct because:

- Ephemeral data names are scoped by `(type, modelId, dataName)` — the same
  scoping as persistent data
- A caller asking for data by name doesn't know (or care) whether it's ephemeral
  or persistent
- The ephemeral repo is checked first because it represents the "current
  execution context" and should shadow any stale persistent data with the same
  name

**Query routing:** For `findAllGlobal()`, `findAllForModel()`, and the sync
variants, merge results from both repositories. The `DataQueryService` iterates
catalog rows — so the composite must also expose a merged catalog view. See
"DataQueryService Integration" below.

**Sync reads:** Same pattern — check ephemeral first, fall back to filesystem.

### DataQueryService Integration

`DataQueryService` (`src/domain/data/data_query_service.ts`) is the engine
behind `data.latest()`, `data.query()`, and `data.search()`. It works by:

1. Ensuring the catalog is populated (backfill from disk if needed)
2. Iterating catalog rows via `catalogStore.iterate()`
3. Evaluating a CEL predicate against each row
4. Lazy-loading JSON content for matching rows

For ephemeral data to appear in queries, `DataQueryService` needs access to
**both** the persistent catalog and the ephemeral catalog.

**Approach:** Create a `CompositeDataQueryService` that wraps two
`DataQueryService` instances — one backed by the persistent catalog + filesystem
repo, one backed by the ephemeral `:memory:` catalog + in-memory repo. Queries
merge results from both, deduplicating by `(type, modelId, dataName, version)`.

Alternatively, modify `DataQueryService` to accept multiple catalog stores and
iterate across all of them. This is simpler but changes an existing class.

The recommended approach is the composite wrapper, since it requires no changes
to the existing `DataQueryService`.

### CEL Resolution: Transparent and Unchanged

The `data.latest()` CEL function is implemented in
`src/domain/expressions/model_resolver.ts:654-671`:

```typescript
latest: async (
  rawModelName: string,
  dataName: string,
): Promise<DataRecord | null> => {
  if (!this.dataQueryService) return null;
  const ns = routeNamespace(rawModelName, ownNamespace);
  const predicate = `modelName == "${escapeCelString(ns.modelName)}" ` +
    `&& name == "${escapeCelString(dataName)}"` +
    ns.namespacePredicate;
  const results = await this.dataQueryService.query(predicate, {
    limit: ns.isWildcard ? undefined : 1,
    loadAttributes: true,
  }) as DataRecord[];
  // ...
  return results.length > 0 ? results[0] : null;
},
```

This delegates entirely to `DataQueryService.query()`. If the
`DataQueryService` is replaced with a composite that searches both catalogs, no
changes are needed here. The CEL engine doesn't know or care whether the data
came from memory or disk.

## Lifecycle Management

### Scoping: Per Workflow Run or Per Method Run

The in-memory store is created when an execution begins and destroyed when it
ends. "Execution" means either:

1. **A workflow run** — the store lives from `run.start()` to `run.complete()`
   (or error/suspension cleanup)
2. **A standalone method run** — the store lives from method setup to the
   `finally` block at `runLog.cleanup()`

### Workflow Run Lifecycle

In `src/domain/workflows/execution_service.ts`, the `WorkflowExecutionService.run()`
method (line 1274) has clear lifecycle boundaries:

**Creation point:** After the workflow is looked up and the run is created, but
before any steps execute. The in-memory repo and its `:memory:` catalog should
be created here and wired into the `StepExecutorDeps`.

**Cleanup points (all paths must be covered):**

1. **Success path** (line 1585): After `run.complete()` and reports, before
   teardown span ends. The `runFileSink.unregister()` call here is the existing
   cleanup pattern — add ephemeral store disposal alongside it.
2. **Suspension path** (line 1591-1604): `WorkflowSuspendedError` catch block.
   The workflow may resume later, so **do not dispose the ephemeral store on
   suspension** — it must survive across suspend/resume cycles. This is a key
   design decision: the ephemeral store must be serializable or re-creatable on
   resume. See "Suspend/Resume" section.
3. **Error path** (line 1606-1621): `workflowRun.complete()` is called, run is
   saved. Dispose the ephemeral store here.
4. **Finally block** (line 1622-1624): `runSpan.end()`. This is the ultimate
   safety net — if the ephemeral store hasn't been disposed by a prior path,
   dispose it here.

**Recommended pattern:** Mirror the existing `runFileSink` pattern:

```typescript
// Created during setup phase
const ephemeralStore = createEphemeralStore(namespace);

try {
  // ... execution ...
} finally {
  ephemeralStore.dispose(); // closes :memory: catalog, drops maps
}
```

### Method Run Lifecycle

In `src/libswamp/models/run.ts`, the `modelMethodRun()` generator (line 219)
has a single `finally` block at line 973-974:

```typescript
} finally {
  runLog.cleanup();
}
```

The ephemeral store should be created before method execution begins and disposed
in this `finally` block, alongside `runLog.cleanup()`.

### Serve-Side Lifecycle

In `src/serve/deps.ts`, the `executeWorkflowWithLocks()` function (line 235) has
its own `finally` block at line 301-313 that releases model locks. The ephemeral
store should be created before `workflowRun()` is called (line 298) and disposed
in this `finally` block.

## Dependency Injection Points

### Where Repositories Are Currently Constructed

There are three key construction sites that need to change:

#### 1. `DefaultStepExecutor.buildDeps()` — Workflow Steps

**File:** `src/domain/workflows/execution_service.ts:324-365`

Currently constructs a `FileSystemUnifiedDataRepository` directly:

```typescript
const unifiedDataRepo = new FileSystemUnifiedDataRepository(
  repoDir,
  opts.dataBaseDir,
  opts.catalogStore,
  opts.markDirty,
  undefined,
  opts.namespace ?? SOLO_NAMESPACE,
);
const dataQueryService = new DataQueryService(
  opts.catalogStore,
  unifiedDataRepo,
);
```

**Change:** Accept an optional `ephemeralRepo` and `ephemeralCatalog` in `opts`.
When present, wrap in `CompositeUnifiedDataRepository` and
`CompositeDataQueryService`:

```typescript
const compositeRepo = ephemeralRepo
  ? new CompositeUnifiedDataRepository(unifiedDataRepo, ephemeralRepo)
  : unifiedDataRepo;
const compositeQueryService = ephemeralCatalog
  ? new CompositeDataQueryService(
      new DataQueryService(opts.catalogStore, unifiedDataRepo),
      new DataQueryService(ephemeralCatalog, ephemeralRepo),
    )
  : new DataQueryService(opts.catalogStore, unifiedDataRepo);
```

#### 2. `createWorkflowRunDeps()` — Serve Path

**File:** `src/serve/deps.ts:66-158`

Returns `WorkflowRunDeps` which includes `catalogStore` and `dataRepo`. The
ephemeral store should be created here and passed through. The
`createExecutionService` callback (line 83) builds the
`WorkflowExecutionService` — it receives `catalogStore` and should also receive
the ephemeral catalog.

#### 3. `createRepositoryContext()` — CLI Path

**File:** `src/infrastructure/persistence/repository_factory.ts:357-478`

Returns `RepositoryContext` containing `unifiedDataRepo`, `catalogStore`, and
`dataQueryService`. For standalone method runs invoked via CLI, the ephemeral
store is created here and the context returns composite wrappers.

### `StepExecutorDeps` Interface

**File:** `src/domain/workflows/execution_service.ts:255-265`

```typescript
export interface StepExecutorDeps {
  definitionRepo: DefinitionRepository;
  unifiedDataRepo: UnifiedDataRepository;
  dataQueryService: DataQueryService;
  outputRepo: OutputRepository;
  evaluatedDefRepo: YamlEvaluatedDefinitionRepository;
  methodExecutionService: MethodExecutionService;
  vaultService: VaultService;
  expressionEvaluator: ExpressionEvaluationService;
  directTypeResolver?: DirectTypeResolver;
}
```

The `unifiedDataRepo` and `dataQueryService` fields are already typed as
interfaces (`UnifiedDataRepository` and `DataQueryService`). The composite
implementations satisfy these interfaces — no type changes needed.

## Remote Execution

### How It Works Today

Remote execution uses a WebSocket control plane + HTTP data plane architecture:

1. The **orchestrator** (serve process) holds all repositories and dispatches
   steps to enrolled **workers** via WebSocket RPC
2. Workers execute method code and write data back through the **data plane**
   (HTTP POST endpoints at `/data/resource`, `/data/writers`, etc.)
3. The data plane authenticates workers via session credentials and authorizes
   writes per active dispatch
4. All data ultimately lands in the orchestrator's repositories

**Key files:**
- `src/serve/dispatch_service.ts` — Dispatch lifecycle, worker acquisition
- `src/serve/data_plane.ts` — HTTP binary transfer, per-dispatch authorization
- `src/serve/worker_gateway.ts` — Worker pool management

### Ephemeral Data in Remote Execution

Since the orchestrator owns the repositories and the data plane is the write
interface for remote workers, ephemeral data for remotely-dispatched steps
naturally flows through the same path:

1. Worker writes ephemeral data via data plane HTTP POST
2. Data plane routes the write through the repository (which will be the
   composite)
3. The composite checks the `Data` entity's `lifetime` field and routes to the
   in-memory repo
4. Subsequent steps (local or remote) read the ephemeral data through the
   composite, which checks in-memory first

The data plane routes writes through `repoContext.unifiedDataRepo` — replacing
this with the composite is sufficient. No data plane code changes are needed
beyond ensuring the data entity's lifetime field is preserved through the HTTP
request/response cycle.

**Verify:** Check that the data plane's write endpoints preserve the `lifetime`
field from the `Data` entity when constructing the entity server-side. If the
data plane constructs its own `Data` entity from the HTTP request body, it must
include `lifetime` from the request.

## Suspend/Resume Consideration

Workflows can be **suspended** (e.g., manual approval steps) and **resumed**
later — potentially in a different process. The `WorkflowSuspendedError` at
`src/domain/workflows/execution_service.ts:1591` triggers this path.

Ephemeral data produced before suspension must survive the suspend/resume cycle.
Options:

1. **Serialize to disk on suspend, reload on resume** — Write the in-memory
   store's contents to a temporary location (e.g.,
   `.swamp/ephemeral/{workflowRunId}/`) on suspend. On resume, load them back
   into a fresh in-memory store. This preserves the "ephemeral = never in the
   persistent datastore" semantic while supporting durability across process
   boundaries.

2. **Accept that suspension converts ephemeral to persistent** — On suspend,
   write ephemeral data to the persistent datastore. On resume, no special
   handling needed — the data is already on disk. On workflow completion, clean
   up any data marked ephemeral. This is simpler but temporarily violates the
   "never on disk" property.

3. **Defer suspend/resume support** — Document that ephemeral data is lost on
   suspension. This is the simplest starting point and can be iterated on.

**Recommendation:** Start with option 3. Ephemeral data is designed for
within-execution intermediate results. If a workflow suspends for manual
approval, it's reasonable to require that the ephemeral data be re-computed on
resume, or that the author uses a different lifetime for data that must survive
suspension.

## Implementation Plan

### Phase 1: InMemoryUnifiedDataRepository

Create `src/infrastructure/persistence/in_memory_data_repository.ts`:

- Implement the full `UnifiedDataRepository` interface
- Use `Map`-based storage for data entities and content
- Accept a `CatalogStore` in the constructor (will receive a `:memory:` instance)
- Call `catalogStore.upsertNewVersion()` on every `save()` — same write-through
  pattern as `FileSystemUnifiedDataRepository`
- Implement `nextId()` via `crypto.randomUUID()`
- Return synthetic `ephemeral://` paths from `getPath()` / `getContentPath()`
- Add a `dispose()` method that clears all maps and closes the catalog

For the `allocateVersion` / `finalizeVersion` pattern, implement an internal
content buffer that the DataWriter can write to instead of opening a file. This
may require adding an optional method to the interface or adapting the DataWriter
to check the repository type.

### Phase 2: CompositeUnifiedDataRepository

Create `src/domain/data/composite_data_repository.ts`:

- Wrap a persistent `UnifiedDataRepository` and an ephemeral
  `InMemoryUnifiedDataRepository`
- Route writes by checking `data.lifetime === "ephemeral"`
- Route reads by checking ephemeral first, then falling back to persistent
- Merge results for `findAllGlobal()`, `findAllForModel()`, and their sync
  variants

### Phase 3: CompositeDataQueryService

Create `src/domain/data/composite_data_query_service.ts`:

- Wrap two `DataQueryService` instances (persistent + ephemeral)
- `query()` and `querySync()` run the predicate against both backing services
  and merge results, deduplicating by `(type, modelId, dataName, version)`
- Preserve the existing implicit `isLatest == true` injection behavior

### Phase 4: Wire Into Execution Lifecycle

**Workflow runs:**

1. In `WorkflowExecutionService.run()` (line 1274), create the ephemeral store
   during setup (after workflow lookup, before step execution)
2. Pass the ephemeral repo and catalog through `StepExecutorDeps` to
   `DefaultStepExecutor.buildDeps()`
3. Dispose in the `finally` block (line 1622-1624) — or mirror the
   `runFileSink` pattern with explicit disposal in success (1585), error (1615),
   and finally paths

**Standalone method runs:**

1. In `modelMethodRun()` (line 219 of `src/libswamp/models/run.ts`), create the
   ephemeral store before execution
2. Pass it through `ModelMethodRunDeps.dataRepo` (already typed as
   `UnifiedDataRepository`)
3. Dispose in the `finally` block at line 973

**Serve path:**

1. In `executeWorkflowWithLocks()` (line 235 of `src/serve/deps.ts`), create the
   ephemeral store before calling `workflowRun()`
2. Pass it through `WorkflowRunDeps`
3. Dispose in the `finally` block at line 301

### Phase 5: Remove Lifecycle Service Warning

In `src/domain/data/data_lifecycle_service.ts:136-140`, remove the "not
implemented" warning. Ephemeral data no longer flows through the lifecycle
service at all — it never reaches the persistent datastore, so there's nothing
to expire or clean up. The lifecycle service only processes persistent data.

### Phase 6: Tests

**Unit tests:**

- `src/infrastructure/persistence/in_memory_data_repository_test.ts` — Full
  coverage of the `UnifiedDataRepository` interface: save/read/delete, version
  management, ownership validation, sync methods, garbage collection
- `src/domain/data/composite_data_repository_test.ts` — Routing logic: writes
  with ephemeral lifetime go to in-memory, others go to filesystem. Reads check
  ephemeral first. Merged results from `findAllGlobal()`.
- `src/domain/data/composite_data_query_service_test.ts` — Queries return
  results from both backing services, properly merged and deduplicated

**Integration tests:**

- Workflow with ephemeral outputs: verify data is available to subsequent steps
  via `data.latest()`, and verify data is gone after workflow completion
- Standalone method run with ephemeral output: verify data is available during
  execution and gone after
- Mixed lifetimes: workflow with both ephemeral and persistent outputs; verify
  persistent data survives while ephemeral is cleaned up

## Key Files Reference

| File | Role |
| ---- | ---- |
| `src/domain/data/repositories.ts:54-411` | `UnifiedDataRepository` interface — the contract to implement |
| `src/infrastructure/persistence/unified_data_repository.ts` | `FileSystemUnifiedDataRepository` — reference implementation (~1600 lines) |
| `src/domain/data/data.ts` | `Data` entity — immutable value object with `lifetime` field |
| `src/domain/data/data_metadata.ts:30-41` | `LifetimeSchema` — defines `"ephemeral"` as a valid variant |
| `src/infrastructure/persistence/catalog_store.ts` | `CatalogStore` — SQLite index, supports `:memory:` |
| `src/domain/data/data_query_service.ts` | `DataQueryService` — query engine for `data.latest()` / `data.query()` |
| `src/domain/expressions/model_resolver.ts:654-671` | `data.latest()` CEL implementation — delegates to `DataQueryService` |
| `src/domain/models/data_writer.ts:242-254` | `DataWriter.createDataEntity()` — where `lifetime` is set on the `Data` entity |
| `src/domain/models/data_writer.ts:550-571` | Lifetime resolution chain (spec → overrides → data output overrides) |
| `src/domain/workflows/execution_service.ts:255-265` | `StepExecutorDeps` interface — injection point for repos |
| `src/domain/workflows/execution_service.ts:324-365` | `DefaultStepExecutor.buildDeps()` — constructs repositories |
| `src/domain/workflows/execution_service.ts:1274-1625` | `WorkflowExecutionService.run()` — workflow lifecycle |
| `src/libswamp/models/run.ts:219-978` | `modelMethodRun()` — method lifecycle |
| `src/serve/deps.ts:66-158` | `createWorkflowRunDeps()` — serve-side dependency wiring |
| `src/serve/deps.ts:235-314` | `executeWorkflowWithLocks()` — serve-side execution wrapper |
| `src/serve/data_plane.ts` | HTTP data plane — remote worker data access |
| `src/domain/data/data_lifecycle_service.ts:136-140` | Ephemeral handling (current: unimplemented warning) |
| `src/infrastructure/persistence/repository_factory.ts:335-478` | `createRepositoryContext()` — composition root |
