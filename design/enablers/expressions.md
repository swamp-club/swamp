---
audience: maintainer, operator
enables: [models, workflows]
last-verified: 2026-09-16 @ uncommitted
---

# Expressions

Model definitions and workflows are YAML files that can contain Google CEL
expressions. After parsing, swamp evaluates each expression and injects its
result into the final data structure. Expressions reference models by name,
read their definitions or data, and transform the result in place (string
manipulation, concatenating array members, etc).

## Three CEL Surfaces

Swamp has three CEL surfaces:

1. **Internal**: `CelEvaluator` evaluates workflow conditions, data queries,
   `forEach` expansion, and definition evaluation. It adds swamp's own
   namespace types (`file.contents`, `data.latest`, etc.) to the baseline
   factory (`src/infrastructure/cel/cel_evaluator.ts`).
2. **Extension-author-facing**: `createExtensionCelEnvironment()` is the same
   factory without the swamp-internal namespace types. `MethodContext` exposes
   it as `ctx.createCelEnvironment()`, so extension model methods can evaluate
   their own CEL over data the model already holds (e.g. selector predicates
   over a fleet of hosts). Extensions register their own functions, types, and
   operators on the returned Environment; registrations on one instance do not
   affect any other. Guide:
   `.claude/skills/swamp/references/extension/references/model/api.md`.
3. **Grant-condition**: `createGrantConditionEnvironment()` is a sealed
   environment for authorization grant conditions
   (`src/infrastructure/cel/grant_condition_environment.ts`). It declares
   explicit variables per resource kind (workflow, model, data, access) and a
   `principal.*` namespace. It sets `unlistedVariablesAreDyn: false`, so
   references to undeclared fields fail at write-time validation. It has no
   I/O receivers (`data.*`, `file.*`, `vault.*`, `env.*`), no extension
   registrations, and no host functions beyond the arithmetic baseline. The
   seal is permanent, so conditions are deterministic pure functions over
   (resource fields, principal context).

All three share the arithmetic overloads from `registerArithmeticOverloads()`
(bigint/double mixes), so arithmetic evaluates the same on every surface. They
differ in which variables and receiver methods are visible.

## Model Data

The `model` namespace is keyed by both definition name and definition id
(`context.model[name]` and `context.model[id]`). It exposes
`definition.{id,name,version,tags,globalArguments,inputs}` through dot notation
(`src/domain/expressions/expression_evaluation_service.ts`; `ModelData` in
`src/domain/expressions/model_resolver.ts`).

## Examples

The expression's result is inserted into the data structure. Given this
definition:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: foo
version: 1
tags: {}
globalArguments:
  message: "I like cheese"
```

Another definition can read its message global argument:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: bar
version: 1
tags: {}
globalArguments:
  message: ${{ model.foo.definition.globalArguments.message }}
```

Or the same model's data output:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: baz
version: 1
tags: {}
globalArguments:
  message: ${{ data.latest('foo', 'result').attributes.message }}
```

`data.latest()` is a shortcut for a `data.query()` call. The general primitive,
`data.query('<CEL predicate>')`, takes any predicate over the queryable fields.
Use it when a shortcut is not enough. Examples are a multi-field predicate,
a projection, tag filters beyond a single key, or history beyond a single
version. [data-query.md](./data-query.md) covers the primitive, the full field
set, and the shortcut mapping table.

`self` refers to your own model (`id`, `name`, `version`, `tags`,
`globalArguments`). Inside a forEach step it also carries the iteration
variable.

A model can also be referenced by its uuid instead of its name. There is no
`workflow.*` namespace; workflows are not addressable from expressions.

## Workers Namespace

The `workers` namespace has helpers for querying workers eligible for dispatch.
It is available wherever `data.*` is: model globalArguments, workflow step
inputs, and forEach.in expressions.

### `workers.connected()`

Returns worker data records whose status is not `disconnected`. This is the
standard query for fleet fan-out workflows:

```yaml
steps:
  - name: scan-${{ self.worker.attributes.name }}
    forEach:
      item: worker
      in: "${{ workers.connected() }}"
    target: "${{ self.worker.attributes.name }}"
    task:
      model: fleet-scanner
      method: scan
```

Internally equivalent to:

```
data.query('modelType == "swamp/worker" && name == "state-main" && attributes.status != "disconnected"')
```

It exists because `data.query('modelType == "swamp/worker"')` includes
disconnected workers. Fan-out would then create steps for unavailable workers
that queue until `queueTimeout` expires.

## Input Access

Model and workflow definitions can declare inputs (variables/parameters) as
JsonSchema. CEL expressions read them.

**Model Inputs:** Within a model definition:

```yaml
globalArguments:
  message: ${{ inputs.someParameter }}
```

**Workflow Inputs:** Within a workflow definition:

```yaml
globalArguments:
  message: ${{ inputs.someWorkflowParameter }}
```

Another model's declared inputs schema is visible as
`model.foo.definition.inputs`. Input values are not readable across models or
workflows.

Inputs can be required or optional (set in JsonSchema). They give dynamic
configuration without editing definition files.

## Workflow Run Context

In workflow step inputs, the `run` namespace holds metadata about the current
workflow execution. It exists only at step execution time, not in
workflow-level fields like `description`.

| Field              | Type                     | Description                      |
| ------------------ | ------------------------ | -------------------------------- |
| `run.id`           | string (UUID)            | Unique ID of this workflow run   |
| `run.workflowId`   | string (UUID)            | Workflow definition ID           |
| `run.workflowName` | string                   | Workflow name                    |
| `run.startedAt`    | string (ISO 8601)        | Timestamp when the run started   |
| `run.tags`         | `Record<string,string>`  | Merged workflow + runtime tags   |
| `run.initiatedBy`  | string (optional)        | Identity that triggered the run  |
| `run.inputs`       | `Record<string,unknown>` | Input values provided to the run |

The flat `workflowRunId` variable equals `run.id`. It remains for backward
compatibility with `data.query()` predicates.

## Step Output Context

In workflow step inputs, the `steps` namespace holds results from completed
upstream steps.

| Field                  | Type                     | Description                                    |
| ---------------------- | ------------------------ | ---------------------------------------------- |
| `steps.<name>.status`  | string                   | Step status (`succeeded`, `failed`, `skipped`) |
| `steps.<name>.outputs` | `Record<string,unknown>` | Resource attributes from model method steps    |

Only completed steps are visible. A model method step's outputs are the
attributes of every JSON resource it wrote, merged into one flat record in
write order; on a name clash the later one wins. For one specific instance, use
`data.latest("<model>", "<instance>")`. Non-JSON resources and file outputs add
nothing, and steps with no resource attributes have no outputs.

The run record never stores output values. Resource attributes are stripped so
its size doesn't depend on the data steps write. A live run takes outputs from
each step's full output before stripping. A resumed run, a parent reading a
child run, and `swamp workflow history get --json` /
`swamp workflow history outputs` load them from the datastore through the
run's resource references. These reads are best-effort: ephemeral-lifetime
data, garbage-collected versions and an uncached remote datastore yield no
outputs. A run and its resume resolve sensitive fields from their vault
references, as `data.latest` does; history shows them as stored. Over
`swamp serve`, history includes only outputs of models the caller may read as
data.

The `steps` namespace exists only once the run does. Like `run.*`, expressions
reading it stay raw during workflow evaluation and resolve at step execution
time. Evaluating them at run start would fail the whole run with
`Unknown variable: steps`.

Outputs cross one level of workflow nesting. When a parent step invokes a child
workflow, the outputs of the child's succeeded model method steps are available
as `steps.<parent-step>.outputs.<child-step>.<attr>`. The parent step records
the child's workflow and run ids, not the values. Multi-level nesting
(grandchild workflows) does not propagate outputs.

## Webhook Payload Context

For webhook-triggered runs, the `webhook` namespace holds the verified request
payload. It is available **only inside a workflow's `trigger.inputs`**, which
is evaluated against the payload at fire time, before input validation, to map
payload fields onto named inputs.

| Field             | Type                    | Description                                         |
| ----------------- | ----------------------- | --------------------------------------------------- |
| `webhook.body`    | unknown                 | JSON-parsed body; raw string if not JSON            |
| `webhook.headers` | `Record<string,string>` | Lowercased header names (signature header excluded) |
| `webhook.route`   | string                  | Matched webhook route (e.g. `/hooks/linear`)        |

```yaml
trigger:
  inputs:
    identifier: "${{ webhook.body.data.issue.identifier }}"
```

swamp's CEL has no `??` operator. Guard optional payload fields with the
`has()` macro and a ternary: `has(x.y) ? x.y : fallback`. A hard reference to a
missing field is an error and the run does not start. Sensitive headers
(authentication, proxy credentials, and names ending in `-token` or `-secret`)
are removed before expressions see the payload, so a reference to one fails as
a missing field. Full walkthrough: `design/primitives/workflows.md`.

**Run-scoped resource keys:** use `run.id` to avoid collisions when the same
workflow runs concurrently:

```yaml
steps:
  - name: filter-vms
    task:
      type: model_method
      modelIdOrName: fleet-scanner
      methodName: filter
      inputs:
        outputKey: "filtered-vms-${{ run.id }}"

  - name: reboot-gate
    dependsOn: [filter-vms]
    task:
      type: model_method
      modelIdOrName: fleet-manager
      methodName: check_kernel
      inputs:
        vmListKey: "filtered-vms-${{ run.id }}"
```

## Data Versioning

Data is immutable and versioned. The shortcuts below cover common reads. Each
is a convenience form of `data.query()` (mapping in
[data-query.md](./data-query.md)). Prefer one when it fits:
`data.latest("m", "n")` reads more clearly than the predicate.

They read from disk on every call, so they are never stale. The
`model.*.resource` and `model.*.file` patterns are **deprecated** and will be
removed in a future release.

### data.latest(modelName, dataName)

Returns the latest version of a model's data artifact:

```yaml
globalArguments:
  result: ${{ data.latest('my-model', 'output').attributes.value }}
```

For `application/json` resources, `.content` is the same parsed object as
`.attributes`, so both work:

```yaml
inputs:
  # These are equivalent for JSON resources:
  via_attributes: ${{ data.latest('shell-runner', 'result').attributes.stdout }}
  via_content: ${{ data.latest('shell-runner', 'result').content.stdout }}
```

For non-JSON content types (e.g. `text/plain`), `.content` is the raw text
string.

`.path` is the local filesystem path of the version's stored content file. It
replaces the deprecated `model.<name>.file.<spec>.<instance>.path`:

```yaml
methods:
  execute:
    arguments:
      run: "wc -l ${{ data.latest('r-lab', 'table').path }}"
```

It works for any data type (a resource's `.path` is its stored JSON file). It
is `""` for ephemeral data, for records from another namespace in a shared
datastore, and when the file cannot be made local. On a lazy-hydration
datastore, `data.latest()` and `data.version()` download it first. The path is
on the host evaluating the expression, not a remote worker. A run replayed with
`--last-evaluated` reuses the path as it was resolved. Select the `.path`
field instead of passing a whole record into an input.

### data.version(modelName, dataName, version)

Returns a specific version of a data artifact:

```yaml
globalArguments:
  # Get version 1 specifically
  oldResult: ${{ data.version('my-model', 'output', 1).attributes.value }}
  # Get version 3
  result: ${{ data.version('my-model', 'output', 3).attributes.value }}
```

### data.listVersions(modelName, dataName)

Returns a data artifact's version numbers in ascending order (oldest first):

```yaml
globalArguments:
  # Get all available versions
  versions: ${{ data.listVersions('my-model', 'output') }}
  # Use with size() to count versions
  versionCount: ${{ size(data.listVersions('my-model', 'output')) }}
```

### Vary Dimensions

Data stored with `vary` dimensions (see
[Workflows](../primitives/workflows.md)) gets a composite data name per
dimension value. To read it, pass a list of dimension values to the 3-argument
form of `data.latest()`, `data.version()`, or `data.listVersions()`. In a
forEach step, the iteration variable picks the right environment's data:

```yaml
# Dynamic access via forEach variable:
inputs:
  scanResult: ${{ data.latest('scanner', 'result', [self.env]).attributes.count }}

# Dynamic access via workflow input:
inputs:
  scanResult: ${{ data.latest('scanner', 'result', [inputs.environment]).attributes.count }}

# Version access with vary dimensions:
inputs:
  oldResult: ${{ data.version('scanner', 'result', [inputs.environment], 1).attributes.count }}

# List versions for a specific dimension:
inputs:
  versions: ${{ data.listVersions('scanner', 'result', [inputs.environment]) }}
```

The 2-argument forms still work for data stored without vary dimensions.

### Cross-Namespace Queries

Point-lookup helpers accept a `namespace:model-name` prefix (`infra:scanner`,
`*:scanner`). `data.query()` filters by the `ns` field. Syntax and examples:
[data-query.md § Cross-namespace queries](./data-query.md#cross-namespace-queries-giga-swamp-phase-4).

### Combined Example

```yaml
globalArguments:
  # Get latest result
  current: ${{ data.latest('processor', 'result').attributes.value }}
  # Get the first result ever produced
  original: ${{ data.version('processor', 'result', 1).attributes.value }}
  # Check how many versions exist
  historySize: ${{ size(data.listVersions('processor', 'result')) }}
```

### Null-safe Optional Access (.?)

`data.latest()` and `data.version()` return `null` when the named instance
doesn't exist. Chain through a possibly-null result with `.?` and supply a
default with `.orValue()`. Syntax and examples:
[data-query.md § Null-safe access](./data-query.md#null-safe-access-).

Use `.?` when the data might not exist yet, such as a prior cycle's output on
the first cycle of a rework loop. Use regular `.` when the data must exist and
a missing result is a bug that should fail loudly.

### data.findBySpec(modelName, specName)

Returns all of a model's data records that match an output spec name. Shortcut
for `data.query('modelName == "..." && specName == "..."')`. Often used in
`task.inputs` or `forEach.in` to iterate over variable-length output.

```yaml
# Iterate over every episode produced by the dedup-model:
- name: download-${{ self.ep.name }}
  forEach:
    item: ep
    in: ${{ data.findBySpec("dedup-model", "episode") }}
  task:
    type: model_method
    modelIdOrName: transmission
    methodName: add
    inputs:
      uri: ${{ self.ep.magnet }}
```

During forEach expansion, `self.*` resolves in any task field: the step
`name`, model targets (`modelIdOrName`, `modelName`, `methodName`), workflow
targets (`workflowIdOrName`), `inputs`, and shell `args`. So a forEach step can
pick a different target per iteration:

```yaml
# Fan out across region-specific model instances:
- name: summary-${{ self.region }}
  forEach:
    item: region
    in: ${{ inputs.regions }}
  task:
    type: model_method
    modelIdOrName: aws-alarms-${{ self.region }}
    methodName: get_summary
    inputs:
      historyHours: 24
```

```yaml
# Each wave item selects which workflow implementation to run:
- name: apply-${{ self.item.host }}-${{ self.item.capability }}
  forEach:
    item: item
    in: ${{ inputs.items }}
  task:
    type: workflow
    workflowIdOrName: ${{ self.item.implementation.workflowIdOrName }}
    inputs:
      host: ${{ self.item.host }}
```

In every field, each `${{ }}` expression that can be evaluated against the
per-iteration context is resolved. `vault.*`/`env.*` and step-output/`data.*`
references wait for their later runtime/execution stages.

Results are not run-scoped: `findBySpec` returns every matching record in
the catalog. To scope to the current run, add a `workflowRunId` predicate via
`data.query()`.

If different workflow steps invoke the same model and write the same
spec/instance name, each step's output is a distinct record with its own latest
version. Step A's latest and step B's latest are both returned. A standalone
model-method write to the same data name demotes all prior step outputs.

### data.findByTag(tagKey, tagValue)

Returns all data records, across all models, with a matching tag. Shortcut for
`data.query('tags.key == "value"')`. Not run-scoped: it always returns all
matching data globally.

```yaml
# Find all data tagged with env=prod across all models:
inputs:
  prodData: ${{ data.findByTag("env", "prod") }}
```

### data.query(predicate, select?)

`data.query()` takes a CEL predicate over every queryable field (full set in
[data-query.md](./data-query.md)) and an optional `select` projection:

```yaml
# Every failed resource for a model tagged with env=prod:
inputs:
  failures: ${{ data.query('modelName == "scanner" && dataType == "resource" && tags.env == "prod" && attributes.status == "failed"') }}

# Project specific fields out of every result across all models:
inputs:
  manifest: ${{ data.query('tags.role == "manifest"', '{"name": name, "version": version, "at": createdAt}') }}
```

Its results have the same `DataRecord[]` shape as the shortcuts and can be
used the same way.

### Step-output deferral in workflows

All `data.*` functions (`data.latest`, `data.version`, `data.listVersions`,
`data.findBySpec`, `data.query`, `data.findByTag`) are step-output
dependencies. In workflow step `task.inputs` and assert step `task.message`,
they are **deferred** past workflow evaluation and resolve at step execution
time, after upstream steps have written their data. So step 1 can produce
ephemeral data that step 2 reads via `data.findBySpec()` or `data.query()`, and
assert steps can put prior-step data in their failure messages.

`--last-evaluated` keeps this: deferred expressions are saved as raw `${{ }}`
in the evaluated workflow and resolved at step execution time against the
current data store.

### Task-target deferral

A step's **task target** names what it executes: `task.modelIdOrName`,
`task.modelName` in the direct-execution form, or `task.workflowIdOrName` on a
nested workflow step. It defers for either of two independent reasons:

- **It reads step output.** The data it names does not exist at run start,
  which is also why `task.inputs` defers. A driver step that picks the next
  workflow from a record an earlier step wrote needs this (swamp-club#2351).
  Evaluated at run start, the target silently took its `orValue` fallback or a
  previous run's value.
- **Its step has a guard.** A guarded step may not run. Resolving a target for
  a step that will skip caused swamp-club#2304: an empty result failed
  `StepTask` validation while the evaluated workflow was rebuilt. The run died
  before any step executed and no run was recorded, so there was nothing to
  inspect.

An unguarded target with no step-output dependency still resolves at run start.
Deferring it gains nothing for a step that will run, and a mistyped name fails
early.

Deferral is decided per path, but substitution is keyed on the raw expression
text, and two steps can carry the same expression. So deferred paths are
recorded and skipped during substitution. Otherwise a plain step's evaluated
value would land in a guarded step's deferred target and silently undo the
deferral.

Deferred targets are resolved in `executeModelMethod` and `runWorkflowStep`,
after the guard decides. `runStep` returns early on a guarded skip and reaches
neither, so a step that does not run never resolves its target. A target that
interpolates a deferred expression into literal text
(`stage-${{ data.latest(...) }}`) is resolved one expression at a time. Only
author-written expressions are evaluated; template text from a data record
stays literal.

`swamp workflow evaluate` applies the same rule (`createTaskTargetDeferral`),
so the evaluated cache that `--last-evaluated` replays leaves the same targets
raw as a fresh run.

`task.methodName` and `task.modelType` are not task targets and still resolve
at run start.

## Sensitive Data

Vault secrets are read with `vault.get('<vault-name>', '<key>')`, the only
vault expression form recognized (`VAULT_GET_PATTERN` in
`src/domain/expressions/vault_reference_extractor.ts`). Vault expressions are
never evaluated at definition-evaluation time. They resolve at runtime and are
never persisted.

### Example

Set `keyData` from the `machineKeyData` key of the configured `aws` vault:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: baz
version: 1
tags: {}
globalArguments:
  keyData: ${{ vault.get('aws', 'machineKeyData') }}
```

### Only Author-Written Expressions Are Evaluated After Substitution

CEL evaluation splices values into the definition tree as raw text, and later
passes walk that same tree:

- the runtime pass that resolves `vault.get()` and `env` references;
- the step executor's second CEL pass over step inputs (and over a
  direct-execution definition synthesised from them), which resolves deferred
  `data.*`, `steps.*` and `self.*` references.

Without provenance, text that entered the tree only as data content would be
evaluated as if the author wrote it. A `vault.get()` or `env` reference would
resolve a secret directly. Other CEL, such as a `data.latest()` call on another
model's sensitive field, would read one through the evaluation context.

**A pass that runs after substitution evaluates an expression only if its raw
text was written in the workflow or model definition source.**
Expression syntax that arrives as data content is inert. It stays literal text
and a warning naming the path is logged.

`collectAuthoredExpressions()` collects the authored set from each source
before any CEL evaluation runs. The sets from every author-written source
feeding a run are unioned:

| Source                    | Collected from                                                              |
| ------------------------- | --------------------------------------------------------------------------- |
| Model definition          | the definition on disk, in both the normal and `--last-evaluated` paths     |
| Workflow                  | the workflow YAML on disk, before evaluation, at fresh-run and resume seams |
| Model-run `--input` flags | operator-typed values, on `swamp model ... method run` only                 |
| Parent workflow           | the parent's set, unioned into a nested child run's set                     |
| Evaluated caches          | the set persisted with each evaluated definition and evaluated workflow     |

Evaluated caches carry their own set because `--last-evaluated` runs the
cached tree without the evaluator. If the source changed since, it cannot vouch
for an expression still in the cache. On load, the persisted set is unioned
with the current source's set, never substituted for it.

Workflow runs do not seed CLI `--input` values. Trigger inputs and CLI
inputs merge into one map before the evaluator sees them, so a vault reference
passed to `swamp workflow run --input` is inert (fail-closed). Two more sources
are also not trusted:

- Step `task.inputs` are not seeded at step-execution time, because the
  workflow evaluator has already substituted data into them. The
  workflow-source set covers author-written step inputs instead.
- A direct-execution definition is not seeded. It is synthesised from
  `task.inputs`, not loaded from the repository, so it is not an authored
  source.

The set guards available-expression resolution, forEach expansion,
whole-record inputs/global arguments, step-input and definition evaluation,
runtime selectors, inherited placement, guards, and assertion-message
interpolation. Whole-record fields reject untrusted expression strings without
evaluating them. Bare assertion predicates are checked separately against the
original authored CEL source, so substitution cannot turn a supplied string
into an executable predicate. These checks cover fresh runs, resumed runs,
nested calls, and evaluated-cache replay.

Placement merges workflow → job → step defaults, then resolves target, labels,
and platform through the same provenance-gated runtime resolver.

Parent-authored runtime expressions passed to child inputs keep the parent's
scope. For example, `${{ env['HOME'] + inputs.suffix }}` uses the parent's
`suffix`, even if the child has no `suffix` or a different one. Internal
references point to records holding the original expression and the parent's
`inputs`, `self`, `run`, `workflowRunId`, and `steps` bindings. The same
expression authored by the child uses child scope. A reference passed through
another nested workflow keeps its existing scope.

Runs and evaluated caches persist these scoped records alongside provenance.
They do not capture the process environment, service objects, or resolved
vault secrets. Execution rebuilds service-backed namespaces and resolves vault
values through the secret bag. Scope metadata is optional: older artifacts keep
their existing provenance behavior, and missing parent bindings are never
rebuilt from child inputs.

The parameter carrying the set is required and typed
`ReadonlySet<string> | "unrestricted"`, so every caller of these passes must
state whether its input is author-written. `"unrestricted"` is only for callers
that applied no substitution, such as model validation on definitions
read straight from the repository.

The env classifier also treats any bare `env` identifier (dotted,
bracket-index or passed as a value) as a runtime reference. No form of env
access is evaluated in the persist phase or written to an evaluated definition
on disk.

This is separate from the sensitive-field gating on the data read path. That
gate limits which stored fields get vault references resolved when read, and
passes a non-sensitive field's literal text through untouched. This rule
decides whether such text is ever evaluated.

The remaining gap is replay. Anyone who can write a plain field can inject the
exact raw text of an expression the author wrote elsewhere in the same source
and have it evaluated at a sink of their choosing. That is bounded by what the
author already granted the run.

### Dynamic Vault Arguments

vault.get() arguments can be CEL expressions when passed as bare tokens
(without quotes). A bare-token argument containing a `.` (member access) is
CEL-evaluated against the expression context before the vault lookup:

```yaml
# Resolve vault name and key from workflow inputs:
globalArguments:
  apiKey: ${{ vault.get(inputs.vaultName, inputs.secretKey) }}
```

```yaml
# Mixed: literal vault name, dynamic key from inputs:
globalArguments:
  password: ${{ vault.get('prod-vault', inputs.passwordKey) }}
```

Quoted arguments are always used verbatim. So are bare tokens without a `.`
(e.g. `my-vault`), for backwards compatibility; they cannot be mistaken for CEL
expressions.

If a dynamic argument references a missing input or evaluates to a non-string,
the lookup fails at runtime with an error. It never uses the expression
text as a literal key.

**Security note:** In local execution, dynamic vault.get() arguments let
workflow inputs select any registered vault and key. The authored-expression
rule above does not limit this: the expression text is author-written, so it
stays resolvable, and only its arguments are evaluated at runtime. If
those inputs carry attacker-controlled data, the caller still picks the vault
and key. This is acceptable because the local user already has filesystem
access to vault configurations. In remote execution (serve dispatch), the
`hasDynamicRefs` flag on the `VaultExtractionResult` bypasses the per-dispatch
secret allowlist, while `DENIED_VAULT_NAMES` / `DENIED_SECRET_KEY_PREFIXES`
still block infrastructure secrets.

**Known limitation:** `vault.get(self.item.vaultName, self.item.key)` inside a
`forEach` step cannot resolve, because the forEach iteration context is not
available during runtime vault resolution. For per-target secrets in forEach
steps, use workflow inputs or an extension method.

### Shell Safety

When vault secrets appear in the `run` field of a `command/shell` model, the
shell model passes them as environment variables instead of embedding them
in the command string. The shell never parses secret content as syntax, so
shell metacharacter injection is impossible.

CEL evaluation replaces vault secrets with unique sentinel tokens. At the shell
model boundary, each sentinel becomes a double-quoted environment variable
reference (`"${__SWAMP_VAULT_N}"` on POSIX, `"$env:__SWAMP_VAULT_N"` on native
Windows PowerShell), and the raw values go through the process environment.
Shell variable expansion happens after command parsing, so metacharacters in a
secret stay literal data.

```yaml
# Secret value: pass;rm -rf /
# POSIX shell receives: echo "${__SWAMP_VAULT_0}"
# Windows PowerShell receives: Write-Output "$env:__SWAMP_VAULT_0"
# Both receive env __SWAMP_VAULT_0="pass;rm -rf /"
# Output: pass;rm -rf /  (literal, no injection)
globalArguments:
  run: "echo ${{ vault.get('my-vault', 'SECRET') }}"
```

As a result:
- `;`, `|`, `&`, `(`, `)`, `<`, `>` in a secret do not split or redirect commands.
- `$VAR_NAME` and `$(cmd)` in a secret are not expanded or executed.
- `` `cmd` `` in a secret is not executed.
- `!` in a secret does not trigger bash history expansion.
- All current and future shell metacharacters are handled; there is no
  character blocklist.
- Non-shell contexts (extension models, API calls) get the exact raw secret
  values, with no escaping artifacts.

## Environment Variables

All process environment variables are available in CEL through the `env`
namespace as `env.VAR_NAME`.

### Basic Usage

```yaml
globalArguments:
  homeDir: ${{ env.HOME }}
  configValue: ${{ env.MY_CONFIG_VALUE }}
```

### Security Warning

> **Warning:** Values read via `env` are not redacted or filtered. An
> environment variable used as a model attribute is stored on disk in the
> datastore `data/` directory (default `.swamp/data/`) as model output data,
> and is visible in `swamp data get` output. This includes sensitive variables
> present at runtime (e.g. `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, database
> passwords).

### Use `vault.get()` for Sensitive Values

For API keys, tokens, passwords, and other secrets, use `vault.get()` instead
of `env`. Vault values are fetched at runtime and are never persisted in
model output data.

**Wrong: the secret is stored on disk in the datastore `data/` directory:**

```yaml
globalArguments:
  apiKey: ${{ env.API_KEY }}
```

**Right: the secret is fetched at runtime and never persisted:**

```yaml
globalArguments:
  apiKey: ${{ vault.get('my-vault', 'API_KEY') }}
```

See [Sensitive Data](#sensitive-data) for more on vaults.

## Extensibility

Extension model methods extend CEL through `ctx.createCelEnvironment()`
(surface 2 above), registering their own functions, types, and operators on an
isolated environment. There is no repo-level way to register custom CEL
functions in the internal evaluator.

## Runtime Guidance

When loading the YAML, swamp first parses the CEL expressions, then embeds
their values into the data structure. Evaluated definitions are written to the
datastore at `definitions-evaluated/` (default `.swamp/definitions-evaluated/`),
mirroring the `models/` directory. Evaluated workflows go to
`workflows-evaluated/` (default `.swamp/workflows-evaluated/`). See
`SWAMP_SUBDIRS` in `src/infrastructure/persistence/paths.ts`. Both live under
`.swamp/`, which `swamp repo init` adds to the managed `.gitignore` section
(`src/domain/repo/repo_service.ts`).

These evaluated directories are internal working directories in the datastore,
used by the expression evaluation system.
