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
import { ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import {
  SamplingDecision,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { adoptAuthenticatedParent, rootSampled } from "./adopted_parent.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

function envOf(values: Record<string, string>) {
  return (name: string) => values[name];
}

function headers(flags: string): Headers {
  return new Headers({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-${flags}` });
}

Deno.test("adoptAuthenticatedParent: keeps the caller's trace and span ids", () => {
  const parent = adoptAuthenticatedParent(headers("01"), envOf({}));
  assert(parent !== undefined);
  const context = trace.getSpanContext(parent);
  assertEquals(context?.traceId, TRACE_ID);
  assertEquals(context?.spanId, SPAN_ID);
  assertEquals(context?.isRemote, true);
});

Deno.test("adoptAuthenticatedParent: a caller's unsampled flag does not stop serve sampling", () => {
  const parent = adoptAuthenticatedParent(headers("00"), envOf({}));
  assertEquals(trace.getSpanContext(parent!)?.traceFlags, TraceFlags.SAMPLED);
});

Deno.test("adoptAuthenticatedParent: a caller's sampled flag does not make serve sample", () => {
  const parent = adoptAuthenticatedParent(
    headers("01"),
    envOf({ OTEL_TRACES_SAMPLER: "always_off" }),
  );
  assertEquals(trace.getSpanContext(parent!)?.traceFlags, TraceFlags.NONE);
});

Deno.test("adoptAuthenticatedParent: no parent without a valid traceparent", () => {
  assertEquals(adoptAuthenticatedParent(new Headers(), envOf({})), undefined);
  assertEquals(
    adoptAuthenticatedParent(
      new Headers({ traceparent: "garbage" }),
      envOf({}),
    ),
    undefined,
  );
  assertEquals(
    adoptAuthenticatedParent(
      new Headers({ traceparent: `00-${"0".repeat(32)}-${SPAN_ID}-01` }),
      envOf({}),
    ),
    undefined,
  );
});

Deno.test("rootSampled: follows OTEL_TRACES_SAMPLER as serve's own root spans do", () => {
  assertEquals(rootSampled(TRACE_ID, envOf({})), true);
  assertEquals(
    rootSampled(
      TRACE_ID,
      envOf({ OTEL_TRACES_SAMPLER: "parentbased_always_on" }),
    ),
    true,
  );
  assertEquals(
    rootSampled(
      TRACE_ID,
      envOf({ OTEL_TRACES_SAMPLER: "parentbased_always_off" }),
    ),
    false,
  );
});

Deno.test("rootSampled: decides a trace id ratio as the SDK's sampler does", () => {
  for (const ratio of [0, 0.1, 0.5, 0.9, 1]) {
    const sdk = new TraceIdRatioBasedSampler(ratio);
    for (let i = 0; i < 200; i++) {
      const traceId = crypto.randomUUID().replaceAll("-", "");
      const expected = sdk.shouldSample(ROOT_CONTEXT, traceId).decision ===
        SamplingDecision.RECORD_AND_SAMPLED;
      assertEquals(
        rootSampled(
          traceId,
          envOf({
            OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
            OTEL_TRACES_SAMPLER_ARG: String(ratio),
          }),
        ),
        expected,
        `ratio ${ratio}, trace ${traceId}`,
      );
    }
  }
});
