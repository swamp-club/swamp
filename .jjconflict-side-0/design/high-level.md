# Swamp

## Purpose

Swamp is an AI Native Automation tool. It has 1:1 models of external APIs or CLI
tools (for example, AWS or Azure cloud resources, or the GitHub CLI), which it
can then validate are correct. Each model has a Type, which specifies metadata,
attributes, methods, and inputs (variables/parameters as JsonSchema). Model
definitions contain attributes and can be configured using inputs (variables).
Methods take the definition and produce data (with data tags like "resource",
"log", or "file"). Model definitions and data are stored as YAML files in the
`.swamp/` directory. Definitions support a CEL expression language for dynamic
configuration.

Swamp also has workflows, which allow for executing workflow steps in parallel
groups. A workflow step can be a method on a model, or an external script.
Workflows can also define inputs (workflow inputs) for parameterization.

Swamp allows for organizing model definitions and data into applications and
environments, which can be used to compare data and definitions to detect
configuration drift.

All this is stored in a 'swamp repo', which is a git repository.

## Storage Architecture

A swamp repo uses a dual-layer storage architecture:

### Internal Storage Directory (`.swamp/`)

The `.swamp/` directory is the internal storage format optimized for swamp's
software architecture. Aggregate repositories (ModelRepository,
WorkflowRepository, WorkflowRunRepository) persist domain objects here.

Both agents and humans can explore the `.swamp/` directory directly, but its
layout reflects swamp's internal domain model rather than user-facing concerns.

### Logical Views

Logical views are symlinked directories that provide human/agent-friendly
perspectives into the `.swamp/` directory. They are automatically maintained by
the RepoIndexService whenever aggregate repositories mutate data.

**Model View (`/models/`):** Explore models by name, with easy access to
definitions, data (resources, logs, files), and outputs for each model.

**Workflow View (`/workflows/`):** Explore workflows by name, with access to
workflow definitions and run history.

These views allow exploration of the same underlying data from different
perspectives. For example, a method output can be viewed from the model's
perspective (`/models/{name}/outputs/`) or from the workflow run that triggered
it (`/workflows/{name}/runs/{run}/steps/{step}/`).

See [./repo.md] for detailed architecture documentation.

## Models

See [./models.md].
