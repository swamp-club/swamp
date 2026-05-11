# Accessing Data in Expressions

Use CEL expressions to access model data in workflows and model inputs.

**Note:** `model.<name>.resource.<spec>` requires the model to have previously
produced data (a method was run that called `writeResource`). If no data exists
yet, accessing `.resource` will fail with "No such key". Use
`swamp data list <model-name>` to verify data exists.

```yaml
# Access latest resource data via dot notation
value: ${{ model.my-model.resource.output.main.attributes.result }}

# Access specific version
value: ${{ data.version("my-model", "main", 2).attributes.result }}

# Access file metadata
path: ${{ model.my-model.file.content.primary.path }}
size: ${{ model.my-model.file.content.primary.size }}

# Lazy-load file contents
body: ${{ file.contents("my-model", "content") }}
```

## Data Namespace Functions

`data.query('<predicate>', '<select>?')` is the general primitive. The functions
below are shortcuts for common predicates — prefer them when your intent
matches, because the short form reads more clearly. Reach for `data.query()`
directly when you need a multi-field predicate, a projection, tag filters beyond
a single key, or history beyond a single version.

| Function                                     | Description                               |
| -------------------------------------------- | ----------------------------------------- |
| `data.query(predicate, select?)`             | General query with full CEL predicate     |
| `data.version(modelName, dataName, version)` | Get specific version of data              |
| `data.latest(modelName, dataName)`           | Get latest version of data                |
| `data.listVersions(modelName, dataName)`     | Get array of available version numbers    |
| `data.findByTag(tagKey, tagValue)`           | Find all data matching a tag              |
| `data.findBySpec(modelName, specName)`       | Find all data from a specific output spec |

### CEL shortcut mapping

Every shortcut is equivalent to a specific `data.query()` call. Results have the
same `DataRecord[]` shape — anything that works on a shortcut result works on a
query result.

| Shortcut                      | Underlying query                                                           |
| ----------------------------- | -------------------------------------------------------------------------- |
| `data.latest("m", "n")`       | `data.query('modelName == "m" && name == "n"')[0]`                         |
| `data.version("m", "n", 2)`   | `data.query('modelName == "m" && name == "n" && version == 2')[0]`         |
| `data.listVersions("m", "n")` | `data.query('modelName == "m" && name == "n" && version >= 0', 'version')` |
| `data.findByTag("k", "v")`    | `data.query('tags.k == "v"')`                                              |
| `data.findBySpec("m", "s")`   | `data.query('modelName == "m" && specName == "s"')`                        |

See [fields.md](fields.md) for the full list of queryable fields and predicate
operators.

**DataRecord structure** returned by these functions:

```json
{
  "id": "uuid",
  "name": "data-name",
  "version": 3,
  "createdAt": "2025-01-15T10:30:00Z",
  "attributes": {/* data content */},
  "tags": { "type": "resource" }
}
```

**Example usage:**

```yaml
# Get specific version
oldValue: ${{ data.version("my-model", "state", 2).attributes.value }}

# Get latest
current: ${{ data.latest("my-model", "output").attributes.result }}

# List versions for conditional logic
hasHistory: ${{ size(data.listVersions("my-model", "state")) > 1 }}

# Find all resources across models
allResources: ${{ data.findByTag("type", "resource") }}

# Find data from a specific workflow
workflowData: ${{ data.findByTag("workflow", "my-workflow") }}

# Find all instances from a factory model's output spec
subnets: ${{ data.findBySpec("my-scanner", "subnet") }}

# Query with a multi-field predicate — reach for data.query() when no
# shortcut fits
failures: ${{ data.query('modelName == "scanner" && dataType == "resource" && attributes.status == "failed"') }}

# Query with a projection — extract specific fields from every match
manifest: ${{ data.query('tags.role == "manifest"', '{"name": name, "version": version, "at": createdAt}') }}
```

**Key rules:**

- `model.<name>.resource.<specName>.<instanceName>` — accesses the latest
  version of a resource. Works both within a workflow run (in-memory updates)
  and across workflow runs (persisted data).
- `model.<name>.file.<specName>.<instanceName>` — accesses file metadata (path,
  size, contentType). Same behavior as resource expressions.
- `data.latest(modelName, dataName)` — reads persisted data snapshot taken at
  workflow start.
- Use `data.version()` function for specific versions
- Use `data.findByTag()` to query across models
- See the `swamp-workflow` skill's
  [data-chaining reference](../../swamp-workflow/references/data-chaining.md)
  for detailed guidance on expression choice in workflows.
