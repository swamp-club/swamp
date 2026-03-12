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

Every libswamp operation takes a `Context` as its first parameter. Context
carries cancellation signals and scoped metadata, following the same pattern as
Go's `context.Context`. This ensures cancellation, timeouts, and future
cross-cutting concerns (tracing, tenant scoping) are handled uniformly without
changing operation signatures.

```typescript
// libswamp/context.ts
interface Context {
  /** Cancellation signal. Abort to cancel the operation and all its children. */
  readonly signal: AbortSignal;

  /** Scoped logger for this operation. */
  readonly logger: Logger;

  /** Create a child context that cancels after the given duration. */
  withTimeout(ms: number): Context;

  /** Create a child context that cancels when either this context or the given signal aborts. */
  withSignal(signal: AbortSignal): Context;
}

function createContext(options?: { signal?: AbortSignal; logger?: Logger }): Context {
  const signal = options?.signal ?? new AbortController().signal;
  const logger = options?.logger ?? getSwampLogger(["libswamp"]);
  return {
    signal,
    logger,
    withTimeout(ms: number): Context {
      return createContext({
        signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
        logger,
      });
    },
    withSignal(other: AbortSignal): Context {
      return createContext({
        signal: AbortSignal.any([signal, other]),
        logger,
      });
    },
  };
}
```

#### Why Context, not a bare AbortSignal parameter

- **Extensible without API churn.** Adding tracing, request IDs, or tenant
  scoping later means adding a field to `Context`, not changing every
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
   `{ step: "error", error: { code: "cancelled", message: "..." } }`.
3. The consumer receives the cancellation through the normal `error` handler —
   no special `try/catch` needed.
4. Generators use `try/finally` for resource cleanup (killing subprocesses,
   releasing locks) regardless of whether cancellation occurred.

### Event Streams

Every operation defines its own event union with a `step` discriminant:

```typescript
// libswamp/auth/whoami.ts
type AuthWhoamiEvent =
  | { step: "loading_credentials" }
  | { step: "contacting_server"; serverUrl: string }
  | { step: "completed"; identity: WhoamiIdentity }
  | { step: "error"; error: SwampError };

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
// libswamp/models/run_method.ts
type MethodRunEvent =
  | { step: "started"; modelId: string; method: string }
  | { step: "log"; line: string }
  | { step: "progress"; pct: number; message: string }
  | { step: "completed"; result: MethodRunResult }
  | { step: "error"; error: SwampError };
```

```typescript
// libswamp/workflows/run.ts
type WorkflowRunEvent =
  | { step: "started"; runId: string; workflow: string }
  | { step: "job_started"; jobId: string; deps: string[] }
  | { step: "step_log"; jobId: string; stepId: string; line: string }
  | { step: "step_completed"; jobId: string; stepId: string; status: string }
  | { step: "job_completed"; jobId: string; status: string }
  | { step: "completed"; summary: WorkflowSummary }
  | { step: "error"; error: SwampError };
```

Events from parallel jobs interleave on the single stream. Each event carries
`jobId` (and `stepId` where applicable) so consumers can demultiplex. See
[Concurrency](#concurrency) for details.

### Convention: every event union includes `completed` and `error`

All event unions must include a `{ step: "completed"; ... }` variant and a
`{ step: "error"; error: SwampError }` variant. This is enforced by a type
constraint:

```typescript
type StreamEvent = { step: string };

type HasTerminals<E extends StreamEvent> =
  Extract<E, { step: "completed" }> extends never ? never
    : Extract<E, { step: "error" }> extends never ? never
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
  [K in E["step"]]: (event: Extract<E, { step: K }>) => void | Promise<void>;
};
```

Given `AuthWhoamiEvent`, this expands to:

```typescript
{
  loading_credentials: (event: { step: "loading_credentials" }) => void;
  contacting_server: (event: { step: "contacting_server"; serverUrl: string }) => void;
  completed: (event: { step: "completed"; identity: WhoamiIdentity }) => void;
  error: (event: { step: "error"; error: SwampError }) => void;
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
    const handler = handlers[event.step as E["step"]];
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
): Promise<Extract<E, { step: "completed" }>> {
  for await (const event of stream) {
    if (event.step === "completed") {
      return event as Extract<E, { step: "completed" }>;
    }
    if (event.step === "error") {
      throw (event as Extract<E, { step: "error" }>).error;
    }
  }
  throw new Error("Stream ended without a completed or error event");
}
```

Usage:

```typescript
const ctx = createContext();
const { identity } = await result(swamp.auth.whoami(ctx));
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

### Workflow execution with merge

```typescript
async function* workflowRun(
  ctx: Context,
  deps: WorkflowDeps,
  input: WorkflowRunInput,
): AsyncIterable<WorkflowRunEvent> {
  yield { step: "started", runId: input.runId, workflow: input.workflowId };

  const sortedJobs = deps.sortService.sort(input.jobs);

  for (const level of sortedJobs.levels) {
    // Each job in this level runs in parallel.
    // Each job gets its own child context for independent timeout/cancellation.
    const jobStreams = level.map((jobName) => {
      const job = input.jobs.find((j) => j.name === jobName)!;
      const jobCtx = ctx.withTimeout(job.timeoutMs ?? 300_000);
      return runJob(jobCtx, deps, job);
    });

    // merge() combines all parallel job streams into one.
    // Events from different jobs interleave in arrival order.
    for await (const event of merge(jobStreams)) {
      yield event;
    }

    // All jobs in this level have completed — proceed to next level.
  }

  yield { step: "completed", summary: buildSummary() };
}
```

Job execution uses the same pattern for parallel steps within a job:

```typescript
async function* runJob(
  ctx: Context,
  deps: WorkflowDeps,
  job: Job,
): AsyncIterable<WorkflowRunEvent> {
  yield { step: "job_started", jobId: job.name, deps: job.dependencies };

  const sortedSteps = deps.sortService.sort(job.steps);

  for (const level of sortedSteps.levels) {
    const stepStreams = level.map((stepName) => {
      const step = job.steps.find((s) => s.name === stepName)!;
      return runStep(ctx, deps, job.name, step);
    });

    for await (const event of merge(stepStreams)) {
      yield event;
    }
  }

  yield { step: "job_completed", jobId: job.name, status: "success" };
}
```

The pattern is recursive — `merge()` at the workflow level merges job streams,
and each job stream internally uses `merge()` to combine its parallel step
streams. The consumer sees a single flat stream of tagged events regardless of
the depth of parallelism.

### What interleaved events look like

A workflow with two parallel jobs (`build` and `test`) produces events like:

```
{ step: "started", runId: "run-1", workflow: "ci" }
{ step: "job_started", jobId: "build", deps: [] }
{ step: "job_started", jobId: "test", deps: [] }
{ step: "step_log", jobId: "build", stepId: "compile", line: "Compiling..." }
{ step: "step_log", jobId: "test", stepId: "unit", line: "Running tests..." }
{ step: "step_log", jobId: "build", stepId: "compile", line: "Build complete." }
{ step: "step_completed", jobId: "build", stepId: "compile", status: "success" }
{ step: "step_log", jobId: "test", stepId: "unit", line: "42 tests passed." }
{ step: "step_completed", jobId: "test", stepId: "unit", status: "success" }
{ step: "job_completed", jobId: "build", status: "success" }
{ step: "job_completed", jobId: "test", status: "success" }
{ step: "completed", summary: { ... } }
```

Events from `build` and `test` interleave in arrival order. The exact ordering
between jobs is non-deterministic — two runs may produce different interleavings.
Within a single job, events are always in causal order.

### Consuming interleaved events

Consumers use the same `consumeStream` / `EventHandlers` pattern. The `jobId`
field routes events to the right place:

```typescript
// CLI adapter — prefix each line with the job name
await consumeStream(swamp.workflows.run(ctx, input), {
  started: (e) => writeOutput(`Workflow ${e.workflow} started`),
  job_started: (e) => writeOutput(`  [${e.jobId}] started`),
  step_log: (e) => writeOutput(`  [${e.jobId}] ${e.line}`),
  step_completed: (e) => writeOutput(`  [${e.jobId}] ${e.stepId}: ${e.status}`),
  job_completed: (e) => writeOutput(`  [${e.jobId}] ${e.status}`),
  completed: (e) => writeOutput(`Done.`),
  error: (e) => { throw new UserError(e.error.message); },
});

// Web UI — route events to per-job panels
const jobPanels = new Map<string, JobPanelState>();

await consumeStream(swamp.workflows.run(ctx, input), {
  started: (e) => initDashboard(e.runId),
  job_started: (e) => {
    jobPanels.set(e.jobId, createPanel(e.jobId));
  },
  step_log: (e) => {
    jobPanels.get(e.jobId)!.appendLog(e.stepId, e.line);
  },
  step_completed: (e) => {
    jobPanels.get(e.jobId)!.markStepDone(e.stepId, e.status);
  },
  job_completed: (e) => {
    jobPanels.get(e.jobId)!.markDone(e.status);
  },
  completed: (e) => showSummary(e.summary),
  error: (e) => showError(e.error),
});
```

### Cancellation with parallel streams

Context's hierarchical cancellation integrates naturally with `merge()`. Each
parallel job gets a child context; cancelling the parent cancels all children:

```
CLI SIGINT → root Context
               └─► workflow Context
                    ├─► job "build" Context (5 min timeout)
                    │    ├─► step "compile" (inherits build signal)
                    │    └─► step "package" (inherits build signal)
                    └─► job "test" Context (10 min timeout)
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

## libswamp API Surface

```typescript
// libswamp/mod.ts
interface Swamp {
  auth: {
    whoami(ctx: Context): AsyncIterable<AuthWhoamiEvent>;
    login(ctx: Context, input: AuthLoginInput): AsyncIterable<AuthLoginEvent>;
    logout(ctx: Context): AsyncIterable<AuthLogoutEvent>;
  };
  models: {
    create(ctx: Context, input: ModelCreateInput): AsyncIterable<ModelCreateEvent>;
    describe(ctx: Context, id: string): AsyncIterable<ModelDescribeEvent>;
    search(ctx: Context, query: string): AsyncIterable<ModelSearchEvent>;
    runMethod(ctx: Context, input: MethodRunInput): AsyncIterable<MethodRunEvent>;
    delete(ctx: Context, id: string): AsyncIterable<ModelDeleteEvent>;
  };
  workflows: {
    run(ctx: Context, input: WorkflowRunInput): AsyncIterable<WorkflowRunEvent>;
    validate(ctx: Context, id: string): AsyncIterable<WorkflowValidateEvent>;
    history(ctx: Context, id: string): AsyncIterable<WorkflowHistoryEvent>;
  };
  data: {
    list(ctx: Context, filter?: DataFilter): AsyncIterable<DataListEvent>;
    get(ctx: Context, id: string): AsyncIterable<DataGetEvent>;
    gc(ctx: Context, options?: GcOptions): AsyncIterable<DataGcEvent>;
  };
  // ... vaults, repo, extensions
}

function createSwamp(config: SwampConfig): Swamp;
```

Each method is an `async function*` internally. Generators receive the context
and forward `ctx.signal` to all downstream async operations:

```typescript
async function* whoami(ctx: Context, deps: AuthDeps): AsyncIterable<AuthWhoamiEvent> {
  yield { step: "loading_credentials" };
  const credentials = await deps.authRepo.load();
  if (!credentials) {
    yield { step: "error", error: notAuthenticated() };
    return;
  }

  const serverUrl = deps.serverUrlOverride ?? credentials.serverUrl;
  yield { step: "contacting_server", serverUrl };

  // ctx.signal is forwarded to fetch — true cancellation of in-flight HTTP
  const client = new SwampClubClient(serverUrl);
  const whoamiResponse = await client.whoami(credentials.apiKey, ctx.signal);

  if (!whoamiResponse.authenticated) {
    yield { step: "error", error: invalidApiKey() };
    return;
  }

  const collectives = getCollectives(whoamiResponse);
  yield {
    step: "completed",
    identity: {
      serverUrl,
      id: whoamiResponse.id!,
      username: whoamiResponse.username!,
      email: whoamiResponse.email!,
      name: whoamiResponse.name!,
      collectives,
    },
  };
}
```

## Example: `swamp auth whoami` with libswamp

This section shows how the existing `auth whoami` command would be implemented
using the libswamp pattern. The command today lives entirely in
`src/cli/commands/auth_whoami.ts` — it loads credentials, calls the HTTP client,
and renders output in the same function.

### Current implementation (before)

```typescript
// src/cli/commands/auth_whoami.ts (current)
export const authWhoamiCommand = new Command()
  .name("whoami")
  .description("Show current authenticated identity")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["auth", "whoami"]);
    const repo = new AuthRepository();
    const credentials = await repo.load();
    if (!credentials) {
      throw new UserError("Not authenticated. Run 'swamp auth login' to sign in.");
    }
    const serverUrl = Deno.env.get("SWAMP_CLUB_URL") ?? credentials.serverUrl;
    const client = new SwampClubClient(serverUrl);
    const whoami = await client.whoami(credentials.apiKey);
    if (!whoami.authenticated) {
      throw new UserError("Stored API key is no longer valid...");
    }
    const collectives = getCollectives(whoami);
    if (ctx.outputMode === "json") {
      console.log(JSON.stringify({ authenticated: true, serverUrl, ... }));
    } else {
      console.log(`${whoami.username} (${whoami.email}) on ${serverUrl}`);
      if (collectives?.length) console.log(`Collectives: ${collectives.join(", ")}`);
    }
  });
```

Domain logic, HTTP calls, error handling, and presentation are interleaved in
one function.

### With libswamp (after)

**Step 1: libswamp defines the operation and its events**

```typescript
// libswamp/auth/whoami.ts
type AuthWhoamiEvent =
  | { step: "loading_credentials" }
  | { step: "contacting_server"; serverUrl: string }
  | { step: "completed"; identity: WhoamiIdentity }
  | { step: "error"; error: SwampError };

interface WhoamiIdentity {
  serverUrl: string;
  id: string;
  username: string;
  email: string;
  name: string;
  collectives?: string[];
}
```

**Step 2: libswamp implements the operation as a generator**

```typescript
// libswamp/auth/whoami.ts (continued)
async function* whoami(ctx: Context, deps: AuthDeps): AsyncIterable<AuthWhoamiEvent> {
  yield { step: "loading_credentials" };

  const credentials = await deps.authRepo.load();
  if (!credentials) {
    yield {
      step: "error",
      error: { code: "not_authenticated", message: "Not authenticated. Run 'swamp auth login' to sign in." },
    };
    return;
  }

  const serverUrl = deps.serverUrlOverride ?? credentials.serverUrl;
  yield { step: "contacting_server", serverUrl };

  const client = new SwampClubClient(serverUrl);
  const response = await client.whoami(credentials.apiKey, ctx.signal);

  if (!response.authenticated) {
    yield {
      step: "error",
      error: { code: "invalid_api_key", message: "Stored API key is no longer valid. Run 'swamp auth login' to re-authenticate." },
    };
    return;
  }

  yield {
    step: "completed",
    identity: {
      serverUrl,
      id: response.id!,
      username: response.username!,
      email: response.email!,
      name: response.name!,
      collectives: getCollectives(response),
    },
  };
}
```

**Step 3: CLI adapter consumes events with exhaustive handlers**

```typescript
// src/cli/commands/auth_whoami.ts (new)
export const authWhoamiCommand = new Command()
  .name("whoami")
  .description("Show current authenticated identity")
  .action(async function (options: AnyOptions) {
    const cliCtx = createCliContext(options as GlobalOptions, ["auth", "whoami"]);
    const ctx = createContext({ signal: sigintSignal(), logger: cliCtx.logger });
    const swamp = getSwamp();

    if (cliCtx.outputMode === "json") {
      const { identity } = await result(swamp.auth.whoami(ctx));
      console.log(JSON.stringify(
        { authenticated: true, ...identity },
        null,
        2,
      ));
    } else {
      await consumeStream(swamp.auth.whoami(ctx), {
        loading_credentials: () => {
          cliCtx.logger.debug("Loading stored credentials");
        },
        contacting_server: (e) => {
          cliCtx.logger.debug("Contacting {serverUrl}", e);
        },
        completed: (e) => {
          console.log(
            `${e.identity.username} (${e.identity.email}) on ${e.identity.serverUrl}`,
          );
          if (e.identity.collectives?.length) {
            console.log(`Collectives: ${e.identity.collectives.join(", ")}`);
          }
        },
        error: (e) => {
          throw new UserError(e.error.message);
        },
      });
    }
  });
```

The command handler contains zero domain logic. It creates a `Context` with the
CLI's SIGINT signal, then translates events into presentation.

**Step 4: tests assert on events directly**

```typescript
// libswamp/auth/whoami_test.ts
Deno.test("whoami yields identity on success", async () => {
  const ctx = createContext();
  const deps = createMockAuthDeps({
    credentials: { serverUrl: "https://swamp.club", apiKey: "swamp_test", ... },
    whoamiResponse: { authenticated: true, username: "adam", email: "adam@example.com", ... },
  });

  const events = await collect(whoami(ctx, deps));

  assertEquals(events, [
    { step: "loading_credentials" },
    { step: "contacting_server", serverUrl: "https://swamp.club" },
    { step: "completed", identity: {
      serverUrl: "https://swamp.club",
      username: "adam",
      email: "adam@example.com",
      // ...
    }},
  ]);
});

Deno.test("whoami yields error when not authenticated", async () => {
  const ctx = createContext();
  const deps = createMockAuthDeps({ credentials: null });
  const events = await collect(whoami(ctx, deps));

  assertEquals(events[events.length - 1].step, "error");
});

Deno.test("whoami respects cancellation", async () => {
  const controller = new AbortController();
  const ctx = createContext({ signal: controller.signal });
  const deps = createMockAuthDeps({
    credentials: { serverUrl: "https://swamp.club", apiKey: "swamp_test", ... },
    whoamiDelay: 5000,  // simulate slow server
  });

  // Cancel immediately
  controller.abort();
  const events = await collect(whoami(ctx, deps));
  const last = events[events.length - 1];

  assertEquals(last.step, "error");
  assertEquals((last as { error: SwampError }).error.code, "cancelled");
});
```

No mocking of console.log. No output mode switching. The test verifies domain
behavior through the event stream, including cancellation.

## WebSocket API Layer

The `AsyncIterable` pattern maps directly onto WebSocket (or Server-Sent Events)
with minimal glue code. This section describes how a networked API layer would
expose libswamp over WebSocket.

### Protocol

The WebSocket protocol is JSON-based with a request/response-stream pattern.
Clients can also cancel in-flight operations:

```
Client → Server (request):
{
  "id": "req_1",
  "operation": "auth.whoami",
  "params": {}
}

Server → Client (event stream, one message per event):
{ "id": "req_1", "event": { "step": "loading_credentials" } }
{ "id": "req_1", "event": { "step": "contacting_server", "serverUrl": "..." } }
{ "id": "req_1", "event": { "step": "completed", "identity": { ... } } }

Client → Server (cancel an in-flight request):
{ "id": "req_1", "cancel": true }
```

Each request gets a unique `id`. The server streams back events tagged with that
`id`. Multiple requests can be in-flight concurrently — the client demultiplexes
by `id`.

For workflow runs, events from parallel jobs interleave naturally — the server
forwards each event as it arrives from `merge()`:

```
{ "id": "req_2", "event": { "step": "started", "runId": "run-1", "workflow": "ci" } }
{ "id": "req_2", "event": { "step": "job_started", "jobId": "build", "deps": [] } }
{ "id": "req_2", "event": { "step": "job_started", "jobId": "test", "deps": [] } }
{ "id": "req_2", "event": { "step": "step_log", "jobId": "build", "stepId": "compile", "line": "Compiling..." } }
{ "id": "req_2", "event": { "step": "step_log", "jobId": "test", "stepId": "unit", "line": "Running tests..." } }
{ "id": "req_2", "event": { "step": "job_completed", "jobId": "build", "status": "success" } }
{ "id": "req_2", "event": { "step": "job_completed", "jobId": "test", "status": "success" } }
{ "id": "req_2", "event": { "step": "completed", "summary": { ... } } }
```

No special protocol handling for parallelism — it's just events on a stream.

### Server implementation

Each in-flight request gets its own `AbortController`. The context carries the
signal into libswamp, so cancellation propagates through the entire operation
tree — including all parallel jobs via `merge()`:

```typescript
// adapters/web/ws_handler.ts
interface WsRequest {
  id: string;
  operation?: string;
  params?: Record<string, unknown>;
  cancel?: boolean;
}

const operations: Record<string, (swamp: Swamp, ctx: Context, params: Record<string, unknown>) => AsyncIterable<StreamEvent>> = {
  "auth.whoami": (swamp, ctx) => swamp.auth.whoami(ctx),
  "auth.login": (swamp, ctx, p) => swamp.auth.login(ctx, p as AuthLoginInput),
  "models.create": (swamp, ctx, p) => swamp.models.create(ctx, p as ModelCreateInput),
  "models.runMethod": (swamp, ctx, p) => swamp.models.runMethod(ctx, p as MethodRunInput),
  "workflows.run": (swamp, ctx, p) => swamp.workflows.run(ctx, p as WorkflowRunInput),
  // ... every libswamp operation is registered here
};

function handleConnection(ws: WebSocket, swamp: Swamp): void {
  const activeRequests = new Map<string, AbortController>();

  ws.addEventListener("message", async (msg) => {
    const req: WsRequest = JSON.parse(msg.data);

    // Handle cancellation
    if (req.cancel) {
      activeRequests.get(req.id)?.abort();
      activeRequests.delete(req.id);
      return;
    }

    const opFn = operations[req.operation!];
    if (!opFn) {
      ws.send(JSON.stringify({
        id: req.id,
        event: { step: "error", error: { code: "unknown_operation", message: `Unknown: ${req.operation}` } },
      }));
      return;
    }

    // Each request gets its own context with its own AbortController
    const controller = new AbortController();
    activeRequests.set(req.id, controller);
    const ctx = createContext({ signal: controller.signal });

    const stream = opFn(swamp, ctx, req.params ?? {});
    for await (const event of stream) {
      ws.send(JSON.stringify({ id: req.id, event }));
    }

    activeRequests.delete(req.id);
  });

  // Cancel all in-flight requests when the connection closes
  ws.addEventListener("close", () => {
    for (const controller of activeRequests.values()) {
      controller.abort();
    }
    activeRequests.clear();
  });
}
```

Because every operation is `AsyncIterable` and takes a `Context`, the server
implementation is a single `for await` loop regardless of the operation. No
special casing for "simple" vs "streaming" vs "parallel" operations.
Cancellation — whether from the client or from a connection drop — flows
through the same `ctx.signal` path, which `merge()` propagates to all parallel
child streams.

### Client library

A thin client wraps the WebSocket and returns `AsyncIterable` to the caller,
preserving the same consumption pattern:

```typescript
// client/ws_client.ts
class SwampWsClient {
  private pending = new Map<string, ReadableStreamDefaultController<StreamEvent>>();

  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (msg) => {
      const { id, event } = JSON.parse(msg.data);
      this.pending.get(id)?.enqueue(event);
      if (event.step === "completed" || event.step === "error") {
        this.pending.get(id)?.close();
        this.pending.delete(id);
      }
    });
  }

  call<E extends StreamEvent>(operation: string, params: Record<string, unknown> = {}): AsyncIterable<E> {
    const id = crypto.randomUUID();

    const stream = new ReadableStream<E>({
      start: (controller) => {
        this.pending.set(id, controller as ReadableStreamDefaultController<StreamEvent>);
        this.ws.send(JSON.stringify({ id, operation, params }));
      },
    });

    return stream;
  }

  /** Cancel an in-flight request. */
  cancel(id: string): void {
    this.ws.send(JSON.stringify({ id, cancel: true }));
    this.pending.get(id)?.close();
    this.pending.delete(id);
  }
}
```

The web UI then consumes events identically to the CLI — including interleaved
events from parallel workflow jobs:

```typescript
// web-ui/components/WorkflowRunPanel.tsx
const jobPanels = new Map<string, JobPanelState>();
const stream = client.call<WorkflowRunEvent>("workflows.run", input);

await consumeStream(stream, {
  started: (e) => initDashboard(e.runId),
  job_started: (e) => jobPanels.set(e.jobId, createPanel(e.jobId)),
  step_log: (e) => jobPanels.get(e.jobId)!.appendLog(e.stepId, e.line),
  step_completed: (e) => jobPanels.get(e.jobId)!.markStepDone(e.stepId, e.status),
  job_completed: (e) => jobPanels.get(e.jobId)!.markDone(e.status),
  completed: (e) => showSummary(e.summary),
  error: (e) => showError(e.error),
});
```

Same `consumeStream`, same `EventHandlers<E>`, same compile-time exhaustiveness
checks. The web UI gets the same safety guarantees as the CLI adapter. Parallel
job events are routed to the correct panel by `jobId`.

### Server-Sent Events alternative

For HTTP-only clients (no WebSocket), the same stream maps onto SSE:

```typescript
// adapters/web/sse_handler.ts
app.get("/api/stream/:operation", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");

  // The HTTP request's own abort signal provides cancellation
  const ctx = createContext({ signal: req.signal });
  const stream = operations[req.params.operation](swamp, ctx, req.query);
  for await (const event of stream) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.step === "completed" || event.step === "error") {
      res.end();
    }
  }
});
```

When the client disconnects, `req.signal` aborts, which cancels the libswamp
operation through the same context mechanism — no special handling needed.

## Error Handling

### SwampError

All errors yielded in event streams use a structured `SwampError` type rather
than thrown exceptions:

```typescript
interface SwampError {
  code: string;        // machine-readable (e.g., "not_authenticated", "model_not_found", "cancelled")
  message: string;     // human-readable
  details?: unknown;   // optional structured data for debugging
}
```

Errors that originate within the generator (domain logic) are **yielded** as
`{ step: "error", error: SwampError }` events. This keeps the stream protocol
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
  step: "error",
  error: { code: "not_authenticated", message: "..." },
});
```

## Testing Utilities

libswamp provides test helpers that make assertions on event streams ergonomic:

```typescript
// libswamp/testing.ts

/** Create a context for tests. No signal, default logger. */
function testContext(): Context {
  return createContext();
}

/** Collect all events from a stream into an array. */
async function collect<E extends StreamEvent>(
  stream: AsyncIterable<E>,
): Promise<E[]> {
  const events: E[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Assert that a stream completes with the expected completed event. */
async function assertCompletes<E extends StreamEvent>(
  stream: AsyncIterable<E>,
  expected: Partial<Extract<E, { step: "completed" }>>,
): Promise<void> {
  const completed = await result(stream);
  for (const [key, value] of Object.entries(expected)) {
    assertEquals((completed as Record<string, unknown>)[key], value);
  }
}

/** Assert that a stream ends with an error matching the given code. */
async function assertErrors<E extends StreamEvent>(
  stream: AsyncIterable<E>,
  expectedCode: string,
): Promise<void> {
  const events = await collect(stream);
  const last = events[events.length - 1];
  assertEquals(last.step, "error");
  assertEquals((last as { error: SwampError }).error.code, expectedCode);
}

/**
 * Extract the subsequence of events for a specific job from a collected
 * workflow event stream. Useful for asserting on per-job behavior without
 * being sensitive to cross-job interleaving order.
 */
function eventsForJob(
  events: WorkflowRunEvent[],
  jobId: string,
): WorkflowRunEvent[] {
  return events.filter((e) => {
    if ("jobId" in e) return e.jobId === jobId;
    return false;
  });
}
```

### Testing parallel workflows

Because events from parallel jobs interleave non-deterministically, tests should
assert on per-job subsequences rather than exact global order:

```typescript
Deno.test("workflow runs build and test jobs in parallel", async () => {
  const ctx = createContext();
  const events = await collect(workflowRun(ctx, deps, input));

  // Assert workflow-level events
  assertEquals(events[0], { step: "started", runId: "run-1", workflow: "ci" });
  assertEquals(events[events.length - 1].step, "completed");

  // Assert per-job subsequences — order between jobs doesn't matter
  const buildEvents = eventsForJob(events, "build");
  assertEquals(buildEvents[0], { step: "job_started", jobId: "build", deps: [] });
  assertEquals(buildEvents[buildEvents.length - 1], { step: "job_completed", jobId: "build", status: "success" });

  const testEvents = eventsForJob(events, "test");
  assertEquals(testEvents[0], { step: "job_started", jobId: "test", deps: [] });
  assertEquals(testEvents[testEvents.length - 1], { step: "job_completed", jobId: "test", status: "success" });
});
```

## Migration Strategy

The migration from the current architecture to libswamp can be done
incrementally, one command at a time:

1. **Define `Context` and stream helpers** (`createContext`, `consumeStream`,
   `result`, `withDefaults`, `collect`, `merge`).
2. **Define the event types** for a single operation (e.g., `auth.whoami`).
3. **Implement the generator** in `libswamp/`, extracting domain logic from the
   existing command handler. The generator takes `ctx: Context` as its first
   parameter.
4. **Rewrite the CLI command handler** to create a `Context` (wired to SIGINT),
   call libswamp, and consume events.
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

