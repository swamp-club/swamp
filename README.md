<p align="center">
  <img src="logo.png" alt="swamp logo" width="200">
</p>

# swamp

Deno-based CLI for AI Native Automation.

## Installation

```bash
deno install -A --name swamp main.ts
```

## Usage

```bash
# Run the CLI
deno run dev

# Show version
swamp version
```

## Architecture Overview

Swamp uses a model-driven architecture with the following key concepts:

- **Models**: Define automation tasks with typed inputs and methods
- **Definitions**: YAML configurations that instantiate models
- **Workflows**: Orchestrate model executions with dependencies and triggers
- **Data**: Versioned, immutable artifacts produced by model methods
- **Vaults**: Secure storage for sensitive data (secrets, credentials)
- **Expressions**: CEL expressions for dynamic values and cross-model references

All data is stored in the `.swamp/` directory:

```
.swamp/
├── definitions/       # Model definitions by type
├── definitions-evaluated/  # Evaluated definitions (with expressions resolved)
├── workflows/         # Workflow definitions
├── workflows-evaluated/    # Evaluated workflows
├── workflow-runs/     # Execution history
├── data/              # Versioned data artifacts
├── outputs/           # Method execution outputs
├── vault/             # Vault configurations
├── secrets/           # Encrypted secrets (local vaults)
└── logs/              # Execution logs
```

Logical views (`/models/`, `/workflows/`, `/vaults/`) provide symlinks for
human-friendly exploration of the repository.

### Example: Echo Model Workflow

The `swamp/echo` model demonstrates the basic model lifecycle.

```bash
# 1. Initialize a swamp repository (if not already done)
swamp repo init

# 2. Create a new echo model definition
swamp model create swamp/echo my-echo

# 3. Edit the definition file to add the required 'message' attribute
#    The file is created at: .swamp/definitions/swamp/echo/<id>.yaml
#    Add under attributes:
#      message: "Hello, world!"

# 4. Validate the model definition
swamp model validate my-echo

# 5. Execute the write method to generate data
swamp model method run my-echo write

# 6. View the output
swamp model output search my-echo
```

Model definitions are stored in `.swamp/definitions/swamp/echo/` and data
artifacts are written to `.swamp/data/swamp/echo/`.

## Shell Completions

Generate shell completions for tab-completion of commands, model names, and
workflow names.

### Bash

Add to your `~/.bashrc`:

```bash
eval "$(swamp completions bash)"
```

### Zsh with oh-my-zsh

Save the completion script to oh-my-zsh's completions directory:

```bash
mkdir -p ~/.oh-my-zsh/completions
swamp completions zsh > ~/.oh-my-zsh/completions/_swamp
rm -f ~/.zcompdump* && exec zsh
```

### Zsh without oh-my-zsh

Add to your `~/.zshrc`:

```bash
eval "$(swamp completions zsh)"
```

### Fish

Save the completion script to fish's completions directory:

```bash
swamp completions fish > ~/.config/fish/completions/swamp.fish
```

### Note

Model and workflow name completions are directory-dependent. They return names
from the current working directory's swamp repository.

## User-Defined Models

You can extend swamp with custom TypeScript models. Place your models in the
`extensions/models/` directory (or configure via `SWAMP_MODELS_DIR` environment
variable or `.swamp.yaml`).

For detailed instructions on creating user-defined models, see the
[swamp-extension-model skill documentation](.claude/skills/swamp-extension-model/SKILL.md).

## Development

```bash
# Run tests
deno run test

# Type check
deno check

# Lint
deno lint

# Format
deno fmt
```

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE),
[COPYRIGHT](COPYRIGHT), [CONTRIBUTORS.md](CONTRIBUTORS.md), and [NOTICE](NOTICE)
for details.
