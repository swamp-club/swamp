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

// With --parallel, other test files may have already called initializeLogging,
// setting both the module-level isInitialized guard and LogTape's own
// configure guard. We must clear both before this test can reconfigure
// logging with a stubbed fetch.

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
  const savedFetch = globalThis.fetch;
  const captured: { url: string; body: string }[] = [];

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
    // Clear any prior OTel logs provider so initLogs() creates a fresh one
    // that picks up our stubbed fetch.
    await shutdownLogs();

    // Log (non-JSON) mode — the path where run loggers inherit root sinks.
    // _reset clears the once-per-process guard and passes reset:true to
    // LogTape's configure(), so this works even when another test file
    // already called initializeLogging in the same --parallel run.
    // _logsConfig bypasses Deno.env to avoid races with other parallel tests.
    await initializeLogging({
      _reset: true,
      _logsConfig: { endpoint: "http://collector.test" },
    });

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
  }
});
