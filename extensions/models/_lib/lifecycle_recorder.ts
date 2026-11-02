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

// whether a dropped upstream write fails the step is model policy, not the
// adapter's: start raises when swamp-club is unreachable or the issue is
// missing, auto-assignment only warns

import type {
  LifecycleEntryParams,
  SwampClubClient,
  UpstreamOutcome,
} from "./swamp_club.ts";

export interface RecorderLogger {
  info: (msg: string, props: Record<string, unknown>) => void;
  warning: (msg: string, props: Record<string, unknown>) => void;
}

/**
 * the server body is included verbatim: it carries the reason the write was
 * refused, which the operator needs to fix the payload
 */
function explain(label: string, outcome: UpstreamOutcome): string {
  if (outcome.ok) return `${label} succeeded`;
  if (outcome.reason === "rejected") {
    return `swamp-club rejected the ${label}: HTTP ${outcome.status} — ` +
      `${outcome.body}. The upstream record was not written. Fix the payload ` +
      `and re-run this method.`;
  }
  return `swamp-club was unreachable while writing the ${label}: ` +
    `${outcome.detail}. The upstream record was not written.`;
}

/**
 * returns quietly with no client (offline is supported, and the warning was
 * already given); a reachable server dropping the record raises
 */
export async function recordLifecycle(
  sc: SwampClubClient | null,
  params: LifecycleEntryParams,
): Promise<void> {
  if (!sc) return;
  const outcome = await sc.postLifecycleEntry(params);
  if (outcome.ok) return;
  throw new Error(explain(`${params.step} lifecycle entry`, outcome));
}

/**
 * use only where the reported action is itself best-effort, otherwise the audit
 * trail and the step's exit status disagree
 */
export async function recordLifecycleBestEffort(
  sc: SwampClubClient | null,
  logger: RecorderLogger,
  params: LifecycleEntryParams,
): Promise<void> {
  if (!sc) return;
  const outcome = await sc.postLifecycleEntry(params);
  if (outcome.ok) return;
  logger.warning("{message}", {
    message: explain(`${params.step} lifecycle entry`, outcome),
  });
}

export async function recordRipple(
  sc: SwampClubClient | null,
  body: string,
): Promise<void> {
  if (!sc) return;
  const outcome = await sc.submitComment(body);
  if (outcome.ok) return;
  throw new Error(explain("contributor ripple", outcome));
}

/**
 * used where raising after an earlier ripple posted would make the re-run post
 * that one twice
 */
export async function recordRippleBestEffort(
  sc: SwampClubClient | null,
  logger: RecorderLogger,
  body: string,
): Promise<boolean> {
  if (!sc) return false;
  const outcome = await sc.submitComment(body);
  if (outcome.ok) return true;
  logger.warning("{message}", {
    message: explain("contributor ripple", outcome),
  });
  return false;
}

export function recordUpstreamChange(
  logger: RecorderLogger,
  label: string,
  outcome: UpstreamOutcome | undefined,
): void {
  if (!outcome) return;
  if (outcome.ok) {
    if (outcome.noop) {
      logger.info("{label} was already applied upstream", { label });
    }
    return;
  }
  throw new Error(explain(label, outcome));
}
