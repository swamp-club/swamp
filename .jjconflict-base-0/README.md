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

### Example: Echo Model Workflow

The `swamp/echo` model demonstrates the basic model lifecycle.

```bash
# 1. Create a new echo model input
swamp model create swamp/echo my-echo

# 2. Edit the input file to add the required 'message' attribute
#    The file is created at: inputs/swamp/echo/<id>.yaml
#    Add under attributes:
#      message: "Hello, world!"

# 3. Validate the model input
swamp model validate my-echo

# 4. Execute the write method to generate a resource
swamp model method run my-echo write
```

Model inputs are stored in `inputs/swamp/echo/` and resources are written to
`resources/swamp/echo/`.

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

MIT
