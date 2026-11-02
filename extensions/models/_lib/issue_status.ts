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

// a lab issue moves one step at a time (open, triaged, in_progress, shipped)
// and refuses jumps; closed reopens to open. The path is computed here as a
// pure function and walked one PATCH at a time

import type { Phase } from "./schemas.ts";

export const STATUS_ORDER = [
  "open",
  "triaged",
  "in_progress",
  "shipped",
] as const;

export type ForwardStatus = typeof STATUS_ORDER[number];

/**
 * empty when the issue is at or past the target, since a walk only moves
 * forward; a closed issue is reopened first; an unknown status raises because a
 * newer one may not sit on this line
 */
export function statusPath(
  current: string,
  target: ForwardStatus,
): ForwardStatus[] {
  const targetIndex = STATUS_ORDER.indexOf(target);
  if (current === "closed") {
    return [...STATUS_ORDER.slice(0, targetIndex + 1)];
  }
  const currentIndex = STATUS_ORDER.indexOf(current as ForwardStatus);
  if (currentIndex === -1) {
    throw new Error(
      `swamp-club reported issue status "${current}", which the lifecycle ` +
        `does not know how to move to "${target}".`,
    );
  }
  return [...STATUS_ORDER.slice(currentIndex + 1, targetIndex + 1)];
}

export function upstreamStatusForPhase(phase: Phase): ForwardStatus {
  switch (phase) {
    case "created":
    case "triaging":
      return "open";
    case "classified":
    case "plan_generated":
      return "triaged";
    case "approved":
    case "implementing":
    case "verifying":
    case "pr_open":
    case "pr_failed":
    case "releasing":
      return "in_progress";
    case "notify":
    case "summarizing":
    case "done":
      return "shipped";
  }
}

export function parsePrNumber(url: string): number | undefined {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  return match ? Number(match[1]) : undefined;
}
