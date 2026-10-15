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
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import {
  RETENTION_KINDS,
  type RetentionKind,
} from "../../domain/retention/retention_policy.ts";
import {
  type RetentionWatermark,
  type RetentionWatermarkRepository,
  RetentionWatermarkSchema,
} from "../../domain/retention/retention_watermark.ts";

const logger = getLogger(["swamp", "persistence", "retention-watermark"]);

const WATERMARK_PREFIX = "retention/watermarks/";
// Claim keys are the hour's epoch milliseconds: an ISO time has colons,
// which a Windows filesystem control plane cannot hold.
const CLAIM_PREFIX = "retention/claims";

/** Hourly claims older than this are removed when a new one is taken. */
const CLAIM_KEEP_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Keeps the per-kind retention watermarks in the datastore's control plane
 * (`_control/retention/` of the repository's namespace), so every process
 * sharing the datastore sees the same records: serve replicas and CLI
 * checkouts alike.
 */
export class ControlPlaneRetentionWatermarkRepository
  implements RetentionWatermarkRepository {
  constructor(private readonly store: ControlPlaneStore) {}

  async get(kind: RetentionKind): Promise<RetentionWatermark | null> {
    const bytes = await this.store.get(`${WATERMARK_PREFIX}${kind}`);
    if (bytes === null) return null;
    return parseWatermark(bytes, kind);
  }

  async getAll(): Promise<RetentionWatermark[]> {
    const watermarks: RetentionWatermark[] = [];
    for (const kind of RETENTION_KINDS) {
      const watermark = await this.get(kind);
      if (watermark) watermarks.push(watermark);
    }
    return watermarks;
  }

  async put(watermark: RetentionWatermark): Promise<void> {
    const valid = RetentionWatermarkSchema.parse(watermark);
    await this.store.put(
      `${WATERMARK_PREFIX}${valid.kind}`,
      encoder.encode(JSON.stringify(valid)),
    );
  }

  async claimHourlyPass(hourStart: Date, owner: string): Promise<boolean> {
    if (!this.store.putIfAbsent) return true;
    const key = `${CLAIM_PREFIX}/${hourStart.getTime()}`;
    const claimed = await this.store.putIfAbsent(
      key,
      encoder.encode(
        JSON.stringify({ owner, claimedAt: new Date().toISOString() }),
      ),
    );
    if (claimed) await this.pruneClaims(hourStart);
    return claimed;
  }

  /** Removes claims a day older than the one just taken, so they never pile up. */
  private async pruneClaims(hourStart: Date): Promise<void> {
    const keys = await this.store.list(CLAIM_PREFIX);
    for (const key of keys) {
      const at = Number(key.slice(key.lastIndexOf("/") + 1));
      if (!Number.isSafeInteger(at)) continue;
      if (hourStart.getTime() - at <= CLAIM_KEEP_MS) continue;
      try {
        await this.store.delete(key);
      } catch (error) {
        logger.debug`Could not remove old retention claim ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
  }
}

function parseWatermark(
  bytes: Uint8Array,
  kind: RetentionKind,
): RetentionWatermark | null {
  try {
    const parsed = RetentionWatermarkSchema.safeParse(
      JSON.parse(decoder.decode(bytes)),
    );
    if (parsed.success && parsed.data.kind === kind) return parsed.data;
  } catch {
    // Falls through: an unreadable record is treated as absent.
  }
  logger.warn`Ignoring an unreadable retention watermark for ${kind}`;
  return null;
}

/**
 * The start of the UTC hour containing `now`, the key an hourly pass is
 * claimed under.
 */
export function hourStartOf(now: Date): Date {
  const hour = new Date(now.getTime());
  hour.setUTCMinutes(0, 0, 0);
  return hour;
}
