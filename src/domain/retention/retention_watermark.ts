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
import { RETENTION_KINDS, type RetentionKind } from "./retention_policy.ts";

/**
 * One record per kind, overwritten on each retention pass: everything of
 * this kind before `cutoff` was reaped by retention (`retention`), as of
 * `lastPassAt`. Constant size, so it never grows (swamp-club#3473).
 * `complete` is false when the pass stopped early (time budget, shutdown,
 * busy serve); items before the cutoff may then still exist until the next
 * pass finishes.
 */
export const RetentionWatermarkSchema = z.object({
  kind: z.enum(RETENTION_KINDS),
  cutoff: z.string().datetime(),
  retention: z.string(),
  lastPassAt: z.string().datetime(),
  complete: z.boolean(),
  deleted: z.number().int().nonnegative(),
  bytesReclaimed: z.number().int().nonnegative(),
});

export type RetentionWatermark = z.infer<typeof RetentionWatermarkSchema>;

/** What started a retention pass; each claims its own hour. */
export type RetentionTrigger = "serve" | "cli";

/** Reads and writes the per-kind watermarks of one datastore. */
export interface RetentionWatermarkRepository {
  get(kind: RetentionKind): Promise<RetentionWatermark | null>;
  getAll(): Promise<RetentionWatermark[]>;
  put(watermark: RetentionWatermark): Promise<void>;
  /**
   * Claims the pass for the hour starting at `hourStart` so only one of
   * several processes of the same `trigger` sharing the datastore runs it.
   * Returns false when another process already claimed it. Serve and the
   * CLI claim separately: a CLI pass is capped by its time budget, so it
   * must never use up the hour of serve's pass, which has none. Stores
   * without an atomic create-if-absent always return true.
   */
  claimHourlyPass(
    hourStart: Date,
    owner: string,
    trigger: RetentionTrigger,
  ): Promise<boolean>;
}

/**
 * The newest pass time across all kinds, used to run a CLI pass at most
 * once per hour; null when no pass has run.
 */
export function lastPassAt(
  watermarks: readonly RetentionWatermark[],
): Date | null {
  let newest: number | null = null;
  for (const watermark of watermarks) {
    const at = Date.parse(watermark.lastPassAt);
    if (Number.isNaN(at)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest === null ? null : new Date(newest);
}

/**
 * The cutoff an item of this kind would have been reaped under, or null when
 * the kind has no watermark. Used to answer "reaped" instead of "not found".
 */
export function reapedBefore(
  watermarks: readonly RetentionWatermark[],
  kind: RetentionKind,
): Date | null {
  const watermark = watermarks.find((w) => w.kind === kind);
  if (!watermark) return null;
  const cutoff = Date.parse(watermark.cutoff);
  return Number.isNaN(cutoff) ? null : new Date(cutoff);
}
