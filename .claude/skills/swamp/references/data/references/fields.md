# DataRecord Field Reference

## Metadata Fields (always available, no disk read)

| Field               | Type             | Values                                                                              |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `id`                | string           | UUID of the data artifact                                                           |
| `name`              | string           | Data instance name (e.g. `classification-main`)                                     |
| `version`           | int              | Version number of this record                                                       |
| `isLatest`          | bool             | `true` for the newest version of each item                                          |
| `createdAt`         | string           | ISO-8601 timestamp                                                                  |
| `modelName`         | string           | Owning model's name when the data was written (not updated by a model rename)       |
| `modelId`           | string           | Owning model id (definition id; workflow id for workflow-scope data)                |
| `modelType`         | string           | Owning model type (normalized)                                                      |
| `specName`          | string           | Output spec name (e.g. `classification`)                                            |
| `dataType`          | string           | `"resource"` or `"file"`                                                            |
| `contentType`       | string           | MIME type (e.g., `"application/json"`)                                              |
| `lifetime`          | string           | `"infinite"`, `"ephemeral"`, `"job"`, `"workflow"`, or duration like `"1h"`, `"7d"` |
| `garbageCollection` | number or string | Versions kept: a count (`10`) or a duration (`"30d"`); `""` if unknown              |
| `ownerType`         | string           | `"model-method"`, `"workflow-step"`, or `"manual"`                                  |
| `ownerRef`          | string           | Owning entity; with `ownerType`, what ownership is checked on                       |
| `workflowRunId`     | string           | Run that wrote the data (empty outside workflows)                                   |
| `workflowName`      | string           | Workflow that wrote the data (empty outside workflows)                              |
| `jobName`           | string           | Job that wrote the data (empty outside workflows)                                   |
| `stepName`          | string           | Step that wrote the data (empty outside workflows)                                  |
| `source`            | string           | Provenance source (e.g. `"step-output"`, `""`)                                      |
| `ns`                | string           | Namespace that produced the data in a shared datastore                              |
| `streaming`         | bool             | `true` if append-only                                                               |
| `size`              | int              | Content size in bytes                                                               |
| `tags`              | map              | Arbitrary string key-value pairs                                                    |

A query matches `name` exactly. To find data by its spec name, match `specName`;
when a `name == "..."` query finds nothing but data with that spec name exists,
`swamp data query` prints the spec-name query to run instead (`specNameHint` in
`--json`; with `--single` it is part of the no-match error).

`garbageCollection` is a number for a count policy and a string for a duration.
Equality across the two types is simply false, but an ordering comparison
against a duration row errors and that row is skipped, so guard it:

```cel
garbageCollection == 10
garbageCollection == "30d"
type(garbageCollection) != string && garbageCollection < 5
```

## Content Fields (loaded from disk on demand)

| Field        | Type   | Notes                                                                                                                                     |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `attributes` | map    | Parsed JSON content. Only loaded when referenced. Empty `{}` for non-JSON types.                                                          |
| `content`    | string | Raw text content. Only loaded when referenced. Available for text types: text/\*, JSON, YAML, XML, TOML and `+json`/`+xml`/`+yaml` types. |

In a predicate, `content` is text: reading it on an item whose `contentType` is
not text fails the query, naming the item. Guard it with the type, for example
`contentType.startsWith("text/") && ...`, adding the other text types when they
should match.

In `--select`, `content` holds any item's bytes (a leading UTF-8 byte-order mark
is dropped), and the select-only field `contentEncoding` says how: `"utf-8"`
(text, or the parsed object for JSON) or `"base64"` (binary, or text that is not
UTF-8). Both are `null` when the bytes are not on this host. To save a binary
artifact:

```bash
swamp data query 'modelName == "<model>" && name == "<name>"' \
  --select '{"content": content, "contentEncoding": contentEncoding}' --json \
  | jq -r '.results[0].content' | base64 -d > out.bin
```

## `model()` — match by model, as `data get` resolves it

`model("<name or definition id>")` is true for data stored under that model's
current definition. It resolves the argument the way `data get <model>` does
(name first, then exact definition id), so it still matches after a model
rename, for data with no `modelName` tag, and never matches data left by a
deleted model whose name was reused. `modelName == "<m>"` compares the tag
written with the data, so it can differ in each of those cases.

- The argument must be a non-empty string literal; up to 32 distinct models per
  predicate.
- An unknown model is an error (`Model not found`), as in `data get`. Over
  `--server`, a model you may not read fails the same way.
- Predicates only, not `--select`. It is resolved by `swamp data query` and
  serve's `data.query`; CEL `data.query()` in models and workflows rejects it
  (use `modelId` and `modelType` there).
- It matches the definition's data in every namespace the catalog holds, not
  only this repository's.

## CEL Operators

```cel
# Equality
modelName == "ingest"
dataType != "file"

# Comparison
version > 3
size >= 1024

# Logical
modelName == "a" && specName == "b"
specName == "result" || specName == "summary"
!streaming

# String methods
name.contains("prod")
name.startsWith("ep-")
name.endsWith("-result")
name.matches("^ep-[0-9]+$")

# Map access (tags and attributes)
tags.env == "prod"
attributes.status == "failed"
attributes.config.retries > 0

# Existence (for optional map keys)
has(attributes.kernel)
```

## `--select` Projection Types

### Scalar — one value per line

```bash
--select 'name'
--select 'modelName + "/" + name'
--select 'string(version)'
```

### Map — custom table with named columns

```bash
--select '{"host": name, "os": attributes.os}'
--select '{"name": name, "v": version, "spec": specName}'
```

### List — positional columns, no headers

```bash
--select '[name, modelName, string(size)]'
```

### Object dump — pretty-printed JSON per record

```bash
--select 'attributes'
--select '{"kernel": attributes.kernel, "arch": attributes.arch}'
```

### Conditional

```bash
--select 'size > 1000 ? name + " (large)" : name + " (small)"'
```
