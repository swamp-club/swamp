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
  registerRunProgress,
  registerTrackedRunSource,
  removeRunProgress,
} from "../../domain/remote/run_progress.ts";
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
    const progress = registerRunProgress({
      runId: "private-run",
      workflow: "private-workflow",
      job: "job",
      step: "step",
    });
    const sibling = registerRunProgress({
      runId: "private-run",
      workflow: "private-workflow",
      job: "job",
      step: "sibling",
    });
    const finalizing = registerRunProgress({
      runId: "private-finalizing",
      scope: "run",
      workflow: "private-workflow",
    });
    finalizing.enter("finalizing");
    const removeTracked = registerTrackedRunSource(
      () => [{ runId: "private-run", kind: "workflow" }, {
        runId: "private-method",
        kind: "model_method",
      }],
    );
    try {
      const leave = progress.enter("waiting_for_lock", {
        resource: "private-lock",
        holderRunId: "private-holder",
      });
      await provider.forceFlush();
      const captured = exporter.getMetrics().at(-1)!;
      assert(!JSON.stringify(captured).includes("private-"));
      const live = captured.scopeMetrics.flatMap((s) => s.metrics);
      assertEquals(
        live.find((m) => m.descriptor.name === "swamp.runs.finalizing")!
          .dataPoints.find((p) => p.attributes.kind === "workflow")?.value,
        1,
      );
      const tracked = live.find((m) =>
        m.descriptor.name === "swamp.runs.active"
      )!;
      assertEquals(
        tracked.dataPoints.find((p) => p.attributes.kind === "workflow")?.value,
        1,
      );
      assertEquals(
        tracked.dataPoints.find((p) => p.attributes.kind === "model_method")
          ?.value,
        1,
      );
      assertEquals(
        live.find((m) => m.descriptor.name === "swamp.runs.observed_active")!
          .dataPoints[0].value,
        1,
      );
      const depth = live.find((m) =>
        m.descriptor.name === "swamp.run_steps.in_flight"
      )!;
      assertEquals(
        depth.dataPoints.find((p) => p.attributes.phase === "waiting_for_lock")
          ?.value,
        1,
      );
      assertEquals(
        depth.dataPoints.find((p) => p.attributes.phase === "queued")?.value,
        1,
      );
      leave();
    } finally {
      removeRunProgress(progress);
      removeRunProgress(sibling);
      removeRunProgress(finalizing);
      removeTracked();
    }
    await provider.forceFlush();
    const settled = exporter.getMetrics().at(-1)!.scopeMetrics.flatMap((s) =>
      s.metrics
    );
    assertEquals(
      settled.find((m) => m.descriptor.name === "swamp.runs.finalizing")!
        .dataPoints.find((p) => p.attributes.kind === "workflow")?.value,
      0,
    );
    assertEquals(
      settled.find((m) => m.descriptor.name === "swamp.runs.observed_active")!
        .dataPoints[0].value,
      0,
    );
    assert(
      settled.find((m) =>
        m.descriptor.name === "swamp.run_steps.state_duration"
      )!.dataPoints.some((p) => p.attributes.phase === "waiting_for_lock"),
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
