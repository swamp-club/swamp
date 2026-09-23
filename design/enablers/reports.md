---
audience: maintainer, extension-author
enables: [models, workflows]
last-verified: 2026-08-28 @ 3d5955a9
---

# Reports

Reports are analysis functions that run after a method completes, or on demand.
They turn model and workflow execution context into markdown and JSON, saved as
data artifacts. Reports work on whatever context they get at runtime, not on
specific model types, so report logic stays separate from model code.

## Report Definition

A report implements the `ReportDefinition` interface:

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

- **description**: what the report produces, for humans.
- **scope**: `"method"`, `"model"` or `"workflow"`. Sets which context variant
  the report receives.
- **labels**: optional tags for filtering (e.g., `["cost",
  "finops"]`).
- **execute**: analyses the context and returns a result.

The full interface is in `src/domain/reports/report.ts`.

## Scopes

Each report declares a scope, which sets the shape of the context passed to
`execute`.

| Scope      | When it runs                             | Context variant          |
| ---------- | ---------------------------------------- | ------------------------ |
| `method`   | After a single method execution          | `MethodReportContext`    |
| `model`    | After a method execution (model-level)   | `ModelReportContext`     |
| `workflow`  | After a full workflow run completes      | `WorkflowReportContext`  |

Reports with `scope: "method"` or `scope: "model"` run against one model
instance and method call. Reports with `scope: "workflow"` run after all
workflow steps complete and get summary data for every step.

### Execution Path Parity

Method-scope and model-scope reports get the same context fields whether the
method ran directly via `swamp model method run` or from a workflow step. Both
paths fill `swampSha`, `outputSpecs`, `executionStatus` and every other
`MethodReportContext` field. In both paths, reports also run on failed
executions, with `executionStatus: "failed"` and `errorMessage` set.

## Report Context

The three context variants share base fields and differ by scope
(`src/domain/reports/report_context.ts`).

### Base Fields (all scopes)

| Field                  | Type                       | Description                              |
| ---------------------- | -------------------------- | ---------------------------------------- |
| `repoDir`              | `string`                   | Repository root path                     |
| `logger`               | `Logger`                   | LogTape logger for report output         |
| `dataRepository`       | `UnifiedDataRepository`    | Read/query persisted data                |
| `definitionRepository` | `DefinitionRepository`     | Read model definitions                   |
| `swampSha?`            | `string`                   | Git commit sha of the swamp repo at execution time |

### MethodReportContext / ModelReportContext

Method and model scope contexts have the same core fields. Only method-scope
contexts also have `extensionFile`.

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
| `errorMessage?`   | `string`                     | Error message when execution failed          |
| `dataHandles`     | `DataHandle[]`               | Data artifacts produced by the method        |
| `outputSpecs?`    | `OutputSpecInfo[]`           | Output spec schemas from the model type definition |
| `extensionFile`   | `(relPath: string) => string`| Resolve extension asset path (method-scope only) |

### WorkflowReportContext

| Field              | Type                             | Description                                   |
| ------------------ | -------------------------------- | --------------------------------------------- |
| `scope`            | `"workflow"`                     | Discriminant                                  |
| `workflowId`       | `string`                         | Workflow UUID                                 |
| `workflowRunId`    | `string`                         | Run UUID                                      |
| `workflowName`     | `string`                         | Workflow name                                 |
| `workflowStatus`   | `"succeeded"` / `"failed"`      | Overall run outcome                           |
| `inputs?`          | `Record<string, unknown>`        | Workflow inputs captured for the run          |
| `stepExecutions`   | `StepExecution[]`                | Per-step details (job, task, status)          |

Each `stepExecutions` entry has `jobName`, `stepName`, `taskType`, `modelName`,
`modelType`, `methodName`, `status` (`"succeeded"`, `"failed"` or
`"skipped"`), `dataHandles`, `methodArgs`, `modelId`, `globalArgs` and an
optional `errorMessage`. `taskType` is the step's task kind (`model_method`,
`assert`, `manual_approval`, `workflow`). For non-model tasks, the model fields
(`modelName`, `modelType`, `methodName`, `modelId`) are empty strings, and
`errorMessage` holds the failure reason if the step failed.

## Standalone Report Extensions

Reports are TypeScript files in `extensions/reports/`. Each file exports a
`report` object:

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

Report names use the `@collective/name` pattern, with optional nested path
segments (e.g., `@myorg/cost-report` or `@myorg/aws/cost-report`), as models
and other extension types do. When distributed via `extension push`, the
collective must match the extension's collective.

### Loader Validation

The shared extension loader (`src/domain/extensions/extension_loader.ts`) is
configured with `reportKindAdapter`
(`src/domain/extensions/report_kind_adapter.ts`). It finds `.ts` files
recursively in the reports directory (except `_test.ts`) and bundles each with
Deno (zod externalized). It then validates the `report` export against the
adapter's Zod schema (`UserReportSchema`), which requires:

- `name`: matches `@collective/name[/subname/...]` or
  `collective/name[/subname/...]`, with lowercase `[a-z0-9_-]` segments only
  (`USER_REPORT_NAME_PATTERN`)
- `description`: non-empty string
- `scope`: one of `"method"`, `"model"`, `"workflow"`
- `labels`: optional `string[]`
- `execute`: function

Files without a `report` export are silently skipped; they may be utility
modules. Bundles are cached in `.swamp/report-bundles/` and invalidated by
content fingerprint (sha-256 over the entry point plus every local `.ts` dep).
mtime checks were unreliable with atomic-rename saves, mtime-preserving sync
tools and sub-millisecond edits (issue #125).

## Report Registry

`ReportRegistry` is a `Map`-backed registry of report definitions keyed by
name. Each report type is in one of two states:

- **Fully loaded**: the bundle is imported and the `ReportDefinition` (with its
  `execute` function) is in the internal `reports` map. `register`, `get`,
  `getAll`, `getByScope` and `has` all work on fully loaded entries.
- **Lazy**: the extension bundle catalog lists the type, but its bundle is not
  imported yet. Lazy entries live in a separate `lazyTypes` map, built from the
  on-disk catalog on the second and later process starts without reading the
  bundles. `registerLazy`, `isLazy`, `getAllLazy` and the `LazyReportEntry`
  type cover this state.

`ensureTypeLoaded(name)` imports one lazy entry's bundle on demand and calls
`promoteFromLazy` to make it fully loaded. Concurrent callers for the same type
share one in-flight promise through an internal `typeLoadPromises` map, so a
burst of promotions imports each bundle at most once. `ensureTypeLoaded` does
nothing for types that are already loaded or not registered.

The CLI sets two hooks on the registry at startup (`src/cli/mod.ts`):

- `setLoader`: a full eager-load fallback that walks the reports directory and
  imports every bundle. `ensureLoaded()` triggers it when no catalog is
  available.
- `setTypeLoader`: a per-type loader that imports one bundle via that type's
  catalog entry. It backs `ensureTypeLoaded` in normal operation.

**Promotion contract for iteration.** `getAll()` returns only fully loaded
entries. Any domain service that iterates the registry (chiefly
`executeReports` in `report_execution_service.ts`) must first call
`ensureTypeLoaded` for every candidate name, then call `getAll()` and filter.
Candidates are usually `selection.require` plus the model type's declared
report defaults. Skip this and lazy user-extension reports silently vanish on
the second and later process runs, when the populated catalog leaves only
eagerly registered builtins in the fully loaded map. Issue #81 fixed this
regression after the lazy-loading rework in #1089.

The global singleton uses `globalThis` so every module shares the same
registry. This matters when extensions are loaded outside the bundle:

```typescript
const REPORT_REGISTRY_KEY = "__swampReportRegistry";
export const reportRegistry: ReportRegistry =
  (globalThis as any)[REPORT_REGISTRY_KEY] ??= new ReportRegistry();
```

Registering a duplicate name throws. The full API is in
`src/domain/reports/report_registry.ts`.

## Three-Level Control Model

Three layers select reports, from broadest to most specific.

### 1. Model-Type Defaults

A model type declares default reports in `ModelDefinition.reports: string[]`.
These are report names, not values, so the model and report bounded contexts
stay separate:

```typescript
export const model = {
  type: "@myorg/ec2-instance",
  reports: ["@myorg/cost-summary", "@myorg/compliance-check"],
  // ...
};
```

Every registered report named in this list is a candidate whenever a method
runs on this model type.

### 2. Definition YAML Overrides

Each definition can adjust which reports run with a `reports` field:

```yaml
reports:
  require:
    - "@myorg/cost-summary"
    - name: "@myorg/security-audit"
      methods: ["create", "update"]
  skip:
    - "@myorg/compliance-check"
```

- **`require`**: these reports join the candidate set and ignore CLI skip
  flags. An entry is a plain string (all methods) or an object with `name` and
  an optional `methods` array to limit it to those methods.
- **`skip`**: these reports never run. If a report is in both lists, skip wins.

### 3. Workflow YAML Overrides

Workflows also accept a workflow-level `reports` field with the same
`require`/`skip` structure. It applies to workflow-scope reports.

```yaml
reports:
  require:
    - "@myorg/workflow-summary"
  skip:
    - "@myorg/verbose-audit"
```

## Report Selection

The `ReportSelection` type and `ReportRef` union define the YAML selection
schema (`src/domain/reports/report_selection.ts`).

```typescript
type ReportRef = string | { name: string; methods?: string[] };

type ReportSelection = {
  require?: ReportRef[];
  skip?: string[];
};
```

`ReportSelectionSchema` (Zod) validates report selection in both definition and
workflow YAML files.

## Filtering Semantics

`filterReports` in `report_execution_service.ts` runs these steps:

1. **Build candidate set**: the union of model-type defaults
   (`ModelDefinition.reports`) and `selection.require` names. Workflow scope has
   no model-type defaults, so its candidates are `selection.require` only.
2. **Scope filter**: only reports for the requested scope pass.
3. **Definition/workflow skip**: `selection.skip` names are removed. Skip
   always wins.
4. **Method scoping**: required refs with a `methods` array are dropped when
   the current method is not listed.
5. **Required immunity**: reports in `selection.require` survive every CLI
   skip flag.
6. **CLI skip flags**: `--skip-reports` removes all non-required reports.
   `--skip-report <name>` and `--skip-report-label <label>` remove matching
   non-required reports.
7. **Inclusion filters**: `--report <name>` and `--report-label <label>` keep
   only matching reports.

### Unresolvable Required Reports

A `selection.require` name that matches nothing, neither loaded nor
lazy-indexed after promotion, is a contract violation and is not silently
ignored (swamp-club#640). `executeReports` then logs a warning naming the
report and emits a `report_failed` event. It saves a fallback error artifact,
so `swamp report search` shows the failure, and counts it in
`ReportExecutionSummary.failures`. That makes `swamp model method run` fail,
as a required report that loads and then throws would. Names also listed
in `selection.skip` are exempt, because skip wins and the report was never
going to run.

Runners that call `executeReports` more than once with the same selection
(method and model scope passes) avoid a duplicate failure with the
`emitUnresolvableRequireFailures` parameter, passing `true` on exactly one
call.

### Filter Options Are Optional

`ReportFilterOptions` carries CLI flags. Callers of the workflow execution
service with no CLI flags to pass (workflow resume, embedded runs) leave it
out. No filter means no filtering: the service defaults it to `{}`, so all
reports, including required ones, run. Report execution must never depend on
the presentation layer providing an options object.

Key invariants:

- **Skip always wins over require.** A report in both `skip` and `require` is
  skipped.
- **Required reports are immune to CLI skip flags.** `--skip-reports` and
  `--skip-report <name>` cannot stop a required report.
- **Only candidates run.** A report must be in model-type defaults or in
  `require`. Being registered is not enough.

## Data Persistence

`persistReportData` saves report results as data artifacts. Each report
produces two:

| Artifact   | Data name                     | Content type         |
| ---------- | ----------------------------- | -------------------- |
| Markdown   | `report-{reportName}`         | `text/markdown`      |
| JSON       | `report-{reportName}-json`    | `application/json`   |

`{reportName}` is the report name after `sanitizeReportNameForData`, which
replaces path-unsafe characters such as `/`. forEach iterations add the vary
suffix: `report-{reportName}-{suffix}` and `report-{reportName}-{suffix}-json`.

Both artifacts are written with:

- **Lifetime**: `30d`
- **Garbage collection**: `5` (keep latest 5 versions)
- **Tags**: `{ type: "report", reportName, reportScope }`

**Empty results are not persisted.** If `execute()` returns empty markdown
(after trimming), nothing is saved and the previous version stays `latest`.
This stops method-scoped reports that return nothing for some methods from
hiding real content behind 0-byte versions.

Data handles are returned in the `ReportExecutionResult` and included in the
final view.

## Error Handling

A throw from a report's `execute()` **flips the run status to "failed"** and
changes the exit code. The final `ModelMethodRunView.status` is `"failed"` when
`reportFailures > 0`.

When `execute()` throws, swamp builds a fallback error artifact with the
built-in `buildReportErrorResult` function
(`src/domain/reports/builtin/report_error_report.ts`). It is saved under the
same data name the report would have used, so
`swamp data get report-{reportName}-json` still returns useful diagnostics.

The fallback JSON artifact contains:

```json
{
  "error": true,
  "reportName": "@example/failing-report",
  "scope": "workflow",
  "message": "the error message from the throw"
}
```

Consumers check the `error` field to tell a fallback error artifact from a real
result.

A required report that cannot be resolved at all gets the same fallback
artifact (see "Unresolvable Required Reports" above). Its `message` field holds
the "Required report not found" diagnostic instead of a throw from `execute()`.

If saving the fallback artifact fails, that error is silently dropped so it
does not hide the original report error. Only the `WRN` log line then carries
the error.

## Sensitive Argument Redaction

The builtin `@swamp/method-summary` report records argument names only and
never saves argument values. Its markdown and JSON artifacts list argument keys
(`string[]`), not key-value objects. This removes the risk of leaking secrets
passed as literal `--input` values or resolved from expressions
(swamp-club#1746).

Report contexts also include an optional `redactSensitiveArgs` helper for
custom extension reports that show argument values. It replaces values marked
`{ sensitive: true }` in the model type's Zod schema with `"***"`.
`buildRedactSensitiveArgs` builds it and attaches it to the context before the
report runs (`src/domain/reports/report_execution_service.ts`).

```typescript
redactSensitiveArgs?(
  args: Record<string, unknown>,
  argsKind: "global" | "method",
): Record<string, unknown>;
```

The helper calls the shared `redactSensitiveValues(schema, data)` primitive
(`src/domain/models/sensitive_field_extractor.ts`). That walks the model type's
Zod schema via `extractSensitiveFields`, deep-clones the args, and replaces
matching values with `"***"`.

- **Method/model scope**: looks up the schema via `modelRegistry.get(modelType)`
  and returns a redacted clone.
- **Workflow scope**: returns args unchanged, since there is no single model
  type to look up.
- **No model definition found**: returns every value as `"***"` via
  `redactAllValues`. This is the safe default when there is no schema for
  field-level redaction.
- **No argument schema found**: returns every value as `"***"` via
  `redactAllValues`.

Custom extension reports that output argument values should call
`context.redactSensitiveArgs(args, kind)` so they do not save secrets.

`redactSensitiveValues` is the one redaction primitive for every surface that
honors the `sensitive: true` flag. `swamp model get` applies it to a model's
global arguments in the libswamp read path before building `ModelGetData`
(`src/libswamp/models/get.ts`). The log and JSON renderers, and
`swamp model search` (same read path), therefore show `"***"`. With no model
type, the schema is unknown and `redactAllValues` redacts everything, as in the
report path.

Report contexts also get pre-vault arguments. Args are captured before
`resolveRuntimeExpressionsInDefinition` replaces vault expressions with
sentinel tokens. Reports therefore show vault expression strings like
`${{ vault.get('default', 'password') }}`, never the resolved secrets.

## CLI

### `swamp report list` / `swamp report type search`

These list registered report definitions: the report types currently loaded
from extensions and builtins. `swamp report search` is different; it lists
stored report results (artifacts from past runs).

`swamp report list` is an alias for `swamp report type search`. Both open an
interactive TUI picker with each report's name, scope and description. Pass
`--json` for structured output.

```bash
swamp report list
swamp report list cost
swamp report type search
swamp report type search --json
```

### `swamp report get`

Reads a stored report's content. Reports are saved automatically after method
execution.

```bash
swamp report get cost-summary --model my-model
swamp report get cost-summary --model my-model --markdown
swamp report get cost-summary --model my-model --json
swamp report get cost-summary --workflow deploy-pipeline
```

| Flag                    | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `--model <name>`        | Scope to a specific model                            |
| `--workflow <name>`     | Scope to a specific workflow                         |
| `--version <version>`   | Get specific version number (default: latest)        |
| `--variant <variant>`   | Select a specific forEach variant                    |
| `--markdown`            | Plain markdown, not terminal-formatted; conflicts with `--json` |
| `--json`                | Output in JSON format                                |
| `--max-width <width>`   | Cap total output width in columns                    |
| `--max-col-width <width>` | Cap individual table column width in characters   |

### Report Flags on `model method run`

| Flag                              | Description                                      |
| --------------------------------- | ------------------------------------------------ |
| `--skip-reports`                  | Skip all post-run reports                        |
| `--skip-report <name>`           | Skip a specific report by name (repeatable)      |
| `--skip-report-label <label>`    | Skip reports matching a label (repeatable)       |
| `--report <name>`                | Only run this report (inclusion, repeatable)     |
| `--report-label <label>`         | Only run reports with this label (inclusion)     |

### Report Flags on `workflow run`

The same five flags as on `model method run`, with the same meanings:
`--skip-reports`, `--skip-report <name>`, `--skip-report-label <label>`,
`--report <name>`, `--report-label <label>`.

## Output

Reports support the CLI's two output modes:

- **Log mode**: renders each report's markdown to the terminal under a
  separator header with the report name, using `renderMarkdownToTerminal`.
- **JSON mode**: emits one JSON object, the full `ModelReportView`, with all
  report results (name, scope, success, markdown, json, error).

See `src/presentation/renderers/model_method_run.ts`.

## Reports Directory Resolution

The reports directory is resolved in the same order as other extension
directories:

1. `SWAMP_REPORTS_DIR` environment variable
2. `reportsDir` in `.swamp.yaml`
3. Default: `extensions/reports/`

Reports placed next to models in `paths.base: manifest` extensions are also
found. If a manifest such as `extensions/models/myext/manifest.yaml` declares
`reports:` entries with `paths.base: manifest`, its directory is added as a
report source directory at startup (`discoverManifestCrossKindDirs` in
`src/cli/mod.ts`).

See `src/cli/resolve_reports_dir.ts`.
