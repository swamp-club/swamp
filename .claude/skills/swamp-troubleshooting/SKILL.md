---
name: swamp-troubleshooting
description: >
  Fetch and read swamp source code to debug, diagnose, and fix swamp issues.
  IMPORTANT: Use this skill — not swamp-model, swamp-workflow, swamp-vault,
  swamp-data, or swamp-repo — whenever the user's query signals something is
  broken or wrong. Error signals include: "error", "failing", "failed", "broken",
  "not working", "crash", "hang", "timeout", "unexpected", "strange", "wrong",
  "issue", "problem", "bug", "fix", "debug", "diagnose", "troubleshoot", "trace",
  "root cause", "stack trace", "error message", "error log", "isn't being
  resolved", "isn't being found", "not reading", "giving me an error". This skill
  applies even when the error mentions a specific domain (e.g., "vault expressions
  aren't resolving" or "my model isn't being found") — the troubleshooting skill
  fetches swamp source to trace the root cause.
---

# Swamp Troubleshooting Skill

Diagnose and troubleshoot swamp issues by fetching and reading the swamp source
code. All commands support `--json` for machine-readable output.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help source` for the complete, up-to-date CLI schema.

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
7. **Pre-flight check failures**: See below

#### Pre-flight Check Failures

When a method fails with a check-related error (e.g., "Pre-flight check failed:
..."):

- Read the error messages returned by the failing check — they describe exactly
  what condition was not met.
- To identify which check failed, look at the check name in the error output.
- To skip a specific check temporarily:
  ```bash
  swamp model method run <name> <method> --skip-check <check-name> --json
  ```
- To skip all checks (e.g., in an offline environment where live API checks
  can't run):
  ```bash
  swamp model method run <name> <method> --skip-checks --json
  ```
- To skip all checks with a given label (e.g., `live` checks):
  ```bash
  swamp model method run <name> <method> --skip-check-label live --json
  ```
- To run only the checks (without running the method) to diagnose:
  ```bash
  swamp model validate <name> --method <method> --json
  ```
- To run only checks with a specific label:
  ```bash
  swamp model validate <name> --label offline --json
  ```
- Check source at `src/domain/models/` for the check's `execute` function to
  understand what it validates.

#### Check Selection Errors

When `model validate` reports `Check selection` failed:

- **"Required check X not found on model type Y"** — the definition's
  `checks.require` references a check name that doesn't exist on the model type.
  Fix: run `swamp model type describe <type>` to see available checks, then
  correct the name in the YAML definition.
- **"Skipped check X not found on model type Y"** — same issue but for
  `checks.skip`. The check was removed or renamed in the extension.
- **"Check X is in both require and skip lists"** — the definition lists the
  same check in both `require` and `skip`. `skip` wins, but this is likely
  unintentional. Remove it from one list.

#### Extension Check Conflicts

When an extension fails to load with "Check 'X' already exists on model type
'Y'":

- Two extensions define the same check name for the same model type.
- Fix: rename one of the checks in the extension's `checks` array.

#### Required Check Won't Skip

If `--skip-checks` or `--skip-check <name>` doesn't skip a check, the
definition's `checks.require` list includes it. Required checks are immune to
CLI skip flags. To override: edit the YAML definition and remove the check from
`require`, or add it to `skip` (which always wins).

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
