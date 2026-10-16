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

/** The longest pause reason accepted. */
export const SCHEDULE_PAUSE_REASON_MAX_LENGTH = 500;

/**
 * A pause reason: free text that serve prints on every skipped fire and
 * records in audit detail, so it is bounded and holds no control
 * characters (a newline would forge a journal line).
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

/** An ISO-8601 UTC time, as a pause's `until` is stored. */
export const SchedulePauseUntilSchema = z.string().datetime();

/**
 * A paused workflow schedule (swamp-club#3522): cron fires of the workflow
 * are skipped while it is in force. It is operational state kept outside
 * the workflow definition, so pausing never edits the workflow. It is keyed
 * by the workflow's id, which a rename keeps; `workflowName` is the name
 * when it was paused, for display. Manual and webhook runs ignore it.
 */
export const SchedulePauseSchema = z.object({
  workflowId: z.string().min(1),
  workflowName: z.string().min(1),
  reason: SchedulePauseReasonSchema.optional(),
  pausedBy: z.string().min(1),
  pausedAt: z.string().datetime(),
  /** The pause lapses at this time; unset pauses until resumed. */
  until: SchedulePauseUntilSchema.optional(),
});

export type SchedulePause = z.infer<typeof SchedulePauseSchema>;

/** The reason a pause whose record cannot be read is reported with. */
export const UNREADABLE_PAUSE_REASON = "unreadable pause record";

/**
 * The pause reported for a record that exists but cannot be read or parsed:
 * open-ended, so the schedule stays paused rather than silently resuming,
 * and resume can still remove it.
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

/**
 * Whether `pause` is in force at `at`: it is until its `until` time, which
 * it then lapses at. A lapsed pause needs no clean-up; the next pause
 * replaces it and a resume removes it.
 */
export function isSchedulePauseActiveAt(
  pause: SchedulePause,
  at: Date,
): boolean {
  if (pause.until === undefined) return true;
  return at.getTime() < Date.parse(pause.until);
}

/** Reads and writes the schedule pauses of one datastore. */
export interface SchedulePauseRepository {
  /**
   * The pause recorded for a workflow, or null when there is none. A record
   * that does not parse is returned as {@link unreadableSchedulePause}, so a
   * corrupt record keeps the schedule paused rather than silently resuming
   * it. A read that fails or exceeds the repository's deadline rejects;
   * `signal` cancels it sooner.
   */
  get(
    workflowId: WorkflowId,
    options?: { signal?: AbortSignal },
  ): Promise<SchedulePause | null>;
  /**
   * Every recorded pause, lapsed ones included. A record that cannot be read
   * is listed as {@link unreadableSchedulePause}, so one bad record never
   * hides the others.
   */
  list(): Promise<SchedulePause[]>;
  /** Records a pause, replacing any pause the workflow already has. */
  save(pause: SchedulePause): Promise<void>;
  /** Removes a workflow's pause; a workflow with none is no error. */
  delete(workflowId: WorkflowId): Promise<void>;
}
