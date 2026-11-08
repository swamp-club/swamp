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

import { assertStringIncludes } from "@std/assert";
import { trace } from "@opentelemetry/api";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { initTracing } from "../src/infrastructure/tracing/otel_init.ts";
import { initExecutionMetrics } from "../src/infrastructure/tracing/otel_metrics_init.ts";
import { shutdownObservability } from "../src/infrastructure/tracing/otel_shutdown.ts";

Deno.test("shutdownObservability: the final metrics export carries the outcome of the last span send", async () => {
  const metricExports: string[] = [];
  await withMockedFetch(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/metrics") {
      metricExports.push(await request.text());
      return Response.json({});
    }
    // A collector that takes a moment, so the last span is still in flight
    // when shutdown starts.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({});
  }, () =>
    withMockedEnv({
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: undefined,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: undefined,
      OTEL_EXPORTER_OTLP_HEADERS: undefined,
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: undefined,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: undefined,
      OTEL_BSP_USE: undefined,
      TRACEPARENT: undefined,
    }, async () => {
      await initTracing({ endpoint: "http://collector.test" });
      await initExecutionMetrics();
      trace.getTracer("shutdown-order").startSpan("swamp.cli").end();

      await shutdownObservability(Date.now() + 5_000);
    }));

  assertStringIncludes(metricExports.join("\n"), "collector_acknowledged");
});
