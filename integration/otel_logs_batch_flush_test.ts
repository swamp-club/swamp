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

// Adversarial batch-mode flush test (swamp-club#1158): with OTEL_BLRP_USE=1 the
// BatchLogRecordProcessor queues records instead of exporting per-record — the
// classic footgun is dropping the queue when the process exits. This drives the
// real wiring and asserts that a record logged just before shutdownLogs() is
// still delivered, because shutdownLogs() -> provider.shutdown() flushes the
// batch (and the exporter drains its in-flight send).
//
// Runs in its own process so initializeLogging()'s guard is fresh.

import { assert } from "@std/assert";
import {
  getSwampLogger,
  initializeLogging,
} from "../src/infrastructure/logging/logger.ts";
import { shutdownLogs } from "../src/infrastructure/tracing/mod.ts";

Deno.test("OTel logs (batch mode): a record logged right before shutdown is still flushed", async () => {
  const savedEndpoint = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  const savedBatch = Deno.env.get("OTEL_BLRP_USE");
  const savedFetch = globalThis.fetch;
  const bodies: string[] = [];

  Deno.env.set("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  Deno.env.set("OTEL_BLRP_USE", "1");
  // deno-lint-ignore no-explicit-any
  globalThis.fetch = ((input: any, init: any): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/v1/logs") && init?.body) {
      bodies.push(new TextDecoder().decode(init.body as ArrayBuffer));
    }
    return Promise.resolve(new Response(null, { status: 200 }));
    // deno-lint-ignore no-explicit-any
  }) as any;

  try {
    await initializeLogging({});

    getSwampLogger(["model", "method", "run", "m", "execute"])
      .info`batched-line-xyz789`;

    // Nothing may have been sent yet (batched). The shutdown must flush it.
    await shutdownLogs();

    const delivered = bodies.some((b) => b.includes("batched-line-xyz789"));
    assert(
      delivered,
      "batched record was dropped instead of flushed on shutdown",
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEndpoint === undefined) {
      Deno.env.delete("OTEL_EXPORTER_OTLP_ENDPOINT");
    } else Deno.env.set("OTEL_EXPORTER_OTLP_ENDPOINT", savedEndpoint);
    if (savedBatch === undefined) Deno.env.delete("OTEL_BLRP_USE");
    else Deno.env.set("OTEL_BLRP_USE", savedBatch);
  }
});
