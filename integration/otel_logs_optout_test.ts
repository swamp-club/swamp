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

// Adversarial opt-out test (swamp-club#1158): with an OTLP endpoint set but
// OTEL_LOGS_EXPORTER=none, an operator who wants traces-only must get ZERO log
// exports. Drives the real wiring (initializeLogging) with the network stubbed
// and asserts no POST to /v1/logs is ever made, even though a log is emitted.
//
// Runs in its own process so initializeLogging()'s guard is fresh.

import { assertEquals } from "@std/assert";
import {
  getSwampLogger,
  initializeLogging,
} from "../src/infrastructure/logging/logger.ts";
import { shutdownLogs } from "../src/infrastructure/tracing/mod.ts";

Deno.test("OTel logs: OTEL_LOGS_EXPORTER=none exports no log records even with an endpoint", async () => {
  const savedFetch = globalThis.fetch;
  const logPosts: string[] = [];

  // deno-lint-ignore no-explicit-any
  globalThis.fetch = ((input: any): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/v1/logs")) logPosts.push(url);
    return Promise.resolve(new Response(null, { status: 200 }));
    // deno-lint-ignore no-explicit-any
  }) as any;

  try {
    await shutdownLogs();
    await initializeLogging({
      _reset: true,
      _logsConfig: {
        endpoint: "http://collector.test",
        exporterKind: "none",
      },
    });

    getSwampLogger(["model", "method", "run", "m", "execute"])
      .info`this line must not be exported`;

    await shutdownLogs();

    assertEquals(logPosts.length, 0);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
