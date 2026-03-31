---
name: swamp-data-query
description: Query swamp data artifacts using CEL predicates — find, filter, and extract data across all models. Use when searching for data by field values, filtering by attributes or tags, extracting specific fields from data records, or answering questions about what data exists. Triggers on "data query", "query data", "find data", "search data where", "filter data", "which data has", "data with", "select from data", "data.query", "context.queryData", "CEL predicate", "data predicate".
---

# Swamp Data Query

Query data artifacts across all models using CEL predicates. Available from the
CLI, CEL expressions in definitions/workflows, and extension method code.

## CLI: `swamp data query`

```bash
swamp data query '<predicate>'                          # filter with default table
swamp data query '<predicate>' --select '<projection>'  # filter + extract fields
swamp data query '<predicate>' --limit 10               # cap results
```

### Filterable Fields

| Field         | Type   | Example                             |
| ------------- | ------ | ----------------------------------- |
| `modelName`   | string | `modelName == "scanner"`            |
| `specName`    | string | `specName == "result"`              |
| `dataType`    | string | `dataType == "resource"`            |
| `name`        | string | `name.contains("prod")`             |
| `version`     | int    | `version > 3`                       |
| `size`        | int    | `size > 1048576`                    |
| `contentType` | string | `contentType == "application/json"` |
| `lifetime`    | string | `lifetime == "infinite"`            |
| `ownerType`   | string | `ownerType == "workflow-step"`      |
| `streaming`   | bool   | `streaming == true`                 |
| `tags`        | map    | `tags.env == "prod"`                |
| `attributes`  | map    | `attributes.status == "failed"`     |
| `content`     | string | `content.contains("ERROR")`         |
| `createdAt`   | string | `createdAt > "2026-03-01"`          |

`tags` and `attributes` are arbitrary maps — missing keys silently don't match.
`attributes` is the parsed JSON content (JSON types only), loaded from disk only
when referenced. `content` is the raw text string (for text/*, JSON, YAML
types), also lazy-loaded. For binary types, `content` is `""`.

### Predicate Examples

```bash
# By model and spec
swamp data query 'modelName == "ingest" && specName == "result"'

# By tag values
swamp data query 'tags.env == "prod" && tags.team == "platform"'

# By content — find failed results
swamp data query 'attributes.status == "failed"'

# Combine metadata and content filters
swamp data query 'modelName == "scanner" && attributes.os == "amzn"'

# Pattern matching
swamp data query 'name.contains("vpc") && dataType == "resource"'

# Size and version filters
swamp data query 'size > 10000 && version > 1'
```

### Projection with `--select`

Use `--select` to extract specific fields from each matched record. **Always
prefer `--select` for data exploration and extraction** — it produces clean,
targeted output without needing ad-hoc scripts or JSON parsing.

```bash
# Extract one field — one value per line
swamp data query 'modelName == "scanner"' --select 'name'

# Custom table — map keys become column headers
swamp data query 'modelName == "scanner"' \
    --select '{"host": name, "os": attributes.os, "kernel": attributes.kernel}'

# String formatting
swamp data query 'specName == "result"' \
    --select 'modelName + "/" + name + " v" + string(version)'

# Dump content from matching records
swamp data query 'modelName == "ingest" && specName == "result"' \
    --select 'attributes'

# Conditional output
swamp data query 'specName == "result"' \
    --select 'attributes.status == "failed" ? "FAIL " + name : "ok   " + name'
```

**Map keys must be quoted strings** in CEL:

```
{"name": name, "os": attributes.os}     ✓ correct
{name: name, os: attributes.os}         ✗ bare keys resolve as variables
```

### `--json` Flag

Avoid `--json` for data exploration or extraction — use `--select` instead.
Reserve `--json` for third-party integration where another tool needs the full
structured output.

## CEL Expressions in Definitions and Workflows

`data.query(predicate)` returns `DataRecord[]`. With a second argument,
`data.query(predicate, select)` returns projected values directly:

```yaml
attributes:
  # Full records
  results: ${data.query('modelName == "ingest" && specName == "result"')}

  # Projection — returns values directly, no .map() needed
  names: ${data.query('modelName == "scanner"', 'name')}
  summary: ${data.query('specName == "result"', '{"name": name, "status": attributes.status}')}

      # Without projection, use .map() for the same effect
      hostnames: ${data.query('modelName == "scanner"').map(r, r.name)}

      # Check existence
      hasConfig: ${size(data.query('modelName == "config" && name == "active"')) > 0}
```

## Extension Methods

`context.queryData(predicate, select?)` in model method `execute()` functions:

```typescript
// Full records
const hosts = await context.queryData!(
  'modelName == "scanner" && tags.env == "prod"',
);
for (const record of hosts) {
  const { hostname, os } = record.attributes;
}

// With projection — returns projected values directly
const names = await context.queryData!(
  'modelName == "scanner"',
  "name",
);
// names is string[]
```

## References

See [references/fields.md](references/fields.md) for the complete DataRecord
field reference and CEL operator examples.
