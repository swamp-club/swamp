# Health Checks (Tier 1)

Run `swamp doctor <subcommand>` first when a known integration is suspected of
being unhealthy. Doctor commands are the cheapest, most specific diagnostic —
they exit non-zero on failure, support `--json` for CI, and name the failing
piece in the output.

## Contents

- [When to use Tier 1](#when-to-use-tier-1)
- [`swamp doctor audit`](#swamp-doctor-audit)
- [`swamp doctor extensions`](#swamp-doctor-extensions)
- [Using doctor in CI](#using-doctor-in-ci)
- [Escalating to other tiers](#escalating-to-other-tiers)

## When to use Tier 1

Reach for a doctor command when the symptom maps to a known integration:

| Symptom                                                        | Run                       |
| -------------------------------------------------------------- | ------------------------- |
| Audit log empty after init/upgrade or after AI-tool change     | `swamp doctor audit`      |
| Hooks aren't firing for the configured AI tool                 | `swamp doctor audit`      |
| Extension model/vault/driver/datastore/report missing from CLI | `swamp doctor extensions` |
| `swamp-warning:` line on stderr mentioning a load failure      | `swamp doctor extensions` |
| CI preflight needs to gate on integration health               | either, with `--json`     |

If the symptom is generic ("command errored", "method failed"), skip Tier 1 and
go to Tier 2 (error inspection).

## `swamp doctor audit`

Verifies that the AI-tool audit integration is wired correctly. Reads the tool
from `.swamp.yaml` unless `--tool` overrides it. Exits 1 on any check fail.

```bash
swamp doctor audit                  # uses tool from .swamp.yaml
swamp doctor audit --tool kiro      # override
swamp doctor audit --json           # machine-readable
```

Supported tools: `claude | cursor | kiro | opencode | codex | copilot | none`.

### Preflight checks

Runs in fixed order. A failure in one check does not abort later checks.

| Check                   | Verifies                                                         |
| ----------------------- | ---------------------------------------------------------------- |
| `binary-on-path`        | The AI tool's binary is reachable on `$PATH`                     |
| `swamp-binary-on-path`  | The `swamp` binary is on `$PATH` (so hooks can call it)          |
| `agent-config-loadable` | The AI tool's config file (e.g. `.claude/...`) parses            |
| `default-agent-set`     | A default agent is configured                                    |
| `recording-smoke-test`  | A synthetic hook payload roundtrips through `swamp audit record` |

Each check returns `pass | fail | skip` with a short message and (on fail) an
actionable hint. `skip` means the check does not apply to the configured tool
(e.g. `tool: none`).

### Output — log mode

```
✓ binary-on-path           Found at /usr/local/bin/claude
✓ swamp-binary-on-path     Found at /opt/homebrew/bin/swamp
✓ agent-config-loadable    .claude/settings.json parsed
✓ default-agent-set        Default agent: swamp-getting-started
✓ recording-smoke-test     audit record accepted the synthetic payload

5 passed, 0 failed, 0 skipped — OVERALL: PASS
```

Fail rows print a `hint:` line beneath them with the remediation step.

### Output — JSON mode

```json
{
  "tool": "claude",
  "overallStatus": "pass",
  "checks": [
    {
      "name": "binary-on-path",
      "status": "pass",
      "message": "Found at /usr/local/bin/claude"
    }
  ]
}
```

Fields per check: `name`, `status` (`pass | fail | skip`), `message`, optional
`hint` (on fail), optional `details` (structured payload for consumers).

`overallStatus` is `pass` if no fails, `warn` if every check skipped, `fail`
otherwise. Exit code mirrors `fail` only.

### Common failures

| Hint contains           | Fix                                                                  |
| ----------------------- | -------------------------------------------------------------------- |
| "Not found on PATH"     | Install the AI tool, or add its bin dir to `$PATH`                   |
| "swamp not on PATH"     | Install the `swamp` binary into a directory on `$PATH`               |
| "Could not parse"       | Run the AI tool to regenerate its config; check for hand edits       |
| "No default agent"      | Set the default agent through the AI tool's UI/config                |
| "audit record rejected" | Check `swamp` and AI tool versions match; rerun `swamp repo upgrade` |

### `NoToolConfiguredError`

If neither `--tool` nor `.swamp.yaml` declares a tool, the command exits with:

```
No AI tool configured in .swamp.yaml and no --tool flag provided.
Pass --tool <name> (claude | cursor | kiro | opencode | codex | copilot | none)
or run `swamp init --tool <name>`.
```

This is expected first-run UX, not a bug. Either pass `--tool` or set the tool
in `.swamp.yaml` via `swamp init --tool <name>`.

## `swamp doctor extensions`

Verifies that every user-defined extension in this repo loads cleanly. Forces a
catalog rescan and re-runs each registry's loader from scratch — cached lazy
entries cannot mask failures. Exits 1 on any registry fail.

```bash
swamp doctor extensions
swamp doctor extensions --json
swamp doctor extensions --verbose
swamp doctor extensions --repair --dry-run
swamp doctor extensions --repair
```

### Flags

| Flag        | Effect                                                            |
| ----------- | ----------------------------------------------------------------- |
| `--json`    | Machine-readable output for CI                                    |
| `--verbose` | Show per-source detail (source path, RowState, fingerprint)       |
| `--repair`  | Prune Tombstoned rows and evict unreferenced bundle files         |
| `--dry-run` | Preview repair operations without executing (use with `--repair`) |

### Registries checked

Five user-facing registries, in fixed order:

| Registry    | Covers                                               |
| ----------- | ---------------------------------------------------- |
| `model`     | `extensions/models/` and registered model extensions |
| `vault`     | `extensions/vaults/`                                 |
| `driver`    | `extensions/drivers/`                                |
| `datastore` | `extensions/datastores/`                             |
| `report`    | `extensions/reports/`                                |

The `model` row absorbs both `model` and `extension` load warnings — extensions
that augment an existing model type fold into the model registry's row.

### Output — log mode

```
✓ model
✓ vault
✗ driver (1 failure(s))
    • extensions/drivers/my-driver.ts: Missing version field — must be CalVer (YYYY.MM.DD.MICRO)
✓ datastore
✓ report

4 passed, 1 failed — OVERALL: FAIL
```

### Output — JSON mode

All five registry keys are always present, in fixed order, even on a clean run:

```json
{
  "overallStatus": "fail",
  "registries": {
    "model": { "registry": "model", "status": "pass", "failures": [] },
    "vault": { "registry": "vault", "status": "pass", "failures": [] },
    "driver": {
      "registry": "driver",
      "status": "fail",
      "failures": [
        {
          "file": "extensions/drivers/my-driver.ts",
          "error": "Missing version field …"
        }
      ]
    },
    "datastore": { "registry": "datastore", "status": "pass", "failures": [] },
    "report": { "registry": "report", "status": "pass", "failures": [] }
  }
}
```

### Common failures

The error string identifies the cause. Most failures fall into these buckets:

| Error fragment                         | Fix                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Missing version field` / `not CalVer` | Add `version: "YYYY.MM.DD.MICRO"` to the extension export                                                                 |
| `type` field not a string literal      | Replace the variable with a literal — the catalog regex requires it                                                       |
| `Import "<dep>" not a dependency`      | Add the dep to the source's `deno.json` `imports` map                                                                     |
| Syntax / unresolvable import           | Fix the file so `deno check` passes                                                                                       |
| `<registry> loader>: …`                | The loader itself threw — read the message; usually a config issue in the source's `deno.json` or a missing native binary |

For the deeper "extension not in type search" walkthrough (stderr inspection,
source registration, `deno.json` discovery), see
[error-inspection.md](error-inspection.md).

## Using doctor in CI

Both commands exit 1 on failure, so they compose directly into CI. Use `--json`
to capture structured output for review.

```bash
# Gate on audit health
swamp doctor audit --json > audit-health.json

# Gate on extension health
swamp doctor extensions --json > extension-health.json
```

Run `doctor extensions` after every PR that touches `extensions/` or
`.swamp-sources.yaml`. Run `doctor audit` after every `init` or `upgrade` step
in CI bootstrap.

## Escalating to other tiers

Tier 1 cannot diagnose:

- A method that fails its own preflight checks at run time → see
  [checks.md](checks.md) (different concept: per-method validation, not
  integration health).
- A specific command that errors with a non-doctor failure → go to Tier 2:
  [error-inspection.md](error-inspection.md).
- A workflow that's slow or whose execution flow is unclear → go to Tier 3:
  [tracing.md](tracing.md).
- A "how does X work internally" question, or a Tier-1-clean integration that
  still misbehaves → go to Tier 4: [source-reading.md](source-reading.md).
