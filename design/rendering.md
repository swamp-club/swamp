# Rendering: Connecting libswamp Events to Presentation Modes

## Overview

Swamp's CLI supports two output modes — `log` (human-readable) and `json`
(machine-readable). The **renderer** architecture separates presentation logic
from command handlers, ensuring that:

1. Command handlers contain only orchestration (wiring deps, creating contexts,
   checking results) — no formatting, logging, or serialization.
2. Each output mode has its own renderer class that translates libswamp event
   streams into user-facing output.
3. Adding a new output mode is a matter of adding a new renderer implementation —
   no changes to libswamp or command handlers.
4. libswamp logs at debug/trace only; renderers own all info/warn/error output.

Previously, presentation logic lived inline in command handlers via
`if (isLogMode)` branches, and the existing `presentation/output/` files had
unreachable log-mode code paths. The renderer pattern replaced this with clean
separation of concerns.

## Architecture

A **renderer** is a mode-specific object that knows how to present the events
from a single libswamp operation. Each renderer implements a common interface
and is selected by a factory function based on the current output mode.

```
┌──────────────┐     consumeStream()     ┌──────────────────────┐
│   CLI Command │──────────────────────── │      Renderer        │
│   Handler     │   renderer.handlers()  │  (log, json, or tui) │
└──────┬───────┘                         └──────────┬───────────┘
       │                                            │
       │  workflowRun(ctx, deps, input)             │  logger.info(...)
       │                                            │  console.log(JSON...)
       ▼                                            ▼
┌──────────────┐                         ┌──────────────────────┐
│   libswamp    │  ── events ──────────►  │   Terminal / stdout  │
│  (debug logs  │                         │                      │
│   only)       │                         │                      │
└──────────────┘                         └──────────────────────┘
```

### The Renderer interface

Every renderer for a given operation implements a shared interface:

```typescript
// presentation/renderer.ts
import type { EventHandlers, StreamEvent } from "../libswamp/mod.ts";

/**
 * A mode-specific object that translates libswamp event streams into
 * user-facing output. Each renderer produces `EventHandlers<E>` for
 * use with `consumeStream()`.
 */
export interface Renderer<E extends StreamEvent> {
  /** Returns exhaustiveness-checked handlers for consumeStream(). */
  handlers(): EventHandlers<E>;
}
```

The interface is intentionally minimal. A renderer's job is to produce
`EventHandlers<E>` — the same type that `consumeStream` already requires. This
means renderers compose naturally with the existing libswamp stream
infrastructure. No new consumption mechanism is needed.

Renderers that need to expose post-consumption state (e.g., whether a workflow
failed) extend the base interface for that operation:

```typescript
export interface WorkflowRunRenderer extends Renderer<WorkflowRunEvent> {
  workflowFailed(): boolean;
}
```

### Factory functions

Each operation has a factory that selects the right renderer based on mode:

```typescript
// presentation/renderers/workflow_run.ts
export function createWorkflowRunRenderer(
  mode: OutputMode,
  opts: WorkflowRunRenderOpts,
): WorkflowRunRenderer {
  switch (mode) {
    case "json":
      return new JsonWorkflowRunRenderer();
    case "log":
      return new LogWorkflowRunRenderer(opts);
  }
}
```

### Usage in command handlers

The command handler becomes pure orchestration — wire deps, create contexts,
pick a renderer, consume the stream, check the result.

## Logging Boundaries

libswamp and renderers have distinct logging responsibilities:

### libswamp: debug and trace only

libswamp generators log internal operational details at `debug` or `trace`
level. These are developer-facing diagnostics, not user-facing output:

```typescript
// Inside a libswamp generator
ctx.logger.debug("Resolving workflow DAG for {workflow}", { workflow: id });
ctx.logger.trace("Step execution took {ms}ms", { ms: elapsed });
```

libswamp **never** logs at `info`, `warn`, or `error`. All user-facing
information is communicated through the event stream.

### Renderers: info, warn, and error

Renderers own all user-facing log output. When a `step_failed` event arrives,
the renderer decides whether and how to present it:

```typescript
// Log-mode renderer
step_failed: (e) => {
  getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId).error(
    "Step failed: {error}",
    { error: e.error },
  );
}

// JSON-mode renderer
step_failed: () => {}  // no-op — the completed event has the full summary
```

This separation ensures that log levels are a presentation concern, not a domain
concern. The same event can be an `error` log line in log mode and silently
accumulated in JSON mode.

### Step execution output: events, not logs

During `workflow run`, step execution output (model discovery, method execution,
process stdout/stderr) flows through the event stream via `model_resolved`,
`method_executing`, and `method_output` events. The domain layer
(`DefaultStepExecutor`) pushes these events through a callback on
`StepExecutionContext`, and `runStep()` uses `withEventBridge()` to yield
them into the parent event stream.

`withEventBridge()` (in `infrastructure/stream/event_bridge.ts`) is a reusable
utility that bridges Promise-returning code into an AsyncGenerator. It creates
an `AsyncQueue`, passes a `push` callback to the function, and yields events as
they arrive. When the promise settles, the generator completes.

### Domain events from deep layers: `MethodExecutionEvent`

Code deeper in the domain (data writers, vault storage) can't emit workflow
events directly — it has no knowledge of job/step topology. Instead, these
layers emit topology-agnostic `MethodExecutionEvent` values via an `onEvent`
callback on `MethodContext`.

```typescript
// domain/models/method_events.ts
type MethodExecutionEvent =
  | { type: "vault_secret_stored"; fieldPath: string; vaultName: string; vaultKey: string }
  | { type: "schema_validation_warning"; specName: string; instanceName: string; error: string };
```

The workflow execution layer wraps these into `method_event` workflow events
by adding the topology context (jobId, stepId, modelName, methodName). The
callback chain is:

```
StepExecutionContext.emitEvent → MethodContext.onEvent → DataWriter/VaultStorage
```

The `LogWorkflowRunRenderer` uses `getRunLogger(modelName, methodName)` to
present these events — preserving the existing `model·method·run·<name>·<method>`
log category. The `JsonWorkflowRunRenderer` ignores them (no-ops), keeping
stdout clean for machine consumption.

Internal phase transitions (expression evaluation, definition caching, data
persistence) are logged at `debug` level for log file capture only — they are
implementation details, not domain signals.

### Infrastructure warnings

Vault deprecation warnings (setup-time diagnostics) remain as direct logger
calls — these are system-health diagnostics outside the step execution context.

## Example: `auth whoami`

A simple operation with no streaming progress — it loads credentials, contacts
the server, and returns an identity.

### libswamp event type (existing)

```typescript
type AuthWhoamiEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; identity: WhoamiIdentity }
  | { kind: "error"; error: SwampError };
```

### Log-mode renderer

```typescript
class LogAuthWhoamiRenderer implements Renderer<AuthWhoamiEvent> {
  handlers(): EventHandlers<AuthWhoamiEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: (e) => {
        writeOutput(
          `${e.identity.username} (${e.identity.email}) on ${e.identity.serverUrl}`,
        );
        if (e.identity.collectives && e.identity.collectives.length > 0) {
          writeOutput(`Collectives: ${e.identity.collectives.join(", ")}`);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}
```

### JSON-mode renderer

```typescript
class JsonAuthWhoamiRenderer implements Renderer<AuthWhoamiEvent> {
  handlers(): EventHandlers<AuthWhoamiEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: (e) => {
        console.log(JSON.stringify(
          {
            authenticated: true,
            serverUrl: e.identity.serverUrl,
            id: e.identity.id,
            username: e.identity.username,
            email: e.identity.email,
            name: e.identity.name,
            ...(e.identity.collectives
              ? { collectives: e.identity.collectives }
              : {}),
          },
          null,
          2,
        ));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}
```

### Command handler

```typescript
export const authWhoamiCommand = new Command()
  .name("whoami")
  .description("Show current authenticated identity")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["auth", "whoami"]);
    cliCtx.logger.debug("Executing auth whoami command");

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createAuthDeps({
      serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
    });

    const renderer = createAuthWhoamiRenderer(cliCtx.outputMode);
    await consumeStream(whoami(ctx, deps), renderer.handlers());

    cliCtx.logger.debug("Auth whoami command completed");
  });
```

## Example: `workflow run`

A long-running operation with streaming progress from parallel jobs and steps.

### libswamp event type (existing)

```typescript
type WorkflowRunEvent =
  | { kind: "validating_inputs" }
  | { kind: "evaluating_workflow" }
  | { kind: "started"; runId: string; workflowName: string }
  | { kind: "job_started"; jobId: string }
  | { kind: "job_completed"; jobId: string; status: string }
  | { kind: "job_skipped"; jobId: string }
  | { kind: "step_started"; jobId: string; stepId: string }
  | { kind: "step_completed"; jobId: string; stepId: string }
  | { kind: "step_skipped"; jobId: string; stepId: string }
  | { kind: "step_failed"; jobId: string; stepId: string; error: string; allowedFailure?: boolean }
  | { kind: "model_resolved"; jobId: string; stepId: string; modelName: string; modelType: string; methodName: string }
  | { kind: "method_executing"; jobId: string; stepId: string; modelName: string; methodName: string }
  | { kind: "method_output"; jobId: string; stepId: string; modelName: string; methodName: string; stream: "stdout" | "stderr"; line: string }
  | { kind: "method_event"; jobId: string; stepId: string; modelName: string; methodName: string; event: MethodExecutionEvent }
  | { kind: "completed"; run: WorkflowRunView }
  | { kind: "error"; error: SwampError };
```

### Log-mode renderer

The log-mode renderer streams progress to the terminal as events arrive, using
scoped loggers per job and step:

```typescript
class LogWorkflowRunRenderer implements WorkflowRunRenderer {
  private workflowName: string;
  private _failed = false;

  constructor(opts: WorkflowRunRenderOpts) {
    this.workflowName = opts.workflowName;
  }

  handlers(): EventHandlers<WorkflowRunEvent> {
    return {
      validating_inputs: () => {},
      evaluating_workflow: () => {},
      started: (e) => {
        this.workflowName = e.workflowName;
        getWorkflowRunLogger(e.workflowName).info("Starting workflow");
      },
      job_started: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId).info("Job started");
      },
      job_completed: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId).info("Job completed");
      },
      job_skipped: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId).info("Job skipped");
      },
      step_started: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId).info(
          "Step started",
        );
      },
      step_completed: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId).info(
          "Step completed",
        );
      },
      step_skipped: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId).info(
          "Step skipped",
        );
      },
      step_failed: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId).error(
          "Step failed: {error}",
          { error: e.error },
        );
      },
      model_resolved: (e) => {
        getRunLogger(e.modelName, e.methodName).info(
          "Found model {name} ({type})",
          { name: e.modelName, type: e.modelType },
        );
      },
      method_executing: (e) => {
        getRunLogger(e.modelName, e.methodName).info(
          "Executing method {method}",
          { method: e.methodName },
        );
      },
      method_output: (e) => {
        const logger = getRunLogger(e.modelName, e.methodName);
        if (e.stream === "stderr") {
          logger.warn(e.line);
        } else {
          logger.info(e.line);
        }
      },
      method_event: (e) => {
        const logger = getRunLogger(e.modelName, e.methodName);
        switch (e.event.type) {
          case "vault_secret_stored":
            logger.info("Stored sensitive field '{fieldPath}' in vault '{vaultName}'",
              { fieldPath: e.event.fieldPath, vaultName: e.event.vaultName });
            break;
          case "schema_validation_warning":
            logger.warn("Resource '{specName}' data does not match schema: {error}",
              { specName: e.event.specName, error: e.event.error });
            break;
        }
      },
      completed: (e) => {
        const wfLogger = getWorkflowRunLogger(this.workflowName);
        if (e.run.status === "failed") {
          this._failed = true;
          wfLogger.error("Workflow {status}", { status: e.run.status });
        } else {
          wfLogger.with({ summary: true }).info("Workflow {status}", {
            status: e.run.status,
          });
          this.renderDataArtifactHints(e.run, wfLogger);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  workflowFailed(): boolean {
    return this._failed;
  }

  private renderDataArtifactHints(
    run: WorkflowRunView,
    logger: ReturnType<typeof getWorkflowRunLogger>,
  ): void {
    const artifactNames = new Set<string>();
    for (const job of run.jobs) {
      for (const step of job.steps) {
        if (step.dataArtifacts) {
          for (const artifact of step.dataArtifacts) {
            artifactNames.add(artifact.name);
          }
        }
      }
    }

    if (artifactNames.size > 0) {
      logger.info("");
      logger.info("View produced data:");
      logger.info(
        "  swamp data list --workflow {workflowName}",
        { workflowName: run.workflowName },
      );
      for (const name of artifactNames) {
        logger.info(
          "  swamp data get --workflow {workflowName} {artifactName}",
          { workflowName: run.workflowName, artifactName: name },
        );
      }
    }
  }
}
```

### JSON-mode renderer

The JSON renderer ignores all intermediate events and serializes the final
`completed` payload:

```typescript
class JsonWorkflowRunRenderer implements WorkflowRunRenderer {
  private _failed = false;

  handlers(): EventHandlers<WorkflowRunEvent> {
    return {
      validating_inputs: () => {},
      evaluating_workflow: () => {},
      started: () => {},
      job_started: () => {},
      job_completed: () => {},
      job_skipped: () => {},
      step_started: () => {},
      step_completed: () => {},
      step_skipped: () => {},
      step_failed: () => {},
      model_resolved: () => {},
      method_executing: () => {},
      method_output: () => {},
      method_event: () => {},
      completed: (e) => {
        if (e.run.status === "failed") this._failed = true;
        console.log(JSON.stringify(e.run, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  workflowFailed(): boolean {
    return this._failed;
  }
}
```

### Command handler

```typescript
try {
  const deps: WorkflowRunDeps = {
    workflowRepo,
    runRepo,
    repoDir,
    lookupWorkflow: async (repo, idOrName) => {
      return await repo.findByName(idOrName) ??
        await repo.findById(createWorkflowId(idOrName));
    },
    createExecutionService: (wfRepo, rnRepo, dir) =>
      new WorkflowExecutionService(wfRepo, rnRepo, dir),
  };

  const libCtx = createLibSwampContext();
  const renderer = createWorkflowRunRenderer(ctx.outputMode, {
    workflowName: workflowIdOrName,
  });

  await consumeStream(
    workflowRun(libCtx, deps, {
      workflowIdOrName,
      lastEvaluated,
      inputs,
      runtimeTags,
      verbose: ctx.verbosity === "verbose",
    }),
    renderer.handlers(),
  );

  if (renderer.workflowFailed()) {
    Deno.exit(1);
  }
} catch (error) {
  if (error instanceof UserError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new UserError(`Workflow execution failed: ${message}`);
}
```

## File Layout

```
src/presentation/
  renderer.ts                          # Renderer<E> interface
  renderers/
    auth_whoami.ts                     # factory + Log/Json renderers
    workflow_run.ts                    # factory + Log/Json renderers
    ...
```

Each file in `renderers/` contains the factory function, mode-specific renderer
classes, and any shared rendering helpers for that operation.

## Migration Status

Two commands have been migrated to the renderer pattern:

- **`auth whoami`** — `presentation/renderers/auth_whoami.ts`
- **`workflow run`** — `presentation/renderers/workflow_run.ts`

Remaining commands still use the existing `presentation/output/` files. To
migrate a command:

1. Create a new file in `presentation/renderers/` with Log and Json renderer
   classes implementing `Renderer<E>`.
2. Add a factory function that selects the renderer based on `OutputMode`.
3. Replace the inline event handlers in the command with a renderer factory call
   and `consumeStream`.
4. Delete the corresponding `presentation/output/` file once the renderer fully
   replaces it.

The two patterns coexist without conflict — commands can be migrated
incrementally.

### Dependency direction

```
src/cli/commands/     →  src/presentation/renderers/  →  (loggers, formatters)
  (orchestration)          (mode-specific rendering)
        │
        ▼
    src/libswamp/     →  src/domain/
  (event streams,         (entities, value objects)
   debug/trace logs)  →  src/infrastructure/
                          (repositories, HTTP clients)
```

Command handlers depend on both libswamp (for the event stream) and the
presentation layer (for the renderer). The presentation layer depends on
infrastructure (loggers, color formatting). libswamp depends on domain and
infrastructure but never on presentation.
