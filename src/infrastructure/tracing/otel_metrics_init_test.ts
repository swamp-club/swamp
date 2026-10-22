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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { metrics } from "@opentelemetry/api";
import { withMockedEnv } from "../persistence/path_test_helpers.ts";
import { observeExecution } from "../../domain/remote/observability.ts";
import {
  initExecutionMetrics,
  shutdownExecutionMetrics,
} from "./otel_metrics_init.ts";

Deno.test("initExecutionMetrics: requires explicit opt-in and an endpoint", async () => {
  for (
    const [exporter, endpoint] of [[undefined, "http://localhost:1"], [
      "none",
      "http://localhost:1",
    ], ["otlp", undefined]]
  ) {
    await withMockedEnv({
      OTEL_METRICS_EXPORTER: exporter,
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: undefined,
    }, async () => {
      const before = metrics.getMeterProvider();
      await initExecutionMetrics();
      assertEquals(metrics.getMeterProvider(), before);
      await shutdownExecutionMetrics();
    });
  }
});

Deno.test("initExecutionMetrics: installs once, exports configured metrics at shutdown and can restart", async () => {
  const received: unknown[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      assertEquals(new URL(request.url).pathname, "/metric-signal");
      assertEquals(request.headers.get("x-metric-test"), "present");
      received.push(await request.json());
      return Response.json({});
    },
  );
  try {
    await withMockedEnv({
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:1/unused",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
        `http://127.0.0.1:${server.addr.port}/metric-signal`,
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "x-metric-test=present",
    }, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await initExecutionMetrics();
        const installed = metrics.getMeterProvider();
        await initExecutionMetrics();
        assertEquals(metrics.getMeterProvider(), installed);
        observeExecution("query.execute").end("ok");
        await shutdownExecutionMetrics();
        assertEquals(received.length, attempt + 1);
        assertStringIncludes(
          JSON.stringify(received[attempt]),
          "swamp.execution.finished",
        );
        assertStringIncludes(
          JSON.stringify(received[attempt]),
          "query.execute",
        );
        await shutdownExecutionMetrics();
        observeExecution("query.execute").end("ok");
        assertEquals(received.length, attempt + 1);
      }
    });
  } finally {
    await shutdownExecutionMetrics();
    await server.shutdown();
  }
});
