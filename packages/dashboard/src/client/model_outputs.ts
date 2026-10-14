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

// Serve's `model.output.search` over the dashboard time range, for the
// Models page and a model's page. A preset goes as a duration, so the
// request does not change as the clock moves (swamp-club#3449).

import { useRequest } from "./useRequest.ts";
import { useTimeRange } from "./time_range.ts";
import { useRefetchOnRunActivity } from "./run_activity.ts";
import { modelOutputPayloads } from "../lib/model_outputs.ts";

/**
 * `model.output.search` with `payload` over the dashboard time range,
 * fetched again when serve starts or finishes a run or the tab comes back
 * into view. An older serve refuses a duration as `validation_failed`, so a
 * preset search refused that way is retried with the ISO bounds, which move
 * with the clock (rounded to the minute). Any other error stays on the
 * duration request, so a retry or a refetch asks for the duration again.
 */
export function useModelOutputSearch(
  payload: Record<string, unknown>,
): ReturnType<typeof useRequest> {
  const { range } = useTimeRange();
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  const { current, legacy } = modelOutputPayloads(range, payload, minute);
  const now = useRequest("model.output.search", current);
  const useLegacy = legacy !== null &&
    now.errorInfo?.reason === "validation_failed";
  const older = useRequest("model.output.search", legacy ?? undefined, {
    enabled: useLegacy,
  });
  const source = useLegacy ? older : now;
  useRefetchOnRunActivity(source.refetch);
  return source;
}
