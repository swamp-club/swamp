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

Data is immutable and versioned. To access older versions, use CEL functions
(see [./models.md] for detailed versioning information).

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

## Workflow dependency and lazy evaluation

When a model is referenced in a workflow step, any CEL expressions that
reference other models should create an implicit dependency on the evaluation of
that workflow. This ensures that data in a resource, for example, will be
available when the later data is evaluatedd.

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
