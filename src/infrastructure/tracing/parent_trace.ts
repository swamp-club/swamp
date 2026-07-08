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

import { type Context, context, propagation } from "@opentelemetry/api";

/**
 * Runs `fn` within the given parent trace context, or directly if no
 * parent context is provided. Keeps @opentelemetry/api imports
 * encapsulated in the tracing module.
 */
export function runWithParentTrace<T>(
  parentCtx: Context | undefined,
  fn: () => T,
): T {
  if (parentCtx) {
    return context.with(parentCtx, fn);
  }
  return fn();
}

/**
 * Wraps an async generator to run each iteration within the trace context
 * extracted from the given W3C headers. When no traceparent is provided,
 * yields from the generator unchanged.
 */
export async function* withGeneratorTraceContext<T>(
  traceparent: string | undefined,
  tracestate: string | undefined,
  generator: AsyncIterable<T>,
): AsyncGenerator<T> {
  if (!traceparent) {
    yield* generator;
    return;
  }
  const headers: Record<string, string> = { traceparent };
  if (tracestate) headers.tracestate = tracestate;
  const parentCtx = propagation.extract(context.active(), headers);
  const iterator = generator[Symbol.asyncIterator]();
  while (true) {
    const result = await context.with(parentCtx, () => iterator.next());
    if (result.done) break;
    yield result.value;
  }
}
