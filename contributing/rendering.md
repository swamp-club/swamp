---
audience: maintainer
last-verified: 2026-08-28 @ 3d5955a9
---

# Rendering: Connecting libswamp Events to Presentation Modes

## Overview

Swamp's CLI supports two output modes — `log` (human-readable) and `json`
(machine-readable). The **renderer** architecture separates presentation logic
from command handlers, ensuring that:

1. Command handlers contain only orchestration (wiring deps, creating contexts,
   checking results) — no formatting, logging, or serialization.
2. Each output mode has its own renderer class that translates libswamp event
   streams into user-facing output.
3. Adding a new output mode is a matter of adding a new renderer implementation
   — no changes to libswamp or command handlers.
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
// src/presentation/renderers/workflow_run.ts
export interface WorkflowRunRenderOpts {
  workflowName: string;
  isAuthenticated?: boolean;
  quiet?: boolean;
  failOnSeverity?: AssertSeverity;
}

export function createWorkflowRunRenderer(
  mode: OutputMode,
  opts: WorkflowRunRenderOpts,
): WorkflowRunRenderer {
  switch (mode) {
    case "json":
      return new JsonWorkflowRunRenderer();
    case "log":
      return new ConsoleWorkflowRunRenderer(opts);
  }
}
```

### Usage in command handlers

The command handler becomes pure orchestration — wire deps, create contexts,
pick a renderer, consume the stream, check the result.

## JSON Mode Output Contract

When a command runs with `--json`, swamp guarantees the following invariants to
JSON consumers (`jq`, AI agents, CI scripts):

1. **stdout contains exactly one valid JSON document** for the command's primary
   output, OR a stream of newline-delimited JSON (NDJSON) documents for
   streaming commands. No trailing whitespace, no log lines, no prompts.
2. **stderr is reserved for log records** at the configured log level. It may be
   empty, may contain LogTape pretty-formatted lines, but never doubles as a
   structured-output channel.
3. **Errors emit a structured JSON object on stdout** with the shape
   `{ error: string, stack?: string, code?: string }` and a non-zero process
   exit. The `code` field is OPTIONAL — consumers MUST tolerate its presence or
   absence. When present, it carries a machine-readable identifier (e.g.
   `"cancelled"`, `"timeout"`, `"not_found"`, `"validation_failed"`) suitable
   for programmatic dispatch.
4. **Commands MUST NOT prompt interactively in JSON mode.** Any confirmation
   gate must be bypassed when the output mode is `json`. Use
   `Deno.stdin.isTerminal()` to detect non-interactive contexts in addition to
   `outputMode`.

Renderer implementations for new commands MUST preserve these guarantees.
`integration/json_mode_conformance_test.ts` is the static gate: it walks the
Cliffy command tree and asserts that `--json` is a global option, that every
leaf command inherits it and routes output through the `OutputMode` plumbing,
and that the exemption list has no stale entries. It does not execute
commands; behavioural checks of stdout isolation belong in the `swamp-uat`
repo.

At the logging layer, `initializeLogging()` in
`src/infrastructure/logging/logger.ts` configures the
`["model","method","run"]` and `["workflow","run"]` category loggers with
`parentSinks: forceLog && !quiet ? "inherit" : "override"` — i.e. run-scoped
records reach the root console sink only when a caller explicitly forces log
output; otherwise they go to the run file (and OTel) sinks only, regardless
of `jsonMode`. The `["logtape","meta"]` logger is the one keyed on
`jsonMode`: in JSON mode it gets no sinks and `parentSinks: "override"`, so
LogTape's own warnings never reach stdout. The single emitter for fatal
output in JSON mode is `renderError` in
`src/presentation/output/error_output.ts` — it writes to stderr
(`console.error`) and skips `logger.fatal`, so log-mode sinks cannot produce
a duplicate entry.

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
step_failed: ((e) => {
  getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId).error(
    "Step failed: {error}",
    { error: e.error },
  );
});

// JSON-mode renderer
step_failed: (() => {}); // no-op — the completed event has the full summary
```

This separation ensures that log levels are a presentation concern, not a domain
concern. The same event can be an `error` log line in log mode and silently
accumulated in JSON mode.

### Step execution output: events, not logs

During `workflow run`, step execution output (model discovery, method execution,
process stdout/stderr) flows through the event stream via `model_resolved`,
`method_executing`, and `method_output` events. The domain layer
(`DefaultStepExecutor`) pushes these events through a callback on
`StepExecutionContext`, and `runStep()` uses `withEventBridge()` to yield them
into the parent event stream.

`withEventBridge()` (in `infrastructure/stream/event_bridge.ts`) is a reusable
utility that bridges Promise-returning code into an AsyncGenerator. It creates
an `AsyncQueue`, passes a `push` callback to the function, and yields events as
they arrive. When the promise settles, the generator completes.

### Domain events from deep layers: `MethodExecutionEvent`

Code deeper in the domain (data writers, vault storage) can't emit workflow
events directly — it has no knowledge of job/step topology. Instead, these
layers emit topology-agnostic `MethodExecutionEvent` values via an `onEvent`
callback on `MethodContext`.

`MethodExecutionEvent` (`src/domain/models/method_events.ts`) has seven
variants, discriminated on `type`: `output`, `vault_secret_stored`,
`schema_validation_warning`, `vault_single_quote_warning`, `step_queued`,
`nested_model_invocation`, and `step_target_disconnected`. See the file for
payloads.

The workflow execution layer wraps these into `method_event` workflow events by
adding the topology context (jobId, stepId, modelName, methodName). The callback
chain is:

```
StepExecutionContext.emitEvent → MethodContext.onEvent → DataWriter/VaultStorage
```

The `ConsoleWorkflowRunRenderer` presents these events through the
`console_writer` helpers (`writeOutput` and a per-job pipe layout) rather
than through LogTape category loggers. The `JsonWorkflowRunRenderer` ignores
them (no-ops), keeping stdout clean for machine consumption.

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

### Renderers

Both renderers live in `src/presentation/renderers/auth_whoami.ts`:

```typescript
class LogAuthWhoamiRenderer implements Renderer<AuthWhoamiEvent> {
  handlers(): EventHandlers<AuthWhoamiEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: (e) => {
        // identity line (user, or collective token + scopes) via writeOutput,
        // then either the entitlement block the server sent...
        const entitlements = e.identity.collectiveEntitlements;
        if (entitlements && entitlements.length > 0) { /* Plan / Collectives */ return; }
        // ...or the original single "Collectives:" line when it didn't.
      },
      error: (e) => { throw new UserError(e.error.message); },
    };
  }
}

class JsonAuthWhoamiRenderer implements Renderer<AuthWhoamiEvent> { /* ... */ }

export function createAuthWhoamiRenderer(mode: OutputMode): Renderer<AuthWhoamiEvent>;
```

Note the shape of the log-mode fallback: the renderer branches on whether the
*server* supplied a field, not on a CLI-side flag. Optional-everything is what
lets one CLI talk to several server versions, and the pre-existing output is
the behaviour to preserve, not a legacy path to tolerate. The JSON renderer
passes entitlement fields through verbatim — log mode makes display decisions
(it hides a paid collective's trial); JSON mode makes none, because it is what
gets pasted into a support report.

### Command handler

`src/cli/commands/auth_whoami.ts` creates the CLI context, a
`LibSwampContext`, and `createAuthDeps(...)`, then:

```typescript
const renderer = createAuthWhoamiRenderer(cliCtx.outputMode);
await consumeStream(whoami(ctx, deps), renderer.handlers());
```

## Example: `workflow run`

A long-running operation with streaming progress from parallel jobs and steps.

### libswamp event type (existing)

`WorkflowRunEvent` (`src/libswamp/workflows/run.ts`) has 27 kinds; see
[libswamp.md](./libswamp.md#event-streams) for the list. Both renderers below
must handle every one of them — the compiler enforces it.

### Log-mode renderer

`ConsoleWorkflowRunRenderer` (`src/presentation/renderers/workflow_run.ts`)
streams progress to the terminal as events arrive. It writes through the
`console_writer` helpers (`writeOutput`, status colours, a per-job pipe
layout that prefixes each line with the job's display name) rather than
through LogTape category loggers, tracks `workflowFailed()` from the
`completed` / `assert_result` events and `failOnSeverity`, and after a
successful run prints `swamp data list/get --workflow ...` hints for any
user-facing data artifacts the run produced.

### JSON-mode renderer

`JsonWorkflowRunRenderer` (same file) no-ops every intermediate event and
serializes the final `completed` payload (`e.run`) as a single JSON document,
recording `workflowFailed()` from `run.status`.

### Command handler

`src/cli/commands/workflow_run.ts` builds `WorkflowRunDeps`
(`lookupWorkflow`, `createExecutionService`, repositories), picks a renderer
with `createWorkflowRunRenderer(ctx.outputMode, { workflowName, ... })`,
consumes the stream, and sets `Deno.exitCode = 1` when
`renderer.workflowFailed()` is true. Errors that are not already a
`UserError` are wrapped as one.

## File Layout

```
src/presentation/
  renderer.ts                          # Renderer<E> interface
  renderers/
    auth_whoami.ts                     # factory + Log/Json renderers
    workflow_run.ts                    # factory + Console/Json renderers
    data_get.ts
    data_list.ts
    extension_push.ts
    extension_version.ts
    repo_init.ts
    ...                                # 180+ files total (including tests)
```

Each file in `renderers/` contains the factory function, mode-specific renderer
classes, and any shared rendering helpers for that operation.

## Migration Status

The renderer pattern is the default across the codebase: the
`src/presentation/renderers/` directory contains 180+ files covering the
majority of CLI commands. `presentation/output/` still holds shared
primitives (console writer, error output, terminal size, Ink hooks) plus a
few command-specific files that have not been converted. To migrate one of
those:

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

## Terminal Width Awareness

All renderers must adapt to the current terminal width to avoid broken layouts
at non-standard sizes (large fonts, narrow windows, split panes).

### Ink/TUI renderers (interactive mode)

Use the `useTerminalSize()` hook from
`presentation/output/hooks/useTerminalSize.ts`. Constrain content containers
with `overflow="hidden"` and explicit `width` props so Ink clips content rather
than wrapping it. The shared `ResultsList` and `PreviewPane` components handle
height clipping via `overflow="hidden"`, but **preview callbacks that render
markdown content** must also:

- Pass `{ maxWidth: width }` to `renderMarkdownToTerminal()` so lines are
  constrained to the pane width.
- Split the rendered multi-line string into per-line
  `<Text wrap="truncate-end">` elements. Ink's `wrap="truncate-end"` is
  per-element, not per-line — a single `<Text>` containing multi-line ANSI
  content will not clip each line individually, causing lines to overlap when
  content overflows the pane.

Callbacks that build structured output from individual `<Text>` elements (not
markdown) do not need this — `wrap="truncate-end"` on each element is
sufficient.

### Log-mode renderers (non-interactive)

Use `getTerminalColumns()` from `presentation/output/terminal_size.ts` to query
the terminal width synchronously. Apply width constraints only to
`writeOutput()` calls (which have no prefix). `logger.info()` calls are left
unconstrained — LogTape's formatter handles its own line formatting.

Guidelines:

- **Separators**: Use `"─".repeat(getTerminalColumns())` instead of hardcoded
  widths like `"─".repeat(60)`.
- **Column widths**: Clamp `padEnd()` values so the total line width does not
  exceed terminal columns.
- **Truncation**: Truncate plain text before applying ANSI colors to avoid
  breaking escape sequences mid-string.
- **Markdown reports**: Pass `{ maxWidth: getTerminalColumns() }` to
  `renderMarkdownToTerminal()`.
