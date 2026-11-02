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
import { hasControlCharacter } from "../control_characters.ts";
import type { WorkflowId } from "./workflow_id.ts";

export const SCHEDULE_PAUSE_REASON_MAX_LENGTH = 500;

/**
 * free text that serve prints on every skipped fire and records in audit
 * detail, so it is bounded and holds no control characters (a newline would
 * forge a journal line)
 */
export const SchedulePauseReasonSchema = z.string()
  .min(1, "Pause reason must not be empty")
  .max(
    SCHEDULE_PAUSE_REASON_MAX_LENGTH,
    `Pause reason must be at most ${SCHEDULE_PAUSE_REASON_MAX_LENGTH} characters`,
  )
  .refine(
    (value) => !hasControlCharacter(value),
    "Pause reason must not contain control characters or newlines",
  );

export const SchedulePauseUntilSchema = z.string().datetime();

/**
 * operational state kept outside the workflow definition, keyed by the workflow
 * id, which a rename keeps; workflowName is only for display
 */
export const SchedulePauseSchema = z.object({
  workflowId: z.string().min(1),
  workflowName: z.string().min(1),
  reason: SchedulePauseReasonSchema.optional(),
  pausedBy: z.string().min(1),
  pausedAt: z.string().datetime(),
  until: SchedulePauseUntilSchema.optional(),
});

export type SchedulePause = z.infer<typeof SchedulePauseSchema>;

export const UNREADABLE_PAUSE_REASON = "unreadable pause record";

/**
 * open-ended, so the schedule stays paused rather than silently resuming, and
 * resume can still remove it
 */
export function unreadableSchedulePause(workflowId: WorkflowId): SchedulePause {
  return {
    workflowId,
    workflowName: workflowId,
    reason: UNREADABLE_PAUSE_REASON,
    pausedBy: "unknown",
    pausedAt: new Date(0).toISOString(),
  };
}

export function isSchedulePauseActiveAt(
  pause: SchedulePause,
  at: Date,
): boolean {
  if (pause.until === undefined) return true;
  return at.getTime() < Date.parse(pause.until);
}

export interface SchedulePauseRepository {
  get(
    workflowId: WorkflowId,
    options?: { signal?: AbortSignal },
  ): Promise<SchedulePause | null>;
  /**
   * an unreadable record is listed as unreadableSchedulePause, so one bad
   * record never hides the others
   */
  list(): Promise<SchedulePause[]>;
  save(pause: SchedulePause): Promise<void>;
  delete(workflowId: WorkflowId): Promise<void>;
}
