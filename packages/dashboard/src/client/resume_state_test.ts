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
  activeRunIds,
  activeRunsKey,
  resumeStateFor,
  shouldRefetchRuns,
} from "./resume_state.ts";

const base = { runId: "run-1", workflowName: "gated" };

Deno.test("resumeStateFor: offers the resume command for an approved run", () => {
  assertEquals(
    resumeStateFor({ ...base, status: "suspended", awaitingResume: true }),
    {
      command: "swamp workflow resume gated --run run-1",
      needsInputs: false,
    },
  );
});

Deno.test("resumeStateFor: adds an --input placeholder when the workflow declares inputs", () => {
  assertEquals(
    resumeStateFor({
      ...base,
      status: "suspended",
      awaitingResume: true,
      workflowHasInputs: true,
    }),
    {
      command: "swamp workflow resume gated --run run-1 --input <key>=<value>",
      needsInputs: true,
    },
  );
});

Deno.test("resumeStateFor: nothing to resume while a gate still waits", () => {
  assertEquals(resumeStateFor({ ...base, status: "suspended" }), null);
});

Deno.test("resumeStateFor: nothing to resume for a run that is not suspended", () => {
  assertEquals(
    resumeStateFor({ ...base, status: "running", awaitingResume: true }),
    null,
  );
});

Deno.test("activeRunIds: empty without a health snapshot", () => {
  assertEquals(activeRunIds(undefined).size, 0);
  assertEquals(activeRunIds([]).size, 0);
});

Deno.test("activeRunIds: lists the runs serve is driving", () => {
  const ids = activeRunIds([{ runId: "run-1" }, { runId: "run-2" }]);
  assertEquals(ids.has("run-1"), true);
  assertEquals(ids.has("run-3"), false);
});

Deno.test("activeRunsKey: ignores order and fields other than the run id", () => {
  assertEquals(
    activeRunsKey([
      { runId: "run-2", durationMs: 10 } as { runId: string },
      { runId: "run-1" },
    ]),
    activeRunsKey([
      { runId: "run-1" },
      { runId: "run-2", durationMs: 5010 } as { runId: string },
    ]),
  );
  assertEquals(activeRunsKey(undefined), "");
});

Deno.test("shouldRefetchRuns: refetches when a run starts or stops", () => {
  const rows = [{ runId: "run-1", status: "running" }];
  assertEquals(shouldRefetchRuns("", [{ runId: "run-1" }], rows), true);
  assertEquals(shouldRefetchRuns("run-1", [], rows), true);
});

Deno.test("shouldRefetchRuns: refetches while a driven run still reads suspended", () => {
  assertEquals(
    shouldRefetchRuns("run-1", [{ runId: "run-1" }], [
      { runId: "run-1", status: "suspended" },
    ]),
    true,
  );
});

Deno.test("shouldRefetchRuns: no refetch when nothing changed", () => {
  assertEquals(
    shouldRefetchRuns("run-1", [{ runId: "run-1" }], [
      { runId: "run-1", status: "running" },
      { runId: "run-2", status: "suspended" },
    ]),
    false,
  );
  assertEquals(shouldRefetchRuns("", undefined, []), false);
});
