# Inputs

Both workflows and models support _inputs_. These are defined using json-schema, expressed as yaml in a definition file or a workflow file. These are specified as a top level field of both model definitions and workflow definitions.

For example, an input for an environment can be specified as:

```input yaml
inputs:
  environment:
    type: string
    enum: ["dev", "staging", "production"]
    description: "Target environment for deployment"
```

This would make the model have an 'environment' input, that must be a string, and allows for only dev, staging, or production.

## Model Example

Models can reference their inputs:

```input yaml
type: command/shell
typeVersion: 1
id: b015aac3-fdc6-41c5-9d91-b130fb65e78d
name: shell-env
version: 1
tags: {}
inputs:
  environment:
    type: string
    enum: ["dev", "staging", "production"]
    description: "Target environment for deployment"
methods:
  execute:
    arguments:
      run: echo "Deploying to ${{ inputs.environment }}"
```

Then, from a workflow file:

```yaml
id: abc123
name: deploy-application
jobs:
  - name: shell-environments
    description: run shell commands for environments
    steps:
      - name: first-env
        description: the first env
        task:
          type: model_method
          modelIdOrName: shell-env
          methodName: execute
          inputs:
            environment: "dev"
        dependsOn: []
        weight: 0
      - name: second-env
        description: the second env
        task:
          type: model_method
          modelIdOrName: shell-env
          methodName: execute
          inputs:
            environment: "qa"
        dependsOn:
          - step: first-env
            condition:
              type: succeeded
              ref: first-env
        weight: 0
```

Which would run shell commands for "dev" and "qa" environments respectively. If the user passed the 'boo' environment input, the model should fail validation, and report the input as required.

## Workflow Example

A workflow can also specify inputs.

```yaml
id: abc123
name: deploy-application
inputs:
  environment-one:
    type: string
    enum: ["dev", "staging", "production"]
    description: "Target environment for deployment"
jobs:
  - name: shell-environments
    description: run shell commands for environments
    steps:
      - name: first-env
        description: the first env
        task:
          type: model_method
          modelIdOrName: shell-env
          methodName: execute
          inputs:
            environment: ${{ inputs.environment-one }}
        dependsOn: []
        weight: 0
      - name: second-env
        description: the second env
        task:
          type: model_method
          modelIdOrName: shell-env
          methodName: execute
          inputs:
            environment: "qa"
        dependsOn:
          - step: first-env
            condition:
              type: succeeded
              ref: first-env
        weight: 0
```

This would require the workflow to specify a '--inputs environment-one=dev' in order to execute. No inputs would fail validation, and would fail at execution. Any input that does not specify a default value is required.

## Iteration

An input can be specified as an array or a hash, and then a user can use a CEL expression to specify that a step, job, or model global arguments can be set via iteration.

```yaml
id: abc123
name: deploy-application
inputs:
  environments:
    type: array
    items:
      type: string
      enum: ["dev", "staging", "production"]
    minItems: 1
    uniqueItems: true
    description: "Target environments for deployment"
jobs:
  - name: shell-environments
    description: run shell commands for environments
    steps:
      - name: shell-env-${{self.env}}
        description: Deploy to environment
        forEach:
          item: env
          in: ${{ inputs.environments }}
        task:
          type: model_method
          modelIdOrName: shell-env
          methodName: execute
          inputs:
            environment: ${{ self.env }}
```

When iterating over an object:

```map.yaml
inputs:
  tags:
    type: object
    additionalProperties:
      type: string
    description: "Key-value tags to apply"

jobs:
  - name: apply-tags
    steps:
      - name: apply-tag
        forEach:
          item: tag
          in: ${{ inputs.tags }}
        task:
          type: model_method
          modelIdOrName: shell-env
          methodName: execute
          inputs:
            key: ${{ self.tag.key }}
            value: ${{ self.tag.value }}
```

Nested objects should be defrencable like normal in the CEL expression.

## Dependencies

The dependency specification should also support the forEach syntax, allowing you to express dependencies that match your steps and tasks.

## Evaluated Expansion

Workflows and Models must be able to have their inputs and CEL expressions evaluated and written out. They will not be executed.

## Evaluated Execution

Workflow run and model method run both should support a --last-evaluated flag, which will skip evaluating the definitions inputs or CEL expressions, and instead run directly from the last evaluated version of the models and workflows.

### Combining file + key=value overrides

When both `--input-file` and key=value `--input` are provided, the file supplies
base values and key=value pairs act as overrides (deep merged).

### Type coercion

Key=value inputs are always parsed as strings. When the workflow or model
declares an `InputsSchema`, string values are automatically coerced to match
the schema's declared types (`number`, `integer`, `boolean`) before validation.
Without a schema, values remain as strings.

### Arrays

Array inputs are not supported via key=value syntax. Use `--input-file` or JSON
for array values.
