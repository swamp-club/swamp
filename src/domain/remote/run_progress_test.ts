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

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  currentRunProgress,
  registerTrackedRunSource,
  RunProgress,
  runProgressSnapshots,
  trackedRunCounts,
  trackWorkflowProgress,
} from "./run_progress.ts";

Deno.test("trackWorkflowProgress: keeps finalization visible after completed and isolates the consumer", async () => {
  const runId = crypto.randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function* run() {
    yield { kind: "started", runId, workflowName: "workflow" };
    assertEquals(currentRunProgress()?.identity.runId, runId);
    currentRunProgress()?.enter("finalizing");
    yield { kind: "completed" };
    entered.resolve();
    await release.promise;
  }
  const stream = trackWorkflowProgress(run());
  let finishing: ReturnType<typeof stream.next> | undefined;
  try {
    await stream.next();
    assertEquals(currentRunProgress(), undefined);
    assertEquals(runProgressSnapshots(runId)[0].scope, "run");
    await stream.next();
    finishing = stream.next();
    await entered.promise;
    assertEquals(runProgressSnapshots(runId)[0].phase, "finalizing");
    release.resolve();
    await finishing;
    assertEquals(runProgressSnapshots(runId), []);
  } finally {
    release.resolve();
    if (finishing) await finishing;
    await stream.return(undefined);
  }
});

Deno.test("trackWorkflowProgress: abandonment runs cleanup under its own scope and removes the observation", async () => {
  const runId = crypto.randomUUID();
  let cleanupRun: string | undefined;
  async function* run() {
    try {
      yield { kind: "started", runId, workflowName: "workflow" };
    } finally {
      cleanupRun = currentRunProgress()?.identity.runId;
    }
  }
  const stream = trackWorkflowProgress(run());
  await stream.next();
  await stream.return(undefined);
  assertEquals(cleanupRun, runId);
  assertEquals(runProgressSnapshots(runId), []);
  assertEquals(currentRunProgress(), undefined);
});

Deno.test("trackedRunCounts: unavailable sources are explicit and removal is idempotent", () => {
  const remove = registerTrackedRunSource(() => {
    throw new Error("unavailable");
  });
  try {
    assertEquals(trackedRunCounts().unavailableSources, 1);
  } finally {
    remove();
    remove();
  }
  assertEquals(trackedRunCounts().unavailableSources, 0);
});

Deno.test("RunProgress: state duration is monotonic and repeated snapshots do not imply progress", () => {
  let now = 10;
  let wall = "2026-10-22T10:00:00Z";
  const progress = new RunProgress(
    { runId: "run", workflow: "wf", job: "job", step: "step" },
    () => now,
    () => wall,
  );
  now = 20;
  const execute = progress.enter("executing");
  now = 30;
  wall = "2026-10-21T10:00:00Z";
  assertEquals(progress.snapshot().phaseElapsedMs, 10);
  assertEquals(progress.snapshot().lastProgressAt, "2026-10-22T10:00:00Z");
  const persist = progress.enter("persisting");
  now = 40;
  persist();
  assertEquals(progress.snapshot().phase, "executing");
  assertEquals(progress.snapshot().phaseElapsedMs, 0);
  execute();
  execute();
  assertEquals(progress.snapshot().phase, "queued");
});

Deno.test("RunProgress: overlapping operations can settle out of order without replacing the active phase", () => {
  const progress = new RunProgress({
    runId: "run",
    workflow: "wf",
    job: "job",
    step: "step",
  });
  const a = progress.enter("executing");
  const b = progress.enter("persisting");
  a();
  assertEquals(progress.snapshot().phase, "persisting");
  b();
  assertEquals(progress.snapshot().phase, "queued");
});

Deno.test("RunProgress: arbitrary out-of-order and duplicate completions preserve the newest active phase", () => {
  fc.assert(
    fc.property(
      fc.array(fc.nat({ max: 20 }), { maxLength: 100 }),
      (completions) => {
        const progress = new RunProgress({
          runId: "run",
          workflow: "wf",
          job: "job",
          step: "step",
        });
        const phases = [
          "executing",
          "persisting",
          "waiting_for_worker",
        ] as const;
        const entries = Array.from({ length: 21 }, (_, index) => ({
          phase: phases[index % phases.length],
          end: progress.enter(phases[index % phases.length]),
          done: false,
        }));
        for (const index of completions) {
          entries[index].end();
          entries[index].done = true;
          assertEquals(
            progress.snapshot().phase,
            entries.findLast((entry) => !entry.done)?.phase ?? "queued",
          );
        }
        for (const entry of entries) entry.end();
        assertEquals(progress.snapshot().phase, "queued");
      },
    ),
  );
});
