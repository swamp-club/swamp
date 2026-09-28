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

// Test-only helpers for asserting on the spans code under test produces.

import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

export { SpanKind };
export type { ReadableSpan };

// A synchronous in-memory span exporter. OTel's own InMemorySpanExporter
// defers its result callback via setTimeout(0) and never clears it, so one
// timer per exported span leaks and Deno's resource sanitizer fails the test.
// See swamp-club#1121.
class SyncInMemorySpanExporter implements SpanExporter {
  readonly finishedSpans: ReadableSpan[] = [];
  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    for (const span of spans) this.finishedSpans.push(span);
    resultCallback({ code: ExportResultCode.SUCCESS });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Registers a global tracer provider and AsyncLocalStorage context manager,
 * runs `fn` with the list that finished spans are appended to, and tears both
 * down however `fn` settles. Global registration is safe because
 * `deno test --parallel` runs each test file in its own worker and tests
 * within a file run one at a time.
 */
export async function withCapturedSpans(
  fn: (spans: readonly ReadableSpan[]) => Promise<void>,
): Promise<void> {
  const exporter = new SyncInMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const contextManager = new AsyncLocalStorageContextManager();
  context.setGlobalContextManager(contextManager.enable());
  provider.register();
  try {
    await fn(exporter.finishedSpans);
  } finally {
    await provider.shutdown();
    trace.disable();
    context.disable();
  }
}

/** Returns the one finished span named `name`, failing if there is not exactly one. */
export function findSpan(
  spans: readonly ReadableSpan[],
  name: string,
): ReadableSpan {
  const matches = spans.filter((s) => s.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one span named ${name}, found ${matches.length}: ` +
        spans.map((s) => s.name).join(", "),
    );
  }
  return matches[0];
}

/** True when `child` was started as a direct child of `parent`. */
export function isChildOf(child: ReadableSpan, parent: ReadableSpan): boolean {
  return child.parentSpanId === parent.spanContext().spanId &&
    child.spanContext().traceId === parent.spanContext().traceId;
}
