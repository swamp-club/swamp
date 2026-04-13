# Model Type Resolution

How to find the right model type based on the user's goal. Follow the resolution
steps in order — stop as soon as a match is found.

## Step 1: Search Local Types

```bash
swamp model type search <keywords from user goal> --json
```

If a matching type is found, use it. Run
`swamp model type describe <type> --json` to understand required arguments.

## Step 2: Search Extensions

If no local type matches:

```bash
swamp extension search <keywords> --json
```

The search results include name, description, and content types. There is no
`extension info` command — the search output is the only way to evaluate
extensions before pulling. Present the results and let the user pick one:

```bash
swamp extension pull @collective/extension-name
swamp model type search <extension-keywords> --json
```

After pulling, use `swamp model type describe <type> --json` to inspect the
schema and available methods.

## Step 3: Build a Custom Extension

If nothing matches locally or in the registry, offer to build a custom extension
model using the `swamp-extension-model` skill. This creates a typed model with
proper Zod schemas for the service the user wants to automate.

Only use `command/shell` if the user's goal is genuinely a one-off ad-hoc
command (e.g., "check my disk space right now") — never for wrapping CLI tools
or building integrations. This aligns with the CLAUDE.md rule: _"The
`command/shell` model is ONLY for ad-hoc one-off shell commands, NEVER for
wrapping CLI tools or building integrations."_

## Credential Setup

If the chosen model type requires credentials (cloud services, APIs, etc.), set
up a vault before configuring the model. Use the `swamp-vault` skill:

1. Create a vault: `swamp vault create local_encryption my-secrets --json`
2. Store credentials: `swamp vault put my-secrets KEY=VALUE --json`
3. Reference in model YAML: `${{ vault.get("my-secrets", "KEY") }}`

## Method Selection

For a first run, prefer read-only methods that don't create or modify resources:

- `execute` — for shell models
- `sync` or `get` — for typed models (discovers/reads existing resources)

Avoid `create`, `update`, or `delete` for the first run.

## CEL Reference Path

After a successful run, show the user how to reference the output:

```
${{ data.latest("<name>", "<dataName>").attributes.<field> }}
```
