# libswamp: Decoupling Presentation from Domain Logic

## Problem

Swamp's domain logic is currently invoked directly by CLI command handlers. While
the existing separation between domain, infrastructure, and presentation layers
is clean, the CLI is the only entry point — there is no reusable library layer
that other interfaces (web UI, networked API, embedded usage) can call into.

Adding a new presentation layer today requires either duplicating the
orchestration logic in each command handler, or importing and calling CLI
internals in ways they weren't designed for.

## Goal

Extract a **libswamp** library that:

1. Encapsulates all domain orchestration (models, workflows, data, auth, vaults)
2. Communicates progress and results through a uniform `AsyncIterable` event
   stream
3. Enforces exhaustive event handling at compile time
4. Enables new presentation layers (CLI, web UI, networked API) without
   modifying libswamp itself
5. Provides a `Context` object for cancellation, timeouts, and future
   cross-cutting concerns
6. Handles concurrent operations (parallel jobs, parallel steps) by merging
   event streams into a single flat output

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
- **Incrementally adoptable.** Each command can be migrated independently — old
  and new patterns can coexist during the transition.

### Why uniform AsyncIterable (not Promise for simple operations)

Every operation uses `AsyncIterable`, even operations that today produce a single
result. This eliminates a decision point for adapter authors ("is this a stream
or a promise?") and allows any operation to grow intermediate events (validation
warnings, progress, deprecation notices) without breaking the API contract.

## Core Types

### Context

Every libswamp operation takes a `LibSwampContext` as its first parameter.
Context carries cancellation signals and scoped metadata, following the same
pattern as Go's `context.Context`. This ensures cancellation, timeouts, and
future cross-cutting concerns (tracing, tenant scoping) are handled uniformly
without changing operation signatures.

```typescript
// libswamp/context.ts
interface LibSwampContext {
  /** Cancellation signal. Abort to cancel the operation and all its children. */
  readonly signal: AbortSignal;

  /** Scoped logger for this operation. */
  readonly logger: Logger;

  /** Create a child context that cancels after the given duration. */
  withTimeout(ms: number): LibSwampContext;

  /** Create a child context that cancels when either this context or the given signal aborts. */
  withSignal(signal: AbortSignal): LibSwampContext;
}

function createLibSwampContext(options?: { signal?: AbortSignal; logger?: Logger }): LibSwampContext {
  const signal = options?.signal ?? new AbortController().signal;
  const logger = options?.logger ?? getSwampLogger(["libswamp"]);
  return {
    signal,
    logger,
    withTimeout(ms: number): LibSwampContext {
      return createLibSwampContext({
        signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
        logger,
      });
    },
    withSignal(other: AbortSignal): LibSwampContext {
      return createLibSwampContext({
        signal: AbortSignal.any([signal, other]),
        logger,
      });
    },
  };
}
```

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
- **Familiar pattern.** Mirrors Go's `context.Context`, which is
  well-understood for exactly this problem space.

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
// libswamp/auth/whoami.ts
type AuthWhoamiEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; identity: WhoamiIdentity }
  | { kind: "error"; error: SwampError };

interface WhoamiIdentity {
  serverUrl: string;
  id: string;
  username: string;
  email: string;
  name: string;
  collectives?: string[];
}
```

```typescript
// libswamp/workflows/run.ts
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

The key mechanism for compile-time safety. Instead of `switch` statements
(which silently ignore unhandled cases), callers pass a handler object where
every event kind is a required key.

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
  stream: AsyncIterable<E>,
  handlers: EventHandlers<E>,
): Promise<void> {
  for await (const event of stream) {
    const handler = handlers[event.kind as E["kind"]];
    await handler(event as Parameters<typeof handler>[0]);
  }
}
```

### Intentional opt-out

When an adapter genuinely doesn't care about certain events (e.g., JSON mode
ignoring progress), it must be explicit:

```typescript
// Option 1: no-op handler — visible in code review
await consumeStream(stream, {
  loading_credentials: () => {},        // intentional no-op
  contacting_server: () => {},          // intentional no-op
  completed: (e) => console.log(JSON.stringify(e.identity, null, 2)),
  error: (e) => { throw e.error; },
});

// Option 2: withDefaults helper for bulk opt-out
function withDefaults<E extends StreamEvent>(
  partial: Partial<EventHandlers<E>>,
  fallback?: (event: E) => void,
): EventHandlers<E>;

// Usage: only handle what you need, rest are explicitly defaulted
await consumeStream(stream, withDefaults<AuthWhoamiEvent>({
  completed: (e) => console.log(JSON.stringify(e.identity, null, 2)),
  error: (e) => { throw e.error; },
}));
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

`merge()` combines multiple `AsyncIterable` streams into one, yielding events
in arrival order:

```typescript
// libswamp/stream/merge.ts
async function* merge<E extends StreamEvent>(
  streams: AsyncIterable<E>[],
): AsyncIterable<E> {
  if (streams.length === 0) return;
  if (streams.length === 1) {
    yield* streams[0];
    return;
  }

  const queue = new AsyncQueue<E>();
  let active = streams.length;

  for (const stream of streams) {
    (async () => {
      try {
        for await (const event of stream) {
          queue.push(event);
        }
      } finally {
        if (--active === 0) queue.close();
      }
    })();
  }

  for await (const event of queue) {
    yield event;
  }
}
```

`AsyncQueue` is an internal async-iterable queue that supports `push()`,
`close()`, and `for await` consumption. It bridges the gap between multiple
concurrent push-based producers and a single pull-based consumer.

```typescript
// libswamp/stream/async_queue.ts
class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolve: ((done: boolean) => void) | null = null;
  private closed = false;

  push(item: T): void {
    this.buffer.push(item);
    this.resolve?.(false);
    this.resolve = null;
  }

  close(): void {
    this.closed = true;
    this.resolve?.(true);
    this.resolve = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      }
      if (this.closed) return;
      const done = await new Promise<boolean>((r) => { this.resolve = r; });
      if (done && this.buffer.length === 0) return;
    }
  }
}
```

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
between jobs is non-deterministic — two runs may produce different interleavings.
Within a single job, events are always in causal order.

### Consuming interleaved events

Consumers use the same `consumeStream` / `EventHandlers` pattern. The `jobId`
field routes events to the right place:

```typescript
// CLI adapter — prefix each line with the job name
await consumeStream(workflowRun(ctx, deps, input), {
  validating_inputs: () => {},
  evaluating_workflow: () => {},
  started: (e) => console.log(`Workflow ${e.workflowName} started`),
  job_started: (e) => console.log(`  [${e.jobId}] started`),
  job_completed: (e) => console.log(`  [${e.jobId}] ${e.status}`),
  job_skipped: (e) => console.log(`  [${e.jobId}] skipped`),
  step_started: (e) => console.log(`  [${e.jobId}] ${e.stepId} started`),
  step_completed: (e) => console.log(`  [${e.jobId}] ${e.stepId} completed`),
  step_skipped: (e) => console.log(`  [${e.jobId}] ${e.stepId} skipped`),
  step_failed: (e) => console.log(`  [${e.jobId}] ${e.stepId} FAILED: ${e.error}`),
  completed: (e) => console.log(`Done: ${e.run.status}`),
  error: (e) => { throw new UserError(e.error.message); },
});
```

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
async function* whoami(ctx: LibSwampContext, deps: AuthDeps): AsyncIterable<AuthWhoamiEvent>;
function createAuthDeps(options?: { serverUrlOverride?: string }): AuthDeps;

// Workflow operation signatures
async function* workflowRun(ctx: LibSwampContext, deps: WorkflowRunDeps, input: WorkflowRunInput): AsyncGenerator<WorkflowRunEvent>;
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
// Core types
export { createLibSwampContext, type LibSwampContext } from "./context.ts";
export { type SwampError, cancelled, invalidApiKey, notAuthenticated } from "./errors.ts";
export { consumeStream, type EventHandlers, type HasTerminals, result, type StreamEvent, withDefaults } from "./stream.ts";
export { AsyncQueue } from "./stream/async_queue.ts";
export { merge } from "./stream/merge.ts";
export { assertCompletes, assertErrors, collect } from "./testing.ts";

// Auth operations
export { createAuthDeps, type AuthDeps, type AuthWhoamiEvent, whoami, type WhoamiIdentity } from "./auth/whoami.ts";

// Workflow operations
export { workflowRun, type WorkflowRunDeps, type WorkflowRunEvent, type WorkflowRunInput, ... } from "./workflows/run.ts";
export { type WorkflowRunView, type JobRunView, type StepRunView, ... } from "./workflows/workflow_run_view.ts";
```

External consumers (CLI commands, presentation renderers) import exclusively
from `libswamp/mod.ts` — never from internal module paths.

## Example: `swamp auth whoami` with libswamp

### libswamp defines the operation and its events

```typescript
// libswamp/auth/whoami.ts
type AuthWhoamiEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; identity: WhoamiIdentity }
  | { kind: "error"; error: SwampError };

interface AuthDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  fetchWhoami: (serverUrl: string, apiKey: string, signal: AbortSignal) => Promise<WhoamiResponse>;
  serverUrlOverride?: string;
}

function createAuthDeps(options?: { serverUrlOverride?: string }): AuthDeps {
  const repo = new AuthRepository();
  return {
    loadCredentials: () => repo.load(),
    fetchWhoami: (serverUrl, apiKey, signal) => {
      const client = new SwampClubClient(serverUrl);
      return client.whoami(apiKey, signal);
    },
    serverUrlOverride: options?.serverUrlOverride,
  };
}

async function* whoami(ctx: LibSwampContext, deps: AuthDeps): AsyncIterable<AuthWhoamiEvent> {
  yield { kind: "loading_credentials" };

  const credentials = await deps.loadCredentials();
  if (!credentials) {
    yield { kind: "error", error: notAuthenticated() };
    return;
  }

  const serverUrl = deps.serverUrlOverride ?? credentials.serverUrl;
  yield { kind: "contacting_server", serverUrl };

  try {
    const response = await deps.fetchWhoami(serverUrl, credentials.apiKey, ctx.signal);

    if (!response.authenticated) {
      yield { kind: "error", error: invalidApiKey() };
      return;
    }

    const collectives = getCollectives(response);
    yield {
      kind: "completed",
      identity: {
        serverUrl,
        id: response.id!,
        username: response.username!,
        email: response.email!,
        name: response.name!,
        ...(collectives ? { collectives } : {}),
      },
    };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      yield { kind: "error", error: cancelled(error) };
      return;
    }
    throw error;
  }
}
```

### CLI adapter consumes events with exhaustive handlers

```typescript
// src/cli/commands/auth_whoami.ts
import {
  type AuthWhoamiEvent, consumeStream, createAuthDeps,
  createLibSwampContext, whoami,
} from "../../libswamp/mod.ts";

export const authWhoamiCommand = new Command()
  .name("whoami")
  .description("Show current authenticated identity")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["auth", "whoami"]);
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createAuthDeps({
      serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
    });

    await consumeStream<AuthWhoamiEvent>(whoami(ctx, deps), {
      loading_credentials: () => {
        cliCtx.logger.debug("Loading stored credentials");
      },
      contacting_server: (e) => {
        cliCtx.logger.debug(`Contacting ${e.serverUrl}`);
      },
      completed: (e) => {
        if (cliCtx.outputMode === "json") {
          console.log(JSON.stringify({
            authenticated: true,
            serverUrl: e.identity.serverUrl,
            id: e.identity.id,
            username: e.identity.username,
            email: e.identity.email,
            name: e.identity.name,
            ...(e.identity.collectives ? { collectives: e.identity.collectives } : {}),
          }, null, 2));
        } else {
          console.log(`${e.identity.username} (${e.identity.email}) on ${e.identity.serverUrl}`);
          if (e.identity.collectives && e.identity.collectives.length > 0) {
            console.log(`Collectives: ${e.identity.collectives.join(", ")}`);
          }
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    });
  });
```

The command handler contains zero domain logic. It creates a `LibSwampContext`
with the CLI's logger, then translates events into presentation.

### Tests assert on events directly

```typescript
// libswamp/auth/whoami_test.ts
Deno.test("whoami yields identity on success", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    credentials: testCredentials,
    whoamiResponse: testWhoamiResponse,
  });

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  assertEquals(events, [
    { kind: "loading_credentials" },
    { kind: "contacting_server", serverUrl: "https://swamp.club" },
    {
      kind: "completed",
      identity: {
        serverUrl: "https://swamp.club",
        id: "user-1",
        username: "adam",
        email: "adam@example.com",
        name: "Adam",
        collectives: ["si"],
      },
    },
  ]);
});

Deno.test("whoami yields not_authenticated error when no credentials", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ credentials: null });
  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "loading_credentials" });
  const last = events[1] as Extract<AuthWhoamiEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_authenticated");
});

Deno.test("whoami yields cancelled error when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const ctx = createLibSwampContext({ signal: controller.signal });
  const deps: AuthDeps = {
    loadCredentials: () => Promise.resolve(testCredentials),
    fetchWhoami: (_serverUrl, _apiKey, signal) => {
      signal.throwIfAborted();
      return Promise.resolve(testWhoamiResponse);
    },
    serverUrlOverride: undefined,
  };

  const events = await collect<AuthWhoamiEvent>(whoami(ctx, deps));
  const last = events[events.length - 1] as Extract<AuthWhoamiEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "cancelled");
});
```

No mocking of console.log. No output mode switching. The test verifies domain
behavior through the event stream, including cancellation.

## Error Handling

### SwampError

All errors yielded in event streams use a structured `SwampError` type rather
than thrown exceptions:

```typescript
interface SwampError {
  readonly code: string;        // machine-readable (e.g., "not_authenticated", "cancelled")
  readonly message: string;     // human-readable
  readonly cause?: Error;       // original exception for stack traces
  readonly details?: unknown;   // optional structured data for debugging
}
```

Errors that originate within the generator (domain logic) are **yielded** as
`{ kind: "error", error: SwampError }` events. This keeps the stream protocol
uniform — consumers never need `try/catch` around `for await` to handle
expected errors. Cancellation is also an error event with
`code: "cancelled"`, not a special case.

Unexpected errors (bugs, infrastructure failures) may still throw and should be
caught at the adapter boundary.

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
// libswamp/testing.ts

/** Accumulates all events from a stream into an array. */
async function collect<E extends StreamEvent>(
  stream: AsyncIterable<E>,
): Promise<E[]> {
  const events: E[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

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

## Migration Strategy

The migration from the current architecture to libswamp can be done
incrementally, one command at a time:

1. **Define `LibSwampContext` and stream helpers** (`createLibSwampContext`,
   `consumeStream`, `result`, `withDefaults`, `collect`, `merge`).
2. **Define the event types** for a single operation (e.g., `auth.whoami`).
3. **Implement the generator** in `libswamp/`, extracting domain logic from the
   existing command handler. The generator takes `ctx: LibSwampContext` as its
   first parameter.
4. **Rewrite the CLI command handler** to create a `LibSwampContext`, call
   libswamp, and consume events.
5. **Delete the old domain calls** from the command handler.
6. Repeat for the next command.

Old-style and new-style commands coexist during the migration. No big-bang
rewrite required.

### Dependency direction

```
src/cli/commands/     →  libswamp/         →  src/domain/
  (adapters)               (orchestration)      (entities, value objects)
                                            →  src/infrastructure/
                                                 (repositories, HTTP clients)
```

The CLI layer depends on libswamp. libswamp depends on domain and
infrastructure. Domain depends on nothing. This is the standard hexagonal
dependency rule, enforced by Deno's module system.
