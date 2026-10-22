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

import { assertEquals } from "@std/assert";
import { ExportResultCode } from "@opentelemetry/core";
import { Resource } from "@opentelemetry/resources";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { FetchOtlpMetricExporter } from "./fetch_otlp_metric_exporter.ts";

Deno.test("FetchOtlpMetricExporter: malformed replies fail and shutdown refuses requests", async () => {
  const exporter = new FetchOtlpMetricExporter(
    "https://collector.example/v1/metrics",
    {},
  );
  const send = () =>
    new Promise<ExportResultCode>((resolve) => {
      exporter.export(
        { resource: new Resource({}), scopeMetrics: [] },
        (result) => resolve(result.code),
      );
    });
  const { calls } = await withMockedFetch([new Response("not JSON")], async () => {
    try {
      assertEquals(await send(), ExportResultCode.FAILED);
      await exporter.shutdown();
      assertEquals(await send(), ExportResultCode.FAILED);
    } finally {
      await exporter.shutdown();
    }
  });
  assertEquals(calls.length, 1);
});
