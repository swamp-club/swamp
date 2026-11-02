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

import type { SwampError } from "../libswamp/errors.ts";
import type { SerializedError, SerializedEvent } from "./protocol.ts";

/**
 * a client has no handler for an event kind newer than itself and crashes, so
 * these are never sent; signal_wait_requested is repeated in the suspended
 * event's wait and nestedSignalWaits
 */
const LOCAL_ONLY_EVENT_KINDS: ReadonlySet<string> = new Set([
  "signal_wait_requested",
]);

export function isWireEvent(event: { kind: string }): boolean {
  return !LOCAL_ONLY_EVENT_KINDS.has(event.kind);
}

export function serializeEvent(
  event: { kind: string; [key: string]: unknown },
): SerializedEvent {
  if (event.kind === "error") {
    const swampError = event.error as SwampError;
    return {
      kind: "error",
      error: serializeSwampError(swampError),
    };
  }

  return jsonSafeClone(event) as SerializedEvent;
}

/**
 * lossless by design: run events are plain data and a SwampError's code,
 * message and details survive serialization. A future field needing
 * re-inflation belongs here, beside its serializer, never in renderers.
 */
export function deserializeEvent(
  event: SerializedEvent,
): { kind: string; [key: string]: unknown } {
  return event;
}

export function serializeSwampError(error: SwampError): SerializedError {
  return {
    code: error.code,
    message: error.message,
    ...(error.details !== undefined && { details: error.details }),
  };
}

export function jsonSafeClone(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { message: value.message };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafeClone);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = jsonSafeClone(v);
    }
    return result;
  }
  return value;
}
