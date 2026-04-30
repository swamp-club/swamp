# Source Reading (Tier 4)

When Tiers 1–3 don't answer the question — or the question is itself "how does
swamp do X internally?" — fetch swamp's source and read the implementation
directly. Source reading is the most expensive tier; reach for it last.

## Contents

- [When to use Tier 4](#when-to-use-tier-4)
- [Quick reference](#quick-reference)
- [Workflow](#workflow)
- [Source directory layout](#source-directory-layout)
- [Where to look by symptom](#where-to-look-by-symptom)
- [Version matching](#version-matching)
- [Cleaning up](#cleaning-up)

## When to use Tier 4

Reach for source reading when:

- Tiers 1–3 ran clean but the symptom persists.
- The question is conceptual ("how does extension push work?", "what does init
  create and why?") and `swamp <command> --help` doesn't go deep enough.
- A behavior contradicts the docs and the truth needs to come from the code.

Skip Tier 4 if a doctor command, error message, or trace already names the
problem — fetching source is wasted work in that case.

## Quick reference

| Task                | Command                                      |
| ------------------- | -------------------------------------------- |
| Check source status | `swamp source path --json`                   |
| Fetch source        | `swamp source fetch --json`                  |
| Fetch specific ver  | `swamp source fetch --version v1.0.0 --json` |
| Fetch main branch   | `swamp source fetch --version main --json`   |
| Clean source        | `swamp source clean --json`                  |

## Workflow

### 1. Check current source status

```bash
swamp source path --json
```

Output (found):

```json
{
  "status": "found",
  "version": "20260206.200442.0-sha.abc123",
  "path": "/Users/user/.swamp/source",
  "fileCount": 245,
  "fetchedAt": "2026-02-06T20:04:42.000Z"
}
```

Output (not found):

```json
{ "status": "not_found" }
```

### 2. Fetch source if needed

If source is missing or the version doesn't match the running CLI:

```bash
swamp source fetch --json
```

Fetches source for the current CLI version. Use `--version <ver>` to fetch a
specific release; `--version main` for the latest unreleased code.

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

### 3. Read the relevant files

Source is unpacked at `~/.swamp/source/`. Use Read on absolute paths under that
directory.

### 4. Diagnose and explain

After reading, state what the code does, identify the root cause, and suggest a
workaround or fix. If it's a bug, summarize for an issue report.

## Source directory layout

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
│   │   ├── logging/         # LogTape configuration + warning emitters
│   │   ├── tracing/         # OpenTelemetry tracing
│   │   └── update/          # Self-update mechanism
│   └── presentation/
│       └── output/          # Terminal output rendering
├── integration/             # Integration tests
├── design/                  # Design documents
└── deno.json                # Deno configuration
```

## Where to look by symptom

| Question                                            | Read first                                              |
| --------------------------------------------------- | ------------------------------------------------------- |
| "What does `<command>` do?"                         | `src/cli/commands/<command>.ts`                         |
| Model loading / catalog issues                      | `src/domain/models/`, `src/cli/mod.ts`                  |
| Workflow execution / DAG                            | `src/domain/workflows/`                                 |
| Vault expressions / secrets                         | `src/domain/vaults/`                                    |
| Data persistence, atomic writes, garbage collection | `src/infrastructure/persistence/`                       |
| Auth, credentials, API keys                         | `src/infrastructure/auth/`                              |
| Output formatting (log vs JSON)                     | `src/presentation/output/`                              |
| Tracing span names, instrumentation                 | `src/infrastructure/tracing/`                           |
| Extension load warnings                             | `src/infrastructure/logging/extension_load_warnings.ts` |

## Version matching

- By default, `swamp source fetch` downloads source matching the running CLI
  version. This is almost always what you want — it guarantees the code on disk
  matches the binary's behavior.
- Use `--version main` to read unreleased code (e.g. when investigating a fix
  that has merged but not shipped).
- Use `--version <tag>` to read a specific release (e.g. when reproducing a bug
  on an older version).

## Cleaning up

When done, remove the fetched source:

```bash
swamp source clean --json
```

```json
{ "status": "cleaned", "path": "/Users/user/.swamp/source" }
```
