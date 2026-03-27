# Tracing

Swamp has native OpenTelemetry (OTel) tracing that captures the full execution
hierarchy from CLI command through workflow orchestration to individual model
method and driver execution. Tracing is opt-in and has zero overhead when
disabled — the `@opentelemetry/api` package returns no-op implementations when
no provider is registered.

## Configuration

Tracing is controlled entirely through standard OTel environment variables. No
CLI flags or configuration files are needed.

| Variable                       | Purpose                                   | Default               |
| ------------------------------ | ----------------------------------------- | --------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector URL (tracing off when unset)    | _(unset = off)_       |
| `OTEL_TRACES_EXPORTER`        | Exporter: `otlp`, `console`, or `none`    | `otlp`                |
| `OTEL_SERVICE_NAME`           | Service name in traces                    | `swamp`               |
| `OTEL_EXPORTER_OTLP_HEADERS`  | Auth headers (comma-separated `key=val`)  | _(none)_              |

### Enabling Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to point at an OTLP-compatible collector:

```bash
# Send traces to a local Jaeger instance
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Send traces to Honeycomb
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=your-api-key"

# Debug: print spans to stderr
export OTEL_TRACES_EXPORTER=console
```

When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset and `OTEL_TRACES_EXPORTER` is not
`console`, tracing is completely disabled. No SDK packages are loaded, no context
manager is installed, and all tracer/span operations are no-ops.

### Local Development

Run Jaeger for a local trace UI:

```bash
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

Then run any swamp command with tracing enabled:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 swamp workflow run my-workflow
```

Open `http://localhost:16686` and search for the `swamp` service.

## Span Hierarchy

Traces capture the full execution tree. A workflow run produces a hierarchy like:

```
swamp.cli "workflow run"
  ├─ swamp.lock.acquire
  ├─ swamp.datastore.sync (pull)
  └─ swamp.workflow.run.command
       └─ swamp.workflow.run "deploy"
            ├─ swamp.workflow.evaluate
            ├─ swamp.workflow.job "build"
            │    ├─ swamp.workflow.step "compile"
            │    │    └─ swamp.model.method "app.build"
            │    │         └─ swamp.driver.execute "raw"
            │    │              └─ (extension spans — automatic)
            │    └─ swamp.workflow.step "test"
            │         └─ swamp.model.method "app.test"
            │              └─ swamp.driver.execute "docker"
            │                   └─ (TRACEPARENT env var propagated)
            └─ swamp.workflow.job "deploy"
                 └─ swamp.workflow.step "apply"
                      └─ swamp.model.method "ec2.create"
                           └─ swamp.driver.execute "raw"
```

## Instrumentation Points

### CLI Root Span

Every CLI invocation creates a `swamp.cli` root span that encompasses the entire
command lifecycle. Attributes include `swamp.command`, `swamp.subcommand`,
`swamp.version`, `swamp.args` (sanitized positional arguments),
`swamp.option_keys` (command-specific option names), and `swamp.global_options`
(global flags like `--json`, `--verbose`).

### Libswamp Generator Spans

Every libswamp generator is wrapped with `withGeneratorSpan`, producing a span
for the full duration of the operation. These spans use the naming convention
`swamp.<domain>.<operation>`:

| Domain       | Span Names                                                                      |
| ------------ | ------------------------------------------------------------------------------- |
| `auth`       | `swamp.auth.login`                                                              |
| `audit`      | `swamp.audit.timeline`                                                          |
| `data`       | `swamp.data.get`, `.list`, `.search`, `.versions`, `.rename`, `.gc`             |
| `datastore`  | `swamp.datastore.setup`, `.status`, `.sync.command`, `.lock.status`, `.lock.release` |
| `extension`  | `swamp.extension.pull`, `.push`, `.search`, `.update`, `.yank`, `.rm`, `.fmt`, `.list` |
| `issue`      | `swamp.issue.create`                                                            |
| `model`      | `swamp.model.create`, `.delete`, `.edit`, `.get`, `.search`, `.validate`        |
| `model`      | `swamp.model.method.run`, `.method.describe`, `.method.history.logs`            |
| `model`      | `swamp.model.output.search`, `.output.get`, `.output.logs`, `.output.data`     |
| `report`     | `swamp.report.describe`, `.get`, `.search`                                      |
| `repo`       | `swamp.repo.create`, `.upgrade`                                                 |
| `source`     | `swamp.source.fetch`, `.clean`                                                  |
| `telemetry`  | `swamp.telemetry.stats`                                                         |
| `type`       | `swamp.type.describe`, `.search`                                                |
| `update`     | `swamp.update.check`                                                            |
| `vault`      | `swamp.vault.create`, `.describe`, `.edit`, `.get`, `.list_keys`, `.put`, `.search`, `.type_search` |
| `workflow`   | `swamp.workflow.create`, `.delete`, `.edit`, `.get`, `.search`, `.validate`, `.schema` |
| `workflow`   | `swamp.workflow.run.command`, `.history.get`, `.history.logs`, `.history.search`, `.run_search` |

Generator spans automatically detect `kind: "error"` events and mark the span
status as ERROR.

### Domain-Layer Spans

The workflow execution engine and method execution service create fine-grained
spans for the execution hierarchy:

| Span Name                   | Created By                         | Attributes                                     |
| --------------------------- | ---------------------------------- | ---------------------------------------------- |
| `swamp.workflow.run`        | `WorkflowExecutionService.run()`   | `workflow.name`, `workflow.id`, `workflow.run_id` |
| `swamp.workflow.evaluate`   | `evaluateWorkflow()`               | `workflow.name`, `workflow.expressions_evaluated` |
| `swamp.workflow.job`        | `runJob()`                         | `job.name`, `job.status`                       |
| `swamp.workflow.step`       | `runStep()`                        | `step.name`, `job.name`, `step.task.type`      |
| `swamp.model.method`        | `executeWorkflow()`                | `model.name`, `model.type`, `method.name`      |
| `swamp.driver.execute`      | method execution service           | `driver.type`, `model.type`                    |

### Infrastructure Spans

| Span Name               | Created By                     | Attributes                              |
| ------------------------ | ------------------------------ | --------------------------------------- |
| `swamp.lock.acquire`    | `registerDatastoreSyncNamed()` | `lock.key`, `lock.label`                |
| `swamp.datastore.sync`  | sync coordinator               | `sync.direction` (pull/push), `sync.file_count` |
| `swamp.repo.init`       | `requireInitializedRepo()`     | _(none)_                                |

## Context Propagation

### In-Process (Automatic)

The OTel SDK uses `AsyncLocalStorageContextManager` to propagate trace context
through async call chains. When `tracer.startActiveSpan()` or
`tracer.startSpan()` creates a span inside an active context, parent-child
relationships are established automatically. This means:

- Extensions running in-process (raw driver) inherit the active span context
  automatically — their OTel-instrumented code creates child spans without any
  manual wiring.
- `yield*` delegation in async generators preserves context across generator
  boundaries.

### Cross-Process (Docker Driver)

For out-of-process execution, W3C Trace Context headers are propagated:

1. `injectTraceContext()` extracts `traceparent` and `tracestate` from the
   current active context into a `Record<string, string>`.
2. The `ExecutionRequest.traceHeaders` field carries these headers.
3. The Docker driver passes them as container environment variables
   (`TRACEPARENT`, `TRACESTATE`).
4. Extensions running in Docker can read these env vars and connect their spans
   to the parent trace.

```
HOST PROCESS                         DOCKER CONTAINER
─────────────                        ────────────────

active span context
  │
  ├─ injectTraceContext()
  │   → { traceparent: "00-abc..." }
  │
  ├─ ExecutionRequest.traceHeaders
  │
  └─ docker run -e TRACEPARENT=00-abc...
                                     TRACEPARENT env var
                                       │
                                       └─ Extension reads env var
                                          and connects to parent trace
```

## SDK Initialization

### Dynamic Loading

All OTel SDK packages (`sdk-trace-base`, `exporter-trace-otlp-http`,
`context-async-hooks`, `resources`, `semantic-conventions`) are loaded via
dynamic `import()` only when tracing is enabled. The `@opentelemetry/api`
package is statically imported because it is designed as a zero-cost no-op when
no provider is registered.

### Lifecycle

```
main.ts:
  initTracing()          ← Check env vars, optionally load SDK
    │
    ├─ No endpoint?  → return (no-op)
    │
    └─ Endpoint set?
         ├─ Create AsyncLocalStorageContextManager
         ├─ Create BasicTracerProvider with Resource
         ├─ Add BatchSpanProcessor with exporter
         └─ Register as global provider
    │
  runCli(args)           ← All spans created during execution
    │
  shutdownTracing()      ← Flush pending spans, disable context manager
```

### Zero-Cost When Disabled

When tracing is disabled:

- `getTracer()` returns a no-op tracer
- `tracer.startSpan()` returns a no-op span (all-zeros traceId)
- `withSpan()` calls the wrapped function directly
- `withGeneratorSpan()` iterates the wrapped generator directly
- `injectTraceContext()` returns an empty object
- No SDK packages are loaded, no async hooks are installed

## Utilities

### `withSpan(name, attributes, fn)`

Wraps an async function with a span. Creates the span, sets it as active,
executes the function, records errors, and ends the span in all code paths.
Used for regular async methods (e.g., `executeWorkflow()`).

### `withGeneratorSpan(name, attributes, generator)`

Wraps an async generator with a span. The span starts when iteration begins and
ends when the generator completes, throws, or is abandoned. Events with
`kind: "error"` are detected and recorded as span errors. Used for all libswamp
generators.

### `getTracer()`

Returns the swamp tracer from the global provider. Returns a no-op tracer when
tracing is not initialized.

### `injectTraceContext()` / `extractTraceContext(headers)`

Inject/extract W3C Trace Context headers (`traceparent`, `tracestate`) for
cross-process propagation.

## Implementation Files

### Infrastructure Layer

| File                                            | Purpose                                       |
| ----------------------------------------------- | --------------------------------------------- |
| `src/infrastructure/tracing/mod.ts`             | Public API surface (re-exports)               |
| `src/infrastructure/tracing/otel_init.ts`       | SDK bootstrap, dynamic loading, shutdown      |
| `src/infrastructure/tracing/fetch_otlp_exporter.ts` | Fetch-based OTLP span exporter           |
| `src/infrastructure/tracing/tracer.ts`          | `getTracer`, `withSpan`, `withGeneratorSpan`  |
| `src/infrastructure/tracing/propagation.ts`     | W3C Trace Context inject/extract              |

### Instrumented Domain Files

| File                                                    | Spans Created                                     |
| ------------------------------------------------------- | ------------------------------------------------- |
| `main.ts`                                               | `initTracing()` / `shutdownTracing()` lifecycle   |
| `src/cli/mod.ts`                                        | `swamp.cli` root span                             |
| `src/cli/repo_context.ts`                               | `swamp.repo.init`                                 |
| `src/domain/workflows/execution_service.ts`             | `swamp.workflow.run`, `.job`, `.step`, `.evaluate` |
| `src/domain/models/method_execution_service.ts`         | `swamp.model.method`, `swamp.driver.execute`      |
| `src/domain/drivers/docker_execution_driver.ts`         | Trace header propagation via env vars             |
| `src/infrastructure/persistence/datastore_sync_coordinator.ts` | `swamp.lock.acquire`, `swamp.datastore.sync` |

### Dependencies

```json
"@opentelemetry/api": "npm:@opentelemetry/api@^1.9.0",
"@opentelemetry/sdk-trace-base": "npm:@opentelemetry/sdk-trace-base@^1.30.0",
"@opentelemetry/otlp-transformer": "npm:@opentelemetry/otlp-transformer@^0.57.0",
"@opentelemetry/core": "npm:@opentelemetry/core@^1.30.0",
"@opentelemetry/context-async-hooks": "npm:@opentelemetry/context-async-hooks@^1.30.0",
"@opentelemetry/resources": "npm:@opentelemetry/resources@^1.30.0",
"@opentelemetry/semantic-conventions": "npm:@opentelemetry/semantic-conventions@^1.30.0"
```

The OTLP exporter uses Deno's native `fetch` API instead of the Node.js
`http`/`https` modules. This avoids TLS connection failures in Deno compiled
binaries. `@opentelemetry/otlp-transformer` handles JSON serialization of spans.

Only `@opentelemetry/api` is statically imported. All other packages are
dynamically loaded when tracing is enabled.
