# Direct Type Execution in Workflows

The default way to call methods from workflows. Use `behaviorType` +
`behaviorName` to drive inputs dynamically without managing definition YAML
files.

## Syntax

```yaml
task:
  type: behavior
  behaviorType: "@test/greeter"
  behaviorName: my-greeter
  methodName: greet
  inputs:
    greeting: Hello
    name: ${{ inputs.who }}
```

## Rules

- `behavior` and `behaviorType` are **mutually exclusive** — the schema rejects
  YAML with both.
- `behaviorType` requires `behaviorName` to name the auto-created definition.
- Auto-created definitions are stored in `.swamp/auto-definitions/` and exist
  for data ownership boundaries. They are not visible in `swamp behavior search`
  or `swamp behavior list` (by design). Use `swamp behavior get <name>` to
  inspect them.
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
    type: behavior
    behaviorType: "@myorg/deployer"
    behaviorName: "deployer-${{ self.env.name }}"
    methodName: deploy
    globalArgs:
      region: ${{ self.env.region }}
      account: ${{ self.env.account }}
    inputs:
      version: ${{ inputs.version }}
```

## forEach Support

`behaviorName` supports template expressions for per-iteration definitions:

```yaml
- name: greet-${{self.person}}
  forEach: { item: person, in: "${{ inputs.people }}" }
  task:
    type: behavior
    behaviorType: "@test/greeter"
    behaviorName: greeter-for-all
    methodName: greet
    inputs:
      greeting: Hello
      name: ${{ self.person }}
```

Use a fixed `behaviorName` (like `greeter-for-all`) to share one definition
across all iterations, or a template `behaviorName` for per-iteration
definitions.

## When to Use `behavior` Instead

Use `behavior` only when the definition needs persistent, managed configuration:

- CEL expressions in global arguments (vault refs, cross-behavior data refs)
- Version-controlled definition files committed to the repo
- A shared definition referenced across multiple workflows
