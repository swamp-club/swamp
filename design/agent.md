# AI Agent

The primary method for working with swamp is through an AI agent. Each
repository will have skills dedicated to working with swamp, through the CLI,
writing files, etc.

## Repository Exploration

Agents can explore a swamp repository through the following layers:

### Source-of-Truth Directories

The top-level directories contain source-of-truth files tracked in git:

- **`models/`** — Model definitions organized by normalized type
- **`workflows/`** — Workflow definitions
- **`vaults/`** — Vault configurations

These are the primary directories for exploring and understanding the repository
structure.

### Runtime Data (Datastore)

Runtime data (versioned model data, workflow runs, method outputs) is stored in
the datastore. The default datastore uses `.swamp/`, but it can be configured to
use an external path or S3. See [./datastores.md] for details.

### CLI Abstraction

The CLI commands (`swamp model`, `swamp workflow`, etc.) abstract away the
storage layer entirely. Agents should prefer using CLI commands for operations,
and use the top-level directories for exploration and understanding context.
