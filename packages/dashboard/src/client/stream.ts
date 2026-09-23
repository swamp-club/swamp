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
  error?: { code: string; message: string };
  event?: unknown;
}

/** What a pending request does with a frame addressed to it. */
export type FrameOutcome =
  | { kind: "ignore" }
  | { kind: "resolve"; value: unknown; detach: boolean }
  | { kind: "reject"; message: string };

/**
 * Settles a plain request: it resolves on the frame that carries a payload.
 */
export function settleRequest(frame: WireFrame): FrameOutcome {
  if (frame.type === "error" && frame.error) {
    return { kind: "reject", message: frame.error.message };
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
    return { kind: "reject", message: frame.error.message };
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
