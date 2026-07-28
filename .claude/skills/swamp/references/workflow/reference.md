## Create a Workflow

```bash
swamp workflow create my-deploy-workflow --json
```

**Output shape:**

```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "name": "my-deploy-workflow",
  "path": "workflows/workflow-3fa85f64-5717-4562-b3fc-2c963f66afa6.yaml"
}
```

The `id` is auto-assigned and **must not be changed**. Edit the YAML file at the
returned `path` to add jobs and steps.

**Example workflow file:**

```yaml
id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
name: my-deploy-workflow
description: Deploy workflow with build and deploy jobs
version: 1
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
      description: Target deployment environment
    replicas:
      type: integer
      default: 1
  required: ["environment"]
jobs:
  - name: build
    description: Build the application
    steps:
      - name: compile
        description: Compile source code
        task:
          type: model_method
          modelIdOrName: build-runner
          methodName: build
  - name: deploy
    description: Deploy the application
    dependsOn:
      - job: build
        condition:
          type: succeeded
    steps:
      - name: upload
        description: Upload artifacts
        task:
          type: model_method
          modelIdOrName: deploy-service
          methodName: deploy
          inputs:
            environment: ${{ inputs.environment }}
```

## Scheduled Workflows

Workflows can declare a `trigger` section with a `schedule` cron expression for
automatic execution via `swamp serve`:

```yaml
id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
name: anime-downloader
trigger:
  schedule: "0 3,12 * * *"
jobs:
  - name: download
    steps:
      - name: fetch
        task:
          type: model_method
          modelIdOrName: downloader
          methodName: execute
```

When `swamp serve` starts, it scans all workflows and registers cron entries for
any with `trigger.schedule`. A filesystem watcher monitors for changes — adding,
modifying, or removing a schedule takes effect without restart.

**Key behaviors:**

- Overlap prevention: if still running from previous trigger, next trigger skips
- No catch-up: missed schedules while serve was down are not fired on startup
- Use `--no-schedule` on `swamp serve` to disable scheduled execution
- Health endpoint (`/health`) reports scheduled workflows and next fire times

### Trigger inputs

Scheduled runs have no `--input` flag, so add `trigger.inputs` to supply
baseline input values at fire time:

```yaml
trigger:
  schedule: "0 3 * * *"
  inputs:
    projectId: "a6b254a2-0b57-4d0f-bf8b-fef767ab119e"
```

These are merged just like `--input` on `swamp workflow run`, with precedence
`caller inputs > trigger.inputs > schema defaults`. This lets a workflow keep
`required` inputs instead of setting a schema `default` that would apply to
every caller. `trigger.inputs` is a values map (the data to inject), not the
`inputs` schema block. It applies to trigger-fired runs (scheduled and webhook);
a manual `swamp workflow run` is unaffected.

For webhook runs, `trigger.inputs` values may be CEL expressions that read the
request payload through the `webhook` namespace, mapping payload fields onto
named inputs:

```yaml
trigger:
  inputs:
    identifier: "${{ webhook.body.data.issue.identifier }}"
    eventType: '${{ webhook.headers["x-linear-event"] }}'
```

`webhook.body` is the JSON-parsed body (raw string if not JSON),
`webhook.headers` is a lowercased-name map (the active scheme's signature header
excluded), and `webhook.route` is the matched route. Expressions resolve against
the verified payload before input validation, so a payload field can satisfy a
`required` input. swamp's CEL has no `??` — guard optional fields with
`has(x) ? x : y`. See `design/workflow.md` for full semantics and the security
caveat on headers.

The signature scheme is set per endpoint on `swamp serve`'s `--webhook` flag:
`<route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]`, where `scheme`
is `github` (default), `linear`, `stripe`, `slack`, or `generic` (requires
header; optional prefix). Omitting the scheme preserves the original behavior.
The secret field supports indirection to avoid exposing secrets in argv:
`@env=VAR_NAME` reads from an environment variable, `@file=/path` reads from a
file (trailing newline trimmed). Plain strings are literal secrets.

## Edit a Workflow

**Recommended:** Use `swamp workflow get <name> --json` to get the file path,
then edit directly with the Edit tool, then validate with
`swamp workflow validate <name> --json`.

**Alternative methods:**

- Interactive: `swamp workflow edit my-workflow` (opens in system editor)
- Stdin: `cat updated.yaml | swamp workflow edit my-workflow --json`

## Delete a Workflow

Delete a workflow and all its run history.

```bash
swamp workflow delete my-workflow --json
```

**Output shape:**

```json
{
  "deleted": true,
  "workflowId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "workflowName": "my-workflow",
  "runsDeleted": 5
}
```

## Validate Workflows

Validate against schema, check for structural errors, and verify that step
inputs match required method/workflow arguments.

**Checks performed:**

1. Schema validation (Zod)
2. Unique job names
3. Unique step names within each job
4. Valid job dependency references
5. Valid step dependency references
6. No cyclic job dependencies
7. No cyclic step dependencies within jobs
8. Step inputs match required arguments — for `model_method` tasks, checks that
   all required method arguments are provided in the step's `inputs:` block. For
   `workflow` tasks, checks that all required workflow inputs are provided.
   Dynamic CEL references (`${{ ... }}`) in model/workflow names are skipped.

```bash
swamp workflow validate my-workflow --json
swamp workflow validate --json  # Validate all
```

**Output shape (single):**

```json
{
  "workflowId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "workflowName": "my-workflow",
  "validations": [
    { "name": "Schema validation", "passed": true },
    { "name": "Unique job names", "passed": true },
    { "name": "Valid job dependency references", "passed": true },
    { "name": "No cyclic job dependencies", "passed": true },
    {
      "name": "Step inputs for 'deploy' in job 'release' (my-app.deploy)",
      "passed": true
    }
  ],
  "passed": true
}
```

## Run a Workflow

```bash
swamp workflow run my-workflow
swamp workflow run my-workflow --input environment=production
swamp workflow run my-workflow --input environment=production --input replicas=3
swamp workflow run my-workflow --input 'tags:json=["prod","west"]'  # :json suffix for arrays/objects
swamp workflow run my-workflow --input '{"environment": "production"}'  # legacy single-shot JSON
swamp workflow run my-workflow --input-file inputs.yaml
echo '{"environment": "prod"}' | swamp workflow run my-workflow --stdin
printf '{"environment":"dev"}\n{"environment":"prod"}' | swamp workflow run my-workflow --stdin  # NDJSON: one run per line
swamp workflow run my-workflow --last-evaluated  # Use pre-evaluated workflow
```

Pass `--stdin` to read piped input. JSON objects, JSON arrays, NDJSON (one JSON
per line), and YAML are supported. Multiple items (array or NDJSON) produce one
workflow run per item. `--input` key=value overrides are deep-merged onto each
stdin item.

**Options:**

| Flag                | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `--input <value>`   | Input values (key=value repeatable, or JSON)                       |
| `--input-file <f>`  | Input values from YAML file (cannot combine with `--stdin`)        |
| `--stdin`           | Read inputs from stdin (piped data)                                |
| `--last-evaluated`  | Use previously evaluated workflow (skip eval and input validation) |
| `--driver <driver>` | Override execution driver for all steps (e.g. `raw`, `docker`)     |

**Output shape:**

```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "workflowId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "workflowName": "my-workflow",
  "status": "succeeded",
  "jobs": [
    {
      "name": "main",
      "status": "succeeded",
      "steps": [
        {
          "name": "example",
          "status": "succeeded",
          "duration": 2,
          "dataArtifacts": [
            {
              "dataId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
              "name": "output",
              "version": 1
            }
          ]
        }
      ],
      "duration": 2
    }
  ],
  "duration": 5,
  "path": "workflows/workflow-3fa85f64-5717-4562-b3fc-2c963f66afa6/workflow-7c9e6679-7425-40de-944b-e07fc1f90ae7-timestamp.yaml"
}
```

## Workflow History

### Search Run History

```bash
swamp workflow history search --json
swamp workflow history search "deploy" --json
```

**Output shape:**

```json
{
  "query": "",
  "results": [
    {
      "runId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "workflowId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "workflowName": "my-workflow",
      "status": "succeeded",
      "startedAt": "2025-01-15T10:30:00Z",
      "duration": 5
    }
  ]
}
```

### Get Latest Run

```bash
swamp workflow history get my-workflow --json
```

**Output shape:**

```json
{
  "runId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "workflowId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "workflowName": "my-workflow",
  "status": "succeeded",
  "startedAt": "2025-01-15T10:30:00Z",
  "completedAt": "2025-01-15T10:30:05Z",
  "jobs": [/* job execution details */]
}
```

### View Run Logs

```bash
swamp workflow history logs my-workflow --json        # Latest run logs
swamp workflow history logs 7c9e6679-7425-40de-944b-e07fc1f90ae7 --json            # Specific run logs
swamp workflow history logs 7c9e6679-7425-40de-944b-e07fc1f90ae7 build.compile --json  # Specific step logs
```

**Output shape:**

```json
{
  "runId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "step": "build.compile",
  "logs": "Building application...\nCompilation complete.",
  "exitCode": 0
}
```

### Run Tracking

Workflow runs and their individual model method step executions are tracked in
the SQLite run tracker (`.swamp/run_tracker.db`). Use `swamp run history` to see
both workflow-level and step-level runs in a single view:

```bash
swamp run history --active    # what's running right now?
swamp run history             # recent runs (last 24h)
swamp run doctor              # diagnose stale/orphaned runs
swamp run doctor --fix        # auto-reap stale runs
```

The history output shows the `KIND` column as `workflow` or `method`, with the
workflow name or model/method name respectively.

## Workflow Inputs

Workflows can define an `inputs` schema for parameterization. Inputs are
validated against a JSON Schema before execution.

### Input Schema

```yaml
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
      description: Target environment
    replicas:
      type: integer
      default: 1
  required: ["environment"]
```

### Supported Types

| Type      | Description     | Example                                  |
| --------- | --------------- | ---------------------------------------- |
| `string`  | Text value      | `type: string`                           |
| `integer` | Whole number    | `type: integer`                          |
| `number`  | Decimal number  | `type: number`                           |
| `boolean` | True/false      | `type: boolean`                          |
| `array`   | List of items   | `type: array`, `items: { type: string }` |
| `object`  | Key-value pairs | `type: object`, `properties: {...}`      |

### Using Inputs in Expressions

Reference inputs with `${{ inputs.<name> }}`:

```yaml
steps:
  - name: deploy
    task:
      type: model_method
      modelIdOrName: deploy-service
      methodName: deploy
      inputs:
        environment: ${{ inputs.environment }}
```

## Evaluate Workflows

Evaluate expressions without executing. CEL expressions are resolved; vault
expressions remain raw for runtime resolution.

```bash
swamp workflow evaluate my-workflow --json
swamp workflow evaluate my-workflow --input environment=dev --json
swamp workflow evaluate --all --json
```

**Key behaviors:**

- CEL expressions (`${{ inputs.X }}`, `${{ model.X.resource... }}`) are resolved
- forEach steps are expanded into concrete steps with resolved `modelIdOrName`,
  `methodName`, inputs, and args
- Vault expressions (`${{ vault.get(...) }}`) remain raw for runtime resolution
- Output saved to `.swamp/workflows-evaluated/` for `--last-evaluated` use

## Concurrency Limits

Add `concurrency: N` at the workflow, job, or step level to cap parallel
execution. Absent or `0` means unbounded. Resolution: step > job > workflow >
unbounded. A `SWAMP_MAX_CONCURRENT_STEPS` env var provides a host-level ceiling.
See
[references/expressions-and-foreach.md](references/expressions-and-foreach.md)
for forEach concurrency examples.

```yaml
concurrency: 10 # workflow level — caps parallel jobs
jobs:
  - name: fan-out
    concurrency: 5 # job level — caps parallel steps
    steps:
      - name: per-item
        forEach:
          item: target
          in: ${{ inputs.targets }}
        concurrency: 3 # step level — caps forEach iterations
        task: {
          type: model_method,
          modelIdOrName: api-client,
          methodName: call,
        }
```

## Allow Failure

Steps can be marked with `allowFailure: true` so their failure does not fail the
job or workflow. The step is still recorded as failed, but the failure is not
propagated.

```yaml
steps:
  - name: optional-check
    allowFailure: true
    task:
      type: model_method
      modelIdOrName: checker
      methodName: validate
```

- Step status remains `failed` with its error message
- The run output includes `allowedFailure: true` on the step
- Downstream `dependsOn: succeeded` steps will skip; `dependsOn: completed`
  steps will run

## Guard (Idempotent Step Execution)

A step can declare a `guard` — a CEL expression evaluated before execution. When
the guard evaluates truthy, the step is skipped (already done). When falsy or
absent, the step executes normally.

Guard is the workflow-level primitive for idempotent step execution, enabling
safe workflow resume, re-run, and cron scheduling without re-executing completed
steps.

**Evaluation order:**

1. Dependency conditions are checked (`dependsOn`)
2. Expression context is built (including `self.*` for forEach steps)
3. Guard expression is evaluated
4. If truthy → step is skipped with reason `"guarded"`
5. If falsy → step proceeds to execution

**Guard patterns:**

```yaml
steps:
  # Data truthiness — truthy scalar means done, null means not done
  - name: read-plate
    guard: ${{ data.latest("plate-reader", "scan-complete").attributes.id }}
    task:
      type: model_method
      modelIdOrName: plate-reader
      methodName: read-all

  # Value comparison — same batch means skip, different batch means re-run
  - name: dispense-reagent
    guard: >-
      ${{ data.latest("liquid-handler", "dispense-log").attributes.batchId
          == inputs.batchId }}
    task:
      type: model_method
      modelIdOrName: liquid-handler
      methodName: dispense

  # Method call — invoke a model method to check external state
  - name: create-instance
    guard: >-
      ${{ model.method("infra", "check-exists",
          {"name": inputs.instanceName}).stdout }}
    task:
      type: model_method
      modelIdOrName: infra
      methodName: create
```

**`model.method()` in guards:**

`model.method(modelName, methodName)` or
`model.method(modelName, methodName, inputs)` invokes a model method and returns
the content of its first resource data output (parsed as JSON if possible). This
lets guards check external state by running a lightweight probe method. For
command/shell models the return value is `{exitCode, stdout, stderr, ...}`, so
guard expressions typically access a specific field like `.stdout`.

**forEach compatibility:** Guard expressions can reference `self.*`, so each
expanded iteration evaluates its own guard independently:

```yaml
- name: read-plate
  forEach:
    item: well
    in: ${{ range(1, 97) }}
  guard: ${{ data.latest("plate-reader", self.well) }}
  task:
    type: model_method
    modelIdOrName: plate-reader
    methodName: read-single-well
```

**Error handling:** A CEL parse error or runtime error in a guard expression
fails the step with a `step_failed` event containing the error message.

**Events and rendering:** Guard-skipped steps emit a `step_skipped` event with
`reason: "guarded"` (vs `"dependency"` for dependency skips). The console
renderer shows `skipped (guarded)` to distinguish from dependency skips.

## Step Task Types

Steps support four task types:

**`model_method`** — prefer `modelType` + `modelName` (direct type execution)
for dynamic inputs. Use `modelIdOrName` only for persistent definitions with CEL
expressions or shared config. See
[references/direct-execution.md](references/direct-execution.md) for details.

```yaml
# Direct type execution (default — dynamic inputs, no YAML to manage)
task:
  type: model_method
  modelType: "@test/greeter"
  modelName: my-greeter
  methodName: greet
  inputs:
    greeting: ${{ inputs.greeting }}
    name: ${{ inputs.who }}

# Existing definition (only for persistent config with CEL expressions)
task:
  type: model_method
  modelIdOrName: my-model
  methodName: run
  inputs:
    key: ${{ inputs.value }}
```

**`workflow`** - Invoke another workflow (waits for completion):

```yaml
task:
  type: workflow
  workflowIdOrName: child-workflow
  inputs: # Optional: pass inputs to the child workflow
    key: value
```

Nested workflows have a max depth of 10 and cycle detection is enforced.

**`manual_approval`** - Suspend workflow and wait for operator approval:

```yaml
task:
  type: manual_approval
  prompt: "Verify SSH access before proceeding"
  timeout: 3600 # Optional: seconds before approve is rejected
```

The workflow suspends to disk. Approve, reject, or resume from CLI:

```
swamp workflow approve <workflow-name> <step-name>
swamp workflow reject  <workflow-name> <step-name> --reason "Not ready"
swamp workflow resume  <workflow-name>
swamp workflow resume  <workflow-name> --input authKey=tskey-abc123
swamp workflow approvals  # list all pending approvals
```

Resume accepts `--input`/`--input-file`/`--stdin` (same parsing as
`workflow run`). Resume inputs merge over the inputs the run had when it
suspended, with a resume `--input` winning on a key collision. Evaluation stays
strict, so a workflow must declare the inputs it references at run time: declare
the input at run (e.g. a placeholder) and supply or override its value at
resume. The run record records the resume input key names (not values) for
audit.

**Resume from a failed step (`--from`):** Re-enter a failed run's DAG at a named
step. The `--from` step and all its downstream dependents are reset; steps
before it retain their completed status. Guards on completed steps prevent
re-execution.

```
swamp workflow resume <workflow-name> --from <step-name>
swamp workflow resume <workflow-name> --from <step-name> --run <run-id>
```

If there is exactly one failed run, `--run` can be omitted. When multiple failed
runs exist, the CLI prompts you to specify `--run`.

`--from` targets template step names (not forEach-expanded names). For forEach
steps, all iterations are re-evaluated — completed iterations with truthy guards
are skipped; failed/unstarted iterations execute. Only works on failed runs.

**`assert`** — A CEL predicate that evaluates over prior step data and records
pass/fail. Use assert steps to validate that earlier steps produced the expected
state before the workflow continues.

```yaml
- name: vpc-cidr-correct
  task:
    type: assert
    expr: >-
      data.latest("describe-infra", "result").attributes.stdout.contains("10.0.0.0/16")
    message: "VPC does not have expected CIDR 10.0.0.0/16"
    severity: high
```

**Fields:**

| Field      | Required | Description                                                     |
| ---------- | -------- | --------------------------------------------------------------- |
| `expr`     | Yes      | CEL expression that must evaluate to a truthy value to pass     |
| `message`  | Yes      | Human-readable failure message (shown when the assertion fails) |
| `severity` | No       | `low`, `medium`, or `high` (default: `high`)                    |

**YAML quoting rule:** CEL expressions containing double quotes (e.g. inside
`.contains("...")`) MUST use a YAML block scalar (`>-`) to avoid YAML parse
errors. Without the block scalar, the inner double quotes break YAML parsing:

```yaml
# WRONG — YAML parse error from nested double quotes:
- name: check
  task:
    type: assert
    expr: data.latest("model", "spec").attributes.value == "expected"
    message: "Check failed"

# CORRECT — block scalar avoids quoting conflicts:
- name: check
  task:
    type: assert
    expr: >-
      data.latest("model", "spec").attributes.value == "expected"
    message: "Check failed"
```

**Accessing prior step data in `expr`:** Assert expressions have access to the
same expression context as other step expressions. Use `data.latest()` to read
output from prior steps:

```
data.latest("<modelName>", "<specName>").attributes.<field>
```

The result of `data.latest()` is a `DataRecord` — access fields via
`.attributes.<field>`, NOT `.content.<field>`. The `.attributes` map contains
the structured output data that models produce.

**Dynamic messages:** The `message` field supports `${{ }}` expression
interpolation. Use this to include actual values in failure messages:

```yaml
- name: replica-count-ok
  task:
    type: assert
    expr: >-
      int(data.latest("describe-deploy", "result").attributes.stdout) >= 3
    message: >-
      Expected at least 3 replicas, got ${{ data.latest("describe-deploy", "result").attributes.stdout }}
    severity: high
```

**Severity and failure behavior:**

- An assert step that fails records `status: failed` with the resolved message
- By default, ANY failed assert fails the job and workflow (like any other step)
- Use `allowFailure: true` on the step to let execution continue regardless
- Use `--fail-on <severity>` on `swamp workflow run` to set a severity threshold
  — assertions below the threshold are treated as allowed failures

**Common CEL patterns for assert expressions:**

```yaml
# String containment
expr: >-
  data.latest("model", "spec").attributes.stdout.contains("expected-value")

# Exact equality
expr: >-
  data.latest("model", "spec").attributes.status == "active"

# Numeric comparison
expr: >-
  int(data.latest("model", "spec").attributes.count) > 0

# Compound predicates (AND / OR)
expr: >-
  data.latest("model", "spec").attributes.status == "running"
  && int(data.latest("model", "spec").attributes.replicas) >= 3

# Negation
expr: >-
  !data.latest("model", "spec").attributes.output.contains("ERROR")

# Optional access (returns null if data doesn't exist yet)
expr: >-
  data.latest("model", "spec").?attributes.?ready == true
```

### Assert Output: `--fail-on` and `--junit`

Two flags on `swamp workflow run` control assert result handling:

**`--fail-on <severity>`** — Set the minimum severity that causes the run to
fail. Only assertions at or above this threshold fail the workflow; those below
are treated as allowed failures.

| Value    | Effect                                         |
| -------- | ---------------------------------------------- |
| `low`    | Any failed assertion fails the run (default)   |
| `medium` | Only `medium` and `high` failures fail the run |
| `high`   | Only `high` severity failures fail the run     |

```bash
# Only fail on high-severity assertions (treat low/medium as warnings)
swamp workflow run my-checks --fail-on high

# Default behavior — any failure fails the run
swamp workflow run my-checks --fail-on low
```

**`--junit`** — Output assert results as JUnit XML instead of normal log output.
JUnit XML is understood by CI systems (GitHub Actions, Jenkins, GitLab CI) for
test reporting.

```bash
# Print JUnit XML to stdout
swamp workflow run my-checks --junit

# Write JUnit XML to a file
swamp workflow run my-checks --junit --out results.xml

# Combine with --fail-on for CI gating
swamp workflow run my-checks --junit --out results.xml --fail-on high
```

**Constraints:**

- `--junit` cannot be combined with `--json` (they are mutually exclusive output
  formats)
- `--out` requires `--junit` (it only applies to JUnit output)
- `--junit` cannot be combined with multiple input sets (`--stdin` with NDJSON)
- `--fail-on` is not yet supported with `--server`

### Assert Step Example: Full Workflow

A complete workflow that provisions infrastructure and validates the result:

```yaml
id: provision-and-verify
name: provision-and-verify
description: Create infrastructure and assert expected state
version: 1
jobs:
  - name: provision
    steps:
      - name: create-vpc
        task:
          type: model_method
          modelType: "command/shell"
          modelName: create-vpc
          methodName: execute
  - name: verify
    dependsOn:
      - job: provision
        condition:
          type: succeeded
    steps:
      - name: describe-vpc
        task:
          type: model_method
          modelType: "command/shell"
          modelName: describe-vpc
          methodName: execute
      - name: cidr-correct
        dependsOn:
          - step: describe-vpc
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            data.latest("describe-vpc", "result").attributes.stdout.contains("10.0.0.0/16")
          message: "VPC CIDR is not 10.0.0.0/16"
          severity: high
      - name: has-tags
        dependsOn:
          - step: describe-vpc
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            data.latest("describe-vpc", "result").attributes.stdout.contains("env=production")
          message: "VPC is missing env=production tag"
          severity: medium
```

Run with severity gating and JUnit output for CI:

```bash
swamp workflow run provision-and-verify --junit --out test-results.xml --fail-on high
```

## Working with Vaults

Access secrets using vault expressions. See **swamp-vault** skill for details.

```yaml
apiKey: ${{ vault.get(vault-name, secret-key) }}
dbPassword: ${{ vault.get(prod-secrets, DB_PASSWORD) }}
```

Vault expressions are resolved **per-step at execution time** — a step that
writes to a vault makes the new value available to subsequent steps. Example
token-refresh-then-use pattern:

```yaml
jobs:
  refresh:
    steps:
      - name: refresh-token
        task:
          type: model_method
          modelIdOrName: token-refresher
          methodName: refresh
  use-token:
    depends_on: [refresh]
    steps:
      - name: call-api
        task:
          type: model_method
          modelIdOrName: api-client # vault.get() resolved after refresh
          methodName: invoke
```

## Workflow Example

End-to-end workflow creation:

1. **Get schema**: `swamp workflow schema get --json`
2. **Create**: `swamp workflow create my-task --json`
3. **Edit**: Add jobs and steps to the YAML file
4. **Validate**: `swamp workflow validate my-task --json`
5. **Fix** any errors and re-validate
6. **Run**: `swamp workflow run my-task`

## When to Use Other Skills

| Need                       | Use Skill               |
| -------------------------- | ----------------------- |
| Create/run models          | `swamp-model`           |
| Vault management           | `swamp-vault`           |
| Repository structure       | `swamp-repo`            |
| Manage model data          | `swamp-data`            |
| Create custom models       | `swamp-extension`       |
| Understand swamp internals | `swamp-troubleshooting` |

## References

- **CI/CD integration**: See the repo skill's
  [references/ci-integration.md](../repo/references/ci-integration.md) for
  installing swamp in CI and GitHub Actions examples
- **Nested workflows**: See
  [references/nested-workflows.md](references/nested-workflows.md) for when to
  split a workflow into parent + child (reusable sub-processes, shape-validated
  handoffs, independent cadence), full examples of workflows calling other
  workflows, forEach with workflows, and nesting limitations
- **Expressions, forEach, and data tracking**: See
  [references/expressions-and-foreach.md](references/expressions-and-foreach.md)
  for forEach iteration patterns, CEL expressions, environment variables, and
  data artifact tagging
- **Data chaining and lifecycle workflows**: See
  [references/data-chaining.md](references/data-chaining.md) for `model.*` vs
  `data.latest()` expression guidance, delete/update workflow ordering, and
  command/shell chaining examples
- **Idempotent execution with guards**: See
  [references/scenarios.md](references/scenarios.md#scenario-6-idempotent-provisioning-with-guards)
  for end-to-end examples of guard patterns — data truthiness, value comparison,
  `model.method()` probes, forEach + guard for partial re-execution, and
  scheduled workflow guards
- **Remote execution**: See
  [references/remote-execution.md](references/remote-execution.md) for worker
  provisioning and step placement (target/labels/platform)
