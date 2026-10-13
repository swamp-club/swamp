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

import type { ReactNode } from "react";

export type StatTone = "neutral" | "success" | "danger" | "warning" | "running";

export interface Stat {
  label: string;
  value: ReactNode;
  tone?: StatTone;
  /** Full value or explanation on hover. */
  title?: string;
}

/**
 * The header's summary: a row of compact stat pills ("134 workflows",
 * "64,000 passed", …). Zero-valued danger/warning pills stay neutral so
 * red only appears when something is actually wrong.
 */
export function StatPills(
  { stats, label = "Summary" }: { stats: Stat[]; label?: string },
) {
  return (
    <dl className="stat-pills" aria-label={label}>
      {stats.map((s) => (
        <div
          key={s.label}
          className={`stat-pill tone-${s.tone ?? "neutral"}`}
          title={s.title}
        >
          <dd>{s.value}</dd>
          <dt>{s.label}</dt>
        </div>
      ))}
    </dl>
  );
}
