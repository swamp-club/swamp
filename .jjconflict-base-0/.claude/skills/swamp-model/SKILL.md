---
name: swamp-model
description: Work with swamp models for AI-native automation. Use when searching for model types, describing model schemas, creating model inputs, or running model methods. Triggers on requests involving "swamp model", "model type", "create input", or running automation workflows.
---

# Swamp Model Skill

Work with swamp models through the CLI. All commands support `--json` for
machine-readable output.

## Quick Reference

| Task               | Command                                               |
| ------------------ | ----------------------------------------------------- |
| Search model types | `swamp type search [query] --json`                    |
| Describe a type    | `swamp type describe <type> --json`                   |
| Create model input | `swamp model create <type> <name> --json`             |
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
# inputs/swamp/echo/my-echo.yaml
apiVersion: swamp/v1
kind: Input
metadata:
  name: my-echo
  type: swamp/echo
attributes:
  message: "Hello, world!"
```

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
4. **Edit** the YAML file to set `attributes.message`
5. **Run** the method: `swamp model method run my-message write --json`
