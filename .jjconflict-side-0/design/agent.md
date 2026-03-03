# AI Agent

The primary method for working with swamp is through an AI agent. Each
repository will have skills dedicated to working with swamp, through the CLI,
writing files, etc.

## Repository Exploration

Agents can explore a swamp repository through two layers:

### Logical Views (Recommended)

The logical views provide human/agent-friendly exploration:

- **`/models/{name}/`** - Model-centric view with definitions, data (resources,
  logs, files), and outputs organized by model name
- **`/workflows/{name}/`** - Workflow-centric view with definitions and run
  history organized by workflow name

These views use symlinks to reference data in the internal data directory. They
are the recommended way to explore and understand the repository structure.

### Internal Storage Directory (Direct Access)

The `/.swamp/` directory contains the internal storage format. Agents can access
it directly when needed, but the layout reflects swamp's internal architecture
rather than user-facing concerns.

### CLI Abstraction

The CLI commands (`swamp model`, `swamp workflow`, etc.) abstract away the
storage layer entirely. Agents should prefer using CLI commands for operations,
and use the logical views for exploration and understanding context.
