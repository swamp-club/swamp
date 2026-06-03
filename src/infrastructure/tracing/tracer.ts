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
  context,
  type Span,
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
 */
export async function* withGeneratorSpan<T extends { kind: string }>(
  name: string,
  attributes: Attributes,
  generator: AsyncIterable<T>,
): AsyncGenerator<T> {
  const tracer = getTracer();
  const span = tracer.startSpan(name, { attributes });
  const ctx = trace.setSpan(context.active(), span);
  let hasError = false;
  try {
    // Bind each iteration to the span's context so child spans are parented
    const iterator = generator[Symbol.asyncIterator]();
    while (true) {
      const result = await context.with(ctx, () => iterator.next());
      if (result.done) break;
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
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    span.end();
  }
}

export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, (span) => {
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
