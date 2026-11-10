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

import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { reportRegistry } from "../src/domain/reports/report_registry.ts";

export const BARRIER_REPORT = "@test/barrier";

export interface WorkflowReportBarrier {
  readonly dir: string;
  readonly label: string;
  readonly labels: readonly string[];
  readonly waitMs: number;
}

/**
 * a workflow-scope report that waits, up to waitMs, for every other label to
 * arrive before it returns, so overlapping runs save their report data at the
 * same moment unless a lock keeps them apart
 */
export function registerBarrierReport(
  barrierDir: string,
  label: string,
  labels: readonly string[],
  waitMs: number,
): void {
  if (reportRegistry.has(BARRIER_REPORT)) return;
  reportRegistry.register(BARRIER_REPORT, {
    description: "waits for the other runs at a barrier",
    scope: "workflow",
    labels: [],
    async execute() {
      await Deno.writeTextFile(join(barrierDir, label), "");
      const others = labels.filter((other) => other !== label);
      const arrived = async () =>
        (await Promise.all(
          others.map((other) =>
            Deno.stat(join(barrierDir, other)).then(() => true, () => false)
          ),
        )).every(Boolean);
      // under the workflow's lock the others cannot arrive, so the wait ends
      await waitFor(arrived, "the other runs at the barrier", {
        timeoutMs: waitMs,
        intervalMs: 5,
      }).catch(() => {});
      return { markdown: `# barrier ${label}`, json: { label } };
    },
  });
}
