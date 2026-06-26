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

## How Reports Work

Reports run automatically after model method executions and workflow steps. They
analyze execution output and produce both markdown and JSON artifacts.

1. **Reports are attached to model types** — each type defines its default
   reports
2. **Definitions can override** — `reports.require` adds, `reports.skip` removes
3. **CLI flags control per-run** — `--skip-reports`, `--report <name>`,
   `--report-label <label>`

To view a report after execution, use
`swamp report get <report-name> --model <model> --json`.

For detailed walkthroughs including creating custom reports, see
[reference.md](reference.md).
