# Report Types Reference

## ReportDefinition Interface

```typescript
interface ReportDefinition {
  /** Human-readable description of what the report produces. */
  description: string;
  /** The scope at which this report operates. */
  scope: ReportScope;
  /** Labels for filtering (e.g., ["cost", "finops"]). */
  labels?: string[];
  /** Execute the report and produce results. */
  execute(context: ReportContext): Promise<ReportResult>;
}
```

## ReportScope

```typescript
type ReportScope = "method" | "model" | "workflow";
```

| Scope      | When it runs                        | Context type            |
| ---------- | ----------------------------------- | ----------------------- |
| `method`   | After a single method execution     | `MethodReportContext`   |
| `model`    | After method-scope reports complete | `ModelReportContext`    |
| `workflow` | After a workflow run completes      | `WorkflowReportContext` |

## ReportResult

```typescript
interface ReportResult {
  /** Human-readable markdown content. */
  markdown: string;
  /** Machine-readable structured data. */
  json: Record<string, unknown>;
}
```

## Context Types

### Base Fields (shared by all contexts)

```typescript
interface BaseReportContext {
  repoDir: string;
  logger: Logger;
  dataRepository: UnifiedDataRepository;
  definitionRepository: DefinitionRepository;
}
```

### MethodReportContext

```typescript
interface MethodReportContext extends BaseReportContext {
  scope: "method";
  modelType: ModelType;
  modelId: string;
  definition: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  globalArgs: Record<string, unknown>;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  dataHandles: DataHandle[];
}
```

### ModelReportContext

Same fields as `MethodReportContext` but with `scope: "model"`. Runs after all
method-scope reports complete.

### WorkflowReportContext

```typescript
interface WorkflowReportContext extends BaseReportContext {
  scope: "workflow";
  workflowId: string;
  workflowRunId: string;
  workflowName: string;
  workflowStatus: "succeeded" | "failed";
  stepExecutions: Array<{
    jobName: string;
    stepName: string;
    modelName: string;
    modelType: string;
    methodName: string;
    status: "succeeded" | "failed" | "skipped";
    dataHandles: DataHandle[];
  }>;
}
```

## Report Registry

**Extension models define reports inline** on the model's `reports` field (just
like `checks` and `methods`). The model loader auto-registers them — do not call
`register()` directly from extension code.

The global `reportRegistry` singleton manages report registration internally:

```typescript
reportRegistry.get("my-report"); // ReportDefinition | undefined
reportRegistry.has("my-report"); // boolean
reportRegistry.getAll(); // Array<{ name, report }>
reportRegistry.getByScope("method"); // Array<{ name, report }>
```

Names must be unique — `register()` throws on duplicates.

## Report Selection Schema (YAML)

```typescript
const ReportRefSchema = z.union([
  z.string(), // shorthand: applies to all methods
  z.object({
    name: z.string(),
    methods: z.array(z.string()).optional(), // restrict to specific methods
  }),
]);

const ReportSelectionSchema = z.object({
  require: z.array(ReportRefSchema).optional(),
  skip: z.array(z.string()).optional(),
}).optional();
```

## Filtering Precedence

1. Definition-level `skip` always wins (even over `require`)
2. YAML method scoping is respected
3. `require` makes reports immune to CLI skip flags
4. CLI `--skip-report` / `--skip-report-label` apply to non-required reports
5. CLI `--report` / `--report-label` narrow to a subset (inclusion filter)

## Data Persistence

Report results are automatically persisted as data artifacts:

- **Markdown**: data name `report-{reportName}`, content type `text/markdown`
- **JSON**: data name `report-{reportName}-json`, content type
  `application/json`
- **Lifetime**: 30 days
- **Garbage collection**: keeps 5 versions
- **Tags**: `type=report`, `reportName={name}`, `reportScope={scope}`
