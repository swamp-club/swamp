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

// The `model.output.search` payloads for the dashboard time range. A preset
// goes as a duration, so the request does not change as the clock moves
// (swamp-club#3449); the ISO form is for a serve that only reads ISO times.

import {
  requestTimeBounds,
  resolveTimeRange,
  type TimeRange,
} from "../client/time_range.ts";

/**
 * The search payloads for a range: `current` with the bounds serve reads
 * (a preset as `since: "7d"`), and `legacy` with the ISO bounds at `now`
 * for a serve that only reads ISO times. `legacy` is null when the two
 * would be the same request.
 */
export function modelOutputPayloads(
  range: TimeRange,
  payload: Record<string, unknown>,
  now: number,
): {
  current: Record<string, unknown>;
  legacy: Record<string, unknown> | null;
} {
  const current = { ...payload, ...requestTimeBounds(range) };
  const iso = resolveTimeRange(range, now);
  const legacy = iso.since === current.since && iso.until === current.until
    ? null
    : { ...payload, ...iso };
  return { current, legacy };
}
