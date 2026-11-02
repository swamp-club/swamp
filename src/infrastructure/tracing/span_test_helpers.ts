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

import { type Context, context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
  type Span as SdkSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { DiagnosticPhase } from "../../domain/diagnostics/diagnostic_phase.ts";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "./execution_observer.ts";

export { SpanKind };
export type { ReadableSpan };

// synchronous because OTel's InMemorySpanExporter defers its callback via
// setTimeout(0) and never clears it, leaking a timer per span that fails Deno's
// resource sanitizer
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
 * global registration is safe: each test file runs in its own worker and tests
 * within a file run one at a time
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

export async function withObservedSpans(
  fn: (spans: readonly ReadableSpan[]) => Promise<void>,
): Promise<void> {
  await withCapturedSpans(async (spans) => {
    installExecutionObserver();
    try {
      await fn(spans);
    } finally {
      uninstallExecutionObserver();
    }
  });
}

export function diagnosticPhases(
  spans: readonly ReadableSpan[],
  phase: DiagnosticPhase,
): ReadableSpan[] {
  return spans.filter((s) => s.name === `swamp.diagnostic.${phase}`);
}

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

export function isChildOf(child: ReadableSpan, parent: ReadableSpan): boolean {
  return child.parentSpanId === parent.spanContext().spanId &&
    child.spanContext().traceId === parent.spanContext().traceId;
}

export function assertPollCycleRoots(
  spans: readonly ReadableSpan[],
  poller: string,
  ambient: ReadableSpan,
  min = 2,
): ReadableSpan[] {
  const cycles = spans.filter((s) =>
    s.name === "swamp.serve.poll" &&
    s.attributes["swamp.serve.poller"] === poller
  );
  if (cycles.length < min) {
    throw new Error(
      `Expected at least ${min} ${poller} poll cycles, found ${cycles.length}`,
    );
  }
  const traceIds = new Set<string>();
  for (const cycle of cycles) {
    if (cycle.parentSpanId !== undefined) {
      throw new Error(`${poller} poll cycle has a parent span`);
    }
    if (cycle.spanContext().traceId === ambient.spanContext().traceId) {
      throw new Error(`${poller} poll cycle joined the ambient trace`);
    }
    traceIds.add(cycle.spanContext().traceId);
  }
  if (traceIds.size !== cycles.length) {
    throw new Error(`${poller} poll cycles share a trace`);
  }
  return cycles;
}

export class SpanRecorder implements SpanProcessor {
  readonly started: ReadableSpan[] = [];
  readonly ended: ReadableSpan[] = [];
  onStart(span: SdkSpan, _parentContext: Context): void {
    this.started.push(span);
  }
  onEnd(span: ReadableSpan): void {
    this.ended.push(span);
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  named(name: string): ReadableSpan[] {
    return this.ended.filter((s) => s.name === name);
  }
  find(name: string, key: string, value: string): ReadableSpan {
    return findSpan(
      this.named(name).filter((s) => s.attributes[key] === value),
      name,
    );
  }
  allEnded(): boolean {
    return this.started.every((s) => this.ended.includes(s));
  }
}

export async function withRecordedSpans(
  fn: (recorder: SpanRecorder) => Promise<void>,
): Promise<void> {
  const recorder = new SpanRecorder();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(recorder);
  const contextManager = new AsyncLocalStorageContextManager();
  context.setGlobalContextManager(contextManager.enable());
  provider.register();
  try {
    await fn(recorder);
  } finally {
    await provider.shutdown();
    trace.disable();
    context.disable();
  }
}
