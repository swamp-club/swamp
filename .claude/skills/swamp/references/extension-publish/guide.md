# Swamp Extension Publish

Publish extensions (models, workflows, vaults, drivers, datastores, reports) to
the swamp registry. This skill is a **state machine** — each state gates the
next. You MUST NOT advance to the next state until the current state's
**Verify** step passes. The final push is blocked until every prior state has
passed.

## State Machine

```
start → repo_verified → auth_verified → manifest_validated
      → versioned → formatted → quality_checked → dry_run_passed → pushed
```

## Quick Reference

| State              | What it checks                 | Key command                                               |
| ------------------ | ------------------------------ | --------------------------------------------------------- |
| repo_verified      | `.swamp.yaml` exists           | `ls .swamp.yaml`                                          |
| auth_verified      | Authenticated with registry    | `swamp auth whoami --json`                                |
| manifest_validated | `manifest.yaml` is valid       | `swamp extension fmt manifest.yaml --check`               |
| versioned          | Version bumped since last push | `swamp extension version --manifest manifest.yaml --json` |
| formatted          | Code is formatted              | `swamp extension fmt manifest.yaml`                       |
| quality_checked    | Quality score ≥ threshold      | `swamp extension quality manifest.yaml --json`            |
| dry_run_passed     | Dry-run push succeeds          | `swamp extension push manifest.yaml --dry-run`            |
| pushed             | Published to registry          | `swamp extension push manifest.yaml --json`               |

For detailed walkthroughs of each state, see [reference.md](reference.md).
