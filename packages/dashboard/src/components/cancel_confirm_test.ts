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
import {
  type CancelEvent,
  cancelOutcome,
  type CancelStep,
  nextCancelStep,
} from "./cancel_confirm.ts";

Deno.test("nextCancelStep: a cancel is sent only after Cancel then Confirm", () => {
  assertEquals(nextCancelStep("idle", "ask"), "confirming");
  assertEquals(nextCancelStep("confirming", "confirm"), "cancelling");
  assertEquals(nextCancelStep("idle", "confirm"), "idle");
});

Deno.test("nextCancelStep: Keep backs out of the confirm", () => {
  assertEquals(nextCancelStep("confirming", "keep"), "idle");
});

Deno.test("nextCancelStep: only the request ending leaves cancelling", () => {
  const clicks: CancelEvent[] = ["ask", "keep", "confirm"];
  for (const event of clicks) {
    assertEquals(nextCancelStep("cancelling", event), "cancelling");
  }
  assertEquals(nextCancelStep("cancelling", "settled"), "idle");
});

Deno.test("nextCancelStep: a stray settled changes nothing outside cancelling", () => {
  const steps: CancelStep[] = ["idle", "confirming"];
  for (const step of steps) {
    assertEquals(nextCancelStep(step, "settled"), step);
  }
});

Deno.test("cancelOutcome: a plain cancel reports the run cancelled", () => {
  assertEquals(
    cancelOutcome("deploy", {
      data: { runId: "run-1", workflowName: "deploy", status: "cancelled" },
    }),
    { message: "deploy: run cancelled", nestedRunsLeft: [] },
  );
});

Deno.test("cancelOutcome: lists the nested runs a cancel left suspended", () => {
  const child = {
    workflowId: "wf-2",
    workflowName: "child",
    runId: "run-2",
    jobName: "main",
    stepName: "call-child",
    cancelCommand: "swamp workflow cancel --run run-2 --server <url>",
  };
  assertEquals(
    cancelOutcome("parent", {
      data: { runId: "run-1", detachedNestedRuns: [child] },
    }),
    {
      message: "parent: run cancelled — 1 nested run is still suspended",
      nestedRunsLeft: [{
        workflowName: "child",
        runId: "run-2",
        cancelCommand: "swamp workflow cancel --run run-2 --server <url>",
      }],
    },
  );
});

Deno.test("cancelOutcome: counts several nested runs and skips malformed entries", () => {
  const run = (n: number) => ({
    workflowName: `child-${n}`,
    runId: `run-${n}`,
    cancelCommand: `swamp workflow cancel --run run-${n}`,
  });
  const outcome = cancelOutcome("parent", {
    data: { detachedNestedRuns: [run(1), null, { runId: "x" }, run(2)] },
  });
  assertEquals(
    outcome.message,
    "parent: run cancelled — 2 nested runs are still suspended",
  );
  assertEquals(outcome.nestedRunsLeft, [run(1), run(2)]);
});

Deno.test("cancelOutcome: a reply with no data still reports the cancel", () => {
  for (const reply of [null, undefined, {}, { data: null }]) {
    assertEquals(cancelOutcome("deploy", reply), {
      message: "deploy: run cancelled",
      nestedRunsLeft: [],
    });
  }
});
