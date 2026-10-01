// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import {
  type Attributes,
  type Context,
  context,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  type SpanOptions,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";

const TRACER_NAME = "swamp";

/**
 * Re-export SpanStatusCode so consumers don't need a direct
 * `@opentelemetry/api` dependency.
 */
export { SpanStatusCode };
export type { Span };

/**
 * Returns the swamp tracer from the global tracer provider.
 * Returns a no-op tracer when tracing is not initialized.
 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Wraps an async generator with a span. The span is set as the active
 * context so that child spans created during iteration are properly
 * parented.
 *
 * Events with `kind: "error"` are detected and recorded on the span.
 *
 * When the consumer stops early, `return()` is forwarded to the inner
 * iterator (inside the span context) before the span ends, so the inner
 * generator's `finally` blocks still run.
 */
export async function* withGeneratorSpan<T extends { kind: string }>(
  name: string,
  attributes: Attributes,
  generator: AsyncIterable<T>,
): AsyncGenerator<T> {
  const iterator = generator[Symbol.asyncIterator]();
  const tracer = getTracer();
  const span = tracer.startSpan(name, { attributes });
  const ctx = trace.setSpan(context.active(), span);
  let hasError = false;
  let done = false;
  try {
    // Bind each iteration to the span's context so child spans are parented
    while (true) {
      let result: IteratorResult<T>;
      try {
        result = await context.with(ctx, () => iterator.next());
      } catch (error) {
        // The inner iterator threw, so it has already finished.
        done = true;
        throw error;
      }
      if (result.done) {
        done = true;
        break;
      }
      const event = result.value;
      if (event.kind === "error") {
        hasError = true;
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      yield event;
    }
    if (!hasError) {
      span.setStatus({ code: SpanStatusCode.OK });
    }
  } catch (error) {
    recordSpanError(span, error);
    throw error;
  } finally {
    try {
      if (!done) await returnInSpan(span, ctx, iterator);
    } finally {
      span.end();
    }
  }
}

/**
 * Forwards `return()` to an unfinished iterator inside `ctx`, recording an
 * error thrown by its `finally` blocks on `span` before rethrowing it.
 */
async function returnInSpan(
  span: Span,
  ctx: Context,
  iterator: AsyncIterator<unknown>,
): Promise<void> {
  try {
    await context.with(ctx, () => iterator.return?.());
  } catch (error) {
    recordSpanError(span, error);
    throw error;
  }
}

function recordSpanError(span: Span, error: unknown): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  if (error instanceof Error) {
    span.addEvent("exception", {
      "exception.type": error.name,
      "exception.message": error.message,
      "exception.stacktrace": error.stack ?? "",
    });
  }
}

/**
 * Runs an async generator with `span` as the active context, so spans created
 * while it runs are children of `span`.
 *
 * Unlike {@link withGeneratorSpan}, this does not start, end, or set status on
 * the span — the caller owns its lifecycle. Use it when the generator ends the
 * span itself (for example on early-exit paths with custom attributes).
 *
 * When the consumer stops early, `return()` is forwarded to the inner
 * generator (inside the span context) so its `finally` blocks still run.
 */
export async function* bindGeneratorToSpan<T, TReturn>(
  span: Span,
  generator: AsyncGenerator<T, TReturn>,
): AsyncGenerator<T, TReturn> {
  const ctx = trace.setSpan(context.active(), span);
  let done = false;
  try {
    while (true) {
      let result: IteratorResult<T, TReturn>;
      try {
        result = await context.with(ctx, () => generator.next());
      } catch (error) {
        // The inner generator threw, so it has already finished.
        done = true;
        throw error;
      }
      if (result.done) {
        done = true;
        return result.value;
      }
      yield result.value;
    }
  } finally {
    if (!done) {
      await context.with(ctx, () => generator.return(undefined as TReturn));
    }
  }
}

/**
 * Runs `fn` with `span` as the active context, so spans started while it runs
 * are children of `span`.
 *
 * Like {@link bindGeneratorToSpan}, this does not start, end, or set status on
 * the span — the caller owns its lifecycle. Use it when a span covers more
 * than one callback, such as a phase whose locals outlive a single closure.
 */
export function withActiveSpan<T>(span: Span, fn: () => T): T {
  return context.with(trace.setSpan(context.active(), span), fn);
}

export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return runInSpan(name, { attributes }, fn);
}

/**
 * Like {@link withSpan}, but the span is always the root of a new trace.
 *
 * Use it for a unit of work a long-running process starts on its own, such
 * as one poll cycle or one scheduled fire. `swamp serve` runs inside the
 * `swamp.cli` span, which never ends, so that work must not inherit it.
 */
export function withRootSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return runInSpan(name, { root: true, attributes }, fn);
}

/**
 * Runs one cycle of a `swamp serve` background poller as the root of its own
 * trace: a `swamp.serve.poll` span whose `swamp.serve.poller` attribute names
 * the poller. Everything the cycle does — sync-gate waits, datastore pulls,
 * datastore extension calls — nests under it.
 */
export function withPollCycleSpan<T>(
  poller: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withRootSpan(
    "swamp.serve.poll",
    { "swamp.serve.poller": poller },
    () => fn(),
  );
}

/**
 * Runs `fn` with no active span, so spans it starts — directly, or from
 * timers and promises it schedules — begin their own traces instead of
 * joining the caller's.
 *
 * The active context is captured when a timer is armed, so arm a
 * long-running process's background timers inside this, not just their
 * callbacks.
 */
export function runDetached<T>(fn: () => T): T {
  return context.with(ROOT_CONTEXT, fn);
}

function runInSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, options, (span) => {
    return fn(span).then(
      (result) => {
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      },
      (error) => {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error) {
          span.addEvent("exception", {
            "exception.type": error.name,
            "exception.message": error.message,
            "exception.stacktrace": error.stack ?? "",
          });
        }
        span.end();
        throw error;
      },
    );
  });
}

/**
 * Runs `fn` inside a new active SERVER-kind span for one inbound request.
 *
 * The span is always the root of its own trace: `swamp serve` runs inside the
 * `swamp.cli` span, which never ends, so a request must not inherit it. Inbound
 * `traceparent` headers are deliberately ignored — unauthenticated callers must
 * not choose the trace a server span joins.
 *
 * Unlike {@link withSpan}, success leaves the status unset: the caller maps the
 * response to a status. A thrown error is recorded as ERROR and rethrown.
 */
export function withServerSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    name,
    { kind: SpanKind.SERVER, root: true, attributes },
    (span) => {
      return fn(span).then(
        (result) => {
          span.end();
          return result;
        },
        (error) => {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          if (error instanceof Error) {
            span.addEvent("exception", {
              "exception.type": error.name,
              "exception.message": error.message,
              "exception.stacktrace": error.stack ?? "",
            });
          }
          span.end();
          throw error;
        },
      );
    },
  );
}
