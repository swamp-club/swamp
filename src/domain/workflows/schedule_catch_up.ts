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

import { Cron } from "croner";
import { z } from "zod";
import { parseDataDuration } from "../data/duration.ts";

export const CATCH_UP_POLICIES = ["none", "latest"] as const;

export type CatchUpPolicy = typeof CATCH_UP_POLICIES[number];

/** a catch-up older than this is a different cycle's work, not a late fire */
export const CATCH_UP_MAX_DELAY_LIMIT = "31d";
const CATCH_UP_MAX_DELAY_LIMIT_MS = parseDataDuration(CATCH_UP_MAX_DELAY_LIMIT);

/** on a run started by a cron fire: the slot it was fired for */
export const SCHEDULED_FOR_TAG = "swamp.trigger.scheduledFor";
/** on a run fired at startup for a slot missed while serve was down */
export const CATCH_UP_TAG = "swamp.trigger.catchUp";

/**
 * the latest slot recorded by a run the scheduler started; any initiator can
 * set a run tag, so a run started by anyone else is never evidence
 */
export function latestRecordedSlot(
  runs: Iterable<{
    readonly initiatedBy?: string;
    readonly tags: Readonly<Record<string, string>>;
  }>,
  scheduler: string,
): Date | null {
  let latest: number | null = null;
  for (const run of runs) {
    if (run.initiatedBy !== scheduler) continue;
    const slot = Date.parse(run.tags[SCHEDULED_FOR_TAG] ?? "");
    if (!Number.isNaN(slot) && (latest === null || slot > latest)) {
      latest = slot;
    }
  }
  return latest === null ? null : new Date(latest);
}

/** the count is advisory, so a dense schedule after a long outage saturates */
export const MISSED_FIRE_COUNT_CAP = 1000;

function maxDelayIssue(value: string): string | undefined {
  let ms: number;
  try {
    ms = parseDataDuration(value);
  } catch {
    return `'${value}' is not a duration: use a number and a unit (m, h, d or w), e.g. 6h`;
  }
  if (ms <= 0) return "maxDelay must be greater than zero";
  if (ms > CATCH_UP_MAX_DELAY_LIMIT_MS) {
    return `maxDelay must be at most ${CATCH_UP_MAX_DELAY_LIMIT}`;
  }
  return undefined;
}

export const ScheduleCatchUpSchema = z.object({
  policy: z.enum(CATCH_UP_POLICIES),
  maxDelay: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.policy === "none") {
    if (value.maxDelay !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["maxDelay"],
        message: "maxDelay applies only to policy 'latest'",
      });
    }
    return;
  }
  if (value.maxDelay === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["maxDelay"],
      message: "policy 'latest' requires maxDelay, e.g. 6h",
    });
    return;
  }
  const issue = maxDelayIssue(value.maxDelay);
  if (issue) {
    ctx.addIssue({ code: "custom", path: ["maxDelay"], message: issue });
  }
});

export type ScheduleCatchUp = z.infer<typeof ScheduleCatchUpSchema>;

export interface MissedFires {
  readonly missedCount: number;
  /** true when more slots were missed than missedCount shows */
  readonly saturated: boolean;
  readonly oldestMissed: Date | null;
  readonly latestMissed: Date | null;
  /** at most one slot, and only under policy latest within maxDelay */
  readonly catchUpFireTime: Date | null;
}

/**
 * the slots of a schedule strictly after the watermark and at or before now;
 * a slot equal to now is missed because the scheduler's first tick is after it
 */
export function evaluateMissedFires(
  cronExpression: string,
  lastEvaluatedFireTime: Date,
  now: Date,
  catchUp?: ScheduleCatchUp,
): MissedFires {
  const none: MissedFires = {
    missedCount: 0,
    saturated: false,
    oldestMissed: null,
    latestMissed: null,
    catchUpFireTime: null,
  };
  if (lastEvaluatedFireTime.getTime() >= now.getTime()) return none;

  const cron = new Cron(cronExpression);
  let count = 0;
  let oldest: Date | null = null;
  let latest: Date | null = null;
  let cursor: Date = lastEvaluatedFireTime;
  while (count < MISSED_FIRE_COUNT_CAP) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > now.getTime()) break;
    oldest ??= next;
    latest = next;
    count++;
    cursor = next;
  }
  if (count === 0) return none;

  const saturated = count === MISSED_FIRE_COUNT_CAP &&
    nextAtOrBefore(cron, cursor, now) !== null;
  if (saturated) {
    latest = latestAtOrBefore(cron, cursor, now) ?? latest;
  }

  return {
    missedCount: count,
    saturated,
    oldestMissed: oldest,
    latestMissed: latest,
    catchUpFireTime: catchUpTime(latest, now, catchUp),
  };
}

function catchUpTime(
  latest: Date | null,
  now: Date,
  catchUp: ScheduleCatchUp | undefined,
): Date | null {
  if (!latest || catchUp?.policy !== "latest" || !catchUp.maxDelay) {
    return null;
  }
  const maxDelayMs = parseDataDuration(catchUp.maxDelay);
  return now.getTime() - latest.getTime() <= maxDelayMs ? latest : null;
}

function nextAtOrBefore(cron: Cron, after: Date, now: Date): Date | null {
  const next = cron.nextRun(after);
  return next && next.getTime() <= now.getTime() ? next : null;
}

/**
 * nextRun is non-decreasing in its argument, so the latest slot at or before
 * now is found by bisecting for the last instant whose next slot is not past
 * now; floor must have such a slot after it
 */
function latestAtOrBefore(cron: Cron, floor: Date, now: Date): Date | null {
  let lo = floor.getTime();
  let hi = now.getTime();
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const next = cron.nextRun(new Date(mid));
    if (next && next.getTime() <= now.getTime()) lo = mid;
    else hi = mid;
  }
  return nextAtOrBefore(cron, new Date(lo), now);
}
