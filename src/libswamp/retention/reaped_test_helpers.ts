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

import type { RetentionKind } from "../../domain/retention/retention_policy.ts";
import type {
  RetentionWatermark,
  RetentionWatermarkRepository,
} from "../../domain/retention/retention_watermark.ts";

/** The cutoff the fake watermark repository reports. */
export const FAKE_REAPED_CUTOFF = "2026-10-01T00:00:00.000Z";

/**
 * An in-memory watermark repository holding one complete watermark for each
 * of `kinds`, cut off at {@link FAKE_REAPED_CUTOFF} under `14d`.
 */
export function fakeWatermarks(
  kinds: readonly RetentionKind[],
): RetentionWatermarkRepository {
  const stored: RetentionWatermark[] = kinds.map((kind) => ({
    kind,
    cutoff: FAKE_REAPED_CUTOFF,
    retention: "14d",
    lastPassAt: "2026-10-15T00:00:00.000Z",
    complete: true,
    deleted: 3,
    bytesReclaimed: 1024,
  }));
  return {
    get: (kind) => Promise.resolve(stored.find((w) => w.kind === kind) ?? null),
    getAll: () => Promise.resolve([...stored]),
    put: () => Promise.resolve(),
    claimHourlyPass: () => Promise.resolve(true),
  };
}

/** A watermark repository whose every read rejects. */
export function failingWatermarks(): RetentionWatermarkRepository {
  const fail = () => Promise.reject(new Error("datastore unavailable"));
  return {
    get: fail,
    getAll: fail,
    put: fail,
    claimHourlyPass: fail,
  };
}
