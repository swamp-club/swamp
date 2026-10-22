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

import { assert, assertEquals } from "@std/assert";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  ExplicitBucketHistogramAggregation,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  View,
} from "@opentelemetry/sdk-metrics";
import { observeExecution } from "../../domain/remote/observability.ts";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "./execution_observer.ts";
import { EXECUTION_BUCKETS_SECONDS } from "./otel_metrics_init.ts";
import { findSpan, withCapturedSpans } from "./span_test_helpers.ts";

Deno.test("execution observer: parent cutoff reports an unfinished child separately from completed coverage", async () => {
  await withCapturedSpans(async (spans) => {
    installExecutionObserver();
    try {
      const parent = observeExecution("dispatch.logical");
      const child = parent.run(() => observeExecution("dispatch.attempt"));
      parent.end("cancelled");
      const span = findSpan(spans, "swamp.dispatch.logical");
      assertEquals(span.attributes["swamp.phase.pending_children"], 1);
      assertEquals(span.attributes["swamp.phase.child_covered_ms"], 0);
      child.end("ok");
      assertEquals(span.attributes["swamp.phase.pending_children"], 1);
      assertEquals(
        findSpan(spans, "swamp.dispatch.attempt").attributes["swamp.outcome"],
        "ok",
      );
      await Promise.resolve();
    } finally {
      uninstallExecutionObserver();
    }
  });
});

Deno.test("execution observer: metrics see pending work without spans, bound labels and settle exactly once", async () => {
  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
  const provider = new MeterProvider({
    readers: [reader],
    views: [
      new View({
        instrumentName: "swamp.execution.duration",
        aggregation: new ExplicitBucketHistogramAggregation(
          EXECUTION_BUCKETS_SECONDS,
        ),
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);
  installExecutionObserver();
  try {
    const a = observeExecution("query.execute", {
      "swamp.dispatch.id": "private-id",
    });
    const b = observeExecution("query.execute");
    await provider.forceFlush();
    const first = exporter.getMetrics().at(-1)!;
    const data = first.scopeMetrics.flatMap((s) => s.metrics);
    assertEquals(
      data.find((m) => m.descriptor.name === "swamp.execution.in_flight")!
        .dataPoints[0].value,
      2,
    );
    assert(!JSON.stringify(first).includes("private-id"));
    a.end("timeout");
    a.end("ok");
    b.end("ok");
    await provider.forceFlush();
    const last = exporter.getMetrics().at(-1)!.scopeMetrics.flatMap((s) =>
      s.metrics
    );
    assertEquals(
      last.find((m) => m.descriptor.name === "swamp.execution.in_flight")!
        .dataPoints[0].value,
      0,
    );
    const finished = last.find((m) =>
      m.descriptor.name === "swamp.execution.finished"
    )!;
    assertEquals(
      last.find((m) => m.descriptor.name === "swamp.execution.oldest_age")!
        .dataPoints[0].value,
      0,
    );
    assertEquals(finished.dataPoints.map((p) => p.value), [1, 1]);
    assertEquals(finished.dataPoints.map((p) => p.attributes.outcome).sort(), [
      "ok",
      "timeout",
    ]);
    const histogram = last.find((m) =>
      m.descriptor.name === "swamp.execution.duration"
    )!;
    assertEquals(
      (histogram.dataPoints[0].value as { buckets: { boundaries: number[] } })
        .buckets.boundaries,
      EXECUTION_BUCKETS_SECONDS,
    );
    uninstallExecutionObserver();
    const disabled = observeExecution("dispatch.attempt");
    disabled.end("ok");
    await provider.forceFlush();
    const removed = exporter.getMetrics().at(-1)!.scopeMetrics.flatMap((s) =>
      s.metrics
    );
    assertEquals(
      removed.find((m) => m.descriptor.name === "swamp.execution.in_flight")!
        .dataPoints.map((p) => ({ attributes: p.attributes, value: p.value })),
      [{ attributes: { operation: "query.execute" }, value: 0 }],
    );
    assertEquals(
      removed.find((m) => m.descriptor.name === "swamp.execution.finished")!
        .dataPoints.map((p) => p.value),
      [1, 1],
    );
  } finally {
    uninstallExecutionObserver();
    await provider.shutdown();
    metrics.disable();
  }
});
