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
import { waitFor, withMockedFetch } from "@swamp-club/swamp-testing";
import { metrics } from "@opentelemetry/api";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { observeExecution } from "../src/domain/remote/observability.ts";
import {
  initExecutionMetrics,
  shutdownExecutionMetrics,
} from "../src/infrastructure/tracing/otel_metrics_init.ts";

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

Deno.test("shutdownExecutionMetrics: stops waiting at the exit deadline while a silent collector holds the final export", async () => {
  const held = { requests: 0, abandoned: false, answered: false };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  try {
    await withMockedFetch(
      (request) =>
        new Promise<Response>((resolve, reject) => {
          held.requests++;
          request.signal.addEventListener("abort", () => {
            held.abandoned = true;
            reject(request.signal.reason);
          });
          gate.then(() => {
            held.answered = true;
            resolve(Response.json({}));
          });
        }),
      () =>
        withMockedEnv({
          OTEL_METRICS_EXPORTER: "otlp",
          OTEL_TRACES_EXPORTER: "none",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test",
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: undefined,
          OTEL_EXPORTER_OTLP_METRICS_HEADERS: undefined,
        }, async () => {
          await initExecutionMetrics();
          observeExecution("query.execute").end("ok");

          await shutdownExecutionMetrics(Date.now() + 200);

          assertEquals(held.requests, 1);
          // the exporter's own 5 s timeout never had to give up on it
          assertEquals(held.abandoned, false);
          assertEquals(held.answered, false);
          release();
          await waitFor(() => held.answered, "the held export to be answered");
        }),
    );
  } finally {
    release();
  }
});
