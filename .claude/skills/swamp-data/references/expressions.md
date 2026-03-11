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

| Function                                     | Description                               |
| -------------------------------------------- | ----------------------------------------- |
| `data.version(modelName, dataName, version)` | Get specific version of data              |
| `data.latest(modelName, dataName)`           | Get latest version of data                |
| `data.listVersions(modelName, dataName)`     | Get array of available version numbers    |
| `data.findByTag(tagKey, tagValue)`           | Find all data matching a tag              |
| `data.findBySpec(modelName, specName)`       | Find all data from a specific output spec |

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
