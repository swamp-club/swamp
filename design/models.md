# Models

A model in swamp is defined by a _type_. They are instantiated by creating a
_definition_, whose attributes can be set statically or dynamically through
_inputs_. An instantiated _model_ can be used through calling _methods_, which
_output_ their results and can store _data_ that is immutable, has a _lifetime_,
a _content type_, can be marked as _streamable_, can be _tagged_ with
capabilities, and stores the _definition_ that created it (so the model can be
instantiated from the data it produces). Data produced by a model can only be
written again by the an instantiated model with the same definition as the
original data.

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

Each instance of a model has a unique ID that is a uuidv4.

## Version

Each model has a version number, starting with 1. Models must support data
written by all earlier versions, but not later versions.

For example, a model '4' can read data from version 1-4, but not '5'.

## Migration

A model can migrate its definitions and data from one version to the next.

## Definitions

Definitions are specified as YAML files that live in the `/.swamp/definitions/`
directory of a repository, underneath the normalized type as a directory. The
file name is `${id}.yaml`. For example,
`.swamp/definitions/aws/ec2/vpc/fc7fd41e-ae16-4b31-b57a-86de716e3ece.yaml`.

The valid shape of a definition is specified with a Zod 4 schema as part of the
type.

Each definition has the following core properties:

- id: the models unique id
- name: a unique human readable name
- tags: string based key value pairs
- attributes: domain specific data for the input (for example, the specific
  properties of a VPC from above).

### Input

A definition file can also specify custom inputs as JsonSchema serialized to
yaml. By default, every definition has optional inputs that map to the full set
of defined attributes of the definition. If a type specifies that a particular
attribute is required, but it is not present in the static definition, then it
is a required input. If it is present in the definition, than it will be
optional (and can be over-ridden by an input.)

Custom input values can be accessed through CEL expressions.

## Instance

A model is instantiated by feeding its definition to the models constructor. The
models definition is hashed to provide an instantiation id. From the
instantiation id and a record of the definition, a model can always be
re-instantiated.

We call this an instance of a model.

## Methods

Methods can be called on instantiated models, taking the definition as an input.
They can extract data from the definition for use the in the method using a
MethodInput zod schmea to validate the shape.

Methods can write data, which is tracked by the method invocation and the
definiton requried to re-instantiate the object.

Each method invocation records its status in an output, which records any data
that was written in the invocation, status, and information about how it was
called.

Methods can also instantiate a model, from either an existing definition by name
or by supplying the definiton directly, then can invoke methods on those models.

## Data

Models can store data, identified by a unique name for a given instance of a
model. The raw data is written, alongside metadata needed to understand what is
within each data file.

A method should use an interface to write data, and specify the behavior and the
information itself. When a method writes some data, it will be tracked in the
output automatically.

Data is immutable. Each write to the same unique name creates a new version of
the data. The latest version can always be referred to as "latest". When used in
a CEL expression, "latest" is implied. Old versions can only be retrieved by a
CEL function. Versions will be auto-incrementing integers, starting at 1.

Data can only be written by a model instantiated from the same definiton that
originally wrote the data. This is called the _owner_ of the data.

Data has metadata, which consists of:

- A unique name for the data
- A unique id for the data
- The full definition of the model that wrote the data, so we can re-instantiate
  a model to operate on the data
- A content type
- A lifetime, which defines how long the data should persist. Lifetimes can be
  expressed as a duration string (1h, 5m, 10d, 1mo, 10y). A lifetime of
  "ephemeral" means the data will only be stored for the duration of a method
  invocation or workflow execution. A lifetime of "infinite" will store the data
  forever. There are two special lifetimes, which are:
  - Job: the data persists only while the job that create it exists/is running
  - Workflow: The data persists until the workflow that created it exists/is
    running
- A garbage collection setting, which defines how many versions should be
  stored. This has the same values as lifetime, but can also accept a raw
  integer that specifies a specific number.
- A streaming flag, which indicates the data is line-oriented and should provide
  a streaming event
- A set of tags, which are used to mark data for human indexing and retrieval
  later. A standardized 'type' is always present. For example, a 'log' would
  have type=log tag.

The raw data will be written to
`.swamp/data/{normalized-type}/{model id}/{data id}/{data version}/raw`.

The metadata will be written to
`.swamp/data/{normalized-type}/{model id}/{data id}/{data version}/metadata.yaml`.

There will be a symlink to the latest version as
`.swamp/data/{normalized-type}/{model id}/{data id}/latest/metadata.yaml`.

### Logs

Logs will have a tag of 'type=log' and be set to streaming, with a content type
of plain text.

### Files

Files will have a data tag of 'type=file'.

### Resources

Files that represent external resource data will be tagged with 'type=resource'.

## Output

Each method invocation produces an output record, which gets tracked in the
`/.swamp/outputs/` directory of a repository (which should not be tracked in
git). The output record should track the state of the method execution, and the
list of artifacts produced by the method. It should track state as the method
executes. It should be structured as
`/.swamp/outputs/{normalized-type}/{method}/{model-id}-{timestamp}.yaml`.

## Logical Views

The RepoIndexService maintains a model-centric logical view at `/models/` that
provides human/agent-friendly exploration of models by name.

### Model View Structure

```
/models/{model-name}/
  definition.yaml      → symlink to /.swamp/definitions/{type}/{id}.yaml
  {data tag key}/{data tag value/           → symlink to /.swamp/data for the data as tagged
  outputs/
    {method}/     → symlinks to /.swamp/outputs/{type}/{method}/{id}-*.yaml
```

This structure allows exploring all artifacts for a model in one place, using
the model's human-readable name rather than UUIDs or type-based paths.

### Domain Events

The ModelRepository emits domain events when model data changes:

- `ModelCreated` - Emitted when a new model definition is created via
  `model create`
- `ModelUpdated` - Emitted when a model definition or data is modified
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
