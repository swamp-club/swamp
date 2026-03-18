# Swamp

## Purpose

Swamp is an AI Native Automation tool. It has 1:1 models of external APIs or CLI
tools (for example, AWS or Azure cloud resources, or the GitHub CLI), which it
can then validate are correct. Each model has a Type, which specifies metadata,
attributes, methods, and inputs (variables/parameters as JsonSchema). Model
definitions contain attributes and can be configured using inputs (variables).
Methods take the definition and produce data (with data tags like "resource",
"log", or "file"). Model definitions are stored as YAML files in the top-level
`models/` directory, while runtime data is stored in the datastore (default
`.swamp/`). Definitions support a CEL expression language for dynamic
configuration.

Swamp also has workflows, which allow for executing workflow steps in parallel
groups. A workflow step can be a method on a model, or an external script.
Workflows can also define inputs (workflow inputs) for parameterization.

Swamp allows for organizing model definitions and data into applications and
environments, which can be used to compare data and definitions to detect
configuration drift.

All this is stored in a 'swamp repo', which is a git repository.

## Storage Architecture

A swamp repo separates source-of-truth files from runtime data:

### Source-of-Truth Files (Top-Level Directories)

Model definitions, workflow definitions, and vault configurations are stored in
top-level directories that are tracked in git:

- **`models/`** — Model definitions organized by normalized type:
  `models/{type}/{id}.yaml`
- **`workflows/`** — Workflow definitions: `workflows/workflow-{id}.yaml`
- **`vaults/`** — Vault configurations: `vaults/{vault-type}/{id}.yaml`

These directories are the primary way to explore and understand the repository.

### Runtime Data (Datastore)

Runtime data (versioned model data, workflow runs, method outputs, secrets,
telemetry) is managed through a datastore abstraction. The default datastore
uses the `.swamp/` directory, but it can be configured to use an external
filesystem path or S3. See [./datastores.md] for details.

See [./repo.md] for detailed architecture documentation.

## Models

See [./models.md].
