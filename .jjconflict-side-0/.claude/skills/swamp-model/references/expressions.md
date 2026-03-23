# Expression Language Reference

Model inputs support CEL expressions using `${{ <expression> }}` syntax.

## Reference Types

| Reference                                                               | Description                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `inputs.<name>`                                                         | Runtime input value                                     |
| `model.<name>.input.globalArguments.<field>`                            | Another model's global argument                         |
| `model.<name>.resource.<specName>.<instanceName>.attributes.<field>`    | A model's resource data field (spec → instance → field) |
| `model.<name>.file.<specName>.<instanceName>.{path\|size\|contentType}` | A model's file metadata (spec → instance → field)       |
| `file.contents("<modelName>", "<specName>")`                            | Lazy-load file contents from disk                       |
| `self.name`                                                             | This model's name                                       |
| `self.version`                                                          | This model's version                                    |
| `self.globalArguments.<field>`                                          | This model's own global argument                        |

> **Instance name convention:** For single-instance resources (most models),
> `instanceName` equals `specName`. For example, a model `my-shell` with
> resource spec `result` is accessed as
> `model.my-shell.resource.result.result.attributes.exitCode`. Factory models
> use distinct instance names — see the `swamp-extension-model` skill for
> details.

## CEL Operations

- **String concatenation:** `self.name + "-suffix"`
- **Arithmetic:** `self.globalArguments.count * 2`
- **Conditionals:** `self.globalArguments.enabled ? "yes" : "no"`

## Data Versioning Functions

Access specific versions of model data using the `data` namespace:

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

# Find by tag
allResources: ${{ data.findByTag("type", "resource") }}

# Find all instances from a factory model's output spec
subnets: ${{ data.findBySpec("my-scanner", "subnet") }}
```

## Example with Expressions

```yaml
id: 550e8400-e29b-41d4-a716-446655440001
name: my-subnet
version: 1
tags: {}
globalArguments:
  vpcId: ${{ model.my-vpc.resource.state.current.attributes.VpcId }}
  cidrBlock: "10.0.1.0/24"
  tags:
    Name: ${{ self.name + "-subnet" }}
methods:
  create:
    arguments: {}
```
