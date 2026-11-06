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

import {
  type Context,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
} from "@opentelemetry/api";

// W3C Trace Context: version-traceid-parentid-flags
const TRACEPARENT =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/**
 * Whether serve samples a trace it starts itself, read as the SDK reads
 * OTEL_TRACES_SAMPLER for a root span.
 */
export function rootSampled(
  traceId: string,
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): boolean {
  const sampler = (env("OTEL_TRACES_SAMPLER") ?? "").trim().toLowerCase();
  switch (sampler) {
    case "always_off":
    case "parentbased_always_off":
      return false;
    case "traceidratio":
    case "parentbased_traceidratio": {
      const parsed = Number(env("OTEL_TRACES_SAMPLER_ARG"));
      const ratio = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
        ? parsed
        : 1;
      return traceIdRatioSampled(traceId, ratio);
    }
    default:
      return true;
  }
}

// TraceIdRatioBasedSampler's rule, copied so the SDK stays a lazy import
function traceIdRatioSampled(traceId: string, ratio: number): boolean {
  const bound = Math.floor(ratio * 0xffffffff);
  let accumulation = 0;
  for (let i = 0; i < traceId.length / 8; i++) {
    const pos = i * 8;
    const part = parseInt(traceId.slice(pos, pos + 8), 16);
    accumulation = (accumulation ^ part) >>> 0;
  }
  return accumulation < bound;
}

/**
 * The parent for a server span from an already authenticated caller's
 * traceparent: its trace and span ids only. The caller's sampled flag is
 * replaced by serve's own decision, so a caller can neither force nor
 * suppress serve's recording.
 */
export function adoptAuthenticatedParent(
  headers: Headers,
  env?: (name: string) => string | undefined,
): Context | undefined {
  const match = TRACEPARENT.exec(headers.get("traceparent")?.trim() ?? "");
  if (match === null || match[1] === "ff") return undefined;
  // version 00 has exactly four fields; a later version may append more
  if (match[1] === "00" && match[5] !== undefined) return undefined;
  const remote = {
    traceId: match[2],
    spanId: match[3],
    isRemote: true,
    traceFlags: TraceFlags.NONE,
  };
  if (!trace.isSpanContextValid(remote)) return undefined;
  return trace.setSpanContext(ROOT_CONTEXT, {
    ...remote,
    traceFlags: rootSampled(remote.traceId, env)
      ? TraceFlags.SAMPLED
      : TraceFlags.NONE,
  });
}
