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
  message: ${{ model.foo.data.attributes.message }}
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

When accessing model data, the "latest" version is implied by default:

```yaml
message: ${{ model.foo.data.attributes.message }} # accesses latest version
```

Data is immutable and versioned. To access specific versions or list available
versions, use the following CEL functions:

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
> **stored on disk** in `.swamp/data/` as part of the model output data and
> will be visible in the output of `swamp data get`. This includes any
> sensitive environment variables present at runtime (e.g.
> `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, database passwords).

### Use `vault.get()` for Sensitive Values

For API keys, tokens, passwords, and other secrets, always use
`vault.get()` instead of `env`. Vault values are fetched at runtime and are
**never persisted** in model output data.

**Wrong — secret will be stored in `.swamp/data/` on disk:**

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
structures they emit and embed them in the data structure. Write those to a
directory in the repository called `/.swamp/definitions-evaluated/` whose
structure is the same as `/.swamp/definitions/`. This directory should be in a
swamp repo's .gitignore file.

The same is true for `/.swamp/workflows-evaluated/`, and it should also be in
.gitignore.

These evaluated directories are internal working directories in the data layer,
used by the expression evaluation system. They are not exposed through logical
views.
