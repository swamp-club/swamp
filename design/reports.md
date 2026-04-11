# Reports

Reports are post-execution analysis functions that produce markdown and JSON
output from model and workflow execution context. They run after a method
completes (or on demand) and persist their results as data artifacts. Reports
are generic — they operate on whatever context they receive at runtime, not on
specific model types. This decouples report logic from model implementation.

## Report Definition

A report is defined by the `ReportDefinition` interface:

```typescript
interface ReportDefinition {
  description: string;
  scope: ReportScope;
  labels?: string[];
  execute(context: ReportContext): Promise<ReportResult>;
}

interface ReportResult {
  markdown: string;
  json: Record<string, unknown>;
}
```

- **description** — what the report produces (human-readable).
- **scope** — `"method"`, `"model"`, or `"workflow"`. Determines which context
  variant the report receives.
- **labels** — optional categorization tags for filtering (e.g., `["cost",
  "finops"]`).
- **execute** — the function that analyzes context and returns a result.

See `src/domain/reports/report.ts` for the full interface.

## Scopes

Each report declares the scope at which it operates. The scope determines the
shape of the context passed to `execute`.

| Scope      | When it runs                             | Context variant          |
| ---------- | ---------------------------------------- | ------------------------ |
| `method`   | After a single method execution          | `MethodReportContext`    |
| `model`    | After a method execution (model-level)   | `ModelReportContext`     |
| `workflow`  | After a full workflow run completes      | `WorkflowReportContext`  |

Reports with `scope: "method"` or `scope: "model"` run in the context of a
specific model instance and method invocation. Reports with `scope: "workflow"`
run after all workflow steps complete and receive summary data about every step.

### Execution Path Parity

Method-scope and model-scope reports run with identical context fields regardless
of whether the method was invoked directly via `swamp model method run` or
triggered by a workflow step. Both paths populate `swampSha`, `outputSpecs`,
`executionStatus`, and all other `MethodReportContext` fields. Reports also run
on failed executions in both paths, with `executionStatus: "failed"` and the
`errorMessage` field set.

## Report Context

The three context variants share a base set of fields and diverge based on
scope. See `src/domain/reports/report_context.ts`.

### Base Fields (all scopes)

| Field                  | Type                       | Description                              |
| ---------------------- | -------------------------- | ---------------------------------------- |
| `repoDir`              | `string`                   | Repository root path                     |
| `logger`               | `Logger`                   | LogTape logger for report output         |
| `dataRepository`       | `UnifiedDataRepository`    | Read/query persisted data                |
| `definitionRepository` | `DefinitionRepository`     | Read model definitions                   |

### MethodReportContext / ModelReportContext

Both method and model scope contexts carry the same fields:

| Field             | Type                         | Description                                  |
| ----------------- | ---------------------------- | -------------------------------------------- |
| `scope`           | `"method"` / `"model"`       | Discriminant                                 |
| `modelType`       | `ModelType`                  | The model type                               |
| `modelId`         | `string`                     | Model instance ID                            |
| `definition`      | `{ id, name, version, tags }`| Definition metadata                          |
| `globalArgs`      | `Record<string, unknown>`    | Evaluated global arguments                   |
| `methodArgs`      | `Record<string, unknown>`    | Per-method arguments                         |
| `methodName`      | `string`                     | Which method was invoked                     |
| `executionStatus` | `"succeeded"` / `"failed"`   | Method outcome                               |
| `dataHandles`     | `DataHandle[]`               | Data artifacts produced by the method        |

### WorkflowReportContext

| Field              | Type                             | Description                                   |
| ------------------ | -------------------------------- | --------------------------------------------- |
| `scope`            | `"workflow"`                     | Discriminant                                  |
| `workflowId`       | `string`                         | Workflow UUID                                 |
| `workflowRunId`    | `string`                         | Run UUID                                      |
| `workflowName`     | `string`                         | Workflow name                                 |
| `workflowStatus`   | `"succeeded"` / `"failed"`      | Overall run outcome                           |
| `stepExecutions`   | `StepExecution[]`                | Per-step details (job, model, method, status) |

Each `stepExecutions` entry contains `jobName`, `stepName`, `modelName`,
`modelType`, `methodName`, `status`, `dataHandles`, `methodArgs`, `modelId`,
and `globalArgs`.

## Standalone Report Extensions

Reports are implemented as TypeScript files in `extensions/reports/`. Each file
exports a `report` object:

```typescript
export const report = {
  name: "@myorg/cost-summary",
  description: "Summarize estimated costs from resource attributes",
  scope: "method" as const,
  labels: ["cost", "finops"],
  execute: async (context) => {
    // Analyze context.dataHandles, context.globalArgs, etc.
    return {
      markdown: "## Cost Summary\n...",
      json: { totalEstimatedCost: 42.50 },
    };
  },
};
```

### Name Convention

Report names follow the `@collective/name` pattern with optional nested path
segments (e.g., `@myorg/cost-report` or `@myorg/aws/cost-report`). This matches
the same naming convention used by models and other extension types. The
collective must match the extension's collective when distributed via
`extension push`.

### Loader Validation

`UserReportLoader` discovers `.ts` files recursively in the reports directory
(excluding `_test.ts`), bundles each with Deno (zod externalized), and
validates the export against a Zod schema requiring:

- `name` — matches `@collective/name[/subname/...]` or `collective/name[/subname/...]`
- `description` — non-empty string
- `scope` — one of `"method"`, `"model"`, `"workflow"`
- `labels` — optional `string[]`
- `execute` — function

Files without a `report` export are silently skipped (they may be utility
modules). Bundles are cached in `.swamp/report-bundles/` with mtime-based
invalidation.

See `src/domain/reports/user_report_loader.ts`.

## Report Registry

The `ReportRegistry` is a `Map`-backed registry of report definitions keyed by
name. Every report type exists in one of two states:

- **Fully loaded** — the bundle has been imported and the `ReportDefinition`
  (including its `execute` function) is available in the internal `reports`
  map. `register`, `get`, `getAll`, `getByScope`, and `has` all operate on
  fully-loaded entries.
- **Lazy** — the type is known to exist from the extension bundle catalog,
  but its bundle has not been imported yet. Lazy entries live in a separate
  `lazyTypes` map and are materialized from the on-disk catalog on second
  and subsequent process starts without touching the bundle files.
  `registerLazy`, `isLazy`, `getAllLazy`, and the `LazyReportEntry` type
  describe this state.

`ensureTypeLoaded(name)` promotes a single lazy entry to fully loaded by
importing its bundle on demand and invoking `promoteFromLazy`. Concurrent
callers for the same type share a single in-flight promise via an internal
`typeLoadPromises` map, so a burst of promotions still triggers at most one
bundle import per type. `ensureTypeLoaded` is a no-op for types that are
already loaded or not registered at all.

The CLI wires two hooks into the registry at startup (see `src/cli/mod.ts`):

- `setLoader` — a full eager-load fallback that walks the reports directory
  and imports every bundle. Triggered by `ensureLoaded()` and used when no
  catalog is available.
- `setTypeLoader` — a per-type loader that imports a single bundle via the
  catalog entry for that type. Backs `ensureTypeLoaded` in normal operation.

**Promotion contract for iteration.** Because `getAll()` returns only
fully-loaded entries, any domain service that iterates the registry (most
notably `executeReports` in `report_execution_service.ts`) must first call
`ensureTypeLoaded` for every candidate report name — typically the union of
`selection.require` and the model type's declared report defaults — before
calling `getAll()` and filtering the result. Skipping this promotion step
causes lazy user-extension reports to be silently filtered out of the
applicable set on the second and subsequent process runs (the catalog is
populated, so the fully-loaded map contains only eagerly-registered builtin
reports). Iteration without promotion is the regression fixed by issue #81
after the lazy-loading rework in #1089.

The global singleton uses `globalThis` so the same registry is shared across
module boundaries (important when extensions are loaded outside the bundle):

```typescript
const REPORT_REGISTRY_KEY = "__swampReportRegistry";
export const reportRegistry: ReportRegistry =
  (globalThis as any)[REPORT_REGISTRY_KEY] ??= new ReportRegistry();
```

Duplicate name registration throws an error. See
`src/domain/reports/report_registry.ts` for the full API.

## Three-Level Control Model

Reports are selected through three layers, from broadest to most specific:

### 1. Model-Type Defaults

A model type declares default reports via `ModelDefinition.reports: string[]`.
These are report names (not values) — the model references reports by name,
decoupling the model and report bounded contexts:

```typescript
export const model = {
  type: "@myorg/ec2-instance",
  reports: ["@myorg/cost-summary", "@myorg/compliance-check"],
  // ...
};
```

All registered reports whose name appears in this list are candidates whenever
a method runs on this model type.

### 2. Definition YAML Overrides

Each definition can refine which reports run via a `reports` field:

```yaml
reports:
  require:
    - "@myorg/cost-summary"
    - name: "@myorg/security-audit"
      methods: ["create", "update"]
  skip:
    - "@myorg/compliance-check"
```

- **`require`** — reports listed here are added to the candidate set and are
  immune to CLI skip flags. Entries can be a plain string (applies to all
  methods) or an object with `name` and optional `methods` array for method
  scoping.
- **`skip`** — reports listed here are always skipped. Skip wins over require
  if the same report appears in both.

### 3. Workflow YAML Overrides

Workflows also support a `reports` field at the workflow level with the same
`require`/`skip` structure. This applies to workflow-scope reports.

```yaml
reports:
  require:
    - "@myorg/workflow-summary"
  skip:
    - "@myorg/verbose-audit"
```

## Report Selection

The `ReportSelection` type and `ReportRef` union define the YAML-driven
selection schema. See `src/domain/reports/report_selection.ts`.

```typescript
type ReportRef = string | { name: string; methods?: string[] };

type ReportSelection = {
  require?: ReportRef[];
  skip?: string[];
};
```

The `ReportSelectionSchema` (Zod) validates report selection in both definition
and workflow YAML files.

## Filtering Semantics

The `filterReports` function in `report_execution_service.ts` applies the full
filtering pipeline. The algorithm:

1. **Build candidate set** — union of model-type defaults
   (`ModelDefinition.reports`) and `selection.require` names. For workflow scope
   (no model-type defaults), candidates are `selection.require` only.
2. **Scope filter** — only reports matching the requested scope pass.
3. **Definition/workflow skip** — `selection.skip` names are removed. Skip
   always wins.
4. **Method scoping** — required refs with a `methods` array are excluded when
   the current method is not in the list.
5. **Required immunity** — reports in `selection.require` survive all CLI skip
   flags.
6. **CLI skip flags** — `--skip-reports` removes all non-required reports.
   `--skip-report <name>` and `--skip-report-label <label>` remove matching
   non-required reports.
7. **Inclusion filters** — `--report <name>` and `--report-label <label>`
   narrow the remaining set to only matching reports.

Key invariants:

- **Skip always wins over require.** If a report is in both `skip` and
  `require`, it is skipped.
- **Required reports are immune to CLI skip flags.** `--skip-reports` and
  `--skip-report <name>` cannot suppress a required report.
- **Only candidates run.** A report must be in model-type defaults or in
  `require` to be considered. Registration alone is not enough.

## Data Persistence

Report results are automatically persisted as data artifacts via
`persistReportData`. Each report produces two artifacts:

| Artifact   | Data name                     | Content type         |
| ---------- | ----------------------------- | -------------------- |
| Markdown   | `report-{reportName}`         | `text/markdown`      |
| JSON       | `report-{reportName}-json`    | `application/json`   |

Both artifacts are written with:

- **Lifetime**: `30d`
- **Garbage collection**: `5` (keep latest 5 versions)
- **Tags**: `{ type: "report", reportName, reportScope }`

Data handles are returned in the `ReportExecutionResult` and included in the
final view.

## Sensitive Argument Redaction

Report contexts include an optional `redactSensitiveArgs` helper that replaces
values marked `{ sensitive: true }` in the model type's Zod schema with `"***"`.
The helper is built by `buildRedactSensitiveArgs` in
`src/domain/reports/report_execution_service.ts` and attached to the context
before report execution.

```typescript
redactSensitiveArgs?(
  args: Record<string, unknown>,
  argsKind: "global" | "method",
): Record<string, unknown>;
```

The helper uses `extractSensitiveFields` from
`src/domain/models/sensitive_field_extractor.ts` to walk the model type's Zod
schema, then deep-clones the args and replaces matching values with `"***"`.

- **Method/model scope** — looks up the schema via `modelRegistry.get(modelType)`
  and returns a redacted clone.
- **Workflow scope** — returns args unchanged (no single model type to look up).
- **No schema found** — returns args unchanged. Safe to call unconditionally.

Reports that include argument values in their output should call
`context.redactSensitiveArgs(args, kind)` to avoid persisting secrets. The
builtin `@swamp/method-summary` report uses this for both global and method
arguments.

Additionally, report contexts receive **pre-vault** arguments — args are
captured before `resolveRuntimeExpressionsInDefinition` replaces vault
expressions with sentinel tokens. This ensures vault expression strings like
`${{ vault.default.password }}` appear in reports, never the resolved secret
values.

## CLI

### `swamp model report`

Runs reports for a model without executing a method. Uses the evaluated
(post-CEL) definition when available.

```bash
swamp model report my-model
swamp model report my-model --method create
swamp model report my-model --label cost
```

| Flag               | Description                                     |
| ------------------ | ----------------------------------------------- |
| `--method <name>`  | Simulate a method context for report scoping    |
| `--label <label>`  | Only run reports matching this label (repeatable)|

See `src/cli/commands/model_report.ts`.

### Report Flags on `model method run`

| Flag                              | Description                                      |
| --------------------------------- | ------------------------------------------------ |
| `--skip-reports`                  | Skip all post-run reports                        |
| `--skip-report <name>`           | Skip a specific report by name (repeatable)      |
| `--skip-report-label <label>`    | Skip reports matching a label (repeatable)       |
| `--report <name>`                | Only run this report (inclusion, repeatable)     |
| `--report-label <label>`         | Only run reports with this label (inclusion)     |

### Report Flags on `workflow run`

| Flag                              | Description                                      |
| --------------------------------- | ------------------------------------------------ |
| `--skip-reports`                  | Skip all post-run reports                        |
| `--skip-report <name>`           | Skip a specific report by name (repeatable)      |
| `--skip-report-label <label>`    | Skip reports matching a label (repeatable)       |
| `--report <name>`                | Only run this report (inclusion, repeatable)     |
| `--report-label <label>`         | Only run reports with this label (inclusion)     |

## Output

Reports support two output modes, consistent with the rest of the CLI:

- **Log mode** — renders each report's markdown to the terminal with a
  separator header showing the report name. Uses `renderMarkdownToTerminal`
  for terminal-friendly formatting.
- **JSON mode** — emits a single JSON object with the full `ModelReportView`
  containing all report results (name, scope, success, markdown, json, error).

See `src/presentation/renderers/model_report.ts`.

## Reports Directory Resolution

The reports directory is resolved with the same priority as other extension
directories:

1. `SWAMP_REPORTS_DIR` environment variable
2. `reportsDir` in `.swamp.yaml`
3. Default: `extensions/reports/`

See `src/cli/resolve_reports_dir.ts`.
