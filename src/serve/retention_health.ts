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

import {
  RETENTION_KINDS,
  type RetentionConfig,
  RetentionPolicy,
} from "../domain/retention/retention_policy.ts";
import type { RetentionWatermarkRepository } from "../domain/retention/retention_watermark.ts";
import type {
  HealthSnapshotRetention,
  RetentionHealthProvider,
} from "./health_collector.ts";

/**
 * How long one read of the retention config and watermarks serves health:
 * the watermarks may live on a remote control plane, and a pass runs hourly.
 */
export const RETENTION_HEALTH_TTL_MS = 60_000;

export interface RetentionHealthProviderOptions {
  /** Reads `.swamp.yaml`'s `garbageCollection` block. */
  readConfig: () => Promise<RetentionConfig | undefined>;
  /** Absent where the datastore keeps no watermarks. */
  watermarks?: RetentionWatermarkRepository;
  ttlMs?: number;
  /** Monotonic clock. Defaults to `performance.now`. */
  now?: () => number;
}

/**
 * The retention component of serve's health (swamp-club#3473): each kind's
 * configured retention and last pass, read from the watermarks — never a
 * storage scan — and reused for `ttlMs`. Callers asking at once share one
 * read, and a read that fails is not kept.
 */
export function createRetentionHealthProvider(
  options: RetentionHealthProviderOptions,
): RetentionHealthProvider {
  const now = options.now ?? (() => performance.now());
  const ttlMs = options.ttlMs ?? RETENTION_HEALTH_TTL_MS;
  let cached:
    | { value: Promise<HealthSnapshotRetention>; readAt: number }
    | null = null;

  const read = async (): Promise<HealthSnapshotRetention> => {
    const policy = RetentionPolicy.fromConfig(await options.readConfig());
    const watermarks = options.watermarks
      ? await options.watermarks.getAll()
      : [];
    return {
      automatic: policy.automatic,
      configured: policy.hasAnyRetention,
      kinds: RETENTION_KINDS.map((kind) => {
        const watermark = watermarks.find((w) => w.kind === kind);
        return {
          kind,
          retention: policy.durationFor(kind) ?? null,
          cutoff: watermark?.cutoff ?? null,
          lastPassAt: watermark?.lastPassAt ?? null,
          complete: watermark?.complete ?? null,
        };
      }),
    };
  };

  return {
    retention() {
      const at = now();
      if (cached) {
        const age = at - cached.readAt;
        // A negative age means the clock went backwards: treat it as expired.
        if (age >= 0 && age < ttlMs) return cached.value;
      }
      const entry = {
        value: read().catch((error: unknown) => {
          if (cached === entry) cached = null;
          throw error;
        }),
        readAt: at,
      };
      cached = entry;
      return entry.value;
    },
  };
}
