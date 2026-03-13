# Rendering: Connecting libswamp Events to Presentation Modes

## Problem

Swamp's CLI supports two output modes today — `log` (human-readable) and `json`
(machine-readable) — with a potential `tui` mode in the future. The current
approach to rendering has two problems:

1. **Presentation logic lives in command handlers.** The `workflow run` command,
   for example, contains 80+ lines of `if (isLogMode)` branches inline in its
   event handlers. This interleaves orchestration (wiring deps, creating
   contexts, checking results) with presentation (formatting log lines, choosing
   icons, serializing JSON).

2. **Dead code in the output layer.** The existing `presentation/output/` files
   were designed to handle both modes, but many commands bypass them for log mode
   — handling output directly via loggers in the command handler — and only call
   the render function for JSON mode. The log-mode branch in those output files
   is unreachable.

With libswamp's `AsyncIterable` event streams becoming the standard way to
invoke domain operations, we need a clean pattern for connecting those streams to
any presentation mode without mixing concerns.

## Goal

Define a **renderer** abstraction that:

1. Translates libswamp event streams into user-facing output for any mode
2. Keeps command handlers free of presentation logic
3. Preserves compile-time exhaustive event handling from `EventHandlers<E>`
4. Makes adding a new output mode (e.g., `tui`) a matter of adding a new
   renderer implementation — no changes to libswamp or command handlers
5. Establishes clear logging boundaries: libswamp logs at debug/trace only;
   renderers own all info/warn/error output

## Design: Renderer Objects

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
import type { EventHandlers, StreamEvent } from "../libswamp/stream.ts";

interface Renderer<E extends StreamEvent> {
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
interface WorkflowRunRenderer extends Renderer<WorkflowRunEvent> {
  failed(): boolean;
}
```

### Factory functions

Each operation has a factory that selects the right renderer based on mode:

```typescript
// presentation/renderers/workflow_run.ts
function createWorkflowRunRenderer(
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

Adding a `tui` mode means adding a case to the switch and a new renderer class.
The command handler and libswamp are unchanged.

### Usage in command handlers

The command handler becomes pure orchestration — wire deps, create contexts,
pick a renderer, consume the stream, check the result:

```typescript
// src/cli/commands/workflow_run.ts
const renderer = createWorkflowRunRenderer(ctx.outputMode, { workflowName });

await consumeStream(
  workflowRun(libCtx, deps, input),
  renderer.handlers(),
);

if (renderer.failed()) {
  Deno.exit(1);
}
```

No `if (isLogMode)` branches. No presentation logic. The command handler does
not import loggers, color formatters, or JSON serialization — those are the
renderer's concern.

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
  getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId)
    .error("Step failed: {error}", { error: e.error });
}

// JSON-mode renderer
step_failed: () => {}  // no-op — the completed event has the full summary
```

This separation ensures that log levels are a presentation concern, not a domain
concern. The same event can be an `error` log line in log mode, silently
accumulated in JSON mode, and a red panel border in TUI mode.

## Example: `auth whoami`

A simple operation with no streaming progress — it loads credentials, contacts
the server, and returns an identity.

### libswamp event type (existing)

```typescript
type AuthWhoamiEvent =
  | { step: "loading_credentials" }
  | { step: "contacting_server"; serverUrl: string }
  | { step: "completed"; identity: WhoamiIdentity }
  | { step: "error"; error: SwampError };
```

### Log-mode renderer

```typescript
class LogAuthWhoamiRenderer implements Renderer<AuthWhoamiEvent> {
  handlers(): EventHandlers<AuthWhoamiEvent> {
    return {
      loading_credentials: () => {},    // silent — no user-facing output
      contacting_server: () => {},      // silent
      completed: (e) => {
        const { identity: id } = e;
        writeOutput(`${id.username} (${id.email}) on ${id.serverUrl}`);
        if (id.collectives?.length) {
          writeOutput(`Collectives: ${id.collectives.join(", ")}`);
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
        const { identity } = e;
        console.log(JSON.stringify({
          authenticated: true,
          serverUrl: identity.serverUrl,
          id: identity.id,
          username: identity.username,
          email: identity.email,
          name: identity.name,
          ...(identity.collectives ? { collectives: identity.collectives } : {}),
        }, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}
```

### Command handler (after)

```typescript
export const authWhoamiCommand = new Command()
  .name("whoami")
  .description("Show current authenticated identity")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["auth", "whoami"]);
    const libCtx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createAuthDeps({
      serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
    });

    const renderer = createAuthWhoamiRenderer(cliCtx.outputMode);
    await consumeStream(whoami(libCtx, deps), renderer.handlers());
  });
```

## Example: `workflow run`

A long-running operation with streaming progress from parallel jobs and steps.

### libswamp event type (existing)

```typescript
type WorkflowRunEvent =
  | { step: "validating_inputs" }
  | { step: "evaluating_workflow" }
  | { step: "started"; runId: string; workflowName: string }
  | { step: "job_started"; jobId: string }
  | { step: "job_completed"; jobId: string; status: string }
  | { step: "job_skipped"; jobId: string }
  | { step: "step_started"; jobId: string; stepId: string }
  | { step: "step_completed"; jobId: string; stepId: string }
  | { step: "step_skipped"; jobId: string; stepId: string }
  | { step: "step_failed"; jobId: string; stepId: string; error: string; allowedFailure?: boolean }
  | { step: "completed"; run: WorkflowRunData }
  | { step: "error"; error: SwampError };
```

### Log-mode renderer

The log-mode renderer streams progress to the terminal as events arrive, using
scoped loggers per job and step:

```typescript
class LogWorkflowRunRenderer implements WorkflowRunRenderer {
  private workflowName: string;
  private _failed = false;

  constructor(opts: { workflowName: string }) {
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
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId)
          .info("Step started");
      },
      step_completed: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId)
          .info("Step completed");
      },
      step_skipped: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId)
          .info("Step skipped");
      },
      step_failed: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId)
          .error("Step failed: {error}", { error: e.error });
      },
      completed: (e) => {
        const wfLogger = getWorkflowRunLogger(this.workflowName);
        if (e.run.status === "failed") {
          this._failed = true;
          wfLogger.error("Workflow {status}", { status: e.run.status });
        } else {
          wfLogger.with({ summary: true })
            .info("Workflow {status}", { status: e.run.status });
          this.renderDataArtifactHints(e.run, wfLogger);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  failed(): boolean {
    return this._failed;
  }

  private renderDataArtifactHints(run: WorkflowRunData, logger: Logger): void {
    const artifactNames = new Set<string>();
    for (const job of run.jobs) {
      for (const step of job.steps) {
        for (const artifact of step.dataArtifacts ?? []) {
          artifactNames.add(artifact.name);
        }
      }
    }
    if (artifactNames.size > 0) {
      logger.info("");
      logger.info("View produced data:");
      logger.info("  swamp data list --workflow {workflowName}", {
        workflowName: run.workflowName,
      });
      for (const name of artifactNames) {
        logger.info("  swamp data get --workflow {workflowName} {name}", {
          workflowName: run.workflowName,
          name,
        });
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
      completed: (e) => {
        if (e.run.status === "failed") this._failed = true;
        console.log(JSON.stringify(e.run, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  failed(): boolean {
    return this._failed;
  }
}
```

### Command handler (after)

```typescript
const renderer = createWorkflowRunRenderer(ctx.outputMode, { workflowName });

await consumeStream(
  workflowRun(libCtx, deps, {
    workflowIdOrName,
    lastEvaluated,
    inputs,
    runtimeTags,
    enableStepLogging: ctx.outputMode !== "json",
    verbose: ctx.verbosity === "verbose",
  }),
  renderer.handlers(),
);

if (renderer.failed()) {
  Deno.exit(1);
}
```

The command handler shrank from ~100 lines of interleaved orchestration and
presentation to ~15 lines of pure orchestration.

## TUI Mode: Batching Inside the Renderer

A future TUI renderer can buffer events internally and batch screen updates
without changing the consumption model. The renderer still returns
`EventHandlers<E>` — it just does more inside each handler:

```typescript
class TuiWorkflowRunRenderer implements WorkflowRunRenderer {
  private pendingUpdates: WorkflowRunEvent[] = [];
  private renderTimer: number | null = null;
  private dashboard: TuiDashboard;

  handlers(): EventHandlers<WorkflowRunEvent> {
    return {
      started: (e) => {
        this.dashboard = createDashboard(e.workflowName);
        this.dashboard.render();
      },
      step_started: (e) => this.enqueue(e),
      step_completed: (e) => this.enqueue(e),
      step_failed: (e) => this.enqueue(e),
      job_started: (e) => this.enqueue(e),
      job_completed: (e) => this.enqueue(e),
      // ...
      completed: (e) => {
        this.flush();  // drain any pending updates
        this.dashboard.showSummary(e.run);
      },
      error: (e) => {
        this.flush();
        this.dashboard.showError(e.error);
      },
    };
  }

  private enqueue(event: WorkflowRunEvent): void {
    this.pendingUpdates.push(event);
    if (!this.renderTimer) {
      this.renderTimer = setTimeout(() => {
        this.flush();
        this.renderTimer = null;
      }, 16);  // ~60fps
    }
  }

  private flush(): void {
    for (const event of this.pendingUpdates) {
      this.dashboard.applyEvent(event);
    }
    this.pendingUpdates = [];
    this.dashboard.render();
  }
}
```

The command handler is identical to the log and JSON cases. The TUI renderer
owns its own rendering lifecycle — the `consumeStream` loop just delivers events
and the renderer decides when to paint.

## Generic JSON Renderer

Many operations follow a simple pattern in JSON mode: ignore all intermediate
events, await the `completed` event, and serialize it. A generic renderer
eliminates per-operation boilerplate for these cases:

```typescript
class JsonResultRenderer<E extends StreamEvent> implements Renderer<E> {
  private serialize: (event: Extract<E, { step: "completed" }>) => unknown;

  constructor(
    serialize: (event: Extract<E, { step: "completed" }>) => unknown,
  ) {
    this.serialize = serialize;
  }

  handlers(): EventHandlers<E> {
    // Proxy: handle "completed" and "error" explicitly, no-op everything else
    const completedHandler = (e: Extract<E, { step: "completed" }>) => {
      console.log(JSON.stringify(this.serialize(e), null, 2));
    };
    const errorHandler = (e: Extract<E, { step: "error" }>) => {
      throw new UserError(
        (e as unknown as { error: SwampError }).error.message,
      );
    };

    return new Proxy({} as EventHandlers<E>, {
      get(_target, prop) {
        if (prop === "completed") return completedHandler;
        if (prop === "error") return errorHandler;
        return () => {};  // no-op for all intermediate events
      },
    });
  }
}

// Usage: JSON renderer for auth whoami in one line
const renderer = new JsonResultRenderer<AuthWhoamiEvent>(
  (e) => ({ authenticated: true, ...e.identity }),
);
```

Operations that need to track post-consumption state (like `failed()` on
workflow run) or render intermediate events in JSON mode should use a dedicated
renderer class instead.

## File Layout

```
src/presentation/
  renderer.ts                          # Renderer<E> interface
  renderers/
    auth_whoami.ts                     # factory + Log/Json renderers
    workflow_run.ts                    # factory + Log/Json renderers
    model_create.ts                    # factory + Log/Json renderers
    model_method_run.ts                # factory + Log/Json renderers
    ...
```

Each file in `renderers/` contains the factory function, mode-specific renderer
classes, and any shared rendering helpers (icon formatters, etc.) for that
operation. This replaces the existing `presentation/output/` files.

## Migration Strategy

The migration follows the same incremental approach as libswamp itself — one
command at a time, old and new patterns coexisting:

1. **Define the `Renderer<E>` interface** in `presentation/renderer.ts`.
2. **Pick a command** that already uses libswamp (e.g., `auth whoami` or
   `workflow run`).
3. **Extract its presentation logic** from the command handler into renderer
   classes — one per mode.
4. **Replace the inline handlers** in the command with a renderer factory call.
5. **Delete the corresponding `presentation/output/` file** once the renderer
   fully replaces it.
6. Repeat for the next command.

Commands that have not yet migrated to libswamp can continue using the existing
`presentation/output/` files. The two patterns coexist without conflict.

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
