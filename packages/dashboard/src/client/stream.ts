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

/** A frame from serve, addressed to one request by its id. */
export interface WireFrame {
  type: string;
  id: string;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
  event?: unknown;
}

/** What a pending request does with a frame addressed to it. */
export type FrameOutcome =
  | { kind: "ignore" }
  | { kind: "resolve"; value: unknown; detach: boolean }
  | { kind: "reject"; message: string; code: string; details?: unknown };

function rejectFrom(
  error: NonNullable<WireFrame["error"]>,
): FrameOutcome {
  return {
    kind: "reject",
    message: error.message,
    code: error.code,
    ...(error.details !== undefined && { details: error.details }),
  };
}

/**
 * Settles a plain request: it resolves on the frame that carries a payload.
 */
export function settleRequest(frame: WireFrame): FrameOutcome {
  if (frame.type === "error" && frame.error) {
    return rejectFrom(frame.error);
  }
  if (frame.payload !== undefined) {
    return { kind: "resolve", value: frame.payload, detach: false };
  }
  return { kind: "ignore" };
}

/**
 * Settles a detached request, such as `workflow.resume`, whose run serve
 * drives itself. Its frames are `event`s ending in `done`; none carries a
 * payload. It resolves on the first event, which means the run has started,
 * and the caller then detaches. It resolves on `done` with nothing left to
 * detach from.
 */
export function settleDetached(frame: WireFrame): FrameOutcome {
  if (frame.type === "error" && frame.error) {
    return rejectFrom(frame.error);
  }
  if (frame.type === "event") {
    return { kind: "resolve", value: undefined, detach: true };
  }
  if (frame.type === "done") {
    return { kind: "resolve", value: undefined, detach: false };
  }
  return { kind: "ignore" };
}

/**
 * The frame that stops a client following a request without stopping the
 * run. Serve treats a `cancel` whose id is a live request as a detach, but a
 * `cancel` whose id is a run id cancels that run, so this only ever carries
 * the request id.
 */
export function detachFrame(requestId: string): { type: "cancel"; id: string } {
  return { type: "cancel", id: requestId };
}

/**
 * A rejected request, keeping serve's error code and the machine-readable
 * reason and entity type serve attaches to data and history errors, so a
 * view can tell an expired version from a missing model or a denial.
 */
export class RequestError extends Error {
  readonly code: string;
  readonly reason?: string;
  readonly entityType?: string;

  constructor(message: string, code: string, details?: unknown) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    if (details !== null && typeof details === "object") {
      const { reason, entityType } = details as Record<string, unknown>;
      if (typeof reason === "string") this.reason = reason;
      if (typeof entityType === "string") this.entityType = entityType;
    }
  }
}

/** The structured parts of a failed request a view branches on. */
export interface RequestErrorInfo {
  code: string;
  reason?: string;
  entityType?: string;
}

/** Reads the structured parts of an error thrown by a request. */
export function requestErrorInfo(error: unknown): RequestErrorInfo | null {
  if (!(error instanceof RequestError)) return null;
  return {
    code: error.code,
    ...(error.reason !== undefined && { reason: error.reason }),
    ...(error.entityType !== undefined && { entityType: error.entityType }),
  };
}
