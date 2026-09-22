---
audience: maintainer, operator
enables: [models, workflows]
last-verified: 2026-09-16 @ uncommitted
---

# Expressions

Model definitions and Workflows are stored as YAML files, and they can contain
Google CEL expressions which get evaluated into the data structures they return
and injected into the final data structure after parsing. These expressions
reference models by name, read their definitions or data, and manipulate the
result in place (string manipulation, concatenating array members, etc).

## Three CEL Surfaces

Swamp has three distinct CEL surfaces:

1. **Internal**: `CelEvaluator` (`src/infrastructure/cel/cel_evaluator.ts`) is
   used to evaluate expressions in workflow conditions, data queries,
   `forEach` expansion, and definition evaluation. It registers swamp's own
   namespace types (`file.contents`, `data.latest`, etc.) on top of the
   baseline factory.
2. **Extension-author-facing**: `createExtensionCelEnvironment()` is the same
   factory without the swamp-internal namespace types. It is exposed on
   `MethodContext` as `ctx.createCelEnvironment()` so extension model
   methods can evaluate their own CEL expressions over data the model
   already holds (e.g. selector predicates over a fleet of hosts).
   Extensions register their own functions, types, and operators on the
   returned Environment — registrations on one instance do not affect any
   other. See
   `.claude/skills/swamp/references/extension/references/model/api.md` for
   the extension-author guide.
3. **Grant-condition**: `createGrantConditionEnvironment()`
   (`src/infrastructure/cel/grant_condition_environment.ts`) is a sealed,
   purpose-built environment for evaluating authorization grant conditions.
   It declares explicit variables per resource kind (workflow, model, data,
   access) and a `principal.*` namespace, with
   `unlistedVariablesAreDyn: false` so references to undeclared fields fail
   at write-time validation. No I/O receivers (`data.*`, `file.*`,
   `vault.*`, `env.*`), no extension registrations, no host functions beyond
   the arithmetic baseline. The seal is permanent — conditions are
   deterministic pure functions over (resource fields, principal context).

All three surfaces share the same arithmetic-overload registrations
(bigint/double mixes via `registerArithmeticOverloads()`) so a CEL
expression parsed against any surface evaluates arithmetic identically.
They diverge on what variables and receiver methods are visible.

## Model Data

The `model` namespace is keyed by both definition name and definition id
(`context.model[name]` and `context.model[id]`,
`src/domain/expressions/expression_evaluation_service.ts`), and exposes
`definition.{id,name,version,tags,globalArguments,inputs}` through dot notation
(`ModelData` in `src/domain/expressions/model_resolver.ts`).

## Examples

The result of the expression is inserted into the resulting data structure.
Given a definition like this:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: foo
version: 1
tags: {}
globalArguments:
  message: "I like cheese"
```

Another can use a CEL expression to extract the message global argument:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: bar
version: 1
tags: {}
globalArguments:
  message: ${{ model.foo.definition.globalArguments.message }}
```

Or the data output of the same model:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: baz
version: 1
tags: {}
globalArguments:
  message: ${{ data.latest('foo', 'result').attributes.message }}
```

`data.latest()` is a shortcut for the equivalent `data.query()` call. The
general primitive is `data.query('<CEL predicate>')`, which takes any
predicate over the full set of queryable fields. Reach for it when a
shortcut doesn't express what you need — for example, a multi-field
predicate, a projection, tag filters beyond a single key, or history access
beyond a single version. See [data-query.md](./data-query.md) for the
primitive, the full field set, and the shortcut mapping table.

You can refer to your own model with `self` (`id`, `name`, `version`, `tags`,
`globalArguments`); inside a forEach step `self` also carries the iteration
variable.

You can also use the uuid of a model in order to reference it, rather than the
name. There is no `workflow.*` namespace — workflows are not addressable from
expressions.

## Workers Namespace

The `workers` namespace provides helpers for querying workers eligible for
dispatch. It is available in the same contexts as `data.*` (model
globalArguments, workflow step inputs, forEach.in expressions).

### `workers.connected()`

Returns an array of worker data records whose status is not `disconnected`.
This is the canonical query for building fleet fan-out workflows:

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

The `workers.connected()` helper exists because the unfiltered
`data.query('modelType == "swamp/worker"')` includes disconnected workers,
which causes fleet fan-out workflows to create steps for unavailable workers
that queue until `queueTimeout` expires.

## Input Access

Both model definitions and workflow definitions can specify inputs
(variables/parameters) as JsonSchema. These inputs can be accessed through CEL
expressions:

**Model Inputs:** Within a model definition, access inputs with:

```yaml
globalArguments:
  message: ${{ inputs.someParameter }}
```

**Workflow Inputs:** Within a workflow definition, access workflow inputs with:

```yaml
globalArguments:
  message: ${{ inputs.someWorkflowParameter }}
```

Another model's declared inputs _schema_ is visible as
`model.foo.definition.inputs`; there is no cross-model or cross-workflow access
to input _values_.

Inputs can be required or optional (specified in JsonSchema), and provide
dynamic configuration without modifying definition files.

## Workflow Run Context

Inside workflow step inputs, the `run` namespace exposes metadata about the
current workflow execution. This is only available at step execution time (not
in workflow-level fields like `description`).

| Field              | Type                    | Description                    |
| ------------------ | ----------------------- | ------------------------------ |
| `run.id`           | string (UUID)             | Unique ID of this workflow run      |
| `run.workflowId`   | string (UUID)             | Workflow definition ID              |
| `run.workflowName` | string                    | Workflow name                       |
| `run.startedAt`    | string (ISO 8601)         | Timestamp when the run started      |
| `run.tags`         | `Record<string,string>`   | Merged workflow + runtime tags      |
| `run.initiatedBy`  | string (optional)         | Identity that triggered the run     |
| `run.inputs`       | `Record<string,unknown>`  | Input values provided to the run    |

The flat `workflowRunId` variable is also available (equivalent to `run.id`)
for backward compatibility with `data.query()` predicates.

## Step Output Context

Inside workflow step inputs, the `steps` namespace exposes results from
completed upstream steps. This allows downstream steps to consume outputs from
earlier steps in the same workflow.

| Field                      | Type                    | Description                         |
| -------------------------- | ----------------------- | ----------------------------------- |
| `steps.<name>.status`      | string                  | Step status (`succeeded`, `failed`, `skipped`) |
| `steps.<name>.outputs`     | `Record<string,unknown>` | Resource attributes from model method steps |

Only completed steps are visible — pending or running steps are not accessible.
The outputs field contains model method resource attributes when available;
steps that produce no resource attributes have no outputs.

Cross-workflow output passing is supported at one level of nesting: when a
parent step invokes a child workflow, the child's model method resource
attributes are collected and accessible as
`steps.<parent-step>.outputs.<child-step>.<attr>`. Multi-level nesting
(grandchild workflows) does not propagate outputs.

## Webhook Payload Context

For webhook-triggered runs, the `webhook` namespace exposes the verified request
payload. It is available **only inside a workflow's `trigger.inputs`**, where
expressions are evaluated against the payload at fire time (before input
validation) to map payload fields onto named inputs.

| Field             | Type                    | Description                          |
| ----------------- | ----------------------- | ------------------------------------ |
| `webhook.body`    | unknown                 | JSON-parsed body; raw string if not JSON |
| `webhook.headers` | `Record<string,string>` | Lowercased header names (signature header excluded) |
| `webhook.route`   | string                  | Matched webhook route (e.g. `/hooks/linear`) |

```yaml
trigger:
  inputs:
    identifier: "${{ webhook.body.data.issue.identifier }}"
```

swamp's CEL has no `??` operator — guard optional payload fields with the
`has()` macro and a ternary: `has(x.y) ? x.y : fallback`. A hard reference to a
missing field surfaces an error and the run does not start. Sensitive headers
(authentication, proxy credentials, and headers ending in `-token` or `-secret`)
are redacted before the payload is exposed to workflow expressions — redacted
headers are omitted entirely, so a workflow referencing one will fail on the
missing field. See `design/primitives/workflows.md` for the full walkthrough.

**Run-scoped resource keys** — use `run.id` to prevent collisions when the
same workflow runs concurrently:

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

Data is immutable and versioned. The following CEL shortcuts cover the common
read patterns; each is a convenience form of `data.query()` (see
[data-query.md](./data-query.md) for the shortcut-to-query mapping). Prefer
a shortcut when it matches your intent — `data.latest("m", "n")` reads more
clearly than the equivalent predicate. Reach for `data.query()` directly when
you need something the shortcuts don't express.

These accessors read directly from disk on every call, so they always reflect
the latest on-disk state with no cache staleness. The `model.*.resource` and
`model.*.file` patterns are **deprecated** and will be removed in a future
release.

### data.latest(modelName, dataName)

Returns the latest version of a data artifact for a model:

```yaml
globalArguments:
  result: ${{ data.latest('my-model', 'output').attributes.value }}
```

For `application/json` resources, `.content` is the same parsed object as
`.attributes`, so both access patterns work:

```yaml
inputs:
  # These are equivalent for JSON resources:
  via_attributes: ${{ data.latest('shell-runner', 'result').attributes.stdout }}
  via_content: ${{ data.latest('shell-runner', 'result').content.stdout }}
```

For non-JSON content types (e.g. `text/plain`), `.content` remains the raw text
string.

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

Returns an array of available version numbers for a data artifact, sorted in
ascending order (oldest first):

```yaml
globalArguments:
  # Get all available versions
  versions: ${{ data.listVersions('my-model', 'output') }}
  # Use with size() to count versions
  versionCount: ${{ size(data.listVersions('my-model', 'output')) }}
```

### Vary Dimensions

When data is stored with `vary` dimensions (see [Workflows](../primitives/workflows.md)),
each dimension value produces a composite data name. Use the 3-argument form
of `data.latest()`, `data.version()`, and `data.listVersions()` to access
varied data by passing a list of dimension values:

In a forEach step, use the iteration variable to dynamically select the right
environment's data:

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

The 2-argument forms continue to work for data stored without vary dimensions.

### Cross-Namespace Queries

Point-lookup helpers accept a `namespace:model-name` prefix (`infra:scanner`,
`*:scanner`), and `data.query()` filters by the `ns` field. See
[data-query.md § Cross-namespace queries](./data-query.md#cross-namespace-queries-giga-swamp-phase-4)
for the syntax and examples.

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
doesn't exist; chain through a possibly-null result with `.?` and supply a
default with `.orValue()`. See
[data-query.md § Null-safe access](./data-query.md#null-safe-access-) for the
syntax and examples.

Use `.?` when the data **might not exist yet** — for example, referencing a
prior cycle's output on the first cycle of a rework loop. Use regular `.` when
the data **must exist** — a missing result is a bug and should fail loudly.

### data.findBySpec(modelName, specName)

Returns all data records for a model that match a given output spec name.
Shortcut for `data.query('modelName == "..." && specName == "..."')`.
Commonly used in `task.inputs` or `forEach.in` to iterate over variable-length
output.

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

During forEach expansion, `self.*` expressions resolve in **any** task field —
the step `name`, model targets (`modelIdOrName`, `modelName`, `methodName`),
workflow targets (`workflowIdOrName`), `inputs`, and shell `args` — so a forEach
step can pick a different target per iteration:

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

Resolution is uniform across fields: every `${{ }}` expression that can be
evaluated against the per-iteration context is resolved, while `vault.*`/`env.*`
and step-output/`data.*` references are left for their later runtime/execution
stages.

Results are **not** run-scoped — `findBySpec` returns every matching record
in the catalog. Add a `workflowRunId` predicate via `data.query()` when you
want to scope to the current run.

When the same model is invoked by different workflow steps that produce data
with the same spec/instance name, each step's output is treated as a distinct
record. Each step maintains its own latest version, so step A's latest and
step B's latest are both returned. A standalone model-method write to the
same data name demotes all prior step outputs.

### data.findByTag(tagKey, tagValue)

Returns all data records across all models with a matching tag. Shortcut for
`data.query('tags.key == "value"')`. Not run-scoped — always returns all
matching data globally.

```yaml
# Find all data tagged with env=prod across all models:
inputs:
  prodData: ${{ data.findByTag("env", "prod") }}
```

### data.query(predicate, select?)

`data.query()` is the underlying primitive. Use it when the shortcuts don't
express what you need. It takes a CEL predicate over every queryable field
(see [data-query.md](./data-query.md) for the full set) and an optional
`select` projection. For example:

```yaml
# Every failed resource for a model tagged with env=prod:
inputs:
  failures: ${{ data.query('modelName == "scanner" && dataType == "resource" && tags.env == "prod" && attributes.status == "failed"') }}

# Project specific fields out of every result across all models:
inputs:
  manifest: ${{ data.query('tags.role == "manifest"', '{"name": name, "version": version, "at": createdAt}') }}
```

`data.query()` results have the same `DataRecord[]` shape as the shortcuts
— anything you can do with a shortcut result, you can do with a query result.

### Step-output deferral in workflows

All `data.*` functions (`data.latest`, `data.version`, `data.listVersions`,
`data.findBySpec`, `data.query`, `data.findByTag`) are classified as
step-output dependencies. In workflow step `task.inputs` and assert step
`task.message`, they are **deferred** past workflow evaluation and resolved at
step execution time — after upstream steps have run and their data is available.
This enables patterns where step 1 produces ephemeral data and step 2 consumes
it via `data.findBySpec()` or `data.query()`, and assert steps that interpolate
prior-step data in their failure messages.

The `--last-evaluated` flag preserves this behavior: deferred expressions saved
as raw `${{ }}` in the evaluated workflow are resolved at step execution time
against the current data store.

### Task-target deferral

A step's **task target** — `task.modelIdOrName`, or `task.modelName` in the
direct-execution form — names what the step executes. It defers for either of
two independent reasons:

- **It reads step output.** The data it names does not exist at run start, the
  same reason `task.inputs` defers.
- **Its step carries a guard.** A guarded step may not run at all, and
  resolving a target for a step that will skip is what made swamp-club#2304
  fail: an empty result failed `StepTask` validation while the evaluated
  workflow was rebuilt, killing the run before any step executed — and
  recording no run at all, so there was nothing to inspect afterwards.

An unguarded target with no step-output dependency still resolves at run start.
Deferral buys nothing for a step that is going to run, so a mistyped name keeps
failing where the error is cheapest.

Deferral is decided per path, while substitution is keyed on the raw expression
text. Two steps can carry the identical expression, so the paths that deferred
are recorded and skipped during substitution — otherwise a plain step's
evaluated value would be written into a guarded step's deferred target and
silently undo the deferral.

Deferred targets are resolved in `executeModelMethod`, after the guard has
decided. `runStep` returns early on a guarded skip and never reaches the
executor, so a step that does not run never resolves the target it would have
used.

## Sensitive Data

Vault secrets are read with `vault.get('<vault-name>', '<key>')` — the only
vault expression form recognized (`VAULT_GET_PATTERN` in
`src/domain/expressions/vault_reference_extractor.ts`). Vault expressions are
never evaluated at definition-evaluation time; they are resolved at runtime and
never persisted.

### Example

Setting `keyData` out of the configured `aws` vault from the `machineKeyData`
key:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: baz
version: 1
tags: {}
globalArguments:
  keyData: ${{ vault.get('aws', 'machineKeyData') }}
```

### Only Author-Written Expressions Are Evaluated After Substitution

CEL evaluation splices values into the definition tree as raw text, and every
later pass walks that same tree: the runtime pass that resolves `vault.get()`
and `env` references, and the second CEL pass the step executor runs over step
inputs (and over a direct-execution definition synthesised from them) to
resolve deferred `data.*`, `steps.*` and `self.*` references. Without
provenance, authored source and substituted content are indistinguishable, so
text that entered the tree purely as _data content_ would be evaluated as if
the author had written it — a `vault.get()` or `env` reference resolves a
secret directly, and any other CEL (a `data.latest()` call on another model's
sensitive field, say) reads one through the evaluation context.

The rule is therefore: **an expression is evaluated in a pass that runs after
substitution only if its raw text was written in the workflow or model
definition source.** Expression syntax that arrives as data content is inert —
it is left as literal text and a warning naming the path is logged.

The authored set is collected with `collectAuthoredExpressions()` from each
source _before_ any CEL evaluation runs, and unioned across every
author-written source feeding a run:

| Source                    | Collected from                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------- |
| Model definition          | the definition on disk, in both the normal and `--last-evaluated` paths             |
| Workflow                  | the workflow YAML on disk, before evaluation, at both the fresh-run and resume seams |
| Model-run `--input` flags | the operator-typed values, on `swamp model ... method run` only                     |
| Parent workflow           | the parent's set, unioned into a nested child run's set                             |
| Evaluated caches          | the set persisted alongside each evaluated definition and evaluated workflow        |

The evaluated caches carry the authored set that was collected when they were
written, because `--last-evaluated` executes the cached tree without running
the evaluator: if the source has been edited since, the current source alone
cannot vouch for an expression that is still in the cache. The persisted set
is unioned with the current source's set on load, never substituted for it.

Workflow runs do **not** seed CLI `--input` values: trigger inputs and CLI
inputs merge into one map before the evaluator sees them, so a vault reference
passed to `swamp workflow run --input` is inert (fail-closed). Two further
sources are deliberately not trusted. Step `task.inputs` are not seeded at
step-execution time, because the workflow evaluator has already substituted
data into them — author-written step inputs are covered by the workflow-source
set instead. A direct-execution definition is not seeded either: it is
synthesised from `task.inputs` rather than loaded from the repository, so it
is not an authored source at all.

The set guards available-expression resolution, forEach expansion, whole-record
inputs/global arguments, step-input and definition evaluation, runtime selectors,
inherited placement, guards, and assertion-message interpolation. Whole-record
fields reject untrusted expression strings without evaluating them. Bare assertion
predicates are checked separately against the original authored CEL source, so
substitution cannot turn a supplied string into an executable predicate. These
checks apply to fresh runs, resumed runs, nested calls, and evaluated-cache replay.

Placement merges workflow → job → step defaults before resolving target, labels,
and platform through the same provenance-gated runtime resolver.

Parent-authored runtime expressions passed to child inputs retain their parent
scope. For example, `${{ env['HOME'] + inputs.suffix }}` uses the parent's
`suffix`, even when the child has no `suffix` or supplies a different one.
Internal references identify records containing the original expression and the
parent's `inputs`, `self`, `run`, `workflowRunId`, and `steps` bindings. An identical
expression authored by the child still uses child scope. Passing a reference
through another nested workflow preserves its existing scope.

Runs and evaluated caches persist these scoped records alongside provenance.
They do not capture the process environment, service objects, or resolved vault
secrets. Execution rebuilds service-backed namespaces and resolves vault values
through the secret bag. Scope metadata is optional: older artifacts keep their
existing provenance behavior, and missing parent bindings are never reconstructed
from child inputs.

The parameter carrying the set is required rather than optional, typed
`ReadonlySet<string> | "unrestricted"`, so the compiler forces every caller of
those passes to state whether its input is author-written. `"unrestricted"` is
only for callers that have applied no substitution at all, such as model
validation running against definitions straight from the repository.

Relatedly, the env classifier recognises _any_ bare `env` identifier — dotted,
bracket-index or passed as a value — as a runtime reference, so no form of env
access is ever evaluated in the persist phase or written to an evaluated
definition on disk.

Note that this is a distinct concern from the sensitive-field gating on the data
_read_ path, which restricts which stored fields have vault references resolved
when they are read. That gate gives a non-sensitive field's literal text through
untouched, by design; this one decides whether such text is ever evaluated.

The residual is replay: whoever can write a plain field can inject the exact
raw text of an expression the author wrote elsewhere in the same source, and
have it evaluated at a sink of their choosing. That is bounded by what the
author already granted the run.

### Dynamic Vault Arguments

vault.get() arguments can be CEL expressions when passed as bare tokens (without
quotes). Bare-token arguments containing a `.` (member access) are CEL-evaluated
against the expression context before the vault lookup:

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

Quoted arguments are always used verbatim. Bare tokens without a `.` (e.g.
`my-vault`) are also used verbatim for backwards compatibility — they cannot be
confused with CEL expressions.

If a dynamic argument references an input that is missing or evaluates to a
non-string value, the vault lookup fails with a clear error at runtime — it does
not silently use the expression text as a literal key.

**Security note:** In local execution, dynamic vault.get() arguments allow
workflow inputs to select any registered vault and key. Note that the
authored-expression rule above does **not** constrain this: the expression text
is author-written, so it stays resolvable, and only its *arguments* are
evaluated at runtime. If those inputs carry attacker-controlled data, the caller
still chooses the vault and key. This is acceptable
because the local user already has filesystem access to vault configurations. In
remote execution (serve dispatch), the `hasDynamicRefs` flag on the
`VaultExtractionResult` bypasses the per-dispatch secret allowlist, and
`DENIED_VAULT_NAMES` / `DENIED_SECRET_KEY_PREFIXES` still block infrastructure
secrets.

**Known limitation:** `vault.get(self.item.vaultName, self.item.key)` inside a
`forEach` step cannot resolve because the forEach iteration context is not
available during runtime vault resolution. Use workflow inputs or an extension
method for per-target secrets in forEach steps.

### Shell Safety

When vault secrets are used in the `run` field of a `command/shell` model, the
shell model passes secret values via **environment variables** instead of
embedding them in the command string. This prevents all shell metacharacter
injection — the shell never parses secret content as syntax.

Internally, vault secrets are replaced with unique sentinel tokens during CEL
evaluation. At the shell model boundary, sentinels are replaced with
double-quoted environment variable references (`"${__SWAMP_VAULT_N}"` on POSIX
and `"$env:__SWAMP_VAULT_N"` on native Windows PowerShell), and the raw secret
values are passed through the process environment. Shell variable expansion
happens after command parsing, so metacharacters in the secret value are always
treated as literal data.

```yaml
# Secret value: pass;rm -rf /
# POSIX shell receives: echo "${__SWAMP_VAULT_0}"
# Windows PowerShell receives: Write-Output "$env:__SWAMP_VAULT_0"
# Both receive env __SWAMP_VAULT_0="pass;rm -rf /"
# Output: pass;rm -rf /  (literal, no injection)
globalArguments:
  run: "echo ${{ vault.get('my-vault', 'SECRET') }}"
```

This means:
- `;`, `|`, `&`, `(`, `)`, `<`, `>` in a secret do **not** split or redirect commands.
- `$VAR_NAME` and `$(cmd)` in a secret are **not** expanded or executed.
- `` `cmd` `` in a secret is **not** executed.
- `!` in a secret does **not** trigger bash history expansion.
- All current and future shell metacharacters are handled — no character blocklist.
- Non-shell contexts (extension models, API calls) receive exact raw secret values
  with no escaping artifacts.

## Environment Variables

All process environment variables are available in CEL expressions via the `env`
namespace as `env.VAR_NAME`.

### Basic Usage

```yaml
globalArguments:
  homeDir: ${{ env.HOME }}
  configValue: ${{ env.MY_CONFIG_VALUE }}
```

### Security Warning

> **Warning:** Values accessed via `env` are **not redacted or filtered**. If
> you use an environment variable as a model attribute, its value will be
> **stored on disk** in the datastore `data/` directory (default
> `.swamp/data/`) as part of the model output data and will be visible in the
> output of `swamp data get`. This includes any sensitive environment variables
> present at runtime (e.g. `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, database
> passwords).

### Use `vault.get()` for Sensitive Values

For API keys, tokens, passwords, and other secrets, always use
`vault.get()` instead of `env`. Vault values are fetched at runtime and are
**never persisted** in model output data.

**Wrong — secret will be stored in the datastore `data/` directory on disk:**

```yaml
globalArguments:
  apiKey: ${{ env.API_KEY }}
```

**Right — secret is fetched at runtime and never persisted:**

```yaml
globalArguments:
  apiKey: ${{ vault.get('my-vault', 'API_KEY') }}
```

See the [Sensitive Data](#sensitive-data) section for more on vault usage.

## Extensibility

Extension model methods extend CEL through `ctx.createCelEnvironment()` (surface
2 above), registering their own functions, types, and operators on an isolated
environment. There is no repo-level mechanism for registering custom CEL
functions into the internal evaluator.

## Runtime Guidance

When loading the YAML, swamp first parses the CEL expressions, then embeds the
values they emit into the data structure. Evaluated definitions are written to
the datastore at `definitions-evaluated/` (default
`.swamp/definitions-evaluated/`), whose structure mirrors the `models/`
directory; evaluated workflows go to `workflows-evaluated/` (default
`.swamp/workflows-evaluated/`) — see `SWAMP_SUBDIRS` in
`src/infrastructure/persistence/paths.ts`. Both live under `.swamp/`, which
`swamp repo init` adds to the managed `.gitignore` section
(`src/domain/repo/repo_service.ts`).

These evaluated directories are internal working directories in the datastore,
used by the expression evaluation system.
