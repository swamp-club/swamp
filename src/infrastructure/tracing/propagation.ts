// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { context, propagation } from "@opentelemetry/api";

/**
 * Carrier that implements the TextMapSetter/Getter interfaces for
 * a plain Record<string, string>.
 */
type HeaderCarrier = Record<string, string>;

/**
 * Extracts W3C Trace Context (`traceparent`/`tracestate`) from the current
 * active context and returns them as a plain object.
 *
 * Returns an empty object when tracing is not initialized (propagation API
 * returns no-op implementations).
 */
export function injectTraceContext(): HeaderCarrier {
  const carrier: HeaderCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Reconstructs an OTel context from W3C Trace Context headers.
 *
 * This is useful for receiving trace context from an external caller
 * (e.g. a parent process that set TRACEPARENT).
 */
export function extractTraceContext(
  headers: HeaderCarrier,
): ReturnType<typeof context.active> {
  return propagation.extract(context.active(), headers);
}
