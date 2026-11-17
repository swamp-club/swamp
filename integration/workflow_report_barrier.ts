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
import { processRuntimeSlot } from "../src/infrastructure/runtime/process_runtime.ts";

export const BARRIER_REPORT = "@test/barrier";

export interface WorkflowReportBarrier {
  readonly dir: string;
  readonly label: string;
  readonly labels: readonly string[];
  readonly waitMs: number;
}

interface Barrier {
  readonly dir: string;
  readonly label: string;
  readonly labels: readonly string[];
  readonly waitMs: number;
}

// one report for the isolate; each ProcessRuntime runs it as its own label
const barrierOf = processRuntimeSlot<{ current?: Barrier }>(() => ({}));
let registrants = 0;

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
): Disposable {
  const slot = barrierOf();
  slot.current = { dir: barrierDir, label, labels, waitMs };
  if (registrants++ === 0) {
    reportRegistry.invalidateType(BARRIER_REPORT);
    reportRegistry.register(BARRIER_REPORT, {
      description: "waits for the other runs at a barrier",
      scope: "workflow",
      labels: [],
      async execute() {
        const barrier = barrierOf().current;
        if (barrier === undefined) {
          throw new Error("no barrier in this process runtime");
        }
        await Deno.writeTextFile(join(barrier.dir, barrier.label), "");
        const others = barrier.labels.filter((other) =>
          other !== barrier.label
        );
        const arrived = async () =>
          (await Promise.all(
            others.map((other) =>
              Deno.stat(join(barrier.dir, other)).then(() => true, () => false)
            ),
          )).every(Boolean);
        // under the workflow's lock the others cannot arrive, so the wait ends
        await waitFor(arrived, "the other runs at the barrier", {
          timeoutMs: barrier.waitMs,
          intervalMs: 5,
        }).catch(() => {});
        return {
          markdown: `# barrier ${barrier.label}`,
          json: { label: barrier.label },
        };
      },
    });
  }
  let disposed = false;
  return {
    [Symbol.dispose]: () => {
      if (disposed) return;
      disposed = true;
      slot.current = undefined;
      if (--registrants === 0) reportRegistry.invalidateType(BARRIER_REPORT);
    },
  };
}
