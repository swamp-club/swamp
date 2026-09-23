---
audience: maintainer, operator
enables: [models, workflows]
last-verified: 2026-08-28 @ 3d5955a9
---

# Inputs

Models and workflows both support _inputs_. Inputs are JSON Schema, written as
YAML in a top-level `inputs` field of a model definition or workflow file.

For example, an environment input:

```yaml
inputs:
  environment:
    type: string
    enum: ["dev", "staging", "production"]
    description: "Target environment for deployment"
```

This gives the model an 'environment' input that must be a string: dev, staging
or production.

## Model Example

Models can reference their inputs:

```yaml
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

A workflow can then pass them:

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
        weight: 0
```

This runs shell commands for "dev" and then "qa". An `environment` value outside
the enum (e.g. `boo`) fails input validation before the method runs.

## Workflow Example

A workflow can also declare inputs.

```yaml
id: abc123
name: deploy-application
inputs:
  targetEnvironment:
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
            environment: ${{ inputs.targetEnvironment }}
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
        weight: 0
```

This needs `--input targetEnvironment=dev` on `swamp workflow run`
(`src/cli/commands/workflow_run.ts`). Without it, input validation fails at run
time. Any input without a default is required. Input names must be valid CEL
identifiers: a hyphenated name such as `environment-one` parses as subtraction
inside `${{ }}`.

## Iteration

An input can be an array or a hash. A CEL expression can then iterate over it to
set a step, a job, or a model's global arguments.

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

Iterating over an object:

```yaml
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

Nested objects use normal dot notation in the CEL expression.

## Dependencies

A `dependsOn` entry names the forEach _template_ step. The template's status
combines its expanded iterations, so a downstream step waits for all of them
(`WorkflowRun.registerForEachExpansion` in
`src/domain/workflows/workflow_run.ts`).

## Evaluated Expansion

`swamp workflow evaluate` and `swamp model evaluate` evaluate inputs and CEL
expressions without running anything. They write the result to
`.swamp/workflows-evaluated/` and `.swamp/definitions-evaluated/`
(`src/cli/commands/workflow_evaluate.ts`, `src/cli/commands/model_evaluate.ts`).

## Evaluated Execution

`swamp workflow run` and `swamp model method run` accept `--last-evaluated`. It
skips evaluating inputs and CEL and runs the last evaluated version of the
models and workflows (`src/cli/commands/workflow_run.ts`,
`src/cli/commands/model_method_run.ts`).

### Combining file + key=value overrides

With both `--input-file` and key=value `--input`, the file gives base values and
the key=value pairs override them (deep merged).

### Type coercion

Key=value inputs are strings by default. When the workflow or model declares an
`InputsSchema`, strings are coerced to the schema's types (`number`, `integer`,
`boolean`, `array`, `object`) before validation (`coerceInputTypes` in
`src/domain/inputs/input_coercion.ts`). Without a schema they stay strings.

For `array` and `object`, the string is parsed as JSON. If that gives a real
array or object, the parsed value is used. If parsing fails or gives another
JSON type (e.g. `null`, a number), the value stays a string and validation
reports the mismatch.

### File references via `@`

Values starting with `@` are read as file paths:

```sh
swamp model method run my-model deploy --input cert=@/path/to/cert.pem
swamp model method run my-model deploy --input token=@~/secrets/token.txt
```

To pass a literal `@`, escape it with `\`:

```sh
swamp model method run my-model search --input email=\@user
```

**Scoped identifiers** (`@namespace/name`) pass through as literals, not file
paths. This covers swamp type identifiers like `@hivemq/base-images` or
`@swamp/aws/ec2/vpc`. A value is a scoped identifier if the text after `@`
starts with a letter, contains at least one `/`, and has no `.`
(`isScopedIdentifier` in `src/cli/input_parser.ts`). Paths with extensions
(e.g. `@path/to/file.txt`) are still read as files.

```sh
# Passes @hivemq/base-images as the literal value (not a file path)
swamp model method run my-model check --input sourceType=@hivemq/base-images
```

### JSON-typed values via `:json` suffix

Append `:json` to the leaf segment of a key to parse the value as JSON instead
of a string:

```sh
# Array
swamp model method run my-model search --input 'keywords:json=["typescript","retry"]'

# Object
swamp model method run my-model deploy --input 'config:json={"port":8080,"replicas":3}'

# Nested key (suffix attaches to the LEAF segment only)
swamp model method run my-model deploy --input 'server.config:json={"port":8080}'
# → { server: { config: { port: 8080 } } }
```

With `:json`, the value is always parsed as a JSON literal; the `@file`
shorthand and the `\@` escape do not apply. A parse failure is a hard error. If
`--input key:json=...` and a YAML `--input-file` set the same key, the CLI
value wins (the usual deepMerge precedence).

### Arrays

Array inputs can come from:

- type coercion, when the schema declares `type: array` (the string is parsed
  as JSON);
- the `:json` suffix above, which works without a schema;
- `--input-file` with YAML or JSON;
- the legacy single-shot `--input '<json-object>'` form.

### Reading inputs from stdin

With `--stdin`, `method run` and `workflow run` read stdin to EOF and parse it
as inputs. This lets them sit in Unix pipes, opt-in like `jq -n`.

The format is detected automatically (`parseStdinContent` in
`src/cli/input_parser.ts`):

- **JSON object**: one run with the object as inputs.
- **JSON array**: one run per element; each must be an object.
- **NDJSON** (one JSON object per line): one run per line.
- **YAML object**: one run with the parsed object as inputs.

With several items (array or NDJSON), the method or workflow runs once per item.
Each run has its own data, pre-flight checks and report. Execution stops at the
first failure.

`--stdin` cannot be combined with `--input-file`. It can be combined with
`--input` key=value overrides, which are deep-merged onto each stdin item and
win on conflict.

```sh
# Single JSON object from stdin
echo '{"run": "echo hello"}' | swamp model method run my-model execute --stdin

# NDJSON: run method once per line
printf '{"run":"echo a"}\n{"run":"echo b"}' \
  | swamp model method run my-model execute --stdin

# Pipe from data query via jq, with static overrides
swamp data query 'modelName == "source"' --json \
  | jq -c '.results[] | {run: .attributes.command}' \
  | swamp model method run target-model execute --stdin --input env=prod
```

## Input Routing for Direct Type Execution

Direct type execution (`swamp model @type method run ...`) has no
`definition.inputs` schema to split inputs. The type's own schemas route
`--input` values instead (`routeInputsBySchema` in
`src/libswamp/models/direct_execution.ts`):

1. Keys in the method's `arguments` Zod schema → **method arguments**
2. Keys in the type's `globalArguments` Zod schema, but not the method schema →
   **global arguments**
3. Keys in neither → **rejected**, with an error listing valid keys

If a key is in both schemas, the method argument wins (the narrower scope).

`coerceMethodArgs` coerces string values to the schema types (e.g., `"428"` →
`428` for a number field). It reads the Zod schema directly and handles Zod v3
and v4 (`src/domain/models/zod_type_coercion.ts`).

Routing happens when the definition is created. Global arguments are stored in
the auto-created definition; method arguments go to the method's execute
function.

### Explicit `globalArgs` in Workflow Steps

A workflow step using direct type execution can pass global arguments directly
in a `globalArgs` field, skipping the routing above:

```yaml
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

With `globalArgs`, `inputs` are method arguments only and no schema routing
runs. The `globalArgs` values go straight into the auto-created definition's
`globalArguments`. This helps with `forEach` fan-out, where each iteration needs
its own connection or configuration global args.

`globalArgs` is valid only with direct type execution (`modelType` +
`modelName`). It is rejected for existing definitions (`modelIdOrName`); see
`src/domain/workflows/step_task.ts`.
