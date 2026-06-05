# Report Filtering Semantics and Precedence

Reports are selected from three sources (model-type defaults, definition YAML,
workflow YAML) and filtered by CLI flags. This file documents how those layers
combine.

## Filtering Semantics

For **method/model scope** reports, the candidate set is:

- Model-type defaults (`ModelDefinition.reports`)
- Plus definition YAML `require`
- Minus definition YAML `skip` (always wins)
- Minus CLI skip flags (unless report is in `require`)
- Narrowed by CLI inclusion flags (`--report`, `--report-label`)

For **workflow scope** reports, the candidate set is:

- Workflow YAML `require` (no model-type defaults apply)
- Minus workflow YAML `skip`
- Minus CLI skip flags (unless in `require`)
- Narrowed by CLI inclusion flags

## Precedence Rules

- `skip` always wins — even over `require` for the same report name
- `require` makes reports immune to `--skip-reports`, `--skip-report <name>`,
  and `--skip-report-label <label>` CLI flags
- Method scoping (`methods: [...]`) restricts a required report to specific
  methods — it won't run for unlisted methods
- CLI inclusion filters (`--report`, `--report-label`) narrow to a subset
