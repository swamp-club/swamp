# Data Query

Data query provides a unified interface for finding data artifacts across models
using CEL predicates. Queries filter on artifact metadata (model name, spec name,
tags, version, etc.) and optionally on JSON content.

The query interface is available in three places:

- **CLI** — `swamp data query '<predicate>'`
- **CEL expressions** — `data.query('<predicate>')` in definitions and workflows
- **Extension methods** — `context.queryData('<predicate>')` in model method
  implementations

All three accept the same CEL predicate syntax and operate on the same fields.

## DataRecord

`data.query()` returns `DataRecord[]` — the same type returned by
`data.latest()`, `data.version()`, `data.findByTag()`, `data.findBySpec()`,
and `context.readModelData()`. As part of this work, `DataRecord` is extended
with metadata fields:

```typescript
interface DataRecord {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  attributes: Record<string, unknown>;
  tags: Record<string, string>;
  modelName: string;
  modelType: string;
  specName: string;
  dataType: string;
  contentType: string;
  lifetime: string;
  ownerType: string;
  streaming: boolean;
  size: number;
  content: string;

  // Provenance fields — promoted from tags/ownerDefinition.
  // Empty string when data was not produced inside a workflow.
  ownerRef: string;
  workflowRunId: string;
  workflowName: string;
  jobName: string;
  stepName: string;
  source: string;
}
```

All `DataRecord` fields are populated by a unified `DataRecordMapper`
(`fromRow()` for catalog-backed queries, `fromData()` for version lookups).
This is backward-compatible: existing code that reads `record.name` or
`record.attributes` continues to work; the provenance fields are additive.

For JSON resources (`contentType == "application/json"`), `attributes` contains
the parsed content — matching the existing behavior of `data.latest()` and
other accessors. For non-JSON data, `attributes` is `{}`.

Results from `data.query()` are interchangeable with results from any other
data accessor. CEL expressions that work on `data.latest()` results work
identically on `data.query()` results, and vice versa.

## Filter Context

The predicate is evaluated against each `DataRecord`. The full set of
filterable fields:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Data artifact UUID |
| `name` | string | Data artifact name |
| `version` | int | Latest version number |
| `createdAt` | string | ISO-8601 timestamp |
| `attributes` | map | Parsed JSON content (lazy-loaded, resources only) |
| `tags` | map | All tags as key-value pairs |
| `modelName` | string | Owning model name |
| `modelType` | string | Owning model type |
| `specName` | string | Output spec name |
| `dataType` | string | `"resource"` or `"file"` |
| `contentType` | string | MIME type |
| `lifetime` | string | Lifetime policy |
| `ownerType` | string | `"model-method"`, `"workflow-step"`, or `"manual"` |
| `streaming` | bool | Whether data is append-only |
| `size` | int | Content size in bytes |
| `content` | string | Raw text content (lazy-loaded, text types only) |
| `ownerRef` | string | Model definition ID that owns this data |
| `workflowRunId` | string | Workflow run ID (`""` outside workflows) |
| `workflowName` | string | Workflow name (`""` outside workflows) |
| `jobName` | string | Job name (`""` outside workflows) |
| `stepName` | string | Step name (`""` outside workflows) |
| `source` | string | Provenance source (e.g. `"step-output"`, `""`) |

All fields except `attributes` and `content` are metadata stored in the
catalog. `attributes` and `content` are loaded from disk on demand when the
predicate or select expression references them. `attributes` contains parsed
JSON (for `application/json` only). `content` contains the raw text string
(for `text/*`, `application/json`, `application/yaml`). For binary content
types, `content` is `""`.

## Provenance-Based Filtering

Data produced inside a workflow carries first-class provenance fields
(`workflowRunId`, `workflowName`, `stepName`, etc.). These fields are
queryable just like any other `DataRecord` field — no hidden scoping is
applied by the framework.

To scope results to a specific workflow run, write an explicit predicate:

```cel
modelName == "dedup" && specName == "episode" && workflowRunId == "run-uuid"
```

All data access functions (`data.findBySpec()`, `data.findByTag()`,
`data.latest()`, `data.query()`, `context.readModelData()`,
`context.queryData()`) return unscoped results by default. The predicate
string is the contract — if it doesn't say it, it isn't happening.

**Vault resolution:** JSON attributes containing `vault.get(...)` references
are resolved automatically in async data access paths (extension methods,
`data.query()` in CEL). Resolution failures leave the reference unresolved
rather than failing the record.

## Predicate Syntax

Predicates are standard CEL expressions that evaluate to a boolean. Any CEL
operator or built-in function can be used.

```cel
modelName == "ingest-pipeline" && specName == "result"

tags.env == "prod" && tags.team == "platform"

specName == "result" || specName == "summary"

name.contains("episode") && version > 3

streaming && ownerType == "workflow-step"

modelName == "scanner" && attributes.status == "failed"
```

### Field Validation

Before evaluation, the predicate AST is walked to verify that all referenced
identifiers are known query record fields. Unknown fields produce an error:

```
Error: Unknown field "model" in query predicate.
Available: id, name, version, createdAt, attributes, tags, modelName,
  modelType, specName, dataType, contentType, lifetime, ownerType, streaming, size
```

## Catalog

Query performance is backed by a SQLite metadata catalog at
`.swamp/data/_catalog.db`, using `node:sqlite` (built into the Deno runtime).
The catalog stores one row per artifact (latest version only) containing all
metadata fields from the query record except `attributes`.

### Schema

```sql
CREATE TABLE catalog (
  type_normalized TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  data_name       TEXT NOT NULL,
  id              TEXT NOT NULL,
  version         INTEGER NOT NULL,
  model_name      TEXT NOT NULL,
  spec_name       TEXT NOT NULL DEFAULT '',
  data_type       TEXT NOT NULL DEFAULT '',
  content_type    TEXT NOT NULL DEFAULT '',
  lifetime        TEXT NOT NULL DEFAULT '',
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
  PRIMARY KEY (type_normalized, model_id, data_name)
);

CREATE INDEX idx_model_name      ON catalog(model_name);
CREATE INDEX idx_spec_name       ON catalog(spec_name);
CREATE INDEX idx_data_type       ON catalog(data_type);
CREATE INDEX idx_created_at      ON catalog(created_at);
CREATE INDEX idx_workflow_run_id ON catalog(workflow_run_id);
CREATE INDEX idx_step_name       ON catalog(step_name);

CREATE TABLE catalog_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

The catalog includes a `schema_version` key in `catalog_meta`. When the
version changes, the catalog table is dropped and rebuilt via self-healing
backfill on next query.

Content is not stored in the catalog. It remains on disk in the existing
versioned file layout.

### Write-Through Updates

Every mutation in `UnifiedDataRepository` updates the catalog inline:

| Repository Method | Catalog Operation |
| --- | --- |
| `save()` | Upsert row with new version, size, checksum, createdAt |
| `append()` | Update size |
| `delete()` | Remove row, or update version if only one version deleted |
| `rename()` | Remove old row, insert new row |
| `finalizeVersion()` | Upsert row |
| `removeLatestMarker()` | Remove row |
| `collectGarbage()` | Update version or remove row |

The `CatalogStore` is a required constructor parameter on
`UnifiedDataRepository`. Every repository instance maintains write-through
catalog consistency. Use `createCatalogStore()` from `repository_factory.ts`
to construct one from a repo directory.

### Population Strategy

The catalog builds up incrementally:

1. **Write-through** — every data mutation upserts or removes a catalog row.
   New data is immediately queryable.
2. **Backfill on first query** — on the first call to `DataQueryService.query()`,
   if the catalog is not marked as populated, a one-time `findAllGlobal()` runs,
   bulk-inserts all existing metadata, and sets a `populated` flag in the
   `catalog_meta` table.
3. **Self-healing** — if `_catalog.db` is deleted or corrupted, the next query
   triggers a backfill automatically.

### Remote Datastores (S3)

The catalog is local-only. It lives in the local cache directory and is excluded
from sync — it is never pushed to or pulled from S3.

After `pullChanged()`, the sync diff (list of changed and deleted file paths)
drives incremental catalog updates:

- For each changed `metadata.yaml`: parse it and upsert the corresponding row.
- For each deleted artifact path: remove the corresponding row.

On cold start (new machine, empty cache), the initial pull downloads all files.
The catalog doesn't exist yet, so the first query triggers a backfill from the
freshly-pulled cache.

The `DatastoreSyncService` interface returns the diff:

```typescript
interface SyncDiff {
  changed: string[];
  deleted: string[];
}

interface DatastoreSyncService {
  pullChanged(): Promise<SyncDiff>;
  pushChanged(): Promise<void>;
}
```

## Query Execution

Queries iterate over catalog rows and evaluate the full CEL predicate against
each row. There is no SQL pushdown — SQLite serves as a fast metadata store,
and CEL handles all filtering semantics.

```
1. Parse predicate into AST
2. Validate field references
3. Detect whether predicate references `attributes`
4. SELECT metadata columns from catalog (via stmt.iterate())
5. For each row:
   a. Project row into query record
   b. If predicate references `attributes`:
      load JSON content from disk for this row
   c. Evaluate CEL predicate against query record
   d. If true: add to results
   e. If results.length >= limit: stop
6. Return results
```

Iteration uses `stmt.iterate()` so that only one row is in memory at a time.
Content is loaded per-row only when needed. The query stops as soon as the
limit is reached.

When the predicate does not reference `attributes`, the SELECT omits content
loading entirely. This is detected by walking the AST for the `attributes`
identifier before execution.

## Projection (`--select`)

The `--select` flag takes a second CEL expression that controls what to show
from each matched row. The filter predicate decides **which rows** match. The
projection decides **what to extract**.

```bash
swamp data query '<filter predicate>' --select '<projection expression>'
```

Both expressions operate on the same `DataRecord` fields. The filter returns a
boolean; the projection returns any value.

### Output Format by Return Type

The projection result type determines the output format:

| Projection returns | Log mode | JSON mode |
| --- | --- | --- |
| string / number / bool | One value per line | Array of values |
| map (object) | Table with map keys as headers | Array of objects |
| list (array) | Tab-separated columns (no headers) | Array of arrays |
| null | Skipped | `null` in array |

The first result's type sets the format. If the first result is a map, all
results render as a table. If it's a scalar, all results render as lines.

### Map Key Syntax

CEL map literals require **quoted string keys**. Bare identifiers are resolved
as variable references, not key names:

```cel
{"name": name, "status": attributes.status}    ✓ correct
{name: name, status: attributes.status}         ✗ wrong — "name" resolves as variable
```

### Examples

**Scalar projection** — one value per row, pipe-friendly:

```bash
$ swamp data query 'modelName == "ingest"' --select 'name'

episode-001
episode-002
episode-003
```

**String expression** — formatted output:

```bash
$ swamp data query 'specName == "result"' \
    --select 'modelName + "/" + name + " v" + string(version)'

ingest/episode-001 v3
ingest/episode-002 v1
scanner/scan-result v7
```

**Map projection** — custom-columned table:

```bash
$ swamp data query 'modelName == "ingest"' \
    --select '{"name": name, "status": attributes.status, "v": version}'

name             status    v
───────────────  ────────  ──
episode-001      failed     3
episode-002      ok         1
episode-003      failed     5
```

The map keys become column headers. This is the primary way to build custom
views — pick exactly which fields you want, name them how you want.

With `--json`, map projections produce a JSON array of objects:

```bash
$ swamp data query 'modelName == "ingest"' \
    --select '{"name": name, "status": attributes.status}' --json

[
  {"name": "episode-001", "status": "failed"},
  {"name": "episode-002", "status": "ok"}
]
```

**Nested map projection** — complex structures as table values:

```bash
$ swamp data query 'modelName == "scanner"' \
    --select '{"name": name, "system": {"kernel": attributes.kernel, "arch": attributes.arch}}'

name             system
───────────────  ─────────────────────────────────────────
ip-172-31-12     `{"kernel":"6.1.161-183","arch":"x86_64"}`
ip-10-0-3-42     `{"kernel":"6.1.161-183","arch":"arm64"}`
```

Complex values (objects, arrays) in table cells render as inline JSON code
spans. For full pretty-printed output, project the object as a scalar instead:

```bash
$ swamp data query 'modelName == "scanner"' \
    --select '{"kernel": attributes.kernel, "arch": attributes.arch}'

{
  "kernel": "6.1.161-183.298.amzn2023.x86_64",
  "arch": "x86_64"
}

{
  "kernel": "6.1.161-183.298.amzn2023.x86_64",
  "arch": "arm64"
}
```

When the projection returns a bare object (not inside a map with other
columns), each result renders as a pretty-printed syntax-highlighted JSON
block.

**Bare attributes** — dump content from matching records:

```bash
$ swamp data query 'modelName == "ingest" && specName == "result"' \
    --select 'attributes'

{
  "status": "failed",
  "errorCode": "TIMEOUT",
  "retries": 3
}

{
  "status": "ok",
  "processedCount": 142
}
```

**Conditional projection:**

```bash
$ swamp data query 'specName == "result"' \
    --select 'attributes.status == "failed" ? "FAIL " + name : "ok   " + name'

FAIL episode-001
ok   episode-002
FAIL episode-003
```

**List projection** — positional columns (no headers):

```bash
$ swamp data query 'tags.env == "prod"' \
    --select '[name, modelName, string(size)]'

episode-001  ingest    1234
episode-002  ingest    890
config       platform  45
```

### Default (no `--select`)

Without `--select`, the CLI renders a markdown table with fixed columns:
`name`, `modelName`, `specName`, `dataType`, `version`, `size`.

### Interaction with Other Flags

`--select` and `--json` compose naturally: `--json` changes the rendering of
projected values from human-readable to JSON. `--select` and `--limit` compose
naturally: limit applies to matched rows, projection applies to output.

### Implementation

Projection is a domain/application concern. The `DataQueryService` returns
`DataRecord[]` as before, but accepts a `selectExpression` hint so it loads
`attributes` from disk when the projection references them. The libswamp
generator evaluates the projection against each result, classifies the output
shape, and yields typed events. The renderer builds markdown from the event
data and passes it through `renderMarkdownToTerminal()` for terminal output.

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

`data.query()` accepts a predicate and an optional projection expression.
Without projection, it returns `DataRecord[]`. With projection, it returns
the projected values directly.

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

`context.queryData()` accepts the same two arguments:

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

`CatalogStore` is an infrastructure component wrapping `node:sqlite`. It
exposes `upsert()`, `remove()`, `iterate()`, and population management.

`DataQueryService` is a domain service. It owns the query lifecycle: catalog
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
