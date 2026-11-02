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
 * one record per kind, overwritten each pass; complete is false when a pass
 * stopped early, so items before cutoff may remain until the next pass finishes
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

export type RetentionTrigger = "serve" | "cli";

export interface RetentionWatermarkRepository {
  get(kind: RetentionKind): Promise<RetentionWatermark | null>;
  getAll(): Promise<RetentionWatermark[]>;
  put(watermark: RetentionWatermark): Promise<void>;
  /**
   * serve and CLI claim separately so a time-budgeted CLI pass cannot use up
   * the hour of serve's pass; stores without atomic create-if-absent always
   * return true
   */
  claimHourlyPass(
    hourStart: Date,
    owner: string,
    trigger: RetentionTrigger,
  ): Promise<boolean>;
}

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

export function reapedBefore(
  watermarks: readonly RetentionWatermark[],
  kind: RetentionKind,
): Date | null {
  const watermark = watermarks.find((w) => w.kind === kind);
  if (!watermark) return null;
  const cutoff = Date.parse(watermark.cutoff);
  return Number.isNaN(cutoff) ? null : new Date(cutoff);
}
