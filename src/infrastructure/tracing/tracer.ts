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
  type Link,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  type SpanOptions,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";

const TRACER_NAME = "swamp";

export { SpanStatusCode };
export type { Link, Span };

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * on early stop, return() is forwarded to the inner iterator inside the span
 * context before the span ends so its finally blocks still run
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
    while (true) {
      let result: IteratorResult<T>;
      try {
        result = await context.with(ctx, () => iterator.next());
      } catch (error) {
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
 * does not start, end or set status on the span; the caller owns its lifecycle.
 * return() is forwarded inside the span context so finally blocks still run
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

export function withActiveSpan<T>(span: Span, fn: () => T): T {
  return context.with(trace.setSpan(context.active(), span), fn);
}

export function setActiveSpanAttributes(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

export function activeSpanLink(): Link | undefined {
  const span = trace.getActiveSpan();
  return span?.isRecording() ? { context: span.spanContext() } : undefined;
}

export function activeSpanAttributeSetter(): (attributes: Attributes) => void {
  const span = trace.getActiveSpan();
  return (attributes) => span?.setAttributes(attributes);
}

export function markActiveSpanError(message: string): void {
  trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message });
}

export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return runInSpan(name, { attributes }, fn);
}

/**
 * serve runs inside the never-ending swamp.cli span, so work a long-running
 * process starts on its own, such as a poll cycle, must root a new trace
 */
export function withRootSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return runInSpan(name, { root: true, attributes }, fn);
}

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
 * the active context is captured when a timer is armed, so arm a long-running
 * process's background timers inside this, not just their callbacks
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
 * always a new trace root, as serve runs inside the never-ending swamp.cli
 * span; inbound traceparent is ignored so unauthenticated callers cannot choose
 * the trace joined
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
