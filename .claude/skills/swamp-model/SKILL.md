---
name: swamp-model
description: Work with swamp models for AI-native automation. Use when searching for model types, describing model schemas, creating model inputs, or running model methods. Triggers on requests involving "swamp model", "model type", "create input", or running automation workflows.
---

# Swamp Model Skill

Work with swamp models through the CLI. All commands support `--json` for
machine-readable output.

## Repository Structure

Swamp uses a dual-layer architecture:

- **Data directory (`/.data/`)** - Internal storage organized by entity type
- **Logical views (`/models/`)** - Human-friendly symlinked directories

The `/models/` directory provides convenient exploration of each model:

```
/models/{model-name}/
  input.yaml → ../.data/inputs/{type}/{id}.yaml
  resource.yaml → ../.data/resources/{type}/{id}.yaml
  data.yaml → ../.data/data/{type}/{id}.yaml
  outputs/ → ../.data/outputs/{type}/{id}/
  logs/ → ../.data/logs/{type}/{id}/
  files/ → ../.data/files/{type}/{id}/
```

This structure is maintained automatically. Use `swamp repo index` to rebuild if
needed.

## Quick Reference

| Task               | Command                                               |
| ------------------ | ----------------------------------------------------- |
| Search model types | `swamp type search [query] --json`                    |
| Describe a type    | `swamp type describe <type> --json`                   |
| Create model input | `swamp model create <type> <name> --json`             |
| Evaluate input(s)  | `swamp model evaluate [id_or_name] --json`            |
| Run a method       | `swamp model method run <id_or_name> <method> --json` |

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

Select the type whose `normalized` name best matches the user's intent.

## Describe Model Types

Get the full schema and available methods for a type.

```bash
swamp type describe swamp/echo --json
```

**Output shape:**

```json
{
  "type": { "raw": "swamp/echo", "normalized": "swamp/echo" },
  "version": 1,
  "inputAttributesSchema": { ... },
  "resourceAttributesSchema": { ... },
  "methods": [
    {
      "name": "write",
      "description": "Write the input message to a resource with a timestamp",
      "inputAttributesSchema": { ... }
    }
  ]
}
```

**Key fields:**

- `inputAttributesSchema` - JSON Schema for the input YAML `attributes` section
- `resourceAttributesSchema` - JSON Schema for the resulting resource
- `methods` - Available operations, each with its own input schema

## Create Model Inputs

Create a new model input file from a type.

```bash
swamp model create swamp/echo my-echo --json
```

**Output shape:**

```json
{
  "path": "inputs/swamp/echo/my-echo.yaml",
  "type": "swamp/echo",
  "name": "my-echo"
}
```

After creation, edit the YAML file at the returned `path` to set required
attributes according to the `inputAttributesSchema` from `type describe`.

**Example input file structure:**

```yaml
# .data/inputs/swamp/echo/<uuid>.yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-echo
version: 1
tags: {}
attributes:
  message: "Hello, world!"
```

## Expression Language

Model inputs support CEL (Common Expression Language) expressions using the
`${{ <expression> }}` syntax. Expressions are evaluated at runtime and can
reference other models.

### Reference Types

| Reference                                  | Description                        |
| ------------------------------------------ | ---------------------------------- |
| `model.<name>.input.attributes.<field>`    | Another model's input attribute    |
| `model.<name>.resource.attributes.<field>` | Another model's resource attribute |
| `self.name`                                | This model's name                  |
| `self.version`                             | This model's version               |
| `self.attributes.<field>`                  | This model's own input attribute   |

### CEL Operations

Expressions support standard CEL operations:

- **String concatenation:** `self.name + "-suffix"`
- **Arithmetic:** `self.attributes.count * 2`
- **Conditionals:** `self.attributes.enabled ? "yes" : "no"`

### Example with Expressions

```yaml
# .data/inputs/aws/subnet/<uuid>.yaml
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

Evaluate expressions in model inputs and write the results to
`inputs-evaluated/`.

```bash
swamp model evaluate my-subnet --json
swamp model evaluate --all --json
```

**Arguments:**

- `<id_or_name>` - The model's name or ID (optional if using `--all`)
- `--all` - Evaluate all model inputs

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

The evaluated files contain the resolved attribute values with all expressions
replaced by their computed results.

## Run Methods

Execute a method on a model input.

```bash
swamp model method run my-echo write --json
```

**Arguments:**

- `<model_id_or_name>` - The model's name or ID
- `<method_name>` - Method name from the type's `methods` array

After running, analyze the output to determine success or failure and report
results to the user.

## Workflow Example

1. **Search** for the right type: `swamp type search "echo" --json`
2. **Describe** to understand the schema:
   `swamp type describe swamp/echo --json`
3. **Create** an input file: `swamp model create swamp/echo my-message --json`
4. **Edit** the YAML file to set `attributes.message` (use expressions if
   needed)
5. **Evaluate** expressions: `swamp model evaluate my-message --json`
6. **Run** the method: `swamp model method run my-message write --json`
