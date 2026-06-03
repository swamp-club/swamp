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

import { assert, assertEquals } from "@std/assert";
import {
  computeTier,
  DEFAULT_PEEK_LINES,
  extractBudgetInput,
} from "./budget.ts";
import { createInitialState, treeReducer } from "./state.ts";
import type { WorkflowRunEvent } from "../../../libswamp/mod.ts";

Deno.test("computeTier: full tier when everything fits", () => {
  const result = computeTier(30, {
    runningJobCount: 2,
    activeStepCount: 2,
    waitingJobCount: 3,
  });
  // 50% of 30 = 15, minus separator = 14 available
  // 2 running + 0 expanded + 6 peek (2 * 3) + 3 waiting = 11 lines, fits in 14
  assertEquals(result.tier, "full");
  assertEquals(result.peekLines, DEFAULT_PEEK_LINES);
  assertEquals(result.showWaitingList, true);
  assertEquals(result.expandSteps, true);
  assertEquals(result.maxVisibleRunning, 2);
});

Deno.test("computeTier: no_peek when peek lines overflow", () => {
  const result = computeTier(20, {
    runningJobCount: 3,
    activeStepCount: 3,
    waitingJobCount: 3,
  });
  // 50% of 20 = 10, minus separator = 9 available
  // Full: 3 + 0 + 9 + 3 = 15 > 9
  // No peek: 3 + 0 + 3 = 6 <= 9
  assertEquals(result.tier, "no_peek");
  assertEquals(result.peekLines, 0);
  assertEquals(result.showWaitingList, true);
});

Deno.test("computeTier: compressed_waiting when waiting jobs overflow", () => {
  const result = computeTier(16, {
    runningJobCount: 3,
    activeStepCount: 3,
    waitingJobCount: 5,
  });
  // 50% of 16 = 8, minus separator = 7 available
  // No peek: 3 + 0 + 5 = 8 > 7
  // Compressed waiting: 3 + 0 + 1 = 4 <= 7
  assertEquals(result.tier, "compressed_waiting");
  assertEquals(result.showWaitingList, false);
  assertEquals(result.expandSteps, true);
});

Deno.test("computeTier: compressed_steps when expanded steps overflow", () => {
  const result = computeTier(12, {
    runningJobCount: 2,
    activeStepCount: 6, // 4 extra expanded step lines
    waitingJobCount: 2,
  });
  // 50% of 12 = 6, minus separator = 5 available
  // Compressed waiting: 2 + 4 + 1 = 7 > 5
  // Compressed steps: 2 + 1 = 3 <= 5
  assertEquals(result.tier, "compressed_steps");
  assertEquals(result.expandSteps, false);
});

Deno.test("computeTier: one_line when nothing fits", () => {
  const result = computeTier(3, {
    runningJobCount: 5,
    activeStepCount: 5,
    waitingJobCount: 3,
  });
  assertEquals(result.tier, "one_line");
  assertEquals(result.maxVisibleRunning, 0);
});

Deno.test("computeTier: handles zero running jobs", () => {
  const result = computeTier(20, {
    runningJobCount: 0,
    activeStepCount: 0,
    waitingJobCount: 3,
  });
  assertEquals(result.tier, "full");
  assertEquals(result.showWaitingList, true);
});

Deno.test("computeTier: handles all jobs running, none waiting", () => {
  // 50% of 20 = 10, minus separator = 9 available
  // Full: 3 + 0 + 9 + 0 = 12 > 9 → no_peek: 3 + 0 + 0 = 3 <= 9
  const result = computeTier(20, {
    runningJobCount: 3,
    activeStepCount: 3,
    waitingJobCount: 0,
  });
  assertEquals(result.tier, "no_peek");
});

Deno.test("computeTier: parallel steps expand in full tier", () => {
  const result = computeTier(40, {
    runningJobCount: 1,
    activeStepCount: 3, // 2 extra sub-lines
    waitingJobCount: 0,
  });
  // 50% of 40 = 20, minus separator = 19 available
  // 1 + 2 + 9 + 0 = 12 <= 19
  assertEquals(result.tier, "full");
  assertEquals(result.expandSteps, true);
});

Deno.test("computeTier: very small terminal degrades gracefully", () => {
  const result = computeTier(2, {
    runningJobCount: 1,
    activeStepCount: 1,
    waitingJobCount: 0,
  });
  assertEquals(result.tier, "one_line");
});

Deno.test("computeTier: 50+ running jobs caps visible count", () => {
  // Typical terminal: 40 rows
  const result = computeTier(40, {
    runningJobCount: 55,
    activeStepCount: 55,
    waitingJobCount: 10,
  });
  // 50% of 40 = 20, minus separator = 19 available
  // compressed_steps: 55 + 1 = 56 > 19 — too many
  // Capped: maxVisibleRunning should fit within budget
  assertEquals(result.tier, "compressed_steps");
  assert(result.maxVisibleRunning <= 19);
  assert(result.maxVisibleRunning > 0);
  // Should leave room for "… N more running" + "… N waiting" lines
  assert(result.maxVisibleRunning <= 17); // 19 - 1 waiting - 1 more running
});

Deno.test("computeTier: active zone never exceeds 50% of terminal", () => {
  // Even with a large terminal, available should be capped
  const result = computeTier(100, {
    runningJobCount: 60,
    activeStepCount: 60,
    waitingJobCount: 20,
  });
  // 50% of 100 = 50, minus separator = 49 available
  // compressed_steps: 60 + 1 = 61 > 49
  assertEquals(result.tier, "compressed_steps");
  // maxVisibleRunning + hidden summary + waiting summary <= 49
  assert(result.maxVisibleRunning <= 47);
});

// --- extractBudgetInput tests ---

function reduceEvents(
  ...events: WorkflowRunEvent[]
) {
  let state = createInitialState("test");
  for (const e of events) {
    state = treeReducer(state, e);
  }
  return state;
}

Deno.test("extractBudgetInput: counts running, waiting, and blocked jobs", () => {
  const state = reduceEvents(
    {
      kind: "started",
      runId: "r1",
      workflowName: "test",
      jobs: [
        { id: "a", stepCount: 1, dependsOn: [] },
        { id: "b", stepCount: 1, dependsOn: [] },
        { id: "c", stepCount: 1, dependsOn: ["a"] },
      ],
    },
    { kind: "job_started", jobId: "a" },
  );

  const input = extractBudgetInput(state);
  assertEquals(input.runningJobCount, 1);
  assertEquals(input.waitingJobCount, 2); // b=waiting, c=blocked
  assertEquals(input.activeStepCount, 0); // no steps started yet
});

Deno.test("extractBudgetInput: counts active steps across running jobs", () => {
  const state = reduceEvents(
    {
      kind: "started",
      runId: "r1",
      workflowName: "test",
      jobs: [
        { id: "a", stepCount: 2, dependsOn: [] },
        { id: "b", stepCount: 1, dependsOn: [] },
      ],
    },
    { kind: "job_started", jobId: "a" },
    { kind: "step_started", jobId: "a", stepId: "s1" },
    { kind: "step_started", jobId: "a", stepId: "s2" },
    { kind: "job_started", jobId: "b" },
    { kind: "step_started", jobId: "b", stepId: "s1" },
  );

  const input = extractBudgetInput(state);
  assertEquals(input.runningJobCount, 2);
  assertEquals(input.activeStepCount, 3);
  assertEquals(input.waitingJobCount, 0);
});

Deno.test("extractBudgetInput: empty state returns zeros", () => {
  const state = createInitialState("test");
  const input = extractBudgetInput(state);
  assertEquals(input.runningJobCount, 0);
  assertEquals(input.activeStepCount, 0);
  assertEquals(input.waitingJobCount, 0);
});
