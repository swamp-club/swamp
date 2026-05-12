# Expressions

Model definitions and Workflows are stored as YAML files, and they can contain
Google CEL expressions which get evaluated into the data structures they return
and injected into the final data structure after parsing. These expressions
should be able to reference models by name, then grab data from definitions or
data, and manipulate it in place (such as string manipulation, concatenating
array members, etc).

## Model Data

You should be able to access models by name or id, and then definition
attributes or data through dot notation.

## Examples

The results of the expression should be inserted into the resulting data
structure. Given a definition like this:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: foo
version: 1
tags: {}
attributes:
  message: "I like cheese"
```

Another can use a CEL expression to extract the message attribute:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: bar
version: 1
tags: {}
attributes:
  message: ${{ model.foo.definition.attributes.message }}
```

Or the data output of the same model:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: baz
version: 1
tags: {}
attributes:
  message: ${{ data.latest('foo', 'result').attributes.message }}
```

`data.latest()` is a shortcut for the equivalent `data.query()` call. The
general primitive is `data.query('<CEL predicate>')`, which takes any
predicate over the full set of queryable fields. Reach for it when a
shortcut doesn't express what you need — for example, a multi-field
predicate, a projection, tag filters beyond a single key, or history access
beyond a single version. See [data-query.md](./data-query.md) for the
primitive, the full field set, and the shortcut mapping table.

You can refer to your own model with `self`, for things like name, version,
tags, and a model's other attributes.

You can also use the uuid of a model in order to reference it, rather than the
name.

For workflows, you should be able to reference other workflows by name or id, in
addition to any model.

## Input Access

Both model definitions and workflow definitions can specify inputs
(variables/parameters) as JsonSchema. These inputs can be accessed through CEL
expressions:

**Model Inputs:** Within a model definition, access inputs with:

```yaml
attributes:
  message: ${{ inputs.someParameter }}
```

**Workflow Inputs:** Within a workflow definition, access workflow inputs with:

```yaml
attributes:
  message: ${{ inputs.someWorkflowParameter }}
```

**Cross-Reference:** Reference inputs from other models/workflows:

```yaml
attributes:
  message: ${{ model.foo.inputs.someParameter }}
  workflowParam: ${{ workflow.bar.inputs.someWorkflowParameter }}
```

Inputs can be required or optional (specified in JsonSchema), and provide
dynamic configuration without modifying definition files.

## Workflow Run Context

Inside workflow step inputs, the `run` namespace exposes metadata about the
current workflow execution. This is only available at step execution time (not
in workflow-level fields like `description`).

| Field              | Type                    | Description                    |
| ------------------ | ----------------------- | ------------------------------ |
| `run.id`           | string (UUID)           | Unique ID of this workflow run |
| `run.workflowId`   | string (UUID)           | Workflow definition ID         |
| `run.workflowName` | string                  | Workflow name                  |
| `run.startedAt`    | string (ISO 8601)       | Timestamp when the run started |
| `run.tags`         | `Record<string,string>` | Merged workflow + runtime tags |

The flat `workflowRunId` variable is also available (equivalent to `run.id`)
for backward compatibility with `data.query()` predicates.

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
attributes:
  result: ${{ data.latest('my-model', 'output').attributes.value }}
```

### data.version(modelName, dataName, version)

Returns a specific version of a data artifact:

```yaml
attributes:
  # Get version 1 specifically
  oldResult: ${{ data.version('my-model', 'output', 1).attributes.value }}
  # Get version 3
  result: ${{ data.version('my-model', 'output', 3).attributes.value }}
```

### data.listVersions(modelName, dataName)

Returns an array of available version numbers for a data artifact, sorted in
descending order (newest first):

```yaml
attributes:
  # Get all available versions
  versions: ${{ data.listVersions('my-model', 'output') }}
  # Use with size() to count versions
  versionCount: ${{ size(data.listVersions('my-model', 'output')) }}
```

### Vary Dimensions

When data is stored with `vary` dimensions (see [Workflows](./workflow.md)),
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

### Combined Example

```yaml
attributes:
  # Get latest result
  current: ${{ data.latest('processor', 'result').attributes.value }}
  # Get the first result ever produced
  original: ${{ data.version('processor', 'result', 1).attributes.value }}
  # Check how many versions exist
  historySize: ${{ size(data.listVersions('processor', 'result')) }}
```

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

`self.*` expressions also resolve in `modelIdOrName` and `methodName`, enabling
forEach steps to target different model instances per iteration:

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

Results are **not** run-scoped — `findBySpec` returns every matching record
in the catalog. Add a `workflowRunId` predicate via `data.query()` when you
want to scope to the current run.

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

## Sensitive Data

You should be able to access sensitive data by referencing the storage keys they
were stored with, under a subkey of the vault where they reside.

## Examples

Setting keyData out of the configured aws vault from the machineKeyData key
value

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
resourceId: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: baz
version: 1
tags: {}
attributes:
  keyData: ${{ vault.get(aws, machineKeyData) }}
```

### Shell Safety

When vault secrets are used in the `run` field of a `command/shell` model, the
shell model passes secret values via **environment variables** instead of
embedding them in the command string. This prevents all shell metacharacter
injection — the shell never parses secret content as syntax.

Internally, vault secrets are replaced with unique sentinel tokens during CEL
evaluation. At the shell model boundary, sentinels are replaced with
double-quoted environment variable references (`"${__SWAMP_VAULT_N}"`), and the
raw secret values are passed through the process environment. Shell variable
expansion happens after command parsing, so metacharacters in the secret value
are always treated as literal data.

```yaml
# Secret value: pass;rm -rf /
# Shell receives: echo "${__SWAMP_VAULT_0}"  (with env __SWAMP_VAULT_0="pass;rm -rf /")
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
attributes:
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
attributes:
  apiKey: ${{ env.API_KEY }}
```

**Right — secret is fetched at runtime and never persisted:**

```yaml
attributes:
  apiKey: ${{ vault.get('my-vault', 'API_KEY') }}
```

See the [Sensitive Data](#sensitive-data) section for more on vault usage.

## Extensibility

Users should be able to extend the functions available to the CEL expressions by
registering custom types, functions, etc in their swamp repo.

## Runtime Guidance

When loading the YAML, first parse the CEL expressions. Then take the data
structures they emit and embed them in the data structure. Write those to the
datastore at `definitions-evaluated/` (default `.swamp/definitions-evaluated/`),
whose structure mirrors the `models/` directory. This directory should be in a
swamp repo's .gitignore file.

The same is true for `workflows-evaluated/` (default
`.swamp/workflows-evaluated/`), and it should also be in .gitignore.

These evaluated directories are internal working directories in the datastore,
used by the expression evaluation system.
