# Direct Type Execution in Workflows

The default way to call model methods from workflows. Use `modelType` +
`modelName` to drive inputs dynamically without managing definition YAML files.

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
- An optional `globalArgs` field passes global arguments explicitly, bypassing
  the implicit routing. When present, `inputs` are treated as method arguments
  only. `globalArgs` is only valid with direct type execution.

## Explicit Global Arguments

Use `globalArgs` when you want to separate global arguments from method inputs
explicitly — especially useful for `forEach` fan-out where each iteration needs
distinct configuration:

```yaml
- name: deploy-${{self.env.name}}
  forEach: { item: env, in: "${{ inputs.environments }}" }
  task:
    type: model_method
    modelType: "@myorg/deployer"
    modelName: "deployer-${{ self.env.name }}"
    methodName: deploy
    globalArgs:
      region: ${{ self.env.region }}
      account: ${{ self.env.account }}
    inputs:
      version: ${{ inputs.version }}
```

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

Use `modelIdOrName` only when the definition needs persistent, managed
configuration:

- CEL expressions in global arguments (vault refs, cross-model data refs)
- Version-controlled definition files committed to the repo
- A shared definition referenced across multiple workflows
