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
  extractFirstStepError,
  type WorkflowRunView,
} from "./workflow_run_view.ts";

function makeRun(
  jobs: WorkflowRunView["jobs"],
): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "test-workflow",
    status: "failed",
    jobs,
  };
}

Deno.test("extractFirstStepError: returns error from first failed step", () => {
  const run = makeRun([{
    name: "job1",
    status: "failed",
    steps: [
      { name: "step1", status: "succeeded" },
      { name: "step2", status: "failed", error: "CEL type mismatch" },
    ],
  }]);
  assertEquals(extractFirstStepError(run), "CEL type mismatch");
});

Deno.test("extractFirstStepError: skips allowed failures", () => {
  const run = makeRun([{
    name: "job1",
    status: "failed",
    steps: [
      {
        name: "step1",
        status: "failed",
        error: "allowed error",
        allowedFailure: true,
      },
      { name: "step2", status: "failed", error: "real error" },
    ],
  }]);
  assertEquals(extractFirstStepError(run), "real error");
});

Deno.test("extractFirstStepError: searches across jobs", () => {
  const run = makeRun([
    {
      name: "job1",
      status: "succeeded",
      steps: [{ name: "step1", status: "succeeded" }],
    },
    {
      name: "job2",
      status: "failed",
      steps: [
        { name: "step1", status: "failed", error: "second job error" },
      ],
    },
  ]);
  assertEquals(extractFirstStepError(run), "second job error");
});

Deno.test("extractFirstStepError: returns unknown error when no failed steps", () => {
  const run = makeRun([{
    name: "job1",
    status: "failed",
    steps: [{ name: "step1", status: "succeeded" }],
  }]);
  assertEquals(extractFirstStepError(run), "unknown error");
});

Deno.test("extractFirstStepError: returns unknown error when failed step has no error string", () => {
  const run = makeRun([{
    name: "job1",
    status: "failed",
    steps: [{ name: "step1", status: "failed" }],
  }]);
  assertEquals(extractFirstStepError(run), "unknown error");
});

Deno.test("extractFirstStepError: returns unknown error when all failures are allowed", () => {
  const run = makeRun([{
    name: "job1",
    status: "failed",
    steps: [{
      name: "step1",
      status: "failed",
      error: "allowed",
      allowedFailure: true,
    }],
  }]);
  assertEquals(extractFirstStepError(run), "unknown error");
});
