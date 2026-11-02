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

// ---------------------------------------------------------------------------
// swamp-club Issue Status Order
// ---------------------------------------------------------------------------
//
// swamp-club's lab issue moves one step at a time — open, triaged,
// in_progress, shipped — and refuses any jump (`ForgeIssue` in swamp-club's
// `lib/domain/lab/issue.ts`). `closed` is terminal but can be reopened to
// `open`. A lifecycle that carries more than one issue has to bring each of
// them to the primary issue's status, so the path is worked out here once,
// as a pure function, and the client walks it one PATCH at a time.

import type { Phase } from "./schemas.ts";

/** Statuses a lab issue passes through, in the only order swamp-club allows. */
export const STATUS_ORDER = [
  "open",
  "triaged",
  "in_progress",
  "shipped",
] as const;

export type ForwardStatus = typeof STATUS_ORDER[number];

/**
 * The single-step transitions that take an issue from `current` to `target`.
 *
 * Empty when the issue is already at or past the target: a status walk only
 * ever moves forward, so an issue that got ahead is left where it is. A
 * closed issue is reopened first. An unknown status raises rather than
 * guessing, since a status swamp-club added later may not sit on this line.
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

/**
 * The swamp-club status the primary issue holds while its lifecycle is in
 * `phase` — what an issue linked part way through is caught up to.
 */
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

/** The pull request number in a `.../pull/<n>` URL, if it has one. */
export function parsePrNumber(url: string): number | undefined {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  return match ? Number(match[1]) : undefined;
}
