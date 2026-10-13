# Behavior Type Resolution

How to find the right behavior type based on the user's goal. Follow the
resolution steps in order — installed types, then official `@swamp/*`
extensions, then the rest of the registry — and stop as soon as a match is
found.

## Step 1: Search Installed Types

```bash
swamp behavior type search <keywords from user goal> --json
```

If a matching type is found, use it. Run
`swamp behavior type describe <type> --json` to understand required arguments.

## Step 2: Search Extensions

If no installed type matches:

```bash
swamp extension search <keywords> --json
```

Prefer official `@swamp/*` results; fall back to other collectives only if none
fit. Run `swamp extension info <package> --json` for details on a candidate.
Present the results and let the user pick one:

```bash
swamp extension pull @collective/extension-name
swamp behavior type search <extension-keywords> --json
```

After pulling, use `swamp behavior type describe <type> --json` to inspect the
schema and available methods.

## Step 3: Build a Custom Extension

If nothing matches locally or in the registry, offer to build a custom extension
using the `swamp` skill (extension guide). This creates a typed behavior with
proper Zod schemas for the service the user wants to automate.

Only use `command/shell` if the user's goal is genuinely a one-off ad-hoc
command (e.g., "check my disk space right now") — never for wrapping CLI tools
or building integrations. This aligns with the CLAUDE.md rule: _"The
`command/shell` behavior is ONLY for ad-hoc one-off shell commands, NEVER for
wrapping CLI tools or building integrations."_

## Credential Setup

If the chosen behavior type requires credentials (cloud services, APIs, etc.),
store them in a vault before configuring the behavior. `swamp repo init` already
created a `local_encryption` vault named `default`; confirm it with
`swamp vault search --json`. Use the `swamp` skill (vault guide):

1. Store credentials: `swamp vault put default API_KEY` (prompts securely)
2. Reference in the definition YAML: `${{ vault.get("default", "API_KEY") }}`

If `default` is missing (the repo was created with `--no-vault`), create one
first: `swamp vault create local_encryption default --json`.

## Method Selection

For a first run, prefer read-only methods that don't create or modify resources:

- `execute` — for shell behaviors
- `get`, `list`, or `describe` — for typed behaviors (reads existing resources)

Avoid `sync` for the first run — on a new behavior it fails with "No existing
state found". Avoid `create`, `update`, or `delete` too.

## CEL Reference Path

After a successful run, show the user how to reference the output. CEL
expressions wire data from one behavior into another — anywhere a definition
YAML accepts a value, you can interpolate from prior runs:

```
${{ data.latest("<name>", "<dataName>").attributes.<field> }}
```

Use `data.latest(...)` over the deprecated
`model.<name>.resource.<spec>.<instance>.attributes.<field>` form.

## On Failure Recovery

Per-state recovery actions when a Verify step fails. After fixing, re-run the
state's action and re-verify before advancing.

### State 2 (behavior_created) — validation failed

Read the validation errors. Common fixes:

- Missing required arguments → edit the definition YAML to add them
- Invalid argument values → check the type schema with
  `swamp behavior type describe <type> --json`
- File not found → verify path from `swamp behavior get <name> --json`

For detailed guidance, see the `swamp` skill (behavior guide).

### State 3 (method_run) — method failed

- **Command failed**: Read the error output and suggest specific fixes
- **Missing secrets**: Guide toward vault setup (use the `swamp` skill)
- **Permission denied**: Check the command exists and is executable
- **Timeout**: Suggest a simpler command for the first run

### State 4 (output_inspected) — no output

Check the method run logs for failed runs and report the error:

```bash
swamp behavior output search <name> --json
```

## Delegation Map

When the user picks a next step (or asks something outside the walkthrough
scope), delegate to the appropriate skill with context about what they built.
Always pass along the user's original goal and what they built so the next skill
doesn't start from zero.

| User intent                                | Delegate to                 |
| ------------------------------------------ | --------------------------- |
| Another behavior or edit the one they made | `swamp` (behavior guide)    |
| Chain behaviors together                   | `swamp` (workflow guide)    |
| Secure credentials                         | `swamp` (vault guide)       |
| Inspect or query their data                | `swamp` (data guide)        |
| Build a typed behavior from scratch        | `swamp` (extension guide)   |
| Share their work                           | `swamp` (extension-publish) |
| Which primitive to use, design trade-off   | `swamp` (architecture)      |
| Something is broken                        | `swamp` (troubleshooting)   |
