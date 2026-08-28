---
audience: maintainer, operator
enables: [models, workflows]
last-verified: 2026-08-28 @ 3d5955a9
---

# Inputs

Both workflows and models support _inputs_. These are defined using json-schema, expressed as yaml in a definition file or a workflow file. These are specified as a top level field of both model definitions and workflow definitions.

For example, an input for an environment can be specified as:

```yaml
inputs:
  environment:
    type: string
    enum: ["dev", "staging", "production"]
    description: "Target environment for deployment"
```

This would make the model have an 'environment' input, that must be a string, and allows for only dev, staging, or production.

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
        weight: 0
```

Which would run shell commands for "dev" and "qa" environments respectively. Passing an `environment` value outside the enum (e.g. `boo`) fails input validation before the method runs.

## Workflow Example

A workflow can also specify inputs.

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

This requires `--input targetEnvironment=dev` on `swamp workflow run` (`src/cli/commands/workflow_run.ts`) in order to execute; omitting it fails input validation at run time. Any input that does not specify a default value is required. Input names must be valid CEL identifiers — a hyphenated name such as `environment-one` parses as subtraction inside `${{ }}`.

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

Nested objects are dereferenced with normal dot notation in the CEL expression.

## Dependencies

A `dependsOn` entry names the forEach _template_ step. The template's status aggregates its expanded iterations (`WorkflowRun.registerForEachExpansion` in `src/domain/workflows/workflow_run.ts`), so a downstream step waits for every iteration.

## Evaluated Expansion

`swamp workflow evaluate` and `swamp model evaluate` (`src/cli/commands/workflow_evaluate.ts`, `src/cli/commands/model_evaluate.ts`) evaluate inputs and CEL expressions and write the result to `.swamp/workflows-evaluated/` and `.swamp/definitions-evaluated/` without executing anything.

## Evaluated Execution

`swamp workflow run` and `swamp model method run` both accept a `--last-evaluated` flag (`src/cli/commands/workflow_run.ts`, `src/cli/commands/model_method_run.ts`), which skips evaluating inputs and CEL expressions and runs directly from the last evaluated version of the models and workflows.

### Combining file + key=value overrides

When both `--input-file` and key=value `--input` are provided, the file supplies
base values and key=value pairs act as overrides (deep merged).

### Type coercion

Key=value inputs are parsed as strings by default. When the workflow or model
declares an `InputsSchema`, string values are automatically coerced to match
the schema's declared types (`number`, `integer`, `boolean`, `array`, `object`)
before validation (`coerceInputTypes` in
`src/domain/inputs/input_coercion.ts`). Without a schema, values remain as
strings.

For `array` and `object` types, the string is parsed as JSON. If parsing
succeeds and the result is the correct type (an actual array or object), the
parsed value is used. If parsing fails or the result is a different JSON type
(e.g. `null`, a number), the value remains as a string and downstream
validation reports the mismatch.

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

**Scoped identifiers** (`@namespace/name`) are recognized and passed through
literally — they are not treated as file paths. This covers swamp type
identifiers like `@hivemq/base-images` or `@swamp/aws/ec2/vpc`. The heuristic:
if the value after `@` starts with a letter, contains at least one `/`, and has
no `.` characters, it is a scoped identifier (`isScopedIdentifier` in
`src/cli/input_parser.ts`). File paths with extensions (e.g.
`@path/to/file.txt`) are still read as files.

```sh
# Passes @hivemq/base-images as the literal value (not a file path)
swamp model method run my-model check --input sourceType=@hivemq/base-images
```

### JSON-typed values via `:json` suffix

Append `:json` to the leaf segment of a key to parse the value as JSON
instead of a string:

```sh
# Array
swamp model method run my-model search --input 'keywords:json=["typescript","retry"]'

# Object
swamp model method run my-model deploy --input 'config:json={"port":8080,"replicas":3}'

# Nested key (suffix attaches to the LEAF segment only)
swamp model method run my-model deploy --input 'server.config:json={"port":8080}'
# → { server: { config: { port: 8080 } } }
```

The `:json` suffix bypasses the `@file` shorthand and the `\@` escape;
the value is always parsed as a JSON literal. JSON parse failures are
hard errors. When both `--input key:json=...` and a YAML
`--input-file` set the same key, the CLI value wins (existing
deepMerge precedence).

### Arrays

Array inputs are supported via automatic type coercion when the schema declares
`type: array` (the string is parsed as JSON), via the `:json` suffix above
(explicit, works without a schema), via `--input-file` with YAML/JSON, or via
the legacy single-shot `--input '<json-object>'` form.

### Reading inputs from stdin

Both `method run` and `workflow run` accept piped stdin via the `--stdin` flag.
When `--stdin` is passed, the command reads stdin until EOF and parses it as
inputs. This enables Unix pipe composition following the same pattern as `jq -n`
(explicit opt-in).

The input format is detected automatically (`parseStdinContent` in
`src/cli/input_parser.ts`):

- **JSON object** — single run with the object as inputs
- **JSON array** — one run per array element (each must be an object)
- **NDJSON** (one JSON object per line) — one run per line
- **YAML object** — single run with the parsed object as inputs

When multiple items are detected (array or NDJSON), the method or workflow is
executed once per item. Each execution is discrete — it produces its own data
artifacts, runs pre-flight checks, and reports independently. Execution stops on
the first failure.

`--stdin` and `--input-file` cannot be combined. `--input` key=value overrides
can be combined with `--stdin` — they are deep-merged onto each stdin item (the
`--input` values win on conflict).

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

When using direct type execution (`swamp model @type method run ...`), there is
no `definition.inputs` schema to guide input splitting. Instead, the type's own
schemas are used to route `--input` values (`routeInputsBySchema` in
`src/libswamp/models/direct_execution.ts`):

1. Keys matching the method's `arguments` Zod schema → **method arguments**
2. Keys matching the type's `globalArguments` Zod schema (but not in the method
   schema) → **global arguments**
3. Keys in neither schema → **rejected** with an error listing valid keys

Method arguments take precedence when a key appears in both schemas (more
specific scope wins).

String values are coerced to match schema types (e.g., `"428"` → `428` for a
number field) using `coerceMethodArgs` (`src/domain/models/zod_type_coercion.ts`),
which introspects the Zod schema directly and handles both Zod v3 and v4.

This routing happens at definition creation time. The routed global arguments
are stored in the auto-created definition; the routed method arguments are
passed to the method's execute function.

### Explicit `globalArgs` in Workflow Steps

Workflow step tasks using direct type execution can also pass global arguments
explicitly via a `globalArgs` field, bypassing the implicit routing:

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

When `globalArgs` is present, `inputs` are treated as method arguments only — no
schema-based routing is performed. The `globalArgs` values are passed directly to
the auto-created definition's `globalArguments`. This is particularly useful for
`forEach` fan-out, where each iteration needs distinct connection or
configuration global args.

`globalArgs` is only valid with direct type execution (`modelType` + `modelName`)
and is rejected for existing definitions (`modelIdOrName`) — see
`src/domain/workflows/step_task.ts`.
