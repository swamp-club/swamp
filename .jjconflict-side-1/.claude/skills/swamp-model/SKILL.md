---
name: swamp-model
description: Work with swamp models for AI-native automation. Use when searching for model types, describing model schemas, creating model inputs, running model methods, or viewing outputs. Triggers on "swamp model", "model type", "create input", "type search", "type describe", "run method", "execute method", "model validate", "model delete", "model edit", "model output", "output logs", "CEL expression", or running automation workflows.
---

# Swamp Model Skill

Work with swamp models through the CLI. All commands support `--json` for
machine-readable output.

## Quick Reference

| Task               | Command                                                  |
| ------------------ | -------------------------------------------------------- |
| Search model types | `swamp type search [query] --json`                       |
| Describe a type    | `swamp type describe <type> --json`                      |
| Create model input | `swamp model create <type> <name> --json`                |
| Search models      | `swamp model search [query] --json`                      |
| Get model details  | `swamp model get <id_or_name> --json`                    |
| Edit model input   | `swamp model edit [id_or_name]`                          |
| Delete a model     | `swamp model delete <id_or_name> --json`                 |
| Validate model     | `swamp model validate [id_or_name] --json`               |
| Evaluate input(s)  | `swamp model evaluate [id_or_name] --json`               |
| Run a method       | `swamp model method run <id_or_name> <method> --json`    |
| Run with inputs    | `swamp model method run <name> <method> --input '{}' -j` |
| Search outputs     | `swamp model output search [query] --json`               |
| Get output details | `swamp model output get <output_or_model> --json`        |
| View output logs   | `swamp model output logs <output_id> --json`             |
| View output data   | `swamp model output data <output_id> --json`             |

## Repository Structure

Swamp uses a dual-layer architecture:

- **Data directory (`/.swamp/`)** - Internal storage organized by entity type
- **Logical views (`/models/`)** - Human-friendly symlinked directories

```
/models/{model-name}/
  input.yaml → ../.swamp/definitions/{type}/{id}.yaml
  resource.yaml → ../.swamp/data/{type}/{id}/resource/latest/raw
  data.yaml → ../.swamp/data/{type}/{id}/data/latest/raw
  outputs/ → ../.swamp/outputs/{type}/{id}/
  logs/ → ../.swamp/data/{type}/{id}/ (filtered by type=log)
  files/ → ../.swamp/data/{type}/{id}/ (filtered by type=file)
```

Use `swamp repo index` to rebuild if symlinks become out of sync.

## Search for Model Types

Find available model types in the system.

```bash
swamp type search --json
swamp type search "echo" --json
```

**Output shape:**

```json
{
  "query": "",
  "results": [
    { "raw": "swamp/echo", "normalized": "swamp/echo" }
  ]
}
```

## Describe Model Types

Get the full schema and available methods for a type.

```bash
swamp type describe swamp/echo --json
```

**Output shape:**

```json
{
  "type": { "raw": "swamp/echo", "normalized": "swamp/echo" },
  "version": "2026.02.09.1",
  "inputAttributesSchema": {/* JSON Schema */},
  "resourceAttributesSchema": {/* JSON Schema */},
  "methods": [
    {
      "name": "write",
      "description": "Write the input message to a resource with a timestamp",
      "inputAttributesSchema": {/* JSON Schema */}
    }
  ]
}
```

**Key fields:**

- `inputAttributesSchema` - JSON Schema for input YAML `attributes` section
- `methods` - Available operations with their input schemas

## Create Model Inputs

```bash
swamp model create swamp/echo my-echo --json
```

**Output shape:**

```json
{
  "path": "definitions/swamp/echo/my-echo.yaml",
  "type": "swamp/echo",
  "name": "my-echo"
}
```

After creation, edit the YAML file to set attributes according to
`inputAttributesSchema` from `type describe`.

**Example input file:**

```yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-echo
version: 1
tags: {}
attributes:
  message: "Hello, world!"
```

### Model Inputs Schema

Models can define an `inputs` schema for runtime parameterization:

```yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-deploy
version: 1
tags: {}
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
      description: Target environment
    dryRun:
      type: boolean
      default: false
  required: ["environment"]
attributes:
  target: ${{ inputs.environment }}
  simulate: ${{ inputs.dryRun }}
```

Inputs are provided at runtime with `--input` or `--input-file` and referenced
in attributes using `${{ inputs.<name> }}` expressions.

## Edit a Model

Open model input file in your editor, or update via stdin in non-interactive
mode.

```bash
# Interactive: opens in editor
swamp model edit my-echo
swamp model edit my-echo --resource  # Edit resource file instead

# Non-interactive: update from stdin
cat updated-model.yaml | swamp model edit my-echo --json

# With here-doc (agent-friendly)
swamp model edit my-echo --json <<EOF
id: existing-uuid
name: my-echo
version: 1
attributes:
  message: "Updated message"
EOF
```

Without arguments in interactive mode, shows a search interface to select a
model.

**Output shape (when updating via stdin):**

```json
{
  "path": ".swamp/definitions/swamp/echo/abc-123.yaml",
  "status": "updated",
  "name": "my-echo",
  "type": "swamp/echo",
  "editType": "definition"
}
```

## Delete a Model

Delete a model and all related artifacts (data, outputs, logs).

```bash
swamp model delete my-echo --json
```

**Output shape:**

```json
{
  "deleted": true,
  "modelId": "abc-123",
  "modelName": "my-echo",
  "artifactsDeleted": {
    "outputs": 5,
    "dataItems": 3
  }
}
```

## Validate Model Inputs

Validate a model definition against its type schema.

```bash
swamp model validate my-echo --json
swamp model validate --json  # Validate all models
```

**Output shape (single):**

```json
{
  "modelId": "abc-123",
  "modelName": "my-echo",
  "type": "swamp/echo",
  "validations": [
    { "name": "Input schema validation", "passed": true },
    { "name": "Required attributes present", "passed": true },
    { "name": "Expression syntax valid", "passed": true }
  ],
  "passed": true
}
```

**Output shape (all):**

```json
{
  "models": [
    { "modelId": "abc-123", "modelName": "my-echo", "validations": [...], "passed": true }
  ],
  "totalPassed": 5,
  "totalFailed": 1,
  "passed": false
}
```

## Expression Language

Model inputs support CEL expressions using `${{ <expression> }}` syntax.

### Reference Types

| Reference                                  | Description                        |
| ------------------------------------------ | ---------------------------------- |
| `inputs.<name>`                            | Runtime input value                |
| `model.<name>.input.attributes.<field>`    | Another model's input attribute    |
| `model.<name>.resource.attributes.<field>` | Another model's resource attribute |
| `model.<name>.data.attributes.<field>`     | Another model's data attribute     |
| `self.name`                                | This model's name                  |
| `self.version`                             | This model's version               |
| `self.attributes.<field>`                  | This model's own input attribute   |

### CEL Operations

- **String concatenation:** `self.name + "-suffix"`
- **Arithmetic:** `self.attributes.count * 2`
- **Conditionals:** `self.attributes.enabled ? "yes" : "no"`

### Data Versioning Functions

Access specific versions of model data using the `data` namespace:

| Function                                     | Description                            |
| -------------------------------------------- | -------------------------------------- |
| `data.version(modelName, dataName, version)` | Get specific version of data           |
| `data.latest(modelName, dataName)`           | Get latest version of data             |
| `data.listVersions(modelName, dataName)`     | Get array of available version numbers |
| `data.findByTag(tagKey, tagValue)`           | Find all data matching a tag           |

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

# Get latest (same as model.my-model.data)
current: ${{ data.latest("my-model", "output").attributes.result }}

# List versions for conditional logic
hasHistory: ${{ size(data.listVersions("my-model", "state")) > 1 }}

# Find by tag
allLogs: ${{ data.findByTag("type", "log") }}
```

### Example with Expressions

```yaml
id: 550e8400-e29b-41d4-a716-446655440001
name: my-subnet
version: 1
tags: {}
attributes:
  vpcId: ${{ model.my-vpc.resource.attributes.vpcId }}
  cidrBlock: "10.0.1.0/24"
  tags:
    Name: ${{ self.name + "-subnet" }}
```

## Evaluate Model Inputs

Evaluate expressions and write results to `inputs-evaluated/`.

```bash
swamp model evaluate my-subnet --json
swamp model evaluate --all --json
```

**Output shape:**

```json
{
  "evaluatedInputs": [
    {
      "name": "my-subnet",
      "type": "aws/subnet",
      "path": "inputs-evaluated/aws/subnet/my-subnet.yaml"
    }
  ]
}
```

## Run Methods

Execute a method on a model input.

```bash
swamp model method run my-echo write --json
swamp model method run my-deploy create --input '{"environment": "prod"}' --json
swamp model method run my-deploy create --input-file inputs.yaml --json
swamp model method run my-deploy create --last-evaluated --json
```

**Options:**

| Flag               | Description                                |
| ------------------ | ------------------------------------------ |
| `--input <json>`   | Input values as JSON string                |
| `--input-file <f>` | Input values from YAML file                |
| `--last-evaluated` | Use previously evaluated model (skip eval) |

**Output shape:**

```json
{
  "outputId": "output-789",
  "modelId": "abc-123",
  "modelName": "my-echo",
  "method": "write",
  "status": "succeeded",
  "duration": 150,
  "artifacts": {
    "resource": ".swamp/data/swamp/echo/abc-123/resource/1/raw",
    "logs": ".swamp/data/swamp/echo/abc-123/log/1/raw"
  }
}
```

## Model Outputs

### Search Outputs

Find method execution outputs.

```bash
swamp model output search --json
swamp model output search "my-echo" --json
```

**Output shape:**

```json
{
  "query": "",
  "results": [
    {
      "outputId": "output-789",
      "modelName": "my-echo",
      "method": "write",
      "status": "succeeded",
      "createdAt": "2025-01-15T10:30:00Z"
    }
  ]
}
```

### Get Output Details

Get full details of a specific output or latest output for a model.

```bash
swamp model output get output-789 --json
swamp model output get my-echo --json  # Latest output for model
```

**Output shape:**

```json
{
  "outputId": "output-789",
  "modelId": "abc-123",
  "modelName": "my-echo",
  "type": "swamp/echo",
  "method": "write",
  "status": "succeeded",
  "startedAt": "2025-01-15T10:30:00Z",
  "completedAt": "2025-01-15T10:30:00.150Z",
  "artifacts": [
    { "type": "resource", "path": "..." },
    { "type": "log", "path": "..." }
  ]
}
```

### View Output Logs

Get log content from a method execution.

```bash
swamp model output logs output-789 --json
```

**Output shape:**

```json
{
  "outputId": "output-789",
  "logs": "Executing write method...\nMessage written successfully."
}
```

### View Output Data

Get data artifact content from a method execution.

```bash
swamp model output data output-789 --json
```

**Output shape:**

```json
{
  "outputId": "output-789",
  "data": {
    "message": "Hello, world!",
    "timestamp": "2025-01-15T10:30:00Z"
  }
}
```

## Workflow Example

1. **Search** for the right type: `swamp type search "echo" --json`
2. **Describe** to understand the schema:
   `swamp type describe swamp/echo --json`
3. **Create** an input file: `swamp model create swamp/echo my-message --json`
4. **Edit** the YAML file to set `attributes.message`
5. **Validate** the model: `swamp model validate my-message --json`
6. **Run** the method: `swamp model method run my-message write --json`
7. **View** the output: `swamp model output get my-message --json`

## Data Ownership

Data artifacts are owned by the model (definition) that created them. This
prevents accidental overwrites from other models.

### Ownership Rules

- Data can only be written by the model that originally created it
- Ownership is verified through `definitionHash` comparison
- Owner information includes:
  - **type**: `model-method`, `workflow-step`, or `manual`
  - **ref**: Reference to the creating entity
  - **workflow/run IDs**: Set when created during workflow execution

### Ownership Validation

When a model method writes data, swamp validates:

1. If data doesn't exist → create with current model as owner
2. If data exists → verify `ownerDefinition.definitionHash` matches
3. If hash mismatch → write fails with ownership error

This ensures data integrity when multiple models reference the same data names.

## When to Use Other Skills

| Need                            | Use Skill               |
| ------------------------------- | ----------------------- |
| Create/run workflows            | `swamp-workflow`        |
| Manage secrets                  | `swamp-vault`           |
| Repository structure            | `swamp-repo`            |
| Manage data lifecycle           | `swamp-data`            |
| Create custom TypeScript models | `swamp-extension-model` |

## References

- **Data chaining**: See
  [references/data-chaining.md](references/data-chaining.md) for aws/cli model
  examples and chaining patterns
- **Model design**: See [design/models.md](design/models.md) for data structures
  and concepts
