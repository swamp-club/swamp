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
model using the `swamp-extension` skill. This creates a typed model with proper
Zod schemas for the service the user wants to automate.

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

After a successful run, show the user how to reference the output. CEL
expressions wire data from one model into another — anywhere a model YAML
accepts a value, you can interpolate from prior runs:

```
${{ data.latest("<name>", "<dataName>").attributes.<field> }}
```

Use `data.latest(...)` over the deprecated
`model.<name>.resource.<spec>.<instance>.attributes.<field>` form.

## On Failure Recovery

Per-state recovery actions when a Verify step fails. After fixing, re-run the
state's action and re-verify before advancing.

### State 2 (model_created) — validation failed

Read the validation errors. Common fixes:

- Missing required arguments → edit the model YAML to add them
- Invalid argument values → check the type schema with
  `swamp model type describe <type> --json`
- File not found → verify path from `swamp model get <name> --json`

For detailed model guidance, see the `swamp-model` skill.

### State 3 (method_run) — method failed

- **Command failed**: Read the error output and suggest specific fixes
- **Missing secrets**: Guide toward vault setup (delegate to `swamp-vault`)
- **Permission denied**: Check the command exists and is executable
- **Timeout**: Suggest a simpler command for the first run

### State 4 (output_inspected) — no output

Check the method run logs for failed runs and report the error:

```bash
swamp model output search <name> --json
```

## Delegation Map

When the user picks a next step (or asks something outside the walkthrough
scope), delegate to the appropriate skill with context about what they built.
Always pass along the user's original goal and what they built so the next skill
doesn't start from zero.

| User intent                             | Delegate to               |
| --------------------------------------- | ------------------------- |
| Another model or edit the one they made | `swamp-model`             |
| Chain models together                   | `swamp-workflow`          |
| Secure credentials                      | `swamp-vault`             |
| Inspect or query their data             | `swamp-data`              |
| Build a typed model from scratch        | `swamp-extension`         |
| Share their work                        | `swamp-extension-publish` |
| Something is broken                     | `swamp-troubleshooting`   |
