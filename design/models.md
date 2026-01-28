# Models

A model in swamp specifies _inputs_, that are passed to _methods_, that produce
_outputs_, which may be _model inputs_ or _resources_.

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

A model can migrate its inputs and resources from one version to the next.

## Inputs

Inputs are specified as YAML files that live in the /inputs directory of a
repository, underneath the normalized type as a directory. The file name is
'${id}.yaml'. For example,
'aws/ec2/vpc/input-fc7fd41e-ae16-4b31-b57a-86de716e3ece.yaml'.

The valid shape of an input is specified with a Zod 4 schema.

Each input has the following core properties:

- id: the models unqiue id
- resourceId: an optional resource id, if one exists
- name: a unique human readable name
- tags: string based key value pairs
- attributes: domain specific data for the input (for example, the model of a
  VPC from above).

## Methods

Are named functions that take the model as an input, and produce other model
inputs or resources as outputs.

The method should use a MethodInput zod schema to validate that any specific
inputs it needs are present in the input model.

## Resources

Resources are specified as YAML files that live in the /resources directory of a
repository, underneath the normalized type as a directory. The file name is
'${id}.yaml'. For example,
'aws/ec2/vpc/resource-fc7fd41e-ae16-4b31-b57a-86de716e3ece.yaml'.

The valid shape of a resource is specified with a Zod 4 schema.

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

Creates a new instance of a type with the given unqiue name. Type should accept
either the domain specific type or the normalized type. It should return the id
and path to the model that is created.

### model get <model_id_or_name>

Shows the models input, schema, resource, methods, etc.

### model validate <model_id_or_name>

Runs the models zod validations for the models inputs and resources. Run them in
parallel and print the output as it comes.

### model method run <model_id_or_name> <method_name>

Runs a method for the given model.
