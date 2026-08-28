---
audience: maintainer
last-verified: 2026-08-28 @ 3d5955a9
---

# libswamp: Decoupling Presentation from Domain Logic

## Why

`src/libswamp/` is the orchestration layer that sits between the delivery
mechanisms (`src/cli/`, `src/serve/`) and the domain. It exists so that domain
orchestration (models, workflows, data, auth, vaults) is written once and
consumed by any presentation layer without duplicating command-handler logic
or reaching into CLI internals. It does this by:

1. Communicating progress and results through a uniform `AsyncIterable` event
   stream
2. Enforcing exhaustive event handling at compile time
3. Providing a `LibSwampContext` for cancellation, timeouts, and future
   cross-cutting concerns
4. Merging concurrent operations (parallel jobs, parallel steps) into a single
   flat event stream

**Status:** implemented. The CLI and `swamp serve` both consume libswamp; the
remaining layer-boundary debt is pinned by `integration/ddd_layer_rules_test.ts`
(see [Dependency direction](#dependency-direction)).

## Design: AsyncIterable Event Streams

Every libswamp operation accepts a `Context` as its first parameter and returns
an `AsyncIterable<E>` where `E` is a discriminated union of typed events. The
caller pulls events at its own pace and renders them however it chooses.

```
┌──────────────┐                                    ┌──────────────┐
│  CLI Adapter  │     for await (of stream)          │              │
│  (Cliffy)     │◄───────────────────────────────────│              │
├──────────────┤                                    │              │
│  Web Adapter  │     for await (of stream)          │   libswamp   │
│  (HTTP/WS)    │◄───────────────────────────────────│              │
├──────────────┤                                    │              │
│  Test Harness │     collect(stream)                │              │
│              │◄───────────────────────────────────│              │
└──────────────┘                                    └──────┬───────┘
                                                          │
                                                   ┌──────▼───────┐
                                                   │ Repositories │
                                                   │ (FS / S3)    │
                                                   └──────────────┘
```

### Why AsyncIterable

- **Backpressure is built in.** The consumer pulls events; libswamp yields them.
  A slow WebSocket client naturally throttles the producer without buffering.
- **Deno-native.** `AsyncIterable` and `for await...of` are first-class in Deno
  and TypeScript. No external event emitter libraries needed.
- **Composable.** Streams can be mapped, filtered, merged, and piped using
  standard async iteration utilities.
- **Incrementally adoptable.** Each operation is an independent generator, so
  new operations are added without touching existing ones.

### Why uniform AsyncIterable (not Promise for simple operations)

Every operation uses `AsyncIterable`, even operations that today produce a
single result. This eliminates a decision point for adapter authors ("is this a
stream or a promise?") and allows any operation to grow intermediate events
(validation warnings, progress, deprecation notices) without breaking the API
contract.

## Core Types

### Context

Every libswamp operation takes a `LibSwampContext` as its first parameter.
Context carries cancellation signals and scoped metadata, following the same
pattern as Go's `context.Context`. This ensures cancellation, timeouts, and
future cross-cutting concerns (tracing, tenant scoping) are handled uniformly
without changing operation signatures.

```typescript
// src/libswamp/context.ts
interface LibSwampContext {
  readonly signal: AbortSignal; // abort to cancel the operation and its children
  readonly logger: Logger; // scoped logger for this operation
  withTimeout(ms: number): LibSwampContext; // child that cancels after ms
  withSignal(signal: AbortSignal): LibSwampContext; // child that cancels on either
}

function createLibSwampContext(
  options?: { signal?: AbortSignal; logger?: Logger },
): LibSwampContext;
```

Child contexts combine signals with `AbortSignal.any`; see the file for the
implementation.

#### Why Context, not a bare AbortSignal parameter

- **Extensible without API churn.** Adding tracing, request IDs, or tenant
  scoping later means adding a field to `LibSwampContext`, not changing every
  operation's parameter list.
- **Hierarchical cancellation.** `withTimeout` and `withSignal` create child
  contexts. Cancelling a parent cancels all children. This maps naturally onto
  workflow → job → step.
- **Always present.** Because `ctx` is required, generators never need
  `if (options?.signal)` guards. The signal is always there — it's simply
  never-aborted if the caller doesn't need cancellation.
- **Familiar pattern.** Mirrors Go's `context.Context`, which is well-understood
  for exactly this problem space.

#### Cancellation semantics

When a context's signal is aborted:

1. Any in-flight `fetch()`, `Deno.Command`, or S3 operation that received the
   signal is **immediately interrupted** — the `await` rejects with
   `AbortError`.
2. The generator catches the abort and yields
   `{ kind: "error", error: { code: "cancelled", message: "..." } }`.
3. The consumer receives the cancellation through the normal `error` handler —
   no special `try/catch` needed.
4. Generators use `try/finally` for resource cleanup (killing subprocesses,
   releasing locks) regardless of whether cancellation occurred.

### Event Streams

Every operation defines its own event union with a `kind` discriminant:

```typescript
// src/libswamp/auth/whoami.ts
type AuthWhoamiEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; identity: WhoamiIdentity }
  | { kind: "error"; error: SwampError };
```

`WhoamiIdentity` (same file) carries `serverUrl`, `id`, `username`, `email`,
`name`, and a set of optional server-supplied fields (`collectives`, `plan`,
`collectiveEntitlements`, token scope info). Every field beyond the core five
is optional so one CLI can talk to several server versions.

`WorkflowRunEvent` (`src/libswamp/workflows/run.ts`) is the largest union —
27 kinds at the time of writing:

`validating_inputs`, `evaluating_workflow`, `started`, `superseded_runs`,
`job_started`, `job_completed`, `job_skipped`, `step_started`,
`step_completed`, `step_skipped`, `step_queued`, `step_failed`,
`step_target_disconnected`, `approval_requested`, `model_resolved`,
`env_var_warning`, `method_executing`, `method_output`, `method_event`,
`assert_result`, `report_started`, `report_completed`, `report_failed`,
`completed`, `cancelled`, `suspended`, `error`.

Read the file for each variant's payload; this document deliberately does not
copy the union because it changes often and every adapter is
exhaustiveness-checked against the real type anyway.

Events from parallel jobs interleave on the single stream. Each event carries
`jobId` (and `stepId` where applicable) so consumers can demultiplex. See
[Concurrency](#concurrency) for details.

### Convention: every event union includes `completed` and `error`

All event unions must include a `{ kind: "completed"; ... }` variant and a
`{ kind: "error"; error: SwampError }` variant. This is enforced by a type
constraint:

```typescript
type StreamEvent = { kind: string };

// `kind` is used (rather than `step` or `type`) to avoid collision with:
// - `step`, which refers to workflow Steps (a domain concept)
// - `type`, which is the discriminant used by domain events like MethodExecutionEvent

type HasTerminals<E extends StreamEvent> =
  Extract<E, { kind: "completed" }> extends never ? never
    : Extract<E, { kind: "error" }> extends never ? never
    : E;

// This constraint is applied to the consumeStream and result helpers,
// so event unions that lack completed/error won't compile.
```

## Exhaustiveness-Checked Event Handlers

The key mechanism for compile-time safety. Instead of `switch` statements (which
silently ignore unhandled cases), callers pass a handler object where every
event kind is a required key.

### EventHandlers type

```typescript
type EventHandlers<E extends StreamEvent> = {
  [K in E["kind"]]: (event: Extract<E, { kind: K }>) => void | Promise<void>;
};
```

Given `AuthWhoamiEvent`, this expands to:

```typescript
{
  loading_credentials: (event: { kind: "loading_credentials" }) => void;
  contacting_server: (event: { kind: "contacting_server"; serverUrl: string }) => void;
  completed: (event: { kind: "completed"; identity: WhoamiIdentity }) => void;
  error: (event: { kind: "error"; error: SwampError }) => void;
}
```

Omitting any key is a compile error. Adding a new variant to the event union
breaks every adapter that doesn't handle it.

### consumeStream

The primary consumption function:

```typescript
async function consumeStream<E extends StreamEvent>(
  stream: AsyncIterable<HasTerminals<E>>,
  handlers: EventHandlers<E>,
): Promise<void> {
  for await (const event of stream) {
    const handler = handlers[event.kind as E["kind"]];
    await handler(event as any);
  }
}
```

### Intentional opt-out

When an adapter genuinely doesn't care about certain events (e.g., JSON mode
ignoring progress), it must be explicit:

```typescript
// Option 1: no-op handler — visible in code review
await consumeStream(stream, {
  loading_credentials: () => {}, // intentional no-op
  contacting_server: () => {}, // intentional no-op
  completed: (e) => console.log(JSON.stringify(e.identity, null, 2)),
  error: (e) => {
    throw e.error;
  },
});

// Option 2: withDefaults helper for bulk opt-out
function withDefaults<E extends StreamEvent>(
  partial: Partial<EventHandlers<E>>,
  fallback?: (event: E) => void,
): EventHandlers<E>;

// Usage: only handle what you need, rest are explicitly defaulted
await consumeStream(
  stream,
  withDefaults<AuthWhoamiEvent>({
    completed: (e) => console.log(JSON.stringify(e.identity, null, 2)),
    error: (e) => {
      throw e.error;
    },
  }),
);
```

`withDefaults` fills missing handlers with no-ops (or a provided fallback). The
caller is consciously choosing to ignore events, rather than accidentally
forgetting a `case` in a `switch`.

## The result Helper

For call sites that only need the final result (tests, scripts, simple
integrations), the `result` helper fast-forwards through the stream:

```typescript
async function result<E extends StreamEvent>(
  stream: AsyncIterable<HasTerminals<E>>,
): Promise<Extract<E, { kind: "completed" }>> {
  for await (const event of stream) {
    if (event.kind === "completed") {
      return event as Extract<E, { kind: "completed" }>;
    }
    if (event.kind === "error") {
      throw (event as Extract<E, { kind: "error" }>).error;
    }
  }
  throw new Error("Stream ended without a completed or error event");
}
```

Usage:

```typescript
const ctx = createLibSwampContext();
const { identity } = await result(whoami(ctx, deps));
console.log(identity.username);
```

This consumes and discards all intermediate events, awaits the terminal event,
and returns the `completed` payload (or throws the `error` payload). It
preserves full type inference — the return type is the exact shape of the
`completed` variant.

## Concurrency

Swamp workflows execute jobs in parallel within each topological level, and
steps in parallel within each job level. Since `async function*` generators are
single-producer (they can only `yield` one event at a time), parallel work is
handled by merging concurrent event streams into a single flat output using a
`merge()` utility.

### Design: flat tagged stream with merge

All events from all parallel jobs appear on a single `AsyncIterable`. Events
carry `jobId` and `stepId` fields so consumers can demultiplex by source. The
producer uses `merge()` internally — the consumer sees a flat stream and uses
`consumeStream` / `EventHandlers` exactly as with any other operation.

```
                                    ┌─ job-1 stream ─┐
workflow generator ── merge() ◄─────┤                 │──► single flat stream
                                    ├─ job-2 stream ─┤
                                    └─ job-3 stream ─┘
```

### The merge utility

`merge()` combines multiple `AsyncIterable` streams into one, yielding events in
arrival order:

```typescript
// src/infrastructure/stream/merge.ts (re-exported from src/libswamp/stream/merge.ts)
async function* merge<T>(
  streams: AsyncIterable<T>[],
  signal?: AbortSignal,
): AsyncGenerator<T>;

// Same file — bounded fan-out for callers that must cap parallelism.
async function* mergeWithConcurrency<T>(...): AsyncGenerator<T>;
```

Each input stream pushes into a shared `AsyncQueue`; the last stream to finish
closes it, and `signal` allows early abort.

`AsyncQueue` (`src/infrastructure/stream/async_queue.ts`, re-exported from
`src/libswamp/stream/async_queue.ts`) is an async-iterable queue with
`push()`, `close()`, `abort()`, and `for await` consumption. It bridges
multiple concurrent push-based producers and a single pull-based consumer,
using `IteratorResult<T>` signalling internally to distinguish values from
end-of-stream.

### merge is a general-purpose composable

`merge()` is not specific to workflows. Any operation that fans out concurrent
work uses the same primitive:

- **Workflow run** merges parallel job streams per topological level
- **Job execution** merges parallel step streams per step level
- **Data GC** could merge parallel cleanup across data types
- **Batch operations** merge parallel model method executions

This is a single utility, tested once, reused everywhere.

### What interleaved events look like

A workflow with two parallel jobs (`build` and `test`) produces events like:

```
{ kind: "started", runId: "run-1", workflowName: "ci" }
{ kind: "job_started", jobId: "build" }
{ kind: "job_started", jobId: "test" }
{ kind: "step_completed", jobId: "build", stepId: "compile" }
{ kind: "step_completed", jobId: "test", stepId: "unit" }
{ kind: "job_completed", jobId: "build", status: "succeeded" }
{ kind: "job_completed", jobId: "test", status: "succeeded" }
{ kind: "completed", run: { ... } }
```

Events from `build` and `test` interleave in arrival order. The exact ordering
between jobs is non-deterministic — two runs may produce different
interleavings. Within a single job, events are always in causal order.

### Consuming interleaved events

Consumers use the same `consumeStream` / `EventHandlers` pattern. The `jobId`
field routes events to the right place:

```typescript
// Sketch — a real adapter must handle every kind in WorkflowRunEvent.
await consumeStream(workflowRun(ctx, deps, input), {
  started: (e) => console.log(`Workflow ${e.workflowName} started`),
  job_started: (e) => console.log(`  [${e.jobId}] started`),
  step_completed: (e) => console.log(`  [${e.jobId}] ${e.stepId} completed`),
  completed: (e) => console.log(`Done: ${e.run.status}`),
  error: (e) => {
    throw new UserError(e.error.message);
  },
  // ...remaining kinds
});
```

The production CLI adapter is `ConsoleWorkflowRunRenderer` in
`src/presentation/renderers/workflow_run.ts`; see
[rendering.md](./rendering.md).

### Cancellation with parallel streams

Context's hierarchical cancellation integrates naturally with `merge()`. Each
parallel job gets a child context; cancelling the parent cancels all children:

```
CLI SIGINT → root LibSwampContext
               └─► workflow LibSwampContext
                    ├─► job "build" LibSwampContext (5 min timeout)
                    │    ├─► step "compile" (inherits build signal)
                    │    └─► step "package" (inherits build signal)
                    └─► job "test" LibSwampContext (10 min timeout)
                         └─► step "unit" (inherits test signal)
```

When the root context is aborted:

1. All child contexts abort simultaneously
2. In-flight `fetch()` / `Deno.Command` calls in every parallel job are
   interrupted
3. Each job generator catches the abort and yields an error event
4. `merge()` collects these error events and yields them on the parent stream
5. The workflow generator yields its own error event
6. The consumer receives all errors through the normal `error` handler

A single job timing out cancels only that job's steps — sibling jobs continue
unaffected.

## Public API

libswamp operations are standalone `async function*` generators exported from
`libswamp/mod.ts`. There is no facade object — each operation is a free function
that accepts `(ctx: LibSwampContext, deps: Deps, input?: Input)`.

### Pattern

Every operation follows the same three-argument pattern:

1. **`ctx: LibSwampContext`** — carries cancellation signal and logger
2. **`deps: XxxDeps`** — injectable dependencies (repositories, HTTP clients)
   defined as an interface for testability
3. **`input?: XxxInput`** — operation-specific parameters (optional for
   operations that take no input)

Each domain area provides a `createXxxDeps()` factory that wires real
infrastructure:

```typescript
// Auth operation signatures
async function* whoami(
  ctx: LibSwampContext,
  deps: AuthDeps,
): AsyncIterable<AuthWhoamiEvent>;
function createAuthDeps(options?: { serverUrlOverride?: string }): AuthDeps;

// Workflow operation signatures
async function* workflowRun(
  ctx: LibSwampContext,
  deps: WorkflowRunDeps,
  input: WorkflowRunInput,
): AsyncGenerator<WorkflowRunEvent>;
```

### Why standalone functions, not a facade object

- **No hidden state.** Each call is explicit about what it needs (ctx, deps,
  input). There's no `Swamp` instance to configure or invalidate.
- **Tree-shakeable.** Consumers import only the operations they use.
- **Testable.** Deps are injected per-call, so tests provide fakes without
  mocking a global object.
- **Incrementally adoptable.** New operations are added by exporting a new
  function — no interface to extend.

### Exports

Everything external consumers need is exported from `libswamp/mod.ts`:

```typescript
// src/libswamp/mod.ts (excerpt — the file is ~1600 lines of re-exports)
export { createLibSwampContext, type LibSwampContext } from "./context.ts";
export { consumeStream, type EventHandlers, type HasTerminals, result, type StreamEvent, withDefaults } from "./stream.ts";
export { AsyncQueue } from "./stream/async_queue.ts";
export { merge } from "./stream/merge.ts";
export { assertCompletes, assertErrors, collect } from "./testing.ts";
// ...plus, per domain area: the operation generator, its Deps/Input/Event
// types, and the createXxxDeps() factory (e.g. whoami / createAuthDeps,
// workflowRun / WorkflowRunEvent / WorkflowRunView).
```

External consumers (CLI commands, presentation renderers) import exclusively
from `libswamp/mod.ts` — never from internal module paths. This is enforced
by the "libswamp encapsulation" rule in `integration/ddd_layer_rules_test.ts`.

## Example: `swamp auth whoami` with libswamp

### libswamp defines the operation and its events

```typescript
// src/libswamp/auth/whoami.ts
export interface AuthDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  saveCredentials: (credentials: AuthCredentials) => Promise<void>;
  fetchWhoami: (serverUrl: string, apiKey: string, signal: AbortSignal) => Promise<WhoamiResponse>;
  serverUrlOverride?: string;
}

export function createAuthDeps(options: CreateAuthDepsOptions = {}): AuthDeps;

export async function* whoami(
  ctx: LibSwampContext,
  deps: AuthDeps,
): AsyncIterable<AuthWhoamiEvent>;
```

The generator yields `loading_credentials`, then either `error`
(`notAuthenticated()`) or `contacting_server`; it passes `ctx.signal` to
`fetchWhoami`, maps an `AbortError` to `error` (`cancelled()`), an
unauthenticated response to `error` (`invalidApiKey()`), and otherwise yields
`completed` with the identity. Read the file for the full body.

### CLI adapter consumes events through a renderer

`src/cli/commands/auth_whoami.ts` contains zero domain logic. It creates a
`LibSwampContext` with the CLI's logger, wires deps with `createAuthDeps`, and
hands the stream to a mode-specific renderer:

```typescript
const ctx = createLibSwampContext({ logger: cliCtx.logger });
const deps = createAuthDeps({ serverUrlOverride: ..., identity });
const renderer = createAuthWhoamiRenderer(cliCtx.outputMode);
await consumeStream(whoami(ctx, deps), renderer.handlers());
```

`createAuthWhoamiRenderer` (`src/presentation/renderers/auth_whoami.ts`)
returns `LogAuthWhoamiRenderer` or `JsonAuthWhoamiRenderer`; each implements
`Renderer<AuthWhoamiEvent>` and so is exhaustiveness-checked against the
union. See [rendering.md](./rendering.md).

### Tests assert on events directly

`src/libswamp/auth/whoami_test.ts` drives the generator with fake deps and
asserts on the collected events, e.g.
`"whoami yields loading_credentials -> contacting_server -> completed on success"`,
`"whoami yields not_authenticated error when no credentials"`, and the
already-aborted-signal case that expects `error.code === "cancelled"`:

```typescript
const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));
assertEquals(events[0], { kind: "loading_credentials" });
```

No mocking of console.log. No output mode switching. The test verifies domain
behavior through the event stream, including cancellation.

## Error Handling

### SwampError

All errors yielded in event streams use a structured `SwampError` type rather
than thrown exceptions:

```typescript
interface SwampError {
  readonly code: string; // machine-readable (e.g., "not_authenticated", "cancelled")
  readonly message: string; // human-readable
  readonly cause?: Error; // original exception for stack traces
  readonly details?: unknown; // optional structured data for debugging
}
```

Errors that originate within the generator (domain logic) are **yielded** as
`{ kind: "error", error: SwampError }` events. This keeps the stream protocol
uniform — consumers never need `try/catch` around `for await` to handle expected
errors. Cancellation is also an error event with `code: "cancelled"`, not a
special case.

Unexpected errors (bugs, infrastructure failures) may still throw and should be
caught at the adapter boundary.

### Known error codes

Codes used across libswamp generators and the CLI error boundary:

| Code                        | Origin             | Meaning                                         |
| --------------------------- | ------------------ | ----------------------------------------------- |
| `not_authenticated`         | `libswamp/errors`  | No valid auth credentials                       |
| `invalid_api_key`           | `libswamp/errors`  | Stored API key is no longer valid               |
| `cancelled`                 | `libswamp/errors`  | Operation cancelled (e.g. Ctrl+C, AbortSignal)  |
| `not_found`                 | `libswamp/errors`  | Generic entity not found                        |
| `already_exists`            | `libswamp/errors`  | Entity already exists                           |
| `validation_failed`         | `libswamp/errors`  | Input or configuration validation failed        |
| `lock_timeout`              | `distributed_lock` | Lock held by another process; timed out waiting |
| `model_not_found`           | `models/run`       | No model matches the given name                 |
| `unknown_model_type`        | `models/run`       | Type prefix does not match any installed type   |
| `unknown_method`            | `models/run`       | Model does not define the requested method      |
| `no_evaluated_definition`   | `models/run`       | No evaluated definition exists                  |
| `method_execution_failed`   | `models/run`       | Execution driver returned an error              |
| `missing_deps`              | `models/run`       | Required extension dependencies not installed   |
| `workflow_not_found`        | `workflows/run`    | No workflow matches the given name              |
| `workflow_load_failed`      | `workflows/run`    | Workflow file exists but could not be loaded    |
| `workflow_execution_failed` | `workflows/run`    | Workflow step execution failed                  |
| `input_validation_failed`   | `workflows/run`    | Workflow input validation failed                |

This table is not exhaustive — generators may define additional codes for
domain-specific errors. The `code` field is always a `snake_case` string.

### CLI exit codes

| Exit code | Meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `0`       | Success                                                                                  |
| `1`       | General error (default for all unrecognized error codes)                                 |
| `2`       | Unknown command                                                                          |
| `75`      | Lock contention / temporary failure (`lock_timeout`) — callers should retry with backoff |

Callers that only need pass/fail should check `$? -ne 0`. Callers that want to
handle specific failure modes (e.g. retry on lock contention) should match the
numeric exit code.

### Error handling by adapters

```typescript
// CLI: translate to UserError for clean CLI output
error: (e) => {
  if (e.error.code === "cancelled") return;  // silent on Ctrl+C
  throw new UserError(e.error.message);
},

// Web: send error event, close stream
error: (e) => { ws.send(JSON.stringify({ id, event: e })); },

// Test: assert on error events
const events = await collect(stream);
assertEquals(events[events.length - 1], {
  kind: "error",
  error: { code: "not_authenticated", message: "..." },
});
```

## Testing Utilities

libswamp provides test helpers that make assertions on event streams ergonomic:

```typescript
// src/libswamp/testing.ts

/** Accumulates all events from a stream into an array. */
async function collect<E extends StreamEvent>(
  stream: AsyncIterable<E>,
): Promise<E[]>;

/** Asserts that a stream ends with a `completed` event matching the expected value. */
async function assertCompletes<E extends StreamEvent>(
  stream: AsyncIterable<HasTerminals<E>>,
  expected: Extract<E, { kind: "completed" }>,
): Promise<Extract<E, { kind: "completed" }>>;

/** Asserts that a stream ends with an `error` event with the given code. */
async function assertErrors<E extends StreamEvent>(
  stream: AsyncIterable<HasTerminals<E>>,
  expectedCode: string,
): Promise<SwampError>;
```

## Adding a New Operation

1. **Define the event union** in a new `src/libswamp/<area>/<op>.ts`, with
   `completed` and `error` variants.
2. **Define `XxxDeps` / `XxxInput`** and a `createXxxDeps()` factory that wires
   real infrastructure.
3. **Implement the generator** taking `(ctx: LibSwampContext, deps, input)`;
   pass `ctx.signal` to every outbound call.
4. **Export** the generator, types, and factory from `src/libswamp/mod.ts`.
5. **Write the renderer** in `src/presentation/renderers/` and the CLI command
   that wires them together (see [rendering.md](./rendering.md)).
6. **Test the generator** with fake deps and `collect` / `assertCompletes` /
   `assertErrors`.

### Dependency direction

```
src/cli/commands/, src/serve/  →  src/libswamp/     →  src/domain/
  (delivery mechanisms)             (orchestration)      (entities, value objects)
                                                     →  src/infrastructure/
                                                          (repositories, HTTP clients)
```

The CLI and serve layers depend on libswamp. libswamp depends on domain and
infrastructure. Domain should depend on nothing — that is the standard
hexagonal dependency rule, and the target state.

It is not the current state, and nothing in Deno's module system enforces it.
A set of `src/domain/**` modules still import concrete infrastructure directly
(YAML repositories, the catalog store, the CEL evaluator, path helpers). Those
edges are legacy debt from before libswamp existed, and they are pinned
individually in `integration/ddd_layer_rules_test.ts`:

- The test scans every domain source file and compares the exact set of
  domain→infrastructure import edges against a checked-in list.
- A **new** edge fails the build. Define the port in the domain and implement
  it in infrastructure instead of adding one.
- A **removed** edge also fails the build, so the pinned list must be trimmed
  when debt is paid off and the fix cannot silently regress.
- Logging (`src/infrastructure/logging/`) and tracing
  (`src/infrastructure/tracing/`) are exempt as cross-cutting concerns.

The same file pins the `src/serve/ → src/cli/` edges on the same terms
(`PINNED_SERVE_CLI_EDGES` — serve borrows a handful of CLI wiring helpers
that should be hoisted into a shared layer), asserts that
`src/presentation/` imports no infrastructure other than logging/tracing,
and enforces that `src/cli/` and `src/presentation/` import libswamp only via
`mod.ts`. `integration/architecture_boundary_test.ts` pins the mutual
dependencies between bounded contexts. New code is expected to follow the
dependency rule; the pinned lists exist so the existing violations shrink
over time and never grow.
