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

// the worker child's env carries OTEL_* and TRACEPARENT, and feeding it through
// initTracing and runWithParentTrace makes exported log records carry the
// parent's trace id; no subprocess is spawned

import { assert, assertEquals } from "@std/assert";
import { isDeniedEnvVar } from "../src/domain/remote/environment_snapshot.ts";
import { buildRunnerEnvironment } from "../src/worker/dispatch_handler.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { getSwampLogger } from "../src/infrastructure/logging/logger.ts";
import {
  initTracing,
  runWithParentTrace,
  shutdownLogs,
  shutdownTracing,
  withSpan,
} from "../src/infrastructure/tracing/mod.ts";

const PARENT_TRACE = "11111111111111111111111111111111";
const PARENT_SPAN = "2222222222222222";

Deno.test("worker env: OTEL_* is inherited and TRACEPARENT is overlaid into the child env", () => {
  const base = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test",
    OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=key",
    HOME: "/worker-home",
  };
  const env = buildRunnerEnvironment(
    base,
    {
      SOME_SHIPPED: "value",
      // the orchestrator's own telemetry settings are never shipped; an older
      // orchestrator that ships them is ignored
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://orchestrator-collector.test",
    },
    { traceparent: `00-${PARENT_TRACE}-${PARENT_SPAN}-01` },
  );

  assertEquals(
    env.OTEL_EXPORTER_OTLP_ENDPOINT,
    "http://collector.test",
  );
  assertEquals(env.OTEL_EXPORTER_OTLP_HEADERS, "x-honeycomb-team=key");
  assertEquals(env.SOME_SHIPPED, "value");
  assertEquals(env.TRACEPARENT, `00-${PARENT_TRACE}-${PARENT_SPAN}-01`);

  // The snapshot denylist keeps the orchestrator's telemetry config and trace
  // context on the orchestrator; the dispatch carries its trace explicitly.
  assertEquals(isDeniedEnvVar("OTEL_EXPORTER_OTLP_ENDPOINT"), true);
  assertEquals(isDeniedEnvVar("TRACEPARENT"), true);
});

Deno.test("worker correlation: child logs carry the propagated parent trace id", async () => {
  const savedFetch = globalThis.fetch;
  const captured: { url: string; body: string }[] = [];

  // hand the child env to initTracing through its env lookup, not the
  // process-wide Deno.env, which parallel test files and InProcessExecutor
  // mutate concurrently
  const childEnv = buildRunnerEnvironment({}, {}, {
    traceparent: `00-${PARENT_TRACE}-${PARENT_SPAN}-01`,
  });
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
    await shutdownLogs();

    // mirrors main.ts: initTracing extracts TRACEPARENT and runWithParentTrace
    // activates it; the endpoint is passed via config to avoid Deno.env races
    // with parallel tests
    const parentCtx = await initTracing({
      endpoint: "http://collector.test",
      envGet: (key) => childEnv[key],
    });
    await initializeLogging({
      jsonMode: true,
      _reset: true,
      _logsConfig: { endpoint: "http://collector.test" },
    });

    await runWithParentTrace(parentCtx, async () => {
      await withSpan("swamp.model.method.run", {}, (span) => {
        assertEquals(span.spanContext().traceId, PARENT_TRACE);
        getSwampLogger(["model", "method", "run", "m", "execute"])
          .info`work in the worker child`;
        return Promise.resolve();
      });
    });

    await shutdownLogs();
    await shutdownTracing();

    let found:
      | { traceId?: string; body?: { stringValue?: string } }
      | undefined;
    for (const { url, body } of captured) {
      if (!url.endsWith("/v1/logs")) continue;
      const payload = JSON.parse(body);
      for (const rl of payload.resourceLogs ?? []) {
        for (const sl of rl.scopeLogs ?? []) {
          for (const lr of sl.logRecords ?? []) {
            if (lr.body?.stringValue === "work in the worker child") found = lr;
          }
        }
      }
    }

    assert(found, "worker child log record was not exported");
    assertEquals(found.traceId, PARENT_TRACE);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
