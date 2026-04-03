---
name: swamp-troubleshooting
description: >
  Navigate swamp source code to trace error origins, identify execution
  flows, inspect internal data structures, and understand CLI behavior when
  --help is insufficient. Use this skill whenever something is broken
  ("error", "failing", "not working", "crash", "timeout", "bug", "fix",
  "debug", "troubleshoot", "root cause", "stack trace", "isn't being found",
  "giving me an error", "slow", "performance", "latency") OR when you need
  to understand how swamp works
  internally ("how does", "what happens when", "where is", "internals",
  "under the hood"). Applies even when the query mentions a specific domain
  (e.g., "vault expressions aren't resolving" or "how does extension push
  work") — fetch swamp source to find the answer.
---

# Swamp Troubleshooting Skill

Diagnose and troubleshoot swamp issues, or understand swamp internals, by
fetching and reading the swamp source code. All commands support `--json` for
machine-readable output.

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

## When CLI Help Isn't Enough

If `swamp <command> --help` doesn't fully answer a question about how something
works, fetch the source and read the implementation. Common areas where source
context is needed:

- **Auth**: How credentials are stored (`~/.config/swamp/auth.json`), API key
  format (`swamp_` prefix), headless/CI setup — check `src/infrastructure/auth/`
- **Extension push**: What the push flow does internally, how bundles are
  packaged, registry interaction — check `src/cli/commands/extension*.ts` and
  `src/domain/extensions/`
- **Init**: What files and directories `swamp repo init` creates and why — check
  `src/cli/commands/repo*.ts` and `src/domain/repo/`
- **Data persistence**: How data is stored, versioned, and garbage collected —
  check `src/infrastructure/persistence/`

**General rule:** When a skill's CLI commands and documentation don't provide
enough detail, use `swamp source fetch` to get the source and read the relevant
files directly.

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

### 4. Enable Tracing (Performance Issues)

If the issue is about slowness, timeouts, or understanding execution flow,
enable OpenTelemetry tracing:

```bash
# Quick: print spans to stderr
OTEL_TRACES_EXPORTER=console swamp workflow run my-workflow

# Visual: send to local Jaeger (docker run -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 swamp workflow run my-workflow
```

Traces show the full execution hierarchy with timing for every operation — CLI
command → workflow → job → step → method → driver. See
[references/tracing.md](references/tracing.md) for setup, span names, and
diagnosing common issues.

### 5. Diagnose the Issue

Based on the error message or symptoms:

1. **Command not working**: Check `src/cli/commands/{command}.ts`
2. **Model issues**: Check `src/domain/models/`
3. **Workflow issues**: Check `src/domain/workflows/`
4. **Vault/secret issues**: Check `src/domain/vaults/`
5. **Data persistence issues**: Check `src/infrastructure/persistence/`
6. **Output formatting issues**: Check `src/presentation/output/`
7. **Pre-flight check failures**: See
   [references/checks.md](references/checks.md) for skip flags, check selection
   errors, extension conflicts, and required check behavior
8. **Slow operations**: Enable tracing — see
   [references/tracing.md](references/tracing.md)

### 6. Explain and Suggest Fixes

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
│   │   ├── tracing/         # OpenTelemetry tracing
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

## Source Extension Not Loading

If a source extension isn't appearing in `swamp model type search`:

1. **Check the source is registered**: `swamp extension source list` — look for
   green checkmark. Red cross means the path doesn't exist.
2. **Check the directory structure**: The source path must contain
   `extensions/models/` (or the appropriate type directory).
3. **Check for a `deno.json`**: Source extensions need a `deno.json` with
   dependency mappings (e.g., `"zod": "npm:zod@4"`). Without it, bundling fails
   with `"Import "zod" not a dependency"`.
4. **Check the warning output**: Look for `"Using discovered deno config"`
   warnings — this confirms the bundler found the source's config file.
5. **Check the `only` filter**: If the source was added with `--only vaults`,
   model types won't load from it.

The source loading code lives in:

- `src/infrastructure/persistence/swamp_sources_repository.ts` — file reading
  and path resolution
- `src/cli/mod.ts` — wiring sources into the loader pipeline

## When to Use Other Skills

| Need                    | Use Skill               |
| ----------------------- | ----------------------- |
| Run/create models       | `swamp-model`           |
| Run/create workflows    | `swamp-workflow`        |
| Manage secrets          | `swamp-vault`           |
| Manage repository       | `swamp-repo`            |
| Create extension models | `swamp-extension-model` |
