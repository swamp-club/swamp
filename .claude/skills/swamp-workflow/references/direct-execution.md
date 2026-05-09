# Direct Type Execution in Workflows

Workflow steps can auto-create model definitions using `modelType` + `modelName`
instead of referencing an existing definition with `modelIdOrName`.

## Syntax

```yaml
task:
  type: model_method
  modelType: "@test/greeter"
  modelName: my-greeter
  methodName: greet
  inputs:
    greeting: Hello
    name: ${{ inputs.who }}
```

## Rules

- `modelIdOrName` and `modelType` are **mutually exclusive** — the schema
  rejects YAML with both.
- `modelType` requires `modelName` to name the auto-created definition.
- Auto-created definitions are stored in `.swamp/auto-definitions/`.
- Inputs are routed between global args and method args using the type's schemas
  (method args take precedence on ambiguous keys).

## forEach Support

`modelName` supports template expressions for per-iteration definitions:

```yaml
- name: greet-${{self.person}}
  forEach: { item: person, in: "${{ inputs.people }}" }
  task:
    type: model_method
    modelType: "@test/greeter"
    modelName: greeter-for-all
    methodName: greet
    inputs:
      greeting: Hello
      name: ${{ self.person }}
```

Use a fixed `modelName` (like `greeter-for-all`) to share one definition across
all iterations, or a template `modelName` for per-iteration definitions.

## When to Use `modelIdOrName` Instead

Use `modelIdOrName` when:

- The definition is pre-created with `model create` and managed in `models/`
- You need CEL expressions in global arguments
- The definition is shared across multiple workflows
