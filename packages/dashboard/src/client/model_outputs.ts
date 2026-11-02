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

// a preset goes as a duration, so the request does not change as the clock
// moves

import { useRequest } from "./useRequest.ts";
import { useTimeRange } from "./time_range.ts";
import { useRefetchOnRunActivity } from "./run_activity.ts";
import { modelOutputPayloads } from "../lib/model_outputs.ts";

/**
 * an older serve refuses a duration as `validation_failed`, so a preset search
 * refused that way is retried with ISO bounds rounded to the minute; any other
 * error stays on the duration request
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
  useRefetchOnRunActivity(source.refresh);
  return source;
}
