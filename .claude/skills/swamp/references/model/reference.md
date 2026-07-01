## Repository Structure

Model definitions are stored directly in the `models/` directory, organized by
type:

```
models/
  {normalized-type}/
    {model-id}.yaml
```

Internal data (evaluated definitions, data artifacts, outputs) lives in
`.swamp/`:

```
.swamp/definitions-evaluated/{normalized-type}/{model-id}.yaml
.swamp/data/{normalized-type}/{model-id}/{data-name}/{version}/raw
.swamp/outputs/{normalized-type}/{model-id}/{output-id}.yaml
```

## Search for Model Types

Find available model types in the system.

```bash
swamp model type search --json
swamp model type search "echo" --json
```

**Output shape:**

```json
{
  "query": "",
  "results": [
    { "raw": "command/shell", "normalized": "command/shell" }
  ]
}
```

## Describe Model Types

Get the methods and argument schemas for a type. Use `--compact` for a minimal
digest suitable for agent discovery.

```bash
swamp model type describe command/shell --compact --json
```

**Compact output shape:**

```json
{
  "type": { "raw": "command/shell", "normalized": "command/shell" },
  "version": "2026.02.09.1",
  "globalArguments": {
    "properties": { "message": { "type": "string" } },
    "required": ["message"]
  },
  "dataOutputSpecs": ["result"],
  "methods": [
    {
      "name": "execute",
      "description": "Execute a shell command and capture output",
      "arguments": {
        "properties": { "cmd": { "type": "string" } },
        "required": ["cmd"]
      }
    }
  ]
}
```

Omit `--compact` for full JSON Schema detail on arguments and data output specs.

**Key fields:**

- `globalArguments` - JSON Schema for input YAML `globalArguments` section
- `dataOutputSpecs` - Output spec names (compact) or full specs (full mode), at
  type level
- `methods` - Available operations with their per-method `arguments` schemas

## Create Model Inputs

```bash
swamp model create command/shell my-shell --json
```

Set globalArguments at creation time with `--global-arg` (repeatable):

```bash
swamp model create aws/ec2/vpc my-vpc \
  --global-arg region=us-east-1 \
  --global-arg cidrBlock=10.0.0.0/16 \
  --json
```

Use `${{ vault.get() }}` expressions for secrets — never resolve a secret and
pass the literal value (see **swamp-vault** skill for details):

```bash
swamp model create @user/my-api api-client \
  --global-arg 'apiKey=${{ vault.get(prod-secrets, API_KEY) }}' \
  --global-arg endpoint=https://api.example.com \
  --json
```

Dot notation creates nested objects:

```bash
--global-arg config.db.host=localhost --global-arg config.db.port=5432
# → globalArguments: { config: { db: { host: "localhost", port: "5432" } } }
```

> **Warning:** Omitting `--global-arg` creates an instance with empty
> `globalArguments`. There is no inheritance from sibling instances or schema
> templates. Fields without a `default` in the type's `globalArgumentsSchema`
> arrive as `undefined` in `context.globalArgs.*`. Re-pass every value your
> methods read from globalArgs.

**Output shape:**

```json
{
  "path": "definitions/command/shell/my-shell.yaml",
  "type": "command/shell",
  "name": "my-shell"
}
```

After creation, edit the YAML file to set per-method `arguments` in the
`methods` section.

**Example input file:**

```yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-shell
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: "echo 'Hello, world!'"
```

### Definition-Level Check Selection

Definitions can control which pre-flight checks run via the `checks` field:

```yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-vpc
version: 1
tags: {}
checks:
  require:
    - no-cidr-overlap # Must run, immune to --skip-checks CLI flags
  skip:
    - slow-api-check # Always skipped
globalArguments:
  cidrBlock: "10.0.0.0/16"
methods:
  create:
    arguments: {}
```

**Precedence rules:**

- `skip` always wins — even over `require` for the same check name
- `require` makes checks immune to `--skip-checks`, `--skip-check <name>`, and
  `--skip-check-label <label>` CLI flags (e.g., `--skip-checks` skips
  non-required checks but required checks still run)
- `require` checks still respect `appliesTo` method scoping
- `model validate` honors `skip` lists and warns on require/skip overlap;
  validation errors if a check name doesn't exist on the model type

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
globalArguments:
  target: ${{ inputs.environment }}
  simulate: ${{ inputs.dryRun }}
methods:
  deploy:
    arguments: {}
```

Inputs are provided at runtime with `--input` or `--input-file` and referenced
in globalArguments using `${{ inputs.<name> }}` expressions.

**Factory pattern:** Use inputs to create multiple instances from one model
definition — for **data reuse** (same schema, different parameters) and
**concurrency** (separate instances hold separate locks, so long-running methods
on one instance don't block other instances). See
[references/scenarios.md#scenario-5](references/scenarios.md#scenario-5-factory-pattern-for-model-reuse).

## Edit a Model

**Recommended:** Use `swamp model get <name> --json` to get the file path, then
edit directly with the Edit tool, then validate with
`swamp model validate <name> --json`.

**Alternative methods:**

- Interactive: `swamp model edit my-shell` (opens in system editor)
- Stdin: `cat updated.yaml | swamp model edit my-shell --json`

## Delete a Model

Delete a model and all related artifacts (data, outputs, logs).

```bash
swamp model delete my-shell --json
```

**Output shape:**

```json
{
  "deleted": {
    "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "name": "my-shell",
    "type": "command/shell",
    "inputPath": "models/command/shell/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.yaml"
  },
  "resourceDeleted": false,
  "outputsDeleted": 0,
  "evaluatedInputDeleted": false,
  "dataDeleted": false
}
```

## Validate Model Inputs

Validate a model definition against its type schema. Use `--label` to run only
checks with a specific label, and `--method` to simulate validation for a
specific method context.

```bash
swamp model validate my-shell --json
swamp model validate --json                          # Validate all models
swamp model validate my-shell --label policy --json  # Only checks with label "policy"
swamp model validate my-shell --method create --json # Validate for a specific method
```

**Output shape (single):**

```json
{
  "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "modelName": "my-shell",
  "type": "command/shell",
  "validations": [
    { "name": "Definition schema", "passed": true },
    { "name": "Global arguments", "passed": true },
    { "name": "Expression paths", "passed": true }
  ],
  "warnings": [
    {
      "name": "Environment variables detected",
      "message": "Data stored under this model will vary depending on these environment variables at runtime. Consider using separate models per environment, or vault.get() for sensitive values.",
      "envVars": [
        { "path": "globalArguments.baseUrl", "envVar": "JENKINS_BASE_URL" }
      ]
    }
  ],
  "passed": true
}
```

**Output shape (all):**

```json
{
  "models": [
    { "modelId": "...", "modelName": "my-shell", "validations": [...], "warnings": [...], "passed": true }
  ],
  "totalPassed": 5,
  "totalFailed": 1,
  "totalWarnings": 1,
  "passed": false
}
```

### IMPORTANT: Handling Validation Warnings

**When `warnings` is non-empty, STOP and ask the user before proceeding.** The
most common warning is "Environment variables detected" — this means the model's
behavior depends on env vars that may differ between machines or environments.

- If `warnings` contains env var usage, **tell the user** which fields use which
  env vars and ask if this is intentional.
- **Suggest alternatives:** separate models per environment (e.g.,
  `prod-jenkins` and `dev-jenkins` with hardcoded values), or `vault.get()` for
  sensitive values.
- **Never silently run a method** on a model with env var warnings without user
  confirmation — the data artifacts will be stored under the model name and may
  contain results from an unintended environment.

## Expression Language

Model inputs support CEL expressions using `${{ <expression> }}` syntax.
Reference types, data versioning functions, and examples are in
[references/expressions.md](references/expressions.md).

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
swamp model method run my-shell execute
swamp model method run my-deploy create --input environment=prod
swamp model method run my-deploy create --input environment=prod --input replicas=3
swamp model method run my-deploy create --input config.timeout=30  # dot notation for nesting
swamp model method run my-deploy create --input 'tags:json=["prod","west"]'  # :json suffix for arrays/objects
swamp model method run my-deploy create --input '{"environment": "prod"}'  # legacy single-shot JSON
swamp model method run my-deploy create --input-file inputs.yaml
echo '{"environment": "prod"}' | swamp model method run my-deploy create --stdin
printf '{"environment":"dev"}\n{"environment":"prod"}' | swamp model method run my-deploy create --stdin  # NDJSON: one run per line
swamp data query 'modelName == "source"' --json | jq -c '.results[] | {environment: .attributes.env}' | swamp model method run my-deploy create --stdin
swamp model method run my-deploy create --last-evaluated
swamp model method run my-deploy create --skip-checks
swamp model method run my-deploy create --skip-check valid-region
swamp model method run my-deploy create --skip-check-label live
```

**Data versioning:** Running a method multiple times creates new data versions
(v1, v2, ...), never overwrites. Each run's artifacts are preserved. Use
`swamp data get <name> <spec> --version <N>` to access a specific version, or
see the **swamp-data** skill for version history and cleanup.

Pre-flight checks run automatically before mutating methods (`create`, `update`,
`delete`, `action`). Read-only methods (`sync`, `get`, etc.) do not trigger
checks.

**Environment variable warnings** are emitted before execution if the model
definition uses `${{ env.* }}` expressions. When you see these warnings in the
output, **pause and confirm with the user** that the current environment
variables are correct for the intended target. See
[Handling Validation Warnings](#important-handling-validation-warnings) above.

**Options:**

| Flag                         | Description                                      |
| ---------------------------- | ------------------------------------------------ |
| `--input <value>`            | Input values (key=value repeatable, or JSON)     |
| `--input-file <f>`           | Input values from YAML file                      |
| `--last-evaluated`           | Use previously evaluated model (skip eval)       |
| `--skip-checks`              | Skip all pre-flight checks                       |
| `--skip-check <name>`        | Skip a specific check by name (repeatable)       |
| `--skip-check-label <label>` | Skip all checks with a given label (repeatable)  |
| `--driver <driver>`          | Override execution driver (e.g. `raw`, `docker`) |

**Output shape:**

```json
{
  "outputId": "d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5",
  "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "modelName": "my-shell",
  "method": "execute",
  "status": "succeeded",
  "duration": 150,
  "artifacts": {
    "resource": ".swamp/data/command/shell/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/result/1/raw"
  }
}
```

## Model Outputs

Use `swamp model output search`, `output get`, `output logs`, and `output data`
to inspect method execution results. See
[references/outputs.md](references/outputs.md) for commands and output shapes.

### Inspecting Factory Method Results

When a factory method produces multiple data artifacts, use `swamp data query`
(from the **swamp-data** skill) to explore them:

```bash
# List all artifacts from a model
swamp data query 'modelName == "my-scanner"' --select '{"name": name, "version": version}'

# Filter by spec name and extract fields
swamp data query 'modelName == "my-scanner" && specName == "result"' \
    --select '{"host": attributes.hostname, "status": attributes.status}'
```

For single-output inspection, `swamp model output get <name> --json` is
sufficient. For browsing N artifacts, `data query` with `--select` is the
primary pattern.

## Run Tracking

swamp tracks in-flight runs — both model method executions and workflow runs —
in a local SQLite database (`.swamp/run_tracker.db`). Every execution registers
with the tracker, heartbeats every 30s, and completes on success/failure. Stale
runs (heartbeat >90s old with a dead process) are automatically reaped on next
invocation.

The central command is `swamp run`:

| Question                                  | Command                             |
| ----------------------------------------- | ----------------------------------- |
| What's running right now?                 | `swamp run history --active`        |
| What ran recently (last 24h)?             | `swamp run history`                 |
| Full history of tracked runs              | `swamp run history --all`           |
| Structured output for scripting           | `swamp run history --json`          |
| Are there stuck/orphaned runs?            | `swamp run doctor`                  |
| Fix stuck runs automatically              | `swamp run doctor --fix`            |
| Cancel a specific model's running method  | `swamp model cancel <name>`         |
| Cancel all running model methods          | `swamp model cancel --all`          |
| What completed runs exist (YAML outputs)? | `swamp model output search`         |
| Execution history with duration/status    | `swamp model method history search` |

See `swamp run history --help` for full details.

## Workflow Example

**Design check — before creating a model, ask the user:**

1. Will this model have **multiple methods** that might run at the same time
   (e.g., a long-running build AND an SSH session)?
2. Will any method be **long-running** (builds, deployments, large data
   transfers)?

If yes to either: each independent concern should be a **separate model
instance**. Swamp holds an exclusive per-model lock for the entire duration of a
method execution — a 20-minute build locks out every other method on that model.
Use the factory pattern to split concerns into separate instances so they can
run concurrently. See
[references/scenarios.md#scenario-5](references/scenarios.md#scenario-5-factory-pattern-for-model-reuse).

**Steps:**

1. **Search community extensions** first:
   `swamp extension search <query> --json` — prefer `@swamp/*` official
   extensions. If a match exists, install with `swamp extension pull <package>`
   instead of building from scratch
2. **Search local types**: `swamp model type search "shell" --json`
3. **Describe** to understand the schema:
   `swamp model type describe command/shell --compact --json`
4. **Create** an input file: `swamp model create command/shell my-shell --json`
5. **Edit** the YAML file to set `methods.execute.arguments.run`
6. **Validate** the model: `swamp model validate my-shell --json`
7. **Check warnings** — if the validation output has non-empty `warnings`, stop
   and ask the user before proceeding (see
   [Handling Validation Warnings](#important-handling-validation-warnings))
8. **Run** the method: `swamp model method run my-shell execute`
9. **View** the output: `swamp model output get my-shell --json`

## Data Ownership

Data is owned by the creating model — see
[references/data-ownership.md](references/data-ownership.md) for rules and
validation.

## Choosing the Right Approach

| Task                                                  | Approach                            |
| ----------------------------------------------------- | ----------------------------------- |
| New API/service integration                           | Extension model (`swamp-extension`) |
| Existing model missing a method                       | Extend it (`swamp-extension`)       |
| Reusable data pipeline (reports, analysis, summaries) | Report extension (`swamp-report`)   |
| Ad-hoc debugging or one-off data inspection           | Inline processing is fine           |

## When to Use Other Skills

| Need                            | Use Skill               |
| ------------------------------- | ----------------------- |
| Create/run workflows            | `swamp-workflow`        |
| Manage secrets                  | `swamp-vault`           |
| Repository structure            | `swamp-repo`            |
| Manage data lifecycle           | `swamp-data`            |
| Explore/query method results    | `swamp-data`            |
| Create custom TypeScript models | `swamp-extension`       |
| Create reports for models       | `swamp-report`          |
| Understand swamp internals      | `swamp-troubleshooting` |

## References

- **Outputs**: See [references/outputs.md](references/outputs.md) for output
  search, get, logs, and data commands with output shapes
- **Examples**: See [references/examples.md](references/examples.md) for
  complete model workflows and CEL expression reference
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  errors and fixes
- **Scenarios**: See [references/scenarios.md](references/scenarios.md) for
  end-to-end scenarios (shell commands, chained lookups, runtime inputs)
- **Data chaining**: See
  [references/data-chaining.md](references/data-chaining.md) for command/shell
  model examples and chaining patterns
- **Remote execution / worker placement**: See
  [../workflow/references/remote-execution.md](../workflow/references/remote-execution.md)
