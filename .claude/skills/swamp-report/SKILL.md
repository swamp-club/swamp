---
name: swamp-report
description: Create, register, configure, and run reports for swamp models and workflows. Use when creating report extensions, configuring reports in definition YAML, running reports via CLI, or viewing report output. Triggers on "report", "swamp report", "model report", "create report", "run report", "report extension", "report label", "skip report", "report output", "cost report", "audit report", "workflow report", "report results".
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

## Creating a Standalone Report Extension

Reports are standalone TypeScript files in `extensions/reports/`. Each file
exports a `report` object with a `name`, `description`, `scope`, optional
`labels`, and an `execute` function.

```typescript
// extensions/reports/cost_report.ts
export const report = {
  name: "@myorg/cost-report",
  description: "Estimate costs for the executed method",
  scope: "method",
  labels: ["cost", "finops"],
  execute: async (context) => {
    const modelName = context.definition.name;
    const method = context.methodName;
    const status = context.executionStatus;

    return {
      markdown:
        `# Cost Report\n\n- **Model**: ${modelName}\n- **Method**: ${method}\n- **Status**: ${status}\n`,
      json: { modelName, method, status },
    };
  },
};
```

### Name Conventions

Report names follow the `@collective/name` pattern with optional nested path
segments (e.g., `@myorg/cost-report` or `@myorg/aws/cost-report`). This matches
the same naming convention used by models, drivers, vaults, and datastores.

### Report Scopes

| Scope      | Context type            | When it runs                    |
| ---------- | ----------------------- | ------------------------------- |
| `method`   | `MethodReportContext`   | After a single method execution |
| `model`    | `ModelReportContext`    | After all method-scope reports  |
| `workflow` | `WorkflowReportContext` | After a workflow run completes  |

**Method context** includes: `modelType`, `modelId`, `definition`, `globalArgs`,
`methodName`, `executionStatus`, `dataHandles`.

**Workflow context** includes: `workflowId`, `workflowRunId`, `workflowName`,
`workflowStatus`, `stepExecutions[]` (each with `jobName`, `stepName`,
`modelName`, `modelType`, `methodName`, `status`, `dataHandles`).

All contexts include: `repoDir`, `logger`, `dataRepository`,
`definitionRepository`.

Reports are generic — they receive a `ReportContext` and decide at runtime how
to handle their inputs. They don't declare which model types they support.

See [references/report-types.md](references/report-types.md) for full type
definitions.

### Redacting Sensitive Arguments

The context provides `redactSensitiveArgs()` which replaces values marked
`{ sensitive: true }` in the model type's Zod schema with `"***"`. Use it when
including argument values in report output:

```typescript
const globalArgs = context.redactSensitiveArgs(context.globalArgs, "global");
const methodArgs = context.redactSensitiveArgs(context.methodArgs, "method");
```

The helper is available on method and model scope contexts. It returns args
unchanged if no schema is found, so it is safe to call unconditionally.

### Reading Execution Data

Reports can read data produced during method execution via `context.dataHandles`
and `context.dataRepository`:

```typescript
execute: async (context) => {
  const handle = context.dataHandles.find(h => h.specName === "state");
  if (!handle) {
    return { markdown: "No data produced.", json: {} };
  }

  // getContent returns raw bytes — parse JSON manually
  const raw = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    handle.name,
    handle.version,
  );
  if (!raw) {
    return { markdown: "Data not found.", json: {} };
  }
  const attrs = JSON.parse(new TextDecoder().decode(raw));

  return {
    markdown: `# State Report\n\n- **Status**: ${attrs.status}\n`,
    json: { status: attrs.status },
  };
},
```

Use `findByName()` when you need metadata (tags, version, content type) without
the content itself. See
[references/report-types.md](references/report-types.md#unifieddatarepository-methods)
for the full API and
[references/testing.md](references/testing.md#testing-reports-that-read-data)
for testing patterns.

### Key Rules

1. **Return both markdown and json** — every report must produce both
2. **Labels are optional** — use them for filtering (e.g., `["cost", "audit"]`)
3. **One report per file** — export a single `report` object from each file
4. **Use scope correctly** — method-scope for per-execution analysis,
   model-scope for cross-method analysis, workflow-scope for multi-step
   aggregation
5. **Redact sensitive args** — use `context.redactSensitiveArgs()` when
   including argument values in report output

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

### Filtering Semantics

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

### Precedence Rules

- `skip` always wins — even over `require` for the same report name
- `require` makes reports immune to `--skip-reports`, `--skip-report <name>`,
  and `--skip-report-label <label>` CLI flags
- Method scoping (`methods: [...]`) restricts a required report to specific
  methods — it won't run for unlisted methods
- CLI inclusion filters (`--report`, `--report-label`) narrow to a subset

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

For the full publishing workflow, CalVer versioning, and safety rules, see the
[publishing guide](../swamp-extension-model/references/publishing.md).

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

Access stored reports via data query (see `swamp-data-query` skill):

```bash
swamp data query 'tags.type == "report"'
swamp data get my-model report-cost-estimate --json
```

## Output

**Log mode** (default): Renders report markdown with terminal formatting.
Displays a separator line, the rendered markdown content, and a pass/fail
summary. The built-in `@swamp/method-summary` markdown is compact for human
readability: narrative + retrieval hint only.

**JSON mode** (`--json`): Full structured detail for agents. The built-in
`@swamp/method-summary` JSON includes narrative, output schema (field names and
types from the model's output specs), and all data pointers grouped by spec. Use
`swamp report get <name> --model <model> --json` to retrieve this after
execution.

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

| Need                         | Use Skill               |
| ---------------------------- | ----------------------- |
| Work with models             | `swamp-model`           |
| Create/run workflows         | `swamp-workflow`        |
| Create custom model types    | `swamp-extension-model` |
| Extend model with new method | `swamp-extension-model` |
| Manage model data            | `swamp-data`            |
| Repository structure         | `swamp-repo`            |
| Understand swamp internals   | `swamp-troubleshooting` |

## References

- **Report API**: See [references/report-types.md](references/report-types.md)
  for full `ReportDefinition`, `ReportContext`, `ReportRegistry`, and
  `ReportSelection` type definitions
- **Testing**: See [references/testing.md](references/testing.md) for unit
  testing report execute functions with `@systeminit/swamp-testing`
