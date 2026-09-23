---
audience: maintainer
last-verified: 2026-08-28 @ 3d5955a9
---

# AI Agent

The main way to work with swamp is through an AI agent. Each repository has
skills for working with swamp: using the CLI, writing files, and so on.

## Repository Exploration

Agents can explore a swamp repository at these layers:

### Source-of-Truth Directories

Top-level directories hold the source-of-truth files, tracked in git:

- **`models/`**: model definitions, grouped by normalized type
- **`workflows/`**: workflow definitions
- **`vaults/`**: vault configurations

These are the main places to explore to understand the repository.

### Runtime Data (Datastore)

Runtime data (versioned model data, workflow runs, method outputs) lives in the
datastore. The default datastore uses `.swamp/`; it can also use an external
path or S3. See [datastores](../enablers/datastores.md).

### CLI Abstraction

The CLI commands (`swamp model`, `swamp workflow`, etc.) hide the storage layer.
Agents should prefer CLI commands for operations and read the top-level
directories for context.
