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

import { getLogger } from "@logtape/logtape";
import type { RetentionKind } from "../../domain/retention/retention_policy.ts";
import {
  reapedBefore,
  type RetentionWatermarkRepository,
} from "../../domain/retention/retention_watermark.ts";
import {
  markModelWording,
  modelWording,
} from "../../domain/behavior_wording.ts";
import type { SwampError } from "../errors.ts";

const logger = getLogger(["swamp", "retention"]);

/** Where retention has reaped one kind up to, for a "not found" answer. */
export interface ReapedBefore {
  /** ISO timestamp: items of this kind before it have been reaped. */
  cutoff: string;
  /** The retention timeframe the pass applied (e.g. `14d`). */
  retention: string;
}

/**
 * The watermark retention last wrote for `kind`, or null when there is none,
 * no repository is given, or it cannot be read. Never throws: the answer only
 * enriches a not-found error or a listing.
 */
export async function findReapedBefore(
  watermarks: RetentionWatermarkRepository | undefined,
  kind: RetentionKind,
): Promise<ReapedBefore | null> {
  if (!watermarks) return null;
  try {
    const watermark = await watermarks.get(kind);
    if (!watermark) return null;
    const cutoff = reapedBefore([watermark], kind);
    if (!cutoff) return null;
    return { cutoff: cutoff.toISOString(), retention: watermark.retention };
  } catch (error) {
    logger.debug`Could not read the ${kind} retention watermark: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return null;
  }
}

/** What a not-found message calls the reaped items of each kind. */
const REAPED_ITEMS: Record<RetentionKind, string> = {
  workflowRuns: "runs before {cutoff} have",
  evaluatedSnapshots: "evaluated snapshots before {cutoff} have",
  outputs: "outputs before {cutoff} have",
  data: "data before {cutoff} has",
  audit: "audit records before {cutoff} have",
  bookkeeping: "records before {cutoff} have",
};

/** The `; <items> before <cutoff> have been reaped …` message suffix. */
export function reapedSuffix(
  kind: RetentionKind,
  reaped: ReapedBefore,
): string {
  return `; ${
    REAPED_ITEMS[kind].replace("{cutoff}", reaped.cutoff)
  } been reaped by retention (${reaped.retention})`;
}

/**
 * Adds to a `not_found` error that retention has reaped `kind` before its
 * watermark: the message gains a suffix and the details gain `reapedBefore`
 * and `retention`. Any other error, or no watermark, is returned unchanged.
 * The code stays `not_found`: a run id does not tell whether that run was
 * reaped, only that runs older than the cutoff are gone.
 */
export function decorateNotFound(
  error: SwampError,
  kind: RetentionKind,
  reaped: ReapedBefore | null,
): SwampError {
  if (!reaped || error.code !== "not_found") return error;
  const suffix = reapedSuffix(kind, reaped);
  const baseDetails = typeof error.details === "object" &&
      error.details !== null && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : {};
  const decorated: SwampError = {
    ...error,
    message: `${error.message}${suffix}`,
    details: {
      ...baseDetails,
      reapedBefore: reaped.cutoff,
      retention: reaped.retention,
    },
  };
  const modelText = modelWording(error);
  return modelText === undefined
    ? decorated
    : markModelWording(decorated, `${modelText}${suffix}`);
}

/**
 * Reads the watermark for `kind` and decorates `error` with it, when it is a
 * `not_found`. Never throws.
 */
export async function withReapedHint(
  error: SwampError,
  kind: RetentionKind,
  watermarks: RetentionWatermarkRepository | undefined,
): Promise<SwampError> {
  if (error.code !== "not_found" || !watermarks) return error;
  return decorateNotFound(
    error,
    kind,
    await findReapedBefore(watermarks, kind),
  );
}
