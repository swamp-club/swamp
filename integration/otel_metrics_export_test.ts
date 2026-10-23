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
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { FetchOtlpMetricExporter } from "../src/infrastructure/tracing/fetch_otlp_metric_exporter.ts";
import { ExportResultCode } from "@opentelemetry/core";
import { Resource } from "@opentelemetry/resources";

Deno.test("OTLP metrics: rejection and partial rejection fail export; shutdown refuses new requests", async () => {
  let requests = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      await req.arrayBuffer();
      requests++;
      return requests === 1
        ? new Response("unavailable", { status: 503 })
        : Response.json({ partialSuccess: { rejectedDataPoints: "1" } });
    },
  );
  const exporter = new FetchOtlpMetricExporter(
    `http://127.0.0.1:${server.addr.port}/v1/metrics`,
    {},
  );
  const resource = { resource: new Resource({}), scopeMetrics: [] };
  const send = () =>
    new Promise<ExportResultCode>((resolve) => {
      exporter.export(resource, (result) => resolve(result.code));
    });
  try {
    assertEquals(await send(), ExportResultCode.FAILED);
    assertEquals(await send(), ExportResultCode.FAILED);
    await exporter.shutdown();
    assertEquals(await send(), ExportResultCode.FAILED);
    assertEquals(requests, 2);
  } finally {
    await exporter.shutdown();
    await server.shutdown();
  }
});

Deno.test("OTLP metrics: native fetch exports bounded metric data to a collector", async () => {
  const received: unknown[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      assertEquals(new URL(req.url).pathname, "/v1/metrics");
      assertEquals(req.headers.get("x-test-collector"), "local");
      received.push(await req.json());
      return Response.json({});
    },
  );
  const exporter = new FetchOtlpMetricExporter(
    `http://127.0.0.1:${server.addr.port}/v1/metrics`,
    { "x-test-collector": "local" },
  );
  const provider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      }),
    ],
  });
  try {
    provider.getMeter("swamp.execution").createCounter(
      "swamp.execution.started",
    ).add(2, { operation: "query.execute" });
    await provider.forceFlush();
    assert(received.length > 0);
    const text = JSON.stringify(received);
    assert(text.includes("swamp.execution.started"));
    assert(text.includes("query.execute"));
    assert(!text.includes("request_id"));
  } finally {
    await provider.shutdown();
    await server.shutdown();
  }
});
