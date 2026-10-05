---
audience: maintainer, operator
enables: [data]
last-verified: 2026-08-28 @ 3d5955a9
---

# Data Query

Data query is the general way to find data artifacts across models with CEL
predicates. Queries filter on artifact metadata (model name, spec name, tags,
version, etc.) and optionally on JSON content.

It is available in three places, all with the same predicate syntax and
fields:

- **CLI**: `swamp data query '<predicate>'`
- **CEL expressions**: `data.query('<predicate>')` in definitions and workflows
- **Extension methods**: `context.queryData('<predicate>')` in model method
  implementations

## Query is the primitive; helpers are shortcuts

Every `swamp data` read subcommand and every `data.*` CEL helper answers a
question a `data query` predicate could, over the same `DataRecord` fields. Not
all of them read the catalog. On the CLI, only `data search` and `data query`
read `_catalog.db` (`src/cli/commands/data_search.ts`,
`src/infrastructure/persistence/catalog_search_adapter.ts`). `get`, `list` and
`versions` use the filesystem repository
(`src/libswamp/data/{get,list,versions}.ts`).

The shortcuts read more clearly, so **prefer the shortcut when it fits**. Use
`data query` / `data.query()` directly for a multi-field predicate, a
projection, tag filters beyond a single key, or history beyond a single
version.

`swamp data get` is deprecated: `data query` is the CLI read path for a single
item. `data get` still returns the item, but every read carries a deprecation
warning and a `replacementQuery` naming the equivalent `data query` command
(`src/domain/data/data_query_command.ts`). Its `--workflow` form returns the
highest-versioned match (the first step on a tie) when several steps in a
run wrote the same data name
(swamp-club#2948), so it warns with the other matches; a query that names
`workflowRunId`, `jobName` and `stepName` selects one item.
The printed `replacementQuery` names a model's data by `modelType` and
`modelId`, which survive a rename, and report output (which records no run) the
same way. A read whose content may not be UTF-8 text (a non-text content type,
or text that came back base64-encoded) is replaced by a query that selects
`{"content": content, "contentEncoding": contentEncoding}` instead of
`content` alone, with `--json`, since base64 is read from the JSON result.
The CLI appends its own `--server` / `--repo-dir` to every
printed query.

### CLI shortcuts

Deprecated `data get` forms map to these queries:

| Deprecated command                             | Query                                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `swamp data get <m> <n>`                       | `swamp data query 'model("<m>") && name == "<n>"' --select content`                                                                     |
| `swamp data get <m> <n> --version 2`           | `swamp data query 'model("<m>") && name == "<n>" && version == 2' --select content`                                                     |
| `swamp data get --workflow <w> --run <id> <n>` | `swamp data query 'workflowRunId == "<id>" && jobName == "<j>" && stepName == "<s>" && name == "<n>" && version >= 0' --select content` |
| `swamp data get --workflow <w> <n>`            | `swamp data query 'workflowRunId == latestRun("<w>") && jobName == "<j>" && stepName == "<s>" && name == "<n>" && version >= 0' --select content` |

Add `--single` to any of these to get one bare object under `--json`, as
`data get --json` printed (see [Single result](#single-result---single)).

`model("<m>")` resolves `<m>` as `data get` does and matches rows by the
resolved definition's `modelType` and `modelId` (see
[Model of a data item](#model-of-a-data-item)). `modelName` is the name stamped
on the data when it was written, so `modelName == "<m>"` differs from
`data get` after a model rename, for data with no `modelName` tag, and after a
model is deleted and recreated under the same name. A `--version` read of a data
name that was since renamed has no query equivalent: the rename drops the old
name's catalog rows (see [Rename Forwards](#rename-forwards)).

A query matches the instance `name` exactly, where `data get` fell back to the
spec name; match a spec with `specName == "<s>"`. For a binary item, select
`{"content": content, "contentEncoding": contentEncoding}` so a base64 body can
be told from text (see [Binary content](#binary-content)). When a query with a top-level
`name == "<n>"` matches nothing, swamp builds its spec-name counterpart
(`buildSpecNameFallback` in `query_predicate.ts`): `name` becomes `specName`,
the other top-level string and `version` equalities and any `model("<m>")`
call are kept, and anything else is dropped. If something was dropped, it first runs the kept equalities with
`name` (limit 1): a match there means a dropped condition excluded the data,
not the name, so there is no hint. Otherwise it runs the spec-name predicate
(limit 1) and on a match returns `specNameHint` with `suggestedPredicate` and
`otherFiltersDropped` (log mode prints the command, and notes the dropped
conditions). Both probes use the caller's `include` filter, so the hint never
reveals data the caller may not read; a failed probe only omits it, and the
interactive TUI does not probe. With `--single`, where no match is an error,
the hint is appended to the `QUERY_NO_MATCH` message. `latestRun("<w>")` follows
a workflow's latest run, as `data get --workflow` does without `--run` (see
[Latest run of a workflow](#latest-run-of-a-workflow)). A workflow read without
`--run` also names this latest-run query, in its deprecation warning and as
`latestRunQuery` in `--json` output.

The remaining read subcommands are shortcuts:

| Shortcut                              | Underlying query                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `swamp data list <m>`                 | `swamp data query 'modelName == "<m>"'`                                                     |
| `swamp data list <m> --type resource` | `swamp data query 'modelName == "<m>" && dataType == "resource"'`                           |
| `swamp data list --workflow <w>`      | `swamp data query 'workflowRunId == latestRun("<w>") && version >= 0'`                      |
| `swamp data list --run <id>`          | `swamp data query 'workflowRunId == "<id>" && version >= 0'`                                |
| `swamp data versions <m> <n>`         | `swamp data query 'modelName == "<m>" && name == "<n>" && version >= 0' --select 'version'` |
| `swamp data search --tag env=prod`    | `swamp data query 'tags.env == "prod"'`                                                     |

`data list --workflow` also lists the run's report output, which records no
run id on the data, so the query leaves it out. `workflowName == "<w>"` is not
the same read: it returns the latest version of each item the workflow wrote,
which can come from different runs.

`integration/data_query_get_parity_test.ts` holds the first two deprecated
`data get` rows and the `data versions` row to their queries on the filesystem
datastore, a full-hydration custom datastore and a hand-wired lazy-hydration
setup, after a pull, an invalidate and a catalog rebuild. On a lazy datastore
`data query` downloads a body it needs and does not yet have, as `data get`
does (see [datastores.md](./datastores.md#getcontentsync-limitation)), so a
broad attribute predicate downloads the body of every row that passes its
metadata terms, and a query with no `select` downloads the body of every JSON
row it returns, because results carry `attributes`. A `select` that reads
`content` downloads the body of each item it returns, after `include` has run,
whatever its content type (see [Binary content](#binary-content)). A `select`
over metadata fields only downloads nothing. A failed download fails the query,
as it fails `data get`. One difference remains: `data get` follows a renamed
item's forward reference while a query by the old name matches nothing
(swamp-club#2972).

### CEL shortcuts

| Shortcut                      | Underlying query                                                           |
| ----------------------------- | -------------------------------------------------------------------------- |
| `data.latest("m", "n")`       | `data.query('modelName == "m" && name == "n"')[0]`                         |
| `data.version("m", "n", 2)`   | `data.query('modelName == "m" && name == "n" && version == 2')[0]`         |
| `data.listVersions("m", "n")` | `data.query('modelName == "m" && name == "n" && version >= 0', 'version')` |
| `data.findByTag("k", "v")`    | `data.query('tags.k == "v"')`, latest per step                             |
| `data.findBySpec("m", "s")`   | `data.query('modelName == "m" && specName == "s"')`, latest per step       |

A shortcut returns the same `DataRecord[]` type and fields as the equivalent
`data.query()` call. Execution differs in four ways
(`src/domain/expressions/model_resolver.ts`):

- `data.latest()` / `data.version()` without a `*:` wildcard look on the
  filesystem first (`dataRepo.findByName` on the model's coordinates). They
  fall back to the catalog only on a miss.
- Every helper except `data.query()` adds `&& ns == "<own namespace>"` unless
  the model name has a namespace prefix (`routeNamespace`).
- `data.findBySpec()` and `data.findByTag()` keep only the newest record per
  `(modelName, name, stepName)` (`deduplicateByName`).
- `data.findBySpec()` and `data.findByTag()` query with `latestPerStep`, so
  they match each workflow step's latest version (`is_step_latest`) rather
  than the single latest (`is_latest`). When several steps wrote one data
  name, they return a record per step where `data.query()` returns one.

**specName ambiguity detection:** `data.latest()` throws a `UserError` when its
lookup argument equals a `specName` tag shared by several data items under the
same model. An exact data name that differs from the specName is unaffected,
even if sibling items share the spec. Use `data.findBySpec()` to query by
specName. The raw `data.query()` equivalent skips this check.

**Spec name passed as a data name:** `data.latest()` and `data.version()` match
the data (instance) name, which a model may write under a different name than
its spec (e.g. spec `syncRunSummary` as `sync-<timestamp>`). When a
non-optional select fails on such a miss, the evaluator
(`CelEvaluator.explainMissedLookups`) asks
`DataNamespace.specInstanceNames()` for the data names written under that spec
— same namespace scoping as `data.latest()` — and appends them to the error,
newest first, with a pointer to `data.findBySpec()`. The lookup runs only on
the error path.

### Null-safe access (.?)

`data.latest()` and `data.version()` return `null` when the named instance
doesn't exist. Use `.?` (optional select) to chain through a possibly-null
result without throwing:

```cel
data.latest("m", "n").?attributes.?payload.?findings           // null if missing
data.latest("m", "n").?attributes.?findings.orValue([])        // [] if missing
data.latest("m", "n").attributes.findings                      // throws if missing
```

Details: [expressions.md](./expressions.md#null-safe-optional-access-).

### Cross-namespace queries (giga-swamp Phase 4)

Model-name helpers (`data.latest`, `data.version`, `data.findBySpec`,
`data.listVersions`) accept namespace-prefixed model names. `data.findByTag`
takes no model name and always searches the caller's own namespace
(`model_resolver.ts` `findByTag`):

| Syntax | Scope |
| --- | --- |
| `data.latest("model", "name")` | Own namespace only (default) |
| `data.latest("infra:model", "name")` | Target namespace `infra` |
| `data.latest("*:model", "name")` | All namespaces (errors if ambiguous) |

`data.query()` spans all namespaces by default, with no implicit namespace
filter. Filter with the `ns` field:

| Query | Scope |
| --- | --- |
| `data.query('modelType == "aws/ec2/vpc"')` | All namespaces |
| `data.query('ns == "security"')` | Security namespace only |
| `data.query('ns == ""')` | Solo-mode data only |

The field is `ns`, not `namespace`, because `namespace` is a reserved
identifier in CEL.

## DataRecord

`data.query()` returns `DataRecord[]`, the same type as `data.latest()`,
`data.version()`, `data.findByTag()`, `data.findBySpec()`, and
`context.readModelData()`. As part of this work, `DataRecord` gains metadata
fields:

```typescript
interface DataRecord {
  id: string;
  name: string;
  version: number;
  isLatest: boolean;
  createdAt: string;
  // Provenance namespace (giga-swamp Phase 2). Identifies which repo produced
  // this data within a shared datastore. Empty string ('') in solo mode.
  namespace: string;
  attributes: Record<string, unknown>;
  tags: Record<string, string>;
  modelName: string;
  modelId: string;
  modelType: string;
  specName: string;
  dataType: string;
  contentType: string;
  lifetime: string;
  // Version retention: a count, or a duration such as "30d"; "" when unknown
  garbageCollection: number | string;
  ownerType: string;
  streaming: boolean;
  size: number;
  content: unknown; // parsed object for JSON, text for other text types
  // Local path of the stored content file; "" unless requested (see below)
  path: string;

  // Provenance fields — promoted from tags/ownerDefinition to first-class.
  // Empty string when the data was not produced inside a workflow.
  ownerRef: string;
  workflowRunId: string;
  workflowName: string;
  jobName: string;
  stepName: string;
  source: string;
}
```

Standalone exported mapper functions in `data_record_mapper.ts` fill every
`DataRecord` field: `fromRow()` for catalog-backed queries, `fromData()` for
version lookups, `fromResourceHandle()` for workflow step resource outputs, and
`fromFileHandle()` for file-kind outputs. The provenance fields are additive,
so code reading `record.name` or `record.attributes` still works.

`path` is the local filesystem path of the version's stored content (its `raw`
file). It is filled only when the caller opts in with
`DataQueryOptions.includeContentPath`. The only caller that does is the CEL
`data.*` namespace (`ModelResolver.buildDataNamespace`), so that
`data.latest(...).path` can replace the deprecated
`model.<name>.file.<spec>.<instance>.path`. Everywhere else `path` is `""`:
`swamp data query`, the serve `data.query` handler, remote-worker `queryData`,
and extension `readModelData`/`queryData`. Host filesystem paths therefore
never cross the serve boundary, including through a `select` projection.

Even when requested, `path` is `""` for a record from another namespace in a
shared datastore, for ephemeral data (held in memory), and when the file is not
on local disk (see [datastores.md](./datastores.md), lazy hydration).
`localContentPath()` in `data_record_mapper.ts` holds that rule. `path` is not
a predicate field, because filtering on a host path is not a catalog query.

For JSON resources (`contentType == "application/json"`), `attributes` holds
the parsed content, as `data.latest()` and other accessors already do. For
non-JSON data, `attributes` is `{}`.

`data.query()` results are interchangeable with those of any other data
accessor, in both directions.

## Filter Context

The predicate is evaluated against each `DataRecord`. Filterable fields:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Data artifact UUID |
| `name` | string | Data artifact name |
| `version` | int | Version number |
| `isLatest` | bool | Whether this is the artifact's latest version |
| `createdAt` | string | ISO-8601 timestamp |
| `attributes` | map | Parsed JSON content (lazy-loaded; `{}` unless `contentType` is `application/json`) |
| `tags` | map | All tags as key-value pairs |
| `modelName` | string | Owning model name as of the write (from the `modelName` tag; a model rename does not update it) |
| `modelId` | string | Owning model id (stable across renames) |
| `modelType` | string | Owning model type |
| `specName` | string | Output spec name |
| `dataType` | string | `"resource"` or `"file"` |
| `contentType` | string | MIME type |
| `lifetime` | string | Lifetime policy |
| `garbageCollection` | int or string | Retention policy: a version count, or a duration such as `"30d"`; `""` when unknown (a foreign row from an export older than the field) |
| `ownerType` | string | `"model-method"`, `"workflow-step"`, or `"manual"` |
| `streaming` | bool | Whether data is append-only |
| `size` | int | Content size in bytes |
| `content` | dyn | Parsed object for JSON, raw text for other text types (lazy-loaded); reading it on a non-text item is an error — see [Binary content](#binary-content) |
| `ownerRef` | string | Model definition ID that owns this data |
| `workflowRunId` | string | Workflow run ID (`""` outside workflows) |
| `workflowName` | string | Workflow name (`""` outside workflows) |
| `jobName` | string | Job name (`""` outside workflows) |
| `stepName` | string | Step name (`""` outside workflows) |
| `source` | string | Provenance source (e.g. `"step-output"`, `""`) |
| `ns` | string | Namespace slug (`""` in solo mode); alias for `DataRecord.namespace` |

All fields except `attributes` and `content` are metadata stored in the catalog.
Those two load from disk per row, on demand. They load only when the predicate
touches them (a metadata term earlier in `&&` skips the read), or when a
matching row's result or `select` projection needs them. If a body read fails
for a matching row, the query fails instead of silently skipping the row.

`attributes` holds parsed JSON (for `application/json` only). In a predicate,
`content` is the raw text string for a text content type, decoded leniently.
The text types (`src/domain/data/content_type.ts` `isTextContentType`) are
`text/*`; the text-based `application/*` types JSON, NDJSON, YAML
(`application/yaml`, `application/x-yaml`), XML, TOML, JavaScript,
ECMAScript, shell, SQL and GraphQL; and any type with a `+json`, `+xml` or
`+yaml` structured-syntax suffix. Parameters (`; charset=utf-8`) and case are
ignored. For `application/json` it is the same parsed object as
`attributes` (`src/domain/data/data_record_mapper.ts` `parseContent`). A
`select` projection reads `content` for every content type without losing a
byte (a leading UTF-8 byte-order mark is dropped, as `data get` drops it); see
[Binary content](#binary-content).

### Binary content

`content` is a text concept in a predicate: binary bytes have no text to match
against. A predicate that reads `content` on an item whose content type is not
text fails the query with `BinaryContentPredicateError`
(`src/domain/data/binary_content_predicate_error.ts`), naming the item, rather
than silently skipping it (swamp-club#2959). The check uses the catalog's
`contentType`, so no bytes are read to make it, and it applies even when CEL
would absorb the error (`content == "x" || true`). Guard the content condition
with the type, which `&&` short-circuits. This guard covers `text/*`; add the
other text types when they should match too:

```cel
contentType.startsWith("text/") && content.contains("error")
```

With an `include` callback (`swamp serve`), a violating item goes through
`include` like any match, and only one the caller may read raises the error;
others are dropped as non-matches, so neither the error nor its absence
reveals an unreadable item. Either way, only a violation evaluated before the
query's limit was reached counts: with `include`, matching runs ahead in
batches, so violations are walked in evaluation order with the matches and
ignored once the accepted page is full. A query that stops at its limit first
does not fail, with or without `include`.

A `select` that references `content` or `contentEncoding` reads each item's
bytes in the projection step, after `include` has run
(`DataQueryService.projectedContents`). The async `query()` reads them with
`getContent`, so a lazily-synced body is downloaded as `data get` downloads it;
`querySync` (CEL `data.query()`) reads local disk only. Bytes are represented as `data get`
represents them (`src/domain/data/content_encoding.ts` `encodeContent`): UTF-8
text when the bytes are valid UTF-8, otherwise base64. `contentEncoding`
(`utf-8` or `base64`) says which, and exists only in a projection — naming it
in a predicate is an unknown-field error, since answering it would read every
candidate's bytes. JSON items keep `content` as the parsed attributes, with
`contentEncoding` `utf-8`. An item whose bytes are not on this host (any item
from another namespace in a shared datastore, or a non-JSON item whose file is
missing) projects `content` and `contentEncoding` as `null`, never as empty
content. A leading UTF-8 byte-order mark is dropped from `utf-8` content, as
`data get` drops it. The same rules apply
to `data.query()` in CEL expressions.

```bash
# Download a binary item
swamp data query 'modelName == "site" && name == "logo"' \
  --select '{"content": content, "contentEncoding": contentEncoding}' --json \
  | jq -r '.results[0].content' | base64 -d > logo.png
```

## Provenance-Based Filtering

Data produced inside a workflow carries provenance fields directly on the record
(`workflowRunId`, `workflowName`, `stepName`, etc.). They are queryable like any
other `DataRecord` field; the framework applies no hidden scoping.

To scope results to one workflow run, write the predicate yourself:

```cel
modelName == "dedup" && specName == "episode" && workflowRunId == "run-uuid"
```

No data access function scopes by workflow run. Only `data.query()` and
`context.queryData()` are fully unscoped. The model-name helpers and
`context.readModelData()` add an own-namespace filter (see above) and nothing
else. Any other scoping must be written into the predicate.

**Step-aware versioning:** the catalog keeps two latest flags per row
(`CatalogStore.upsertNewVersion`, `computeLatestFlags`):

- **`is_latest`** marks exactly one row per `(namespace, type, model, data)`:
  the highest promoted version, whatever its `step_name`. It backs `isLatest`
  and the implicit latest-only filter, so `data.query()`, `swamp data query`,
  `swamp data search`, `context.readModelData()` and `context.queryData()`
  return one version per data name even when several workflow steps wrote it
  (swamp-club#2520).
- **`is_step_latest`** marks each workflow step's latest version, with
  asymmetric demotion rules based on `step_name`. A model-method write
  (`step_name = ""`) demotes every lower row. A workflow-step write demotes
  lower rows with the same `step_name` and lower model-method rows. Other
  steps' rows are untouched, so different workflow steps writing the same data
  name keep independent version chains (swamp-club#1761, swamp-club#1802). The
  `is_latest` row is always also `is_step_latest`.

Version order, not arrival order, decides both flags, so parallel steps that
promote out of order converge on the same flags a rebuild derives. Only the
collection helpers (`findBySpec`, `findByTag`) read `is_step_latest`, so they
may return several records for one data name written by different workflow
steps; an older step's record reports `isLatest: false`. `data.latest()`
returns the single latest record regardless of step.

Known gap: deleting a version (`swamp data delete --version`, GC, the version
cap, or rolling back an unpromoted deferred write) re-promotes only the
surviving highest version. Another step whose latest was deleted keeps no
`is_step_latest` row until the catalog is rebuilt.

**Vault resolution:** the query service never resolves vault references.
`data.query()`, `data.version()`, `data.findBySpec()` and `data.findByTag()` in
CEL, `context.queryData()` in extension methods, and `swamp data query` return
schema-marked sensitive fields as the stored `vault.get(...)` reference. The
reads that resolve those fields are `data.latest()` with an exact model name,
`steps.<name>.outputs` and `model.<name>.resource` in CEL, which record each
value in the run's `RunSensitiveValues`, and `readResource()` and
`readModelData()` in extension methods. `data.latest()` with a wildcard model
name goes through the query service and returns the stored reference. See
"Read-Side Resolution" in `design/primitives/vaults.md`.

### Latest run of a workflow

`latestRun("<workflow>")` returns the id of a workflow's most recent run, so
`workflowRunId == latestRun("deploy")` selects the data that run wrote
(swamp-club#2957). Latest is the run with the most recent `startedAt`, whatever
its status, the same run `data get --workflow` and `data list --workflow` read
without `--run` (`WorkflowRunRepository.findLatestByWorkflowId`).

- The argument is a workflow name or id, as a string literal. Each workflow is
  resolved once per query, before any row is read
  (`src/domain/data/query_predicate.ts` `collectLatestRunWorkflows`); a
  per-row argument such as `latestRun(workflowName)` is an error.
- An unknown workflow is an error. A workflow with no runs resolves to `null`,
  so `workflowRunId == latestRun("<w>")` matches nothing and
  `workflowRunId != latestRun("<w>")` matches every latest row (every version,
  with `version >= 0`).
- Add `version >= 0`, as for any read by `workflowRunId`: a later write
  elsewhere can demote the run's item from latest, and the run still holds it.
  A step that wrote the same name twice in one run then returns both versions.
- It is available in `swamp data query` only. The caller passes the resolver
  per query (`DataQueryOptions.latestRunResolver`); `data.query()` in CEL and
  `context.queryData()` pass none, and a query there that calls `latestRun`
  fails.
- Over `swamp serve`, `latestRun` needs `read` on the workflow and on every
  workflow its latest run is recorded under, as a history read of that run
  does. A refusal is audited and fails exactly as an unknown workflow does,
  naming only the argument.

### Model of a data item

`model("<model>")` is true for the rows stored under a model's current
definition, so `model("scanner") && name == "result"` reads what
`data get scanner result` reads (swamp-club#2960). The argument resolves as
`data get`'s model argument does: definition name first, then exact definition
id (`findDefinitionByIdOrName`), and rows match on the resolved definition's
`modelType` and `modelId`, not on the `modelName` tag.

- The argument is a model name or definition id, as a non-empty string literal.
  Each model is resolved once per query, before any row is read
  (`src/domain/data/query_predicate.ts` `collectModelReferences`), and a
  predicate may name at most 32 distinct models (`MAX_MODEL_REFERENCES`); a
  per-row argument such as `model(modelName)` is an error.
- An unknown model is an error (`Model not found`), as in `data get`.
- The caller passes the resolver per query (`DataQueryOptions.modelResolver`).
  The CLI and TUI pass `createModelReferenceResolver`
  (`src/domain/models/model_lookup.ts`); `data.query()` in CEL and
  `context.queryData()` pass none, and a query there that calls `model`
  fails. It is rejected in `--select`.
- Matching evaluates in a cloned environment whose `model()` reads the row
  being evaluated from a variable local to the match, so concurrent queries
  never see each other's resolutions.
- Over `swamp serve`, `model` needs `read` on the data of the model it resolves
  to, as a model-scoped `data.get` does. A refusal is audited and fails exactly
  as an unknown model does, naming only the argument.

## Predicate Syntax

Predicates are standard CEL expressions that return a boolean. Any CEL
operator or built-in function works.

```cel
modelName == "ingest-pipeline" && specName == "result"

tags.env == "prod" && tags.team == "platform"

specName == "result" || specName == "summary"

name.contains("episode") && version > 3

streaming && ownerType == "workflow-step"

modelName == "scanner" && attributes.status == "failed"
```

### Field Validation

Before evaluation, swamp walks the predicate AST to check that every identifier
is a known query record field. Unknown fields produce an error
(`src/domain/data/query_predicate.ts` `validateFieldReferences`). The message
pluralises to `Unknown fields` and lists the available names alphabetically:

```
Error: Unknown field "model" in query predicate.
Available: attributes, content, contentType, createdAt, dataType,
  garbageCollection, id, isLatest, jobName, lifetime, modelId, modelName,
  modelType, name, ns, ownerRef, ownerType, size, source, specName, stepName,
  streaming, tags, version, workflowName, workflowRunId
Functions: latestRun("<workflow>"), model("<model name or definition id>")
```

## Catalog

A SQLite metadata catalog, `_catalog.db`, backs query performance. It lives in
the local-tier `data/` directory (`.swamp/data/_catalog.db` by default), never
the datastore tier. `catalogDbPath` in
`src/infrastructure/persistence/repository_factory.ts` resolves it via
`localPath("data")`. It uses `node:sqlite`, which is built into the Deno
runtime.

The catalog has one row per artifact version, with an `is_latest` column
marking the current version. It holds every query record metadata field except
`attributes`.

### Schema

```sql
CREATE TABLE catalog (
  namespace       TEXT NOT NULL DEFAULT '',
  type_normalized TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  data_name       TEXT NOT NULL,
  id              TEXT NOT NULL,
  version         INTEGER NOT NULL,
  is_latest       INTEGER NOT NULL DEFAULT 1,
  is_step_latest  INTEGER NOT NULL DEFAULT 1,
  model_name      TEXT NOT NULL,
  spec_name       TEXT NOT NULL DEFAULT '',
  data_type       TEXT NOT NULL DEFAULT '',
  content_type    TEXT NOT NULL DEFAULT '',
  lifetime        TEXT NOT NULL DEFAULT '',
  garbage_collection TEXT NOT NULL DEFAULT '',
  owner_type      TEXT NOT NULL DEFAULT '',
  streaming       INTEGER NOT NULL DEFAULT 0,
  size            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '{}',
  owner_ref       TEXT NOT NULL DEFAULT '',
  workflow_run_id TEXT NOT NULL DEFAULT '',
  workflow_name   TEXT NOT NULL DEFAULT '',
  job_name        TEXT NOT NULL DEFAULT '',
  step_name       TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (namespace, type_normalized, model_id, data_name, version)
);

CREATE INDEX idx_catalog_model_name      ON catalog(model_name);
CREATE INDEX idx_catalog_spec_name       ON catalog(spec_name);
CREATE INDEX idx_catalog_data_type       ON catalog(data_type);
CREATE INDEX idx_catalog_created_at      ON catalog(created_at);
CREATE INDEX idx_catalog_workflow_run_id ON catalog(workflow_run_id);
CREATE INDEX idx_catalog_step_name       ON catalog(step_name);
CREATE INDEX idx_namespace               ON catalog(namespace);
CREATE INDEX idx_catalog_is_latest       ON catalog(namespace, type_normalized, model_id, data_name, is_latest);
CREATE INDEX idx_catalog_latest_lookup   ON catalog(model_name, data_name, is_latest, namespace);
CREATE INDEX idx_catalog_step_latest     ON catalog(model_name, is_step_latest);

CREATE TABLE catalog_renames (
  namespace       TEXT NOT NULL DEFAULT '',
  type_normalized TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  data_name       TEXT NOT NULL,
  renamed_to      TEXT NOT NULL,
  PRIMARY KEY (namespace, type_normalized, model_id, data_name)
);

CREATE INDEX idx_catalog_renames_name ON catalog_renames(data_name);

CREATE TABLE catalog_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`catalog_meta` holds a `schema_version` key. When the version changes, or the
catalog table is missing or lacks a column the current schema defines
(processes on different versions racing on one file can record the new version
over an old or dropped table), the `catalog` and `catalog_renames` tables are
dropped and rebuilt by self-healing backfill on the next query.

Content is not stored in the catalog. It stays on disk in the existing
versioned file layout.

### Write-Through Updates

Every mutation in `UnifiedDataRepository` updates the catalog inline:

| Repository Method | Catalog Operation |
| --- | --- |
| `save()` | `upsertNewVersion`: full row for the new version, size, createdAt (no checksum column) |
| `append()` | `upsertNewVersion`: full row for the appended version |
| `delete()` | Remove row, or update version if only one version deleted |
| `rename()` | Remove the old name's rows, insert the new row, record a rename forward |
| `finalizeVersion()` | Upsert row |
| `removeLatestMarker()` | Remove row |
| `collectGarbage()` | Update version or remove row |

`UnifiedDataRepository` is an interface (in `repositories.ts`). The concrete
`FileSystemUnifiedDataRepository` requires a `CatalogStore` constructor
parameter. Every repository instance keeps the catalog consistent through
write-through. Build one
from a repo directory with `createCatalogStore()` from `repository_factory.ts`.

### Population Strategy

The catalog fills incrementally:

1. **Write-through**: every data mutation upserts or removes a catalog row, so
   new data is queryable at once.
2. **Scoped backfill**: `getLatestRecord()` uses a three-tier lookup that
   avoids the full `findAllGlobal()` walk. It first tries the indexed SQL
   lookup (O(1); catches write-through rows). If the catalog is not populated
   and the row is missing or stale, it walks the filesystem for only the
   requested `(modelName, dataName)` pair, upserts matching rows, and retries.
   Scoped backfill does not set the `populated` flag.
3. **Full backfill on first query or search**: the first call to
   `DataQueryService.query()` or `ensurePopulated()` (used by `data search`)
   on an unpopulated catalog runs a one-time `findAllGlobal()`. It commits
   every row found and sets a `populated` flag in the `catalog_meta` table.
   After that, both `data search` and `data query` use the catalog;
   `data search` iterates `is_latest` rows directly instead of re-walking the
   filesystem.
4. **Self-healing**: if `_catalog.db` is deleted or corrupted, the next query
   triggers a backfill.

Full backfill upserts instead of replacing. It commits through
`bulkUpsert()`, which uses `INSERT OR REPLACE` with no preceding `DELETE`.
Rows the walk finds are added or updated; rows it cannot see are left alone.
This is critical for `hydrationStrategy: lazy`, where the local cache is
incomplete on purpose: data lives in the remote datastore and is fetched on
demand. Under the old destructive replace, a walk gap meant data loss in the
catalog. Under additive upsert, a walk gap does nothing to the rows it misses.

### Rename Forwards

`catalog_renames` projects the rename markers `data rename` writes on the old
name (`lifecycle: deleted`, `renamedTo`), so a query can follow them the way
an unversioned `findByName` does (swamp-club#2968). The old name's rows leave
`catalog`; only the forward remains.

- **Write-through**: `rename()` records the forward once the rename's files
  are written; a failed catalog write only logs, since the next backfill
  restores it. `upsertNewVersion` (every runtime write) deletes the forward from
  the name it writes, so writing the old name again ends the forward.
- **Backfill**: the `findAllGlobal` walk reports each rename marker it follows
  past (`FindAllGlobalOptions.renames`), and backfill merges them
  (`mergeRenames`). Like catalog rows, forwards are never deleted by a backfill:
  a walk with gaps (lazy hydration) must not drop a forward it could not see.
- **Delete**: the repository's `catalogRemove` drops the forward of the name it
  removes (delete, expiry). Deleting an older version while the rename marker
  stays latest keeps the forward and adds no catalog row for the marker.
- **Query**: when the predicate does not open history and has a top-level
  `name == "<literal>"` conjunct, the catalog nominates the models with a
  forward from the literal, and each hop is then read from the name's latest
  marker on disk — the same read as an unversioned `findByName` — for at most 5
  hops, never revisiting a name. A forward that a later write or delete ended,
  here or on another machine, therefore matches nothing, and a chain the
  catalog only partly knows is still followed to its end. Rows the chain ends
  at are evaluated with `name` overlaid to the literal; the returned record
  keeps its real name, and the caller's `include` filter still applies. A row
  still under the old name in a model whose forward is confirmed (left by a
  sync or a failed catalog write) is not returned: the marker shows it is not
  the latest version. A model whose marker cannot be read is skipped (logged at
  debug), not the query.
- **Not followed**: versioned or `isLatest` predicates (as `data get --version`
  does not follow), `name in [...]` or a name test under `||` or `!`, and
  renames in other namespaces: `.catalog-export.json` carries rows, not
  forwards.

### Stale-Row Filtering

`DataQueryService` accepts a `filterStaleRows` option. When it is on, the query
hydration loop calls `Deno.statSync` on each row's `raw` content file and drops
rows whose file is absent. This catches rows orphaned by a model retype (type
field changed, UUID kept): the data moves to a new type directory and the old
catalog row goes stale.

`filterStaleRows` must be **disabled** for remote datastores (S3/GCS), where
content may not be hydrated into the local cache yet. There, a missing `raw`
file means "not yet downloaded", not "stale". The repo-context composition root
sets `filterStaleRows: !isCustomDatastoreConfig(...)`.

The trade-off is that the catalog can collect orphaned rows for data deleted or
renamed outside the write-through path (e.g. manual file deletion).
Write-through handles normal deletes and renames. For full reconciliation,
`swamp doctor datastores --repair -y` removes `_catalog.db` and the next query
rebuilds it from scratch. That rebuild also clears foreign-namespace rows
fetched by `swamp datastore catalog pull`. Those rows describe data that is not
on local disk, so a local walk cannot recreate them; re-pull to restore them.

### Remote Datastores (S3)

The catalog is local-only. It lives in the local cache directory and is
excluded from sync, so it is never pushed to or pulled from S3.

After a `pullChanged()` that reports work, core sets `synced = true` and the
caller invalidates the catalog (`catalogStore.invalidate()`). The next query
then backfills from the freshly pulled cache (`src/cli/repo_context.ts`
`acquireModelLocks`). There is no incremental row-level update from a pull
diff: `pullChanged()` returns `Promise<number | void>`, not a structured diff.

On cold start (new machine, empty cache), the initial pull downloads all files.
The catalog doesn't exist yet, so the first query backfills from the pulled
cache.

## Query Execution

Queries run in two phases. SQL pre-filtering narrows the candidate set, then
the full CEL predicate runs on every row SQL returns. CEL is always the
authority on correctness; SQL pushdown is only a performance optimization.

### SQL Pushdown

Before iterating, the query service extracts trivially correct predicates from
the CEL AST and pushes them into SQL WHERE clauses:

| CEL pattern                 | SQL pushdown           | Notes                                                    |
| --------------------------- | ---------------------- | -------------------------------------------------------- |
| implicit `isLatest == true` | `WHERE is_latest = 1`  | When the predicate doesn't reference `version` or `isLatest` |
| implicit, with `latestPerStep` | `WHERE is_step_latest = 1` | `findBySpec`/`findByTag` only; no CEL `isLatest` term |
| `modelName == "<literal>"`  | `WHERE model_name = ?` | Top-level AND conjuncts only                             |
| `model("<literal>")` | `WHERE type_normalized = ? AND model_id = ?` | Top-level AND conjuncts only, with the resolved definition |
| `specName == "<literal>"`   | `WHERE spec_name = ?`  | Top-level AND conjuncts only                             |
| `modelType == "<literal>"` | `WHERE type_normalized = ?` | Top-level AND conjuncts only; `modelType` is the column value |
| `modelId == "<literal>"` | `WHERE model_id = ?` | Top-level AND conjuncts only |
| `workflowRunId == latestRun("<literal>")` | `WHERE workflow_run_id = ?` | Top-level AND conjuncts only, with the resolved run id; a workflow with no runs matches nothing |

All other predicates stay CEL-only and run per row on the narrowed set: OR
expressions, comparisons, tag filters, `attributes` references, and complex
expressions. Future versions may push down more patterns (tag equality via
`json_extract`, comparisons on indexed columns).

SQL pushdown must return a superset of matching rows. CEL can only narrow,
never widen. If a translation is uncertain, the conjunct stays
in CEL.

### Execution Flow

```
1. Parse predicate into AST
2. Validate field references
3. Extract SQL pushdown clauses (isLatest, modelName, specName, modelType
   and modelId equality, model()); resolve rename forwards for a latest-only `name == "<literal>"`
4. Detect whether the filter or the select expression references
   `attributes` or `content` (referencesAttributes / referencesContent)
5. SELECT * from catalog with WHERE pushdown
   (via paged LIMIT/OFFSET queries using stmt.all(); content is never
   a column, so this is metadata only)
6. For each row:
   a. Project row into query record
   b. If step 4 found a content reference in the filter:
      load content from disk for this row (a non-text row records a
      violation instead, without reading its bytes)
   c. Evaluate full CEL predicate against query record
   d. If true: add to results
   e. If results.length >= limit: stop
7. Raise BinaryContentPredicateError for a violation the caller may read
8. Project: a select that references content or contentEncoding reads and
   encodes each remaining record's bytes
9. Return results
```

Iteration uses paged `stmt.all()` with `LIMIT/OFFSET`, so rows arrive in
bounded batches. Content loads per row only when needed, and the query stops as
soon as it reaches the limit.

If neither the predicate nor the projection references `attributes` or
`content`, no content loads at all. Both ASTs are walked for those identifiers
before execution (`src/domain/data/data_query_service.ts`).

## Projection (`--select`)

The `--select` flag takes a second CEL expression. The filter predicate decides
which rows match; the projection decides what to extract from each.

```bash
swamp data query '<filter predicate>' --select '<projection expression>'
```

Both expressions see the same `DataRecord` fields. The filter returns a
boolean; the projection returns any value.

### Output Format by Return Type

The projection's result type sets the output format:

| Projection returns | Log mode | JSON mode |
| --- | --- | --- |
| string / number / bool | One value per line | Array of values |
| map (object) | Table with map keys as headers | Array of objects |
| list (array) | Markdown table with positional numeric headers (`1`, `2`, …) | Array of arrays |
| null | Empty line (scalar) or empty cells (map/list) | `null` in array |

The first non-null result's type decides
(`src/libswamp/data/query.ts` `classifyProjection`). If it is a map, all
results render as a table; if it is a scalar, all render as lines
(`src/presentation/renderers/data_query.ts`).

### Map Key Syntax

CEL map literals need quoted string keys. Bare identifiers resolve as
variables, not key names:

```cel
{"name": name, "status": attributes.status}    ✓ correct
{name: name, status: attributes.status}         ✗ wrong — "name" resolves as variable
```

### Examples

**Scalar projection**: one value per row, pipe-friendly:

```bash
$ swamp data query 'modelName == "ingest"' --select 'name'

episode-001
episode-002
episode-003
```

**String expression**: formatted output:

```bash
$ swamp data query 'specName == "result"' \
    --select 'modelName + "/" + name + " v" + string(version)'

ingest/episode-001 v3
ingest/episode-002 v1
scanner/scan-result v7
```

**Map projection**: a table with custom columns:

```bash
$ swamp data query 'modelName == "ingest"' \
    --select '{"name": name, "status": attributes.status, "v": version}'

name             status    v
───────────────  ────────  ──
episode-001      failed     3
episode-002      ok         1
episode-003      failed     5
```

The map keys become column headers. This is the main way to build custom
views: pick the fields you want and name them.

With `--json`, map projections produce a JSON array of objects:

```bash
$ swamp data query 'modelName == "ingest"' \
    --select '{"name": name, "status": attributes.status}' --json

[
  {"name": "episode-001", "status": "failed"},
  {"name": "episode-002", "status": "ok"}
]
```

**Nested map projection**: complex structures as table values:

```bash
$ swamp data query 'modelName == "scanner"' \
    --select '{"name": name, "system": {"kernel": attributes.kernel, "arch": attributes.arch}}'

name             system
───────────────  ─────────────────────────────────────────
ip-172-31-12     `{"kernel":"6.1.161-183","arch":"x86_64"}`
ip-10-0-3-42     `{"kernel":"6.1.161-183","arch":"arm64"}`
```

Complex values (objects, arrays) in table cells render as inline JSON code
spans. Any object-valued projection counts as a map and renders as a table;
log output has no pretty-printed JSON block mode. To dump whole objects, use
`--json`:

**Bare attributes**: dump content from matching records:

```bash
$ swamp data query 'modelName == "ingest" && specName == "result"' \
    --select 'attributes' --json

[
  { "status": "failed", "errorCode": "TIMEOUT", "retries": 3 },
  { "status": "ok", "processedCount": 142 }
]
```

In log mode the same projection renders as a table whose columns are the keys
of the first non-null record.

**Conditional projection:**

```bash
$ swamp data query 'specName == "result"' \
    --select 'attributes.status == "failed" ? "FAIL " + name : "ok   " + name'

FAIL episode-001
ok   episode-002
FAIL episode-003
```

**List projection**: positional columns with numeric headers:

```bash
$ swamp data query 'tags.env == "prod"' \
    --select '[name, modelName, string(size)]'

1            2         3
───────────  ────────  ────
episode-001  ingest    1234
episode-002  ingest    890
config       platform  45
```

### Default (no `--select`)

Without `--select`, the CLI renders a Cliffy `Table` (not markdown) with fixed
columns `name`, `modelName`, `specName`, `dataType`, `version`, `size`. A
`namespace` column is added in front when any result has a non-empty namespace
(`src/presentation/renderers/data_query.ts` `renderDefaultTable`).

### Interaction with Other Flags

`--select` composes with `--json`, which renders projected values as JSON
instead of human-readable text. It also composes with `--limit`: the limit
applies to matched rows, the projection to output.

### Single result (`--single`)

`--single` requires exactly one match. The libswamp generator queries without
a limit and yields `QUERY_NO_MATCH` or `QUERY_MULTIPLE_MATCHES` instead of
`completed` otherwise, so the command exits non-zero. It does not query with a
limit of 2: an unfiltered query applies its limit before stale catalog rows are
dropped, so two scanned rows could leave one live match and hide a second. With `--json` the renderer prints the one record (the object the
envelope would carry as `results[0]`) or its projected value bare, without the
`{results, total, limited}` envelope; log output is unchanged. `--single`
conflicts with `--limit` and requires a predicate. Over `--server` the client
sends `limit: 2` and applies the same `requireSingleResult` check to the
records in the response, so the `data.query` protocol is unchanged. The limit is
safe there because the server filters by read access, and a filtered query
keeps matching until enough rows survive the stale-row check.

### Implementation

Projection is a domain/application concern. `DataQueryService` still returns
`DataRecord[]`, but accepts a `select` option so it loads
`attributes`/`content` from disk when the projection references them (content
in the projection step, after `include`; see [Binary content](#binary-content)). The
libswamp generator evaluates the projection on each result, classifies the
output shape, and yields typed events. On the `--select` path the renderer
builds markdown from the event data and passes it through
`renderMarkdownToTerminal()`. The default path (no `--select`) builds a Cliffy
`Table` directly.

## Usage

### CLI

```bash
swamp data query 'modelName == "ingest" && specName == "result"'
swamp data query 'tags.env == "prod" && size > 1048576'
swamp data query 'attributes.status == "failed"' --limit 10
swamp data query 'modelName == "scanner"' --json
swamp data query 'modelName == "ingest"' --select 'name'
swamp data query 'specName == "result"' --select '{"name": name, "err": attributes.errorCode}'
```

### CEL Expressions

`data.query()` takes a predicate and an optional projection expression. Without
a projection it returns `DataRecord[]`; with one, it returns the projected
values directly.

```yaml
attributes:
  # Query returns DataRecord[]
  results: ${data.query('modelName == "ingest" && specName == "result"')}

  # With projection — returns projected values directly
  names: ${data.query('modelName == "ingest"', 'name')}

  # Project a custom object per record
  summary: ${data.query('specName == "result"', '{"name": name, "status": attributes.status}')}

  # Without projection — use .map() for the same effect
  names2: ${data.query('tags.team == "platform"').map(r, r.name)}

  # Check existence
  hasData: ${size(data.query('modelName == "config" && name == "active"')) > 0}
```

Results without projection are interchangeable with `data.latest()`,
`data.findBySpec()`, etc.

### Extension Methods

`context.queryData()` takes the same two arguments:

```typescript
// Without projection — returns DataRecord[]
const results = await context.queryData!(
  'modelName == "upstream" && tags.env == "prod"'
);
for (const record of results) {
  const { hostname, os } = record.attributes;
}

// With projection — returns projected values
const names = await context.queryData!(
  'modelName == "scanner"',
  'name'
);
// names is string[]
```

## Architecture

`CatalogStore` is an infrastructure component wrapping `node:sqlite`
(`src/infrastructure/persistence/catalog_store.ts`). It exposes:

- row writes: `upsert`, `upsertNewVersion`, `bulkUpsert`, `bulkUpsertForeign`
- removal: `remove`, `removeVersion`, `bulkRemoveVersions`
- reads: `iterate`, `iterateFiltered`, `findLatestRow`,
  `findLatestRowsBySpecName`, `count`, `distinctValues`,
  `distinctTagKeys`/`distinctTagValues`
- population management: `isPopulated`, `markPopulated`, `invalidate`
- maintenance: `checkpoint`, `vacuum`

`DataQueryService` is a domain service that owns the query lifecycle: catalog
population, AST validation, row iteration, content loading, and CEL evaluation.

```
CLI / CEL / Extension method
         │
    DataQueryService (domain)
         │
    ┌────┴────┐
    │         │
CatalogStore  CelEvaluator
(node:sqlite) (existing)
    │
    │         UnifiedDataRepository
    │              │
    │         content loading
    │         (lazy, per-row)
    │
    └── write-through updates from UnifiedDataRepository mutations
```

Both `CatalogStore` and `DataQueryService` are wired through
`RepositoryContext` via `createRepositoryContext()`.

## Ephemeral Data

Data with `lifetime: "ephemeral"` lives only in memory for the length of a
workflow run or method run. It uses a parallel in-memory stack:

- **`InMemoryUnifiedDataRepository`**: `Map`-based storage with no disk I/O.
  `allocateVersion` creates a temp file for `DataWriter` compatibility;
  `finalizeVersion` reads it into memory and deletes it.
- **`:memory:` `CatalogStore`**: a separate SQLite instance so queries work
  transparently. It is marked pre-populated to skip filesystem backfill.
- **`CompositeUnifiedDataRepository`**: wraps the filesystem and in-memory
  repos. Writes route by `data.lifetime === "ephemeral"`. Reads check
  ephemeral first, then persistent, so `data.latest()` resolves transparently.
- **`CompositeDataQueryService`**: merges query results from both catalogs,
  with deduplication.

### Lifecycle scoping

Each execution creates the ephemeral store at the start and disposes it in the
`finally` block:

- **Workflow runs**: `workflowRun()` creates the store and passes it through
  `createExecutionService` → `WorkflowExecutionService` constructor. All steps
  share it, so downstream steps can read upstream ephemeral data.
- **Standalone method runs**: `modelMethodRun()` creates and disposes its own
  store.
- **Workflow resume**: gets a fresh store. Ephemeral data from before suspension
  is lost by design. Use `"workflow"` or `"infinite"` lifetime for data that
  must survive suspension.

### Definition-level overrides

Definitions can override a model type's default resource lifetime:

```yaml
resources:
  result:
    lifetime: ephemeral
    garbageCollection: 3
```

These become `dataOutputOverrides` and merge with any workflow step overrides
(step wins).

### Remote execution

Each `ActiveDispatch` carries the per-execution composite repo. The data plane
resolves `dispatch.dataRepo` for each worker's reads and writes, so remote
workers reach ephemeral data through the same composite as local steps.
