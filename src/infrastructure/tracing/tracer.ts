// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";

const TRACER_NAME = "swamp";

/**
 * Returns the swamp tracer from the global tracer provider.
 * Returns a no-op tracer when tracing is not initialized.
 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Convenience wrapper around `tracer.startActiveSpan()`.
 *
 * Creates a span that is automatically set as the active span for the
 * duration of `fn`. Records errors and ends the span in `finally`.
 *
 * @param name - Span name (e.g. "swamp.workflow.run")
 * @param attributes - Span attributes
 * @param fn - Async function to execute within the span
 * @returns The return value of `fn`
 */
/**
 * Wraps an async generator with a span. The span starts when iteration
 * begins and ends when the generator completes, errors, or is abandoned.
 *
 * Events with `kind: "error"` are detected and recorded on the span.
 */
export async function* withGeneratorSpan<T extends { kind: string }>(
  name: string,
  attributes: Attributes,
  generator: AsyncIterable<T>,
): AsyncGenerator<T> {
  const span = getTracer().startSpan(name, { attributes });
  try {
    for await (const event of generator) {
      if (event.kind === "error") {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      yield event;
    }
    // Only set OK if we didn't already set ERROR
    if (span.isRecording()) {
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
