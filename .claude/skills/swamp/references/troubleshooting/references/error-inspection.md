# Error Inspection (Tier 2)

When a command fails or behaves unexpectedly and Tier 1 doesn't apply (or has
already passed), inspect the error surface itself before reaching for tracing or
source. Most swamp failures announce themselves loudly on stderr or in
structured form via `--json` — read those before guessing.

## Contents

- [The error surface](#the-error-surface)
- [Read stderr first](#read-stderr-first)
- [Switch to `--json`](#switch-to---json)
- [Exit codes](#exit-codes)
- [`swamp-warning:` lines](#swamp-warning-lines)
- [Recipe: extension not in `model type search`](#recipe-extension-not-in-model-type-search)
- [Recipe: source extension not loading](#recipe-source-extension-not-loading)
- [Recipe: method preflight check failed](#recipe-method-preflight-check-failed)
- [Escalating to other tiers](#escalating-to-other-tiers)

## The error surface

Every swamp command exposes the same surfaces. Cover them in order:

1. **Stderr** — human-readable errors, warnings (`swamp-warning:` prefix), and
   debug logs.
2. **Stdout** — command output. In `--json` mode, errors and structured payloads
   land here too.
3. **Exit code** — `0` on success, `1` on user-facing failure. Doctor commands
   exit `1` on any check fail; CI should gate on this.
4. **Audit log** — `.swamp/audit/<date>.jsonl` records every CLI action with
   inputs, outputs, and exit codes. Useful when the failure is not from the
   command being investigated but from something earlier.

## Read stderr first

Many "silent" failures are not silent — they print a `swamp-warning:` line to
stderr and continue. `--json` only shapes stdout, so warnings stay visible
regardless of mode.

```bash
swamp model type search --json 2>warnings.txt
cat warnings.txt          # check for swamp-warning: lines
```

If the user reports "X isn't appearing" or "X isn't being found," check stderr
before anything else.

## Switch to `--json`

Every command supports `--json`. When the human-readable output is ambiguous,
re-run with `--json` to see the structured shape — error messages, validation
details, and per-item status are all surfaced explicitly.

```bash
swamp model method run my-model my-method --json
```

JSON output is also stable — fields rarely change between releases, so it's the
right surface for scripting and CI gating.

## Exit codes

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| `0`  | Success                                                       |
| `1`  | User-facing failure (validation, missing config, doctor fail) |
| `2+` | Reserved — currently unused, but capture for future-proofing  |

CI should treat any non-zero exit as actionable. Combine with `--json` for the
structured failure context.

## `swamp-warning:` lines

When swamp detects a non-fatal issue during extension load (bad version, broken
import, etc.), it emits a single line to stderr:

```
swamp-warning: model: extensions/models/my-model.ts: Missing version field — must be CalVer (YYYY.MM.DD.MICRO)
```

Format: `swamp-warning: <kind>: <file>: <error>`. Kinds match the doctor
extension registries
(`model | extension | vault | driver | datastore | report`).

The emitter is at `src/infrastructure/logging/extension_load_warnings.ts`.
`swamp doctor extensions` consumes the same emitter and folds warnings into a
structured report — prefer the doctor command when triaging multiple warnings.

## Recipe: extension not in `model type search`

Symptom: a model file at `extensions/models/<name>.ts` doesn't appear in
`swamp model type search`.

1. **Run `swamp doctor extensions --json`** — Tier 1 names the failing file and
   error directly. Stop here if the failure is identified.
2. **If doctor passes**, the model is loading but isn't visible. Re-run
   `swamp model type search --json` and check stderr for late warnings (some
   issues only surface when the catalog is queried, not when registries load).
3. **Verify `deno check` passes** on the file — type errors that pass
   `deno
   check` may still be rejected by swamp's stricter validation (e.g.
   missing `version`).
4. **Do NOT run `swamp extension source add extensions/models`** — that path is
   auto-discovered by default. Registering it as a source is a no-op that adds
   confusion. Source-add is for directories _outside_ the repo.

Discovery code lives in `src/cli/mod.ts` (`loadUserModels`) and
`src/domain/models/user_model_loader.ts` (`UserModelLoader.buildIndex`). Read
those via Tier 4 if doctor and stderr both come up clean.

## Recipe: source extension not loading

Symptom: an extension registered in `.swamp-sources.yaml` isn't appearing.

1. **Run `swamp doctor extensions --json`** — failures from a source path show
   up with the source-relative file path in the failure list.
2. **Check the source is registered**: `swamp extension source list` — green
   checkmark means the path resolves; red cross means it doesn't exist on disk.
3. **Check the directory structure**: the source path must contain
   `extensions/<kind>/` (or be a direct-content directory of one kind).
4. **Check for a `deno.json`**: source extensions need a `deno.json` with
   dependency mappings (e.g. `"zod": "npm:zod@4"`). Without it, bundling fails
   with `Import "zod" not a dependency`.
5. **Check the `only` filter**: if the source was added with `--only vaults`,
   model types won't load from it.

Source loading code:

- `src/infrastructure/persistence/swamp_sources_repository.ts` — file reading
  and path resolution.
- `src/cli/mod.ts` — wiring sources into the loader pipeline.

## Recipe: method preflight check failed

Symptom: `swamp model method run` fails with `Pre-flight check failed: …`.

This is a different concept from `swamp doctor` — it's a per-method validation
check (e.g. "AWS credentials are valid", "API is reachable"), not an integration
health check. See [checks.md](checks.md) for skip flags, check selection errors,
extension conflicts, and required-check behavior.

## Escalating to other tiers

If Tier 2 doesn't resolve the issue:

- **Slow / timing-related** → Tier 3: [tracing.md](tracing.md).
- **Unclear what the command is doing internally**, or a Tier-1-clean
  integration that still misbehaves → Tier 4:
  [source-reading.md](source-reading.md).
- **Doctor flagged a known integration as unhealthy** → Tier 1:
  [health-checks.md](health-checks.md).
