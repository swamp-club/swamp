# DataRecord Field Reference

## Metadata Fields (always available, no disk read)

| Field         | Type   | Values                                                                              |
| ------------- | ------ | ----------------------------------------------------------------------------------- |
| `id`          | string | UUID of the data artifact                                                           |
| `name`        | string | Human-readable data name                                                            |
| `version`     | int    | Latest version number                                                               |
| `createdAt`   | string | ISO-8601 timestamp                                                                  |
| `modelName`   | string | Owning model name                                                                   |
| `modelType`   | string | Owning model type (normalized)                                                      |
| `specName`    | string | Output spec name                                                                    |
| `dataType`    | string | `"resource"` or `"file"`                                                            |
| `contentType` | string | MIME type (e.g., `"application/json"`)                                              |
| `lifetime`    | string | `"infinite"`, `"ephemeral"`, `"job"`, `"workflow"`, or duration like `"1h"`, `"7d"` |
| `ownerType`   | string | `"model-method"`, `"workflow-step"`, or `"manual"`                                  |
| `streaming`   | bool   | `true` if append-only                                                               |
| `size`        | int    | Content size in bytes                                                               |
| `tags`        | map    | Arbitrary string key-value pairs                                                    |

## Content Fields (loaded from disk on demand)

| Field        | Type   | Notes                                                                                                                                  |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `attributes` | map    | Parsed JSON content. Only loaded when referenced. Empty `{}` for non-JSON types.                                                       |
| `content`    | string | Raw text content. Only loaded when referenced. Empty `""` for binary types. Available for text/\*, application/json, application/yaml. |

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
