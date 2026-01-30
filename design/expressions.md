# Expressions

Inputs and Workflow are stored as YAML files, and they can contain Google CEL
expressions which get evaluated into the data structures they return and
injected into the final data structure after parsing. These expressions should
be able to reference models by name, then grab data from inputs or resources,
and manipulate it in place (such as string manipulation, concatenating array
members, etc).

## Model Data

You should be able to access models by name or id, and then input data or
resource data through dot notation.

## Examples

The results of the expression should be inserted into the resulting data
structure. Given an input like this:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
resourceId: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: foo
version: 1
tags: {}
attributes:
  message: "I like cheese"
```

Another can use a CEL expression to extract the message attribute:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
resourceId: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: bar
version: 1
tags: {}
attributes:
  message: ${{ model.foo.input.attributes.message }}
```

Or the resource output of the same model:

```yaml
id: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
resourceId: 0bc79a8f-d9d2-4ec5-a37f-8d88bbb3ee27
name: baz
version: 1
tags: {}
attributes:
  message: ${{ model.foo.resource.attributes.message }}
```

You can refer to your own model with `self`, for things like name, version,
tags, and a models other attributes.

You can also use the uuid of a model in order to reference it, rather than the
name.

## Environment Variables

You can access environment variables using the `env` namespace:

```yaml
attributes:
  region: ${{ env.AWS_REGION }}
  api_key: ${{ env.API_KEY }}
  path: /home/${{ env.USER }}/data
```

Environment variables are resolved at runtime from the process environment. This
allows configuration to be injected without hardcoding values in model inputs or
workflows.

Note: Accessing an undefined environment variable will result in a runtime error
during expression evaluation. Ensure required environment variables are set
before running workflows that depend on them.

You can combine environment variables with model references:

```yaml
attributes:
  bucket: ${{ env.ENV_PREFIX }}-${{ model.vpc.resource.attributes.id }}
```

For workflows, you should be able to reference other workflows by name or id, in
addition to any model.

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
directory in the repository called `/data/inputs-evaluated/` whose structure is
the same as `/data/inputs/`. This directory should be in a swamp repo's
.gitignore file.

The same is true for `/data/workflows-evaluated/`, and it should also be in
.gitignore.

These evaluated directories are internal working directories in the data layer,
used by the expression evaluation system. They are not exposed through logical
views.
