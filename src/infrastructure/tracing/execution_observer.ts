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
  context,
  metrics,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  EXECUTION_TELEMETRY_VERSION,
  type ExecutionObserver,
  setExecutionObserver,
  traceCarrier,
} from "../../domain/remote/observability.ts";
import { extractTraceContext, injectTraceContext } from "./propagation.ts";
import {
  phaseCoverage,
  type PhaseInterval,
} from "../../domain/remote/phase_coverage.ts";

/** No exception messages or payloads: outcomes are a closed vocabulary. */
let dispose: (() => void) | undefined;

export function installExecutionObserver(): void {
  dispose?.();
  const meter = metrics.getMeter("swamp.execution", "1");
  const attempts = meter.createCounter("swamp.execution.started", {
    unit: "{operation}",
  });
  const finished = meter.createCounter("swamp.execution.finished", {
    unit: "{operation}",
  });
  const sampled = meter.createCounter("swamp.execution.sampled", {
    unit: "{operation}",
  });
  const parents = meter.createCounter("swamp.execution.parent_coverage", {
    unit: "{operation}",
  });
  const duration = meter.createHistogram("swamp.execution.duration", {
    unit: "s",
  });
  const pending = new Map<string, Set<{ started: number }>>();
  const phases = new Map<
    string,
    { children: PhaseInterval[]; overflow: boolean; pending: number }
  >();
  const inFlight = meter.createObservableGauge("swamp.execution.in_flight", {
    unit: "{operation}",
  });
  const oldest = meter.createObservableGauge("swamp.execution.oldest_age", {
    unit: "s",
  });
  const counts: Parameters<typeof inFlight.addCallback>[0] = (result) => {
    for (const [operation, entries] of pending) {
      result.observe(entries.size, { operation });
    }
  };
  const ages: Parameters<typeof oldest.addCallback>[0] = (result) => {
    const now = performance.now();
    for (const [operation, entries] of pending) {
      let first = now;
      for (const entry of entries) first = Math.min(first, entry.started);
      result.observe((now - first) / 1000, { operation });
    }
  };
  inFlight.addCallback(counts);
  oldest.addCallback(ages);
  dispose = () => {
    inFlight.removeCallback(counts);
    oldest.removeCallback(ages);
    pending.clear();
    phases.clear();
  };
  const observer: ExecutionObserver = {
    start(operation, attributes, parent, links) {
      const coverage = attributes["swamp.trace.coverage"];
      if (
        coverage === "nested" || coverage === "fallback" ||
        coverage === "missing"
      ) {
        parents.add(1, { operation, coverage });
      }
      const started = performance.now();
      const entry = { started };
      const entries = pending.get(operation) ?? new Set<{ started: number }>();
      pending.set(operation, entries);
      entries.add(entry);
      attempts.add(1, { operation });
      const ctx = parent
        ? extractTraceContext({ ...parent })
        : context.active();
      const parentId = trace.getSpanContext(ctx)?.spanId;
      const parentPhase = parentId ? phases.get(parentId) : undefined;
      if (parentPhase) parentPhase.pending++;
      const span = trace.getTracer("swamp.execution", "1").startSpan(
        `swamp.${operation}`,
        {
          attributes: {
            "swamp.telemetry.version": EXECUTION_TELEMETRY_VERSION,
            ...attributes,
          },
          links: (links ?? []).flatMap((carrier) => {
            const link = trace.getSpanContext(
              extractTraceContext({ ...carrier }),
            );
            return link ? [{ context: link }] : [];
          }),
        },
        ctx,
      );
      const active = trace.setSpan(ctx ?? ROOT_CONTEXT, span);
      const phase = {
        children: [] as PhaseInterval[],
        overflow: false,
        pending: 0,
      };
      const spanId = span.spanContext().spanId;
      if (span.isRecording()) phases.set(spanId, phase);
      if (span.isRecording()) sampled.add(1, { operation });
      let ended = false;
      return {
        carrier: context.with(active, () => traceCarrier(injectTraceContext())),
        run: (fn) => context.with(active, fn),
        attributes: (values) => span.setAttributes(values),
        end(outcome) {
          if (ended) return;
          ended = true;
          const end = performance.now();
          const coverage = phaseCoverage(started, end, phase.children);
          span.setAttributes({
            "swamp.phase.local_ms": coverage.total,
            "swamp.phase.child_covered_ms": coverage.covered,
            "swamp.phase.uncovered_ms": coverage.uncovered,
            "swamp.phase.coverage_truncated": phase.overflow,
            "swamp.phase.pending_children": phase.pending,
            "swamp.phase.clock": "process_monotonic",
          });
          phases.delete(spanId);
          if (parentPhase) {
            parentPhase.pending--;
            if (parentPhase.children.length < 1024) {
              parentPhase.children.push({ start: started, end });
            } else parentPhase.overflow = true;
          }
          entries.delete(entry);
          finished.add(1, { operation, outcome });
          duration.record((performance.now() - started) / 1000, {
            operation,
            outcome,
          });
          span.setAttribute("swamp.outcome", outcome);
          span.setStatus({
            code: outcome === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          });
          span.end();
        },
      };
    },
  };
  setExecutionObserver(observer);
}

export function uninstallExecutionObserver(): void {
  dispose?.();
  dispose = undefined;
  setExecutionObserver(undefined);
}
