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
commands support `--json` for machine-readable output.

## When to Create a Report

Create a report extension when you need a **repeatable pipeline** to transform,
aggregate, or analyze model output. If the analysis will be run more than once
or should be stored alongside model data, a report is the right choice.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help model report` or `swamp help model method run` for the complete,
up-to-date CLI schema.

## Quick Reference

| Task                     | Command                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| Run reports for a model  | `swamp model report <model>`                                      |
| Filter by label          | `swamp model report <model> --label cost`                         |
| Simulate method context  | `swamp model report <model> --method create`                      |
| Run method with reports  | `swamp model method run <model> <method>`                         |
| Skip all reports         | `swamp model method run <model> <method> --skip-reports`          |
| Skip report by name      | `swamp model method run <model> <method> --skip-report <n>`       |
| Skip report by label     | `swamp model method run <model> <method> --skip-report-label <l>` |
| Run only named report    | `swamp model method run <model> <method> --report <n>`            |
| Run only labeled reports | `swamp model method run <model> <method> --report-label <l>`      |
| Workflow with reports    | `swamp workflow run <workflow>`                                   |
| Workflow skip reports    | `swamp workflow run <workflow> --skip-reports`                    |
| Get stored report        | `swamp report get <report-name> --model <model> --json`           |

## End-to-End Workflow

1. **Create the report file** in `extensions/reports/` — export a `report`
   object with `name`, `description`, `scope`, optional `labels`, and `execute`.
2. **Register in manifest** — add the filename to the `reports:` list in
   `manifest.yaml`. Verify with `swamp model get <model> --json` to confirm the
   report appears in the resolved report set.
3. **Configure in definition YAML** — add the report name to `reports.require:`
   in the model or workflow definition if it should run beyond the model-type
   defaults. Use `reports.skip:` to exclude reports you don't need.
4. **Run and verify** — execute `swamp model report <model>` to confirm the
   report produces valid markdown and JSON output without errors.
5. **Check stored output** — run `swamp data query 'tags.type == "report"'` to
   verify the report artifact was persisted correctly.

## Creating Report Extensions

To create a new report extension, use the `swamp-extension` skill. It covers the
TypeScript authoring workflow, export contract, scopes, reading execution data,
and testing.

## Three-Level Report Control Model

Reports are controlled at three levels, from most general to most specific:

### 1. Model Type Defaults (TypeScript `ModelDefinition`)

The `reports` field on model definitions lists standalone report names that are
defaults for any model of this type:

```typescript
// extensions/models/my_model.ts
export const model = {
  type: "@myorg/ec2",
  version: "2026.03.01.1",
  reports: ["@myorg/cost-report", "@myorg/drift-report"],
  // ... methods, resources, etc.
};
```

### 2. Definition YAML Overrides (`reportSelection`)

The `reports:` field in definition YAML provides per-definition overrides.
`require` adds reports beyond model-type defaults. `skip` removes reports from
the defaults.

```yaml
# definitions/my-vpc.yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-vpc
version: 1
tags: {}
reports:
  require:
    - "@myorg/compliance-report" # adds to model-type defaults
    - name: security-audit # only run for these methods
      methods: ["create", "delete"]
  skip:
    - "@myorg/drift-report" # removes from model-type defaults
globalArguments:
  cidrBlock: "10.0.0.0/16"
methods:
  create:
    arguments: {}
```

### 3. Workflow YAML Overrides

The `reports:` field in workflow YAML controls workflow-scope reports and can
also override model-level reports for the workflow run.

```yaml
# workflows/deploy.yaml
name: deploy
reports:
  require:
    - "@myorg/workflow-summary" # workflow-scope report
  skip:
    - "@myorg/cost-report" # skip for all models in this workflow
```

### Filtering Semantics and Precedence

The candidate set is built from model-type defaults plus `require`, minus
`skip`, with CLI flags applied last. `skip` always wins over `require`, and
`require` makes a report immune to CLI skip flags. See
[references/filtering.md](references/filtering.md) for the full set composition
and precedence rules.

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

### model report (standalone)

| Flag                | Description                         |
| ------------------- | ----------------------------------- |
| `--label <label>`   | Only run reports with this label    |
| `--method <method>` | Simulate method context for reports |

The standalone `swamp model report` command runs reports without executing a
method. It builds a `MethodReportContext` with `executionStatus: "succeeded"`
and empty `dataHandles`.

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

**Log mode** (default): renders report markdown with terminal formatting plus a
pass/fail summary. The built-in `@swamp/method-summary` markdown is compact —
narrative + retrieval hint only.

**JSON mode** (`--json`): full structured detail for agents. The built-in
`@swamp/method-summary` JSON includes narrative, output schema, and data
pointers grouped by spec. Retrieve with
`swamp report get <name> --model <model> --json`.

JSON output shape:

```json
{
  "outputId": "...",
  "modelName": "my-vpc",
  "method": "create",
  "status": "succeeded",
  "reports": {
    "cost-estimate": {
      "modelName": "my-vpc",
      "method": "create",
      "status": "succeeded"
    }
  }
}
```

Failed reports appear as `{ "_error": "error message" }`.

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
- **Filtering**: See [references/filtering.md](references/filtering.md) for the
  full filtering semantics and precedence rules
- **Testing**: See [references/testing.md](references/testing.md) for unit
  testing report execute functions with `@systeminit/swamp-testing`
