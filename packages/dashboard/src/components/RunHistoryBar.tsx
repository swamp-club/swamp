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

import { statusColor } from "./StatusDot";

export interface RunHistoryEntry {
  runId: string;
  status: string;
  startedAt?: string;
}

interface RunHistoryBarProps {
  /** Runs newest first, as `workflow.run.search` returns them. */
  runs: RunHistoryEntry[];
  /** Number of segments; slots without a run render empty. */
  slots?: number;
}

/**
 * One segment per recent run, oldest on the left and newest on the right,
 * colored by status.
 */
export function RunHistoryBar({ runs, slots = 20 }: RunHistoryBarProps) {
  const shown = runs.slice(0, slots).reverse();
  const empty = slots - shown.length;
  const label = runs.length === 0
    ? "No runs yet"
    : `Last ${shown.length} ${shown.length === 1 ? "run" : "runs"}`;

  return (
    <div className="run-history" role="img" aria-label={label} title={label}>
      {Array.from(
        { length: empty },
        (_, i) => <span key={`empty-${i}`} className="run-history-seg empty" />,
      )}
      {shown.map((run) => (
        <span
          key={run.runId}
          className="run-history-seg"
          style={{ background: statusColor(run.status) }}
          title={run.startedAt
            ? `${run.status} · ${new Date(run.startedAt).toLocaleString()}`
            : run.status}
        />
      ))}
    </div>
  );
}
