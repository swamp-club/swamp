# Swamp

## Purpose

Swamp is an AI Native Automation tool. It has 1:1 models of external APIs or CLI
tools (for example, AWS or Azure cloud resources, or the GitHub CLI), which it
can then validate are correct. Each model has a Type, which specifies some
metadata about the model, input data that is specified, methods that take the
input data and produce outputs of either more model inputs or resources (which
are specified by each model as well.) Model inputs and resources are stored as
separate YAML files in a 'inputs' or 'resources' directory. Model inputs have a
simple expression language (like github actions) for inserting data.

Swamp also has workflows, which allow for executing workflow steps in parallel
groups. A workflow step can be a method on a model, or an external script.

Swamp allows for organizing model inputs and resources into applications and
environments, which can be used to compare resources and inputs to detect
configuration drift.

All this is stored in a 'swamp repo', which is a git repository.

## Models

See [./models.md].
