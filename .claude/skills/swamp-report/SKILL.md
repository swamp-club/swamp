---
name: swamp-report
description: >
  Run, configure, and view reports for swamp models and workflows. Use when
  running reports via CLI, configuring report selection in definition YAML,
  viewing report output, or filtering reports by label. Do NOT use for creating
  report extensions (that is swamp-extension) or debugging report failures
  (that is swamp-troubleshooting). Triggers on "run report", "swamp report",
  "model report", "report output", "report label", "skip report", "report
  results", "cost report", "audit report", "workflow report", "report get",
  "report filtering".
---

# Swamp Report Skill

Create and run reports that analyze model and workflow executions. Reports
produce markdown (human-readable) and JSON (machine-readable) output. All
commands support `--json`. If unsure about exact flags or subcommands, run
`swamp report --help` or `swamp model method run --help` for the up-to-date
schema.

## Quick Reference

| Task                     | Command                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| Get a stored report      | `swamp report get <report-name> --model <model>`                  |
| Get report as markdown   | `swamp report get <report-name> --model <model> --markdown`       |
| Get report as JSON       | `swamp report get <report-name> --model <model> --json`           |
| Cap total output width   | `swamp report get <report-name> --model <model> --max-width 120`  |
| Cap column width         | `swamp report get <report-name> --max-col-width 60`               |
| Run method with reports  | `swamp model method run <model> <method>`                         |
| Skip all reports         | `swamp model method run <model> <method> --skip-reports`          |
| Skip report by name      | `swamp model method run <model> <method> --skip-report <n>`       |
| Skip report by label     | `swamp model method run <model> <method> --skip-report-label <l>` |
| Run only named report    | `swamp model method run <model> <method> --report <n>`            |
| Run only labeled reports | `swamp model method run <model> <method> --report-label <l>`      |
| Workflow with reports    | `swamp workflow run <workflow>`                                   |
| Workflow skip reports    | `swamp workflow run <workflow> --skip-reports`                    |

## End-to-End Workflow

1. **Create the report file** in `extensions/reports/` — export a `report`
   object with `name`, `description`, `scope`, optional `labels`, and `execute`.
2. **Register in manifest** — add the filename to the `reports:` list in
   `manifest.yaml`. Verify with `swamp model get <model> --json` to confirm the
   report appears in the resolved report set.
3. **Configure in definition YAML** — add the report name to `reports.require:`
   in the model or workflow definition if it should run beyond the model-type
   defaults. Use `reports.skip:` to exclude reports you don't need.
4. **Run and verify** — execute a model method, then use
   `swamp report get <report-name> --model <model>` to confirm the report
   produces valid markdown and JSON output without errors.
5. **Check stored output** — run `swamp data query 'tags.type == "report"'` to
   verify the report artifact was persisted correctly.

## Creating Report Extensions

To create a new report extension, use the `swamp-extension` skill. It covers the
TypeScript authoring workflow, export contract, scopes, reading execution data,
and testing.

## Report Control (Three Levels)

Reports are selected at three levels, most general to most specific:

1. **Model-type defaults** — `reports: [...]` on the model definition.
2. **Definition YAML** — `reports.require` adds, `reports.skip` removes.
3. **Workflow YAML** — workflow-scope reports plus per-run overrides.

CLI flags apply last. `skip` always wins over `require`, and `require` makes a
report immune to CLI skip flags. See
[references/control-model.md](references/control-model.md) for the configuration
examples at each level, and [references/filtering.md](references/filtering.md)
for the full set composition and precedence rules.

## Publishing Reports

Reports can be published as part of extensions via the manifest `reports:`
field:

```yaml
# manifest.yaml
manifestVersion: 1
name: "@myorg/reports"
version: "2026.03.01.1"
description: "Cost and compliance reports"
reports:
  - cost_report.ts
  - compliance_report.ts
```

For the full publishing workflow, use the `swamp-extension-publish` skill. It
provides a state-machine checklist that enforces all prerequisites before
allowing a push.

## CLI Flags

### model method run / workflow run

| Flag                          | Description                                   |
| ----------------------------- | --------------------------------------------- |
| `--skip-reports`              | Skip all reports (except definition-required) |
| `--skip-report <name>`        | Skip a specific report by name (repeatable)   |
| `--skip-report-label <label>` | Skip reports with this label (repeatable)     |
| `--report <name>`             | Only run this report (repeatable, inclusion)  |
| `--report-label <label>`      | Only run reports with this label (repeatable) |

### report search

Browse stored report results across all models and workflows. Pass an optional
`[query]` argument for a case-insensitive substring match; the flags below are
exact matches.

| Flag                | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `[query]`           | Substring match on report name, data name, or variant  |
| `--model <name>`    | Filter to a specific model                             |
| `--workflow <name>` | Filter to a specific workflow                          |
| `--scope <scope>`   | Filter by report scope (`method`, `model`, `workflow`) |
| `--type <name>`     | Filter by exact report type name (e.g. `@myorg/cost`)  |
| `--label <label>`   | Filter by report label (repeatable)                    |

### report get

| Flag                      | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `--model <name>`          | Scope to a specific model                              |
| `--workflow <name>`       | Scope to a specific workflow                           |
| `--version <version>`     | Get specific version (default: latest)                 |
| `--variant <variant>`     | Select a specific forEach variant                      |
| `--markdown`              | Output as plain markdown instead of terminal-formatted |
| `--max-width <width>`     | Cap total output width in columns                      |
| `--max-col-width <width>` | Cap individual table column width in characters        |

## Report Data Storage

Report results are automatically persisted as data artifacts:

- **Markdown**: data name `report-{reportName}`, content type `text/markdown`
- **JSON**: data name `report-{reportName}-json`, content type
  `application/json`
- **Lifetime**: 30 days, garbage collection keeps 5 versions
- **Tags**: `type=report`, `reportName={name}`, `reportScope={scope}`

Access stored reports via data query (see `swamp-data` skill):

```bash
swamp data query 'tags.type == "report"'
swamp data get my-model report-cost-estimate --json
```

## Output

Three output modes: **log** (default, terminal-formatted), **markdown**
(`--markdown`, raw pipe-tables for pasting), **JSON** (`--json`, structured
detail for agents).

**Width controls** (log and markdown modes): `--max-width N` caps total output
width. `--max-col-width N` truncates individual table columns with `…`. Both
combine. Env vars: `SWAMP_REPORT_MAX_WIDTH`, `SWAMP_REPORT_MAX_COL_WIDTH`.

## When to Use Other Skills

| Need                       | Use Skill               |
| -------------------------- | ----------------------- |
| Work with models           | `swamp-model`           |
| Create/run workflows       | `swamp-workflow`        |
| Create report extensions   | `swamp-extension`       |
| Create custom model types  | `swamp-extension`       |
| Manage model data          | `swamp-data`            |
| Repository structure       | `swamp-repo`            |
| Understand swamp internals | `swamp-troubleshooting` |

## References

- **Report API**: See [references/report-types.md](references/report-types.md)
  for full `ReportDefinition`, `ReportContext`, `ReportRegistry`, and
  `ReportSelection` type definitions
- **Control model**: See
  [references/control-model.md](references/control-model.md) for the
  configuration examples at each of the three control levels
- **Filtering**: See [references/filtering.md](references/filtering.md) for the
  full filtering semantics and precedence rules
- **Testing**: See [references/testing.md](references/testing.md) for unit
  testing report execute functions with `@systeminit/swamp-testing`
