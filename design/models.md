# Models

A model in swamp specifies an _input_, that is passed to many possible
_methods_, that produce an _output_, which tracks the status of the method as it
executes, and any artifacts the method has produced (such as _logs_, _files_, a
_resource_, or ephemeral _data_. A method may produce many logs or files, but
only a single resource or data artifact.

## Type

All models in swamp are of a unique _type_. Types are defined by the thing that
they model - for example, a swamp model to manage AWS VPCs using the Cloud
Control API would be named 'AWS::EC2::VPC', because that is what the cloud
control api calls it. They should map semantically to the domain.

They _must_ include a domain identifier at the start of the type. For example:

AWS: AWS::EC2::VPC, AWS::Budget::Budgets Docker CLI: docker run, docker pull
Azure: Microsoft.Resources/resourceGroup

Each type also has a normalized representation, where special characters are
mapped into directory structures like 'aws/ec2/vpc' or 'docker/run' or
'microsoft/resources/resourceGroup'.

## ID

Each instance of a model has a unique ID that is a uuidv4. That id is used for
each instance input and resource.

## Version

Each model has a version number, starting with 1. Models must support data
written by all earlier versions, but not later versions.

For example, a model '4' can read data from version 1-4, but not '5'.

## Migration

A model can migrate its inputs and resources from one version to the next.

## Inputs

Inputs are specified as YAML files that live in the `/.data/inputs/` directory
of a repository, underneath the normalized type as a directory. The file name is
`${id}.yaml`. For example,
`.data/inputs/aws/ec2/vpc/fc7fd41e-ae16-4b31-b57a-86de716e3ece.yaml`.

The valid shape of an input is specified with a Zod 4 schema.

Each input has the following core properties:

- id: the models unique id
- resourceId: an optional resource id, if one exists
- name: a unique human readable name
- tags: string based key value pairs
- attributes: domain specific data for the input (for example, the model of a
  VPC from above).

## Methods

Are named functions that take the model as an input, and produce artifacts as
outputs.

The method should use a MethodInput zod schema to validate that any specific
inputs it needs are present in the input model.

The function body can create Artifacts, which will then be tracked, so when the
function finishes we have a complete record of them.

## Artifacts

Artifacts are information that is produced and stored by a method execution.
They are created inline as the method executes, and tracked with some context
that allows the output of the method to track every artifact created by the
method.

### Logs

A method may produce 0..* log artifacts. They have a name, can have lines
streamed to them, and by default are stored in `/.data/logs/` in the repository
underneath the normalized model type as a directory. Logs are named like
`{model-id}-{method name}-{log name}-{timestamp}.log`.

They are unstructured, line oriented data.

For example, a method might stream the logs for a remote kubernetes job to a log
artifact named 'k8slog'.

The stream of log output should have an event emitter attached to it, so we can
stream logs in real time.

By default, the `/.data/logs/` directory is not stored in git.

### Files

A method may store 0..* file artifacts. They have a name, and can be written to
directly. By default they will be stored in the `/.data/files/` directory of the
repository underneath the normalized model type as a directory plus the model ID
and method name. For example
`.data/files/aws/s3/bucket/{model-id}/{method-name}/{filename}`.

By default, the `/.data/files/` directory is not stored in git.

## Resource

Resource artifacts are used to track data about an external resource that should
be persisted over time (for example, the data about an AWS cloud resource).

A method may produce 0..1 resource as specified as YAML files that live in the
`/.data/resources/` directory of a repository, underneath the normalized type as
a directory. The file name is `${id}.yaml`. For example,
`.data/resources/aws/ec2/vpc/fc7fd41e-ae16-4b31-b57a-86de716e3ece.yaml`.

The valid shape of a resource is specified with a Zod 4 schema.

Resources are tracked in git.

## Data

Data artifacts are pure data objects that are not persisted over time in git.

A method may produce 0..1 data artifacts, stored as YAML files in the
`/.data/data/` directory of a repository, underneath the normalized type as a
directory. The file name is `${id}.yaml`.

The valid shape of data is specified with a Zod 4 schema.

Data is not tracked in git.

### When to Use Resource vs Data

Use **resource artifacts** when:

- The data represents state that should persist across executions (e.g., cloud
  resource metadata, deployment status)
- You need to track changes over time via git history
- The data is needed for drift detection or reconciliation
- Other team members need visibility into the current state

Use **data artifacts** when:

- The data is ephemeral or only relevant to a single execution (e.g., API
  responses, query results)
- The output changes frequently and git history would add noise
- The data is large or contains sensitive information that shouldn't be
  committed
- You're capturing intermediate results that don't represent durable state

## Output

Each method invocation produces an output record, which gets tracked in the
`/.data/outputs/` directory of a repository (which should not be tracked in
git). The output record should track the state of the method execution, and the
list of artifacts produced by the method. It should track state as the method
executes. It should be structured as
`/.data/outputs/{normalized-type}/{method}/{model-id}-{timestamp}.yaml`.

## Logical Views

The RepoIndexService maintains a model-centric logical view at `/models/` that
provides human/agent-friendly exploration of models by name.

### Model View Structure

```
/models/{model-name}/
  input.yaml      → symlink to /.data/inputs/{type}/{id}.yaml
  resource.yaml   → symlink to /.data/resources/{type}/{id}.yaml
  data.yaml       → symlink to /.data/data/{type}/{id}.yaml
  logs/           → symlink to /.data/logs/{type}/{id}/
  files/          → symlink to /.data/files/{type}/{id}/
  outputs/
    {method}/     → symlinks to /.data/outputs/{type}/{method}/{id}-*.yaml
```

This structure allows exploring all artifacts for a model in one place, using
the model's human-readable name rather than UUIDs or type-based paths.

### Domain Events

The ModelRepository emits domain events when model data changes:

- `ModelCreated` - Emitted when a new model input is created via `model create`
- `ModelUpdated` - Emitted when a model input or resource is modified
- `ModelDeleted` - Emitted when a model is deleted

The RepoIndexService subscribes to these events and updates the logical views
accordingly, ensuring the `/models/` view stays synchronized with the data
directory.

## CLI Commands

### type describe <type>

This command describes the model as a markdown document, will all of its
details, using code blocks as neccessary. it should syntax highlight the
markdown.

when specifying json, it should have the same content.

### type search <string>

When run interactively, it should show a text box that says "type to search",
and then use the npm:fzf package to search the list of available types (by
either normalized type or actual type name). Then the user can use the arrow
keys to select the type they want, and the result will be the same as type
describe.

When run non-interactively, it should produce a json output that has the list.

### model create <type> <name>

Creates a new instance of a type with the given unique name. Type should accept
either the domain specific type or the normalized type. It should return the id
and path to the model that is created.

### model search <string>

When run interactively, it should show a text box that says "type to search",
and then use the npm:fzf package to search the list of available models (by
either normalized type or actual type name). Then the user can use the arrow
keys to select the type they want, and the result will be the same as type
describe.

When run non-interactively, it should produce a json output that has the list.

### model get <model_id_or_name>

Shows the entire details of the model. It should not include the type schema or
the methods.

when specifying json, it should have the same content.

### model validate <model_id_or_name>

Runs the models zod validations for the models inputs and resources. Run them in
parallel and print the output as it comes.

### model edit [model_id_or_name]

Opens the model input file in the user's preferred editor. Use `--resource` to
edit the resource file instead.

If no model is specified interactively, shows a search interface.

Editor selection: Uses $EDITOR if set, otherwise falls back to: vscode, zed,
nvim, vim, nano, emacs.

### model method run <model_id_or_name> <method_name>

Runs a method for the given model.
