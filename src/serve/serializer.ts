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

/**
 * Converts libswamp events to JSON-safe objects for WebSocket transmission.
 */

import type { SwampError } from "../libswamp/mod.ts";
import type { SerializedError, SerializedEvent } from "./protocol.ts";

/**
 * Serializes a libswamp event (WorkflowRunEvent or ModelMethodRunEvent) into
 * a JSON-safe object. Handles non-serializable values like Error instances.
 */
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

  // For all other events, do a JSON-safe clone that handles Error instances
  return jsonSafeClone(event) as SerializedEvent;
}

/**
 * Serializes a SwampError into a JSON-safe error object.
 */
export function serializeSwampError(error: SwampError): SerializedError {
  return {
    code: error.code,
    message: error.message,
    ...(error.details !== undefined && { details: error.details }),
  };
}

/**
 * Deep-clones an object, converting Error instances to plain objects.
 */
function jsonSafeClone(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
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
