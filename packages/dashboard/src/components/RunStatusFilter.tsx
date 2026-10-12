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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import {
  RUN_STATUSES,
  type RunStatusFilter as StatusValue,
} from "../lib/run_filters.ts";
import { formatCompactCount, formatCount } from "../lib/format.ts";

const LABELS: Record<StatusValue, string> = {
  "": "All",
  succeeded: "Succeeded",
  failed: "Failed",
  running: "Running",
  suspended: "Suspended",
  cancelled: "Cancelled",
};

const OPTIONS: readonly StatusValue[] = ["", ...RUN_STATUSES];

/**
 * Segmented status filter for run lists, with the number of runs in each
 * status when known (counts come from the run summary, so they span every
 * page, not just the one on screen).
 */
export function RunStatusFilter(
  { value, onChange, counts }: {
    value: StatusValue;
    onChange: (next: StatusValue) => void;
    counts: Readonly<Record<StatusValue, number>> | null;
  },
) {
  return (
    <div className="time-range status-filter" role="group" aria-label="Status">
      {OPTIONS.map((s) => {
        const count = counts?.[s];
        return (
          <button
            type="button"
            key={s || "all"}
            className={value === s ? "active" : ""}
            aria-pressed={value === s}
            onClick={() => onChange(s)}
            title={count !== undefined
              ? `${formatCount(count)} ${s || "runs"}`
              : undefined}
          >
            {s && (
              <span className={`status-dot-sm s-${s}`} aria-hidden="true" />
            )}
            {LABELS[s]}
            {count !== undefined && (
              <span className="status-count">{formatCompactCount(count)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
