---
name: swamp-troubleshooting
description: Debug and diagnose swamp issues using source code. Use when troubleshooting swamp bugs, unexpected behavior, or errors. Triggers on "debug swamp", "swamp bug", "swamp error", "unexpected behavior", "swamp issue", "troubleshoot swamp", "diagnose swamp", "swamp not working", "swamp broken", "fix swamp", "swamp problem", "swamp crash", "source code", "read swamp source".
---

# Swamp Troubleshooting Skill

Diagnose and troubleshoot swamp issues by fetching and reading the swamp source
code. All commands support `--json` for machine-readable output.

## Quick Reference

| Task                | Command                                      |
| ------------------- | -------------------------------------------- |
| Check source status | `swamp source path --json`                   |
| Fetch source        | `swamp source fetch --json`                  |
| Fetch specific ver  | `swamp source fetch --version v1.0.0 --json` |
| Fetch main branch   | `swamp source fetch --version main --json`   |
| Clean source        | `swamp source clean --json`                  |

## Troubleshooting Workflow

When a user reports a swamp issue:

### 1. Check Current Source Status

```bash
swamp source path --json
```

**Output shape (found):**

```json
{
  "status": "found",
  "version": "20260206.200442.0-sha.abc123",
  "path": "/Users/user/.swamp/source",
  "fileCount": 245,
  "fetchedAt": "2026-02-06T20:04:42.000Z"
}
```

**Output shape (not found):**

```json
{
  "status": "not_found"
}
```

### 2. Fetch Source If Needed

If source is missing or the version doesn't match the user's swamp version:

```bash
swamp source fetch --json
```

This fetches source for the current CLI version. To fetch a specific version:

```bash
swamp source fetch --version 20260206.200442.0-sha.abc123 --json
```

**Output shape:**

```json
{
  "status": "fetched",
  "version": "20260206.200442.0-sha.abc123",
  "path": "/Users/user/.swamp/source",
  "fileCount": 245,
  "fetchedAt": "2026-02-06T20:04:42.000Z",
  "previousVersion": "20260205.100000.0-sha.xyz789"
}
```

### 3. Read Source Files

Once source is fetched, read files from `~/.swamp/source/`:

**Key directories:**

- `src/cli/` - CLI commands and entry point
- `src/domain/` - Domain logic (models, workflows, vaults, etc.)
- `src/infrastructure/` - Infrastructure adapters (persistence, HTTP, etc.)
- `src/presentation/` - Output rendering

**Example: Read the CLI entry point**

```
Read ~/.swamp/source/src/cli/mod.ts
```

**Example: Read model service**

```
Read ~/.swamp/source/src/domain/models/model_service.ts
```

### 4. Diagnose the Issue

Based on the error message or symptoms:

1. **Command not working**: Check `src/cli/commands/{command}.ts`
2. **Model issues**: Check `src/domain/models/`
3. **Workflow issues**: Check `src/domain/workflows/`
4. **Vault/secret issues**: Check `src/domain/vaults/`
5. **Data persistence issues**: Check `src/infrastructure/persistence/`
6. **Output formatting issues**: Check `src/presentation/output/`

### 5. Explain and Suggest Fixes

After diagnosing:

1. Explain what the code is doing
2. Identify the root cause
3. Suggest a workaround if available
4. If it's a bug, summarize the issue and potential fix

## Source Directory Structure

```
~/.swamp/source/
├── src/
│   ├── cli/
│   │   ├── commands/        # CLI command implementations
│   │   ├── context.ts       # Command context and options
│   │   └── mod.ts           # CLI entry point
│   ├── domain/
│   │   ├── errors.ts        # User-facing errors
│   │   ├── models/          # Model types and services
│   │   ├── workflows/       # Workflow execution
│   │   ├── vaults/          # Secret management
│   │   ├── data/            # Data lifecycle
│   │   └── events/          # Domain events
│   ├── infrastructure/
│   │   ├── persistence/     # File-based storage
│   │   ├── logging/         # LogTape configuration
│   │   └── update/          # Self-update mechanism
│   └── presentation/
│       └── output/          # Terminal output rendering
├── integration/             # Integration tests
├── design/                  # Design documents
└── deno.json                # Deno configuration
```

## Clean Up Source

When done troubleshooting:

```bash
swamp source clean --json
```

**Output shape:**

```json
{
  "status": "cleaned",
  "path": "/Users/user/.swamp/source"
}
```

## Version Matching

- By default, `swamp source fetch` downloads source matching the current CLI
  version
- Use `--version main` to get the latest unreleased code
- Use `--version <tag>` to get a specific release

## When to Use Other Skills

| Need                    | Use Skill               |
| ----------------------- | ----------------------- |
| Run/create models       | `swamp-model`           |
| Run/create workflows    | `swamp-workflow`        |
| Manage secrets          | `swamp-vault`           |
| Manage repository       | `swamp-repo`            |
| Create extension models | `swamp-extension-model` |
