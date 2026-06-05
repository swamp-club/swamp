# Report Extension API

Create standalone TypeScript report files in `extensions/reports/`. Each file
exports a `report` object.

## Quick Start

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

## Name Conventions

Report names follow `@collective/name` (e.g. `@myorg/cost-report`,
`@myorg/aws/cost-report`) — same convention as models, drivers, vaults, and
datastores.

## Report Scopes

| Scope      | Context type            | When it runs                    |
| ---------- | ----------------------- | ------------------------------- |
| `method`   | `MethodReportContext`   | After a single method execution |
| `model`    | `ModelReportContext`    | After all method-scope reports  |
| `workflow` | `WorkflowReportContext` | After a workflow run completes  |

Reports are generic — they receive a `ReportContext` and decide at runtime how
to handle their inputs. They don't declare which model types they support. See
[report-types.md](report-types.md) for context field listings and full type
definitions.

## Redacting Sensitive Arguments

The context provides `redactSensitiveArgs()` which replaces values marked
`{ sensitive: true }` in the model type's Zod schema with `"***"`. Use it when
including argument values in report output:

```typescript
const globalArgs = context.redactSensitiveArgs(context.globalArgs, "global");
const methodArgs = context.redactSensitiveArgs(context.methodArgs, "method");
```

The helper is available on method and model scope contexts. It returns args
unchanged if no schema is found, so it is safe to call unconditionally.

## Reading Execution Data

Reports can read data produced during method execution via `context.dataHandles`
and `context.dataRepository`:

```typescript
execute: async (context) => {
  const handle = context.dataHandles.find(h => h.specName === "state");
  if (!handle) {
    return { markdown: "No data produced.", json: {} };
  }

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
[report-types.md](report-types.md#unifieddatarepository-methods) for the full
API and [testing.md](testing.md#testing-reports-that-read-data) for testing
patterns.

## Key Rules

1. **Return both markdown and json** — every report must produce both
2. **Labels are optional** — use them for filtering (e.g., `["cost", "audit"]`)
3. **One report per file** — export a single `report` object from each file
4. **Use scope correctly** — method-scope for per-execution analysis,
   model-scope for cross-method analysis, workflow-scope for multi-step
   aggregation
5. **Redact sensitive args** — use `context.redactSensitiveArgs()` when
   including argument values in report output

## Publishing Reports

Add reports to the manifest `reports:` field:

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

Use the `swamp-extension-publish` skill for the full publishing workflow.

## Discovery & Loading

- Location: `{repo}/extensions/reports/**/*.ts`
- Export: `export const report = { ... }`
- Files ending in `_test.ts` are excluded
- Files without the correct export are silently skipped
