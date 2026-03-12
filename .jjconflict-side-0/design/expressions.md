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

Or the data output of the same model (using the preferred `data.latest()`
accessor):

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: baz
version: 1
tags: {}
attributes:
  message: ${{ data.latest('foo', 'result').attributes.message }}
```

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

## Data Versioning

`data.latest()` is the **canonical accessor** for model data. It reads directly
from disk on every call, so it always reflects the latest on-disk state with no
cache staleness. The `model.*.resource` and `model.*.file` patterns are
**deprecated** and will be removed in a future release.

Data is immutable and versioned. Use the following CEL functions to access data:

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

When vault secrets are injected into the `run` field of a `command/shell` model via CEL
string concatenation, shell metacharacters in the secret value are automatically escaped so
that the value is always treated as **literal data**, never as shell syntax.

Specifically, `$` and `` ` `` are escaped so that `$(cmd)` and `` `cmd` `` in a secret
value do not trigger command substitution:

```yaml
# Secret value: $(cat /etc/passwd)
# Shell receives: \$(cat /etc/passwd)  → outputs literally: $(cat /etc/passwd)
attributes:
  run: '"echo " + vault.get(''my-vault'', ''SECRET'') + '' done'''
```

This means:
- `$VAR_NAME` in a secret is **not** expanded as a shell variable — it appears literally.
- `$(cmd)` and `` `cmd` `` in a secret are **not** executed — they appear literally.
- Prices, connection strings, and other data containing `$` are safe to store and use.

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
