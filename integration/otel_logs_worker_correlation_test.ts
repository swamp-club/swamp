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

// Worker-subprocess coverage for the OTel logs signal (swamp-club#1158).
//
// The production worker child (`swamp worker exec-dispatch`) boots through
// main.ts, which runs initTracing() (extracting the propagated TRACEPARENT) and
// shutdownLogs(); and dispatch_handler.ts builds the child env by overlaying the
// shipped snapshot on top of Deno.env.toObject(), so OTEL_* is inherited. This
// test proves both halves without spawning a subprocess:
//   1. The env plumbing carries OTEL_* + TRACEPARENT into the child env.
//   2. Feeding that TRACEPARENT through the real initTracing + runWithParentTrace
//      makes the child's exported log records carry the *parent's* trace id.

import { assert, assertEquals } from "@std/assert";
import {
  isDeniedEnvVar,
  overlayEnvironment,
} from "../src/domain/remote/environment_snapshot.ts";
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

/** Reproduces dispatch_handler.ts's child-env construction. */
function buildChildEnv(
  base: Record<string, string>,
  snapshot: Record<string, string>,
  traceHeaders: Record<string, string>,
): Record<string, string> {
  let env = overlayEnvironment(base, snapshot);
  const traceSnapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(traceHeaders)) {
    traceSnapshot[key.toUpperCase().replace(/-/g, "_")] = value;
  }
  env = overlayEnvironment(env, traceSnapshot);
  return env;
}

Deno.test("worker env: OTEL_* is inherited and TRACEPARENT is overlaid into the child env", () => {
  const base = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test",
    OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=key",
    HOME: "/worker-home",
  };
  const env = buildChildEnv(
    base,
    { SOME_SHIPPED: "value" },
    { traceparent: `00-${PARENT_TRACE}-${PARENT_SPAN}-01` },
  );

  // OTEL_* survives from the worker's own env into the child.
  assertEquals(
    env.OTEL_EXPORTER_OTLP_ENDPOINT,
    "http://collector.test",
  );
  assertEquals(env.OTEL_EXPORTER_OTLP_HEADERS, "x-honeycomb-team=key");
  // Propagated trace context is present as the env var initTracing reads.
  assertEquals(env.TRACEPARENT, `00-${PARENT_TRACE}-${PARENT_SPAN}-01`);

  // And the denylist never strips telemetry config or trace context.
  assertEquals(isDeniedEnvVar("OTEL_EXPORTER_OTLP_ENDPOINT"), false);
  assertEquals(isDeniedEnvVar("OTEL_EXPORTER_OTLP_HEADERS"), false);
  assertEquals(isDeniedEnvVar("TRACEPARENT"), false);
});

Deno.test("worker correlation: child logs carry the propagated parent trace id", async () => {
  const savedTraceparent = Deno.env.get("TRACEPARENT");
  const savedFetch = globalThis.fetch;
  const captured: { url: string; body: string }[] = [];

  // TRACEPARENT must be in Deno.env because initTracing() reads it from the
  // process environment (it's how W3C trace propagation works across processes).
  // The OTel logs endpoint is passed via _logsConfig to avoid racing with other
  // parallel test files that manipulate OTEL_EXPORTER_OTLP_ENDPOINT.
  Deno.env.set("TRACEPARENT", `00-${PARENT_TRACE}-${PARENT_SPAN}-01`);
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

    // This mirrors main.ts: initTracing() extracts TRACEPARENT and returns the
    // parent context; runWithParentTrace activates it for the run.
    // Endpoint passed via config to avoid Deno.env races with parallel tests.
    const parentCtx = await initTracing({ endpoint: "http://collector.test" });
    await initializeLogging({
      jsonMode: true,
      _reset: true,
      _logsConfig: { endpoint: "http://collector.test" },
    });

    await runWithParentTrace(parentCtx, async () => {
      await withSpan("swamp.model.method.run", {}, (span) => {
        // The child span must be parented to the propagated trace.
        assertEquals(span.spanContext().traceId, PARENT_TRACE);
        getSwampLogger(["model", "method", "run", "m", "execute"])
          .info`work in the worker child`;
        return Promise.resolve();
      });
    });

    await shutdownLogs();
    await shutdownTracing();

    // Find the exported log record and confirm it carries the PARENT trace id.
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
    if (savedTraceparent === undefined) Deno.env.delete("TRACEPARENT");
    else Deno.env.set("TRACEPARENT", savedTraceparent);
  }
});
