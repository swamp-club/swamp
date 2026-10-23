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

import { metrics } from "@opentelemetry/api";
import { parseOtlpHeaders, resolveOtlpEndpoint } from "./otel_config.ts";

export const EXECUTION_BUCKETS_SECONDS = [
  0.0001,
  0.001,
  0.01,
  0.1,
  0.5,
  1,
  5,
  15,
  30,
  60,
  120,
  300,
  600,
  900,
  1800,
];
let provider: { shutdown(): Promise<void> } | undefined;

/** Metrics are explicitly opt-in, independent of traces and product telemetry. */
export async function initExecutionMetrics(): Promise<void> {
  if (provider) return;
  if (Deno.env.get("OTEL_METRICS_EXPORTER") !== "otlp") return;
  const url = resolveOtlpEndpoint("metrics");
  if (!url) return;
  const [
    {
      MeterProvider,
      PeriodicExportingMetricReader,
      View,
      ExplicitBucketHistogramAggregation,
    },
    { Resource, envDetectorSync },
    { buildOtelResource },
    { FetchOtlpMetricExporter },
  ] = await Promise.all([
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/resources"),
    import("./otel_resource.ts"),
    import("./fetch_otlp_metric_exporter.ts"),
  ]);
  const resource = buildOtelResource(Resource, envDetectorSync, {
    serviceNameAttr: "service.name",
    serviceVersionAttr: "service.version",
  });
  const reader = new PeriodicExportingMetricReader({
    exporter: new FetchOtlpMetricExporter(url, parseOtlpHeaders("metrics")),
    exportIntervalMillis: 10_000,
    exportTimeoutMillis: 5_000,
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [reader],
    views: ["swamp.execution.duration", "swamp.run_steps.state_duration"].map(
      (instrumentName) =>
        new View({
          instrumentName,
          aggregation: new ExplicitBucketHistogramAggregation(
            EXECUTION_BUCKETS_SECONDS,
          ),
        }),
    ),
  });
  metrics.setGlobalMeterProvider(meterProvider);
  provider = meterProvider;
  const { installExecutionObserver } = await import("./execution_observer.ts");
  installExecutionObserver();
}

export async function shutdownExecutionMetrics(): Promise<void> {
  try {
    await provider?.shutdown();
  } catch { /* Observations cannot fail a run. */ }
  provider = undefined;
  metrics.disable();
  const { uninstallExecutionObserver } = await import(
    "./execution_observer.ts"
  );
  uninstallExecutionObserver();
}
