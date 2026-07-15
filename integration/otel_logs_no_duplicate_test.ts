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

// Adversarial regression for the double-export bug (swamp-club#1158): in
// NON-JSON mode the run/workflow loggers inherit the root's sinks, so listing
// the otel sink on BOTH the root and the run logger would export every per-run
// record twice. This test drives the real production wiring (initializeLogging
// in log mode, real LoggerProvider, real serializer) with only the network
// transport stubbed, and asserts each logged line is exported EXACTLY ONCE.
//
// Runs in its own process, so initializeLogging()'s once-per-process guard is
// fresh and configures log (non-JSON) mode.

import { assertEquals } from "@std/assert";
import {
  getSwampLogger,
  initializeLogging,
} from "../src/infrastructure/logging/logger.ts";
import { shutdownLogs } from "../src/infrastructure/tracing/mod.ts";

function countBodies(
  captured: { url: string; body: string }[],
  needle: string,
): number {
  let n = 0;
  for (const { url, body } of captured) {
    if (!url.endsWith("/v1/logs")) continue;
    const payload = JSON.parse(body);
    for (const rl of payload.resourceLogs ?? []) {
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          if (lr.body?.stringValue === needle) n++;
        }
      }
    }
  }
  return n;
}

Deno.test("OTel logs (log mode): each record is exported exactly once, never duplicated", async () => {
  const savedEndpoint = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  const savedFetch = globalThis.fetch;
  const captured: { url: string; body: string }[] = [];

  Deno.env.set("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  // deno-lint-ignore no-explicit-any
  globalThis.fetch = ((input: any, init: any): Promise<Response> => {
    if (init?.body) {
      captured.push({
        url: typeof input === "string" ? input : String(input),
        body: new TextDecoder().decode(init.body as ArrayBuffer),
      });
    }
    return Promise.resolve(new Response(null, { status: 200 }));
    // deno-lint-ignore no-explicit-any
  }) as any;

  try {
    // Log (non-JSON) mode — the path where run loggers inherit root sinks.
    await initializeLogging({});

    // A run-category logger: its records reach the root (which holds the otel
    // sink) by inheritance. If the otel sink were also on this logger, the
    // record would be exported twice.
    getSwampLogger(["model", "method", "run", "m", "execute"])
      .info`unique-run-line-abc123`;
    // A plain root-category logger for good measure.
    getSwampLogger(["cli"]).info`unique-root-line-def456`;

    await shutdownLogs();

    assertEquals(countBodies(captured, "unique-run-line-abc123"), 1);
    assertEquals(countBodies(captured, "unique-root-line-def456"), 1);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEndpoint === undefined) {
      Deno.env.delete("OTEL_EXPORTER_OTLP_ENDPOINT");
    } else {
      Deno.env.set("OTEL_EXPORTER_OTLP_ENDPOINT", savedEndpoint);
    }
  }
});
