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

import { z } from "zod";
import type { WorkflowId } from "./workflow_id.ts";

export const MISSED_FIRE_REASONS = ["serve_down", "paused", "overlap"] as const;

export type MissedFireReason = typeof MISSED_FIRE_REASONS[number];

export const MissedFireSchema = z.object({
  fireTime: z.string().datetime(),
  count: z.number().int().positive(),
  /** count stopped at the cap, so it is a lower bound */
  saturated: z.boolean().optional(),
  reason: z.enum(MISSED_FIRE_REASONS),
  caughtUp: z.boolean(),
  detectedAt: z.string().datetime(),
});

export type MissedFire = z.infer<typeof MissedFireSchema>;

/**
 * operational state kept outside the workflow definition, keyed by the workflow
 * id like a pause; the watermark is the latest fire slot serve settled,
 * whatever the outcome, so any slot after it was never seen
 */
export const ScheduleStateSchema = z.object({
  workflowId: z.string().min(1),
  workflowName: z.string().min(1),
  lastEvaluatedFireTime: z.string().datetime(),
  /** the expression the watermark was measured on; another one starts afresh */
  cronExpression: z.string().optional(),
  lastMissed: MissedFireSchema.optional(),
});

export type ScheduleState = z.infer<typeof ScheduleStateSchema>;

/**
 * the watermark never moves back, so instances racing to settle the same slot,
 * or a late write of an older slot, cannot reopen a slot already settled; the
 * kept lastMissed is the most recent lost fire, whichever write reports it
 */
export function advanceScheduleState(
  current: ScheduleState | null,
  workflowId: WorkflowId,
  workflowName: string,
  fireTime: Date,
  lastMissed?: MissedFire,
  cronExpression?: string,
): ScheduleState {
  const fireIso = fireTime.toISOString();
  const watermark = current &&
      Date.parse(current.lastEvaluatedFireTime) > fireTime.getTime()
    ? current.lastEvaluatedFireTime
    : fireIso;
  const missed = newerMissed(current?.lastMissed, lastMissed);
  const expression = cronExpression ?? current?.cronExpression;
  return {
    workflowId,
    workflowName,
    lastEvaluatedFireTime: watermark,
    ...(expression ? { cronExpression: expression } : {}),
    ...(missed ? { lastMissed: missed } : {}),
  };
}

function newerMissed(
  current: MissedFire | undefined,
  given: MissedFire | undefined,
): MissedFire | undefined {
  if (!given) return current;
  if (!current) return given;
  return Date.parse(current.fireTime) > Date.parse(given.fireTime)
    ? current
    : given;
}

export interface ScheduleStateRepository {
  get(
    workflowId: WorkflowId,
    options?: { signal?: AbortSignal },
  ): Promise<ScheduleState | null>;
  /** an unreadable record is skipped, so one bad record never hides the rest */
  list(): Promise<ScheduleState[]>;
  /** false when this instance may not write, so nothing was stored */
  save(state: ScheduleState): Promise<boolean>;
}
