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

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { COMMIT_UNREACHABLE_CODE } from "../datastore_v3/commit_log_unit_of_work.ts";
import {
  STEP_START_UNRECORDED_CODE,
  StepStart,
  StepStartUnrecordedError,
} from "./step_start.ts";

const DATA = {
  workflowId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  jobName: "main",
  stepName: "deploy",
  startedAt: 1_700_000_000_000,
};

Deno.test("StepStart.fromYaml: round-trips what toYaml writes", () => {
  const start = StepStart.create(DATA);
  const read = StepStart.fromYaml(start.toYaml());
  assertEquals(read.toData(), DATA);
  assertEquals(read.fileName, start.fileName);
});

Deno.test("StepStart.fromYaml: refuses a field beyond a start's own", () => {
  const yaml = StepStart.create(DATA).toYaml() +
    "approvalDecision: approved\n";
  assertThrows(() => StepStart.fromYaml(yaml));
});

Deno.test("StepStart.create: refuses an empty name or a negative start time", () => {
  assertThrows(() => StepStart.create({ ...DATA, stepName: "" }));
  assertThrows(() => StepStart.create({ ...DATA, startedAt: -1 }));
  assertThrows(() => StepStart.create({ ...DATA, startedAt: 1.5 }));
});

Deno.test("StepStart.fileName: differs for another start of the same step", () => {
  const first = StepStart.create(DATA);
  const again = StepStart.create({ ...DATA, startedAt: DATA.startedAt + 1 });
  assertNotEquals(first.fileName, again.fileName);
  assertEquals(first.fileName, StepStart.create(DATA).fileName);
});

Deno.test("StepStart.fileName: a delimiter in a name cannot make two starts collide", () => {
  const a = StepStart.create({ ...DATA, jobName: "a/b", stepName: "c" });
  const b = StepStart.create({ ...DATA, jobName: "a", stepName: "b/c" });
  assertNotEquals(a.fileName, b.fileName);
});

Deno.test("StepStartUnrecordedError: carries the commit-unreachable code, so the command exits 75", () => {
  assertEquals(STEP_START_UNRECORDED_CODE, COMMIT_UNREACHABLE_CODE);
  const error = new StepStartUnrecordedError(new Error("down"), {
    workflowId: DATA.workflowId,
    workflowName: "deploy-all",
    runId: DATA.runId,
    stepName: "deploy",
    jobName: "main",
  });
  assertEquals(error.code, COMMIT_UNREACHABLE_CODE);
});

Deno.test("StepStartUnrecordedError: names resume when the failed record landed, recover when it did not", () => {
  const error = new StepStartUnrecordedError(new Error("down"), {
    workflowId: DATA.workflowId,
    workflowName: "deploy-all",
    runId: DATA.runId,
    stepName: "deploy",
    jobName: "main",
  });
  const landed = error.withEnd(true).message;
  const notLanded = error.withEnd(false).message;
  assertEquals(
    landed.includes(`swamp workflow resume deploy-all --run ${DATA.runId}`),
    true,
  );
  assertEquals(landed.includes("workflow recover"), false);
  assertEquals(
    notLanded.includes(`swamp workflow recover deploy-all --run ${DATA.runId}`),
    true,
  );
  assertEquals(notLanded.includes("step deploy"), true);
});

Deno.test("StepStartUnrecordedError: a run whose move into running could not be committed says no step ran", () => {
  const error = new StepStartUnrecordedError(new Error("down"), {
    workflowId: DATA.workflowId,
    workflowName: "deploy-all",
    runId: DATA.runId,
  }).withEnd(false);
  assertEquals(error.message.includes("No step of it ran"), true);
  assertEquals(
    error.message.includes(
      `swamp workflow recover deploy-all --run ${DATA.runId}`,
    ),
    true,
  );
  assertEquals(
    error.message.includes("swamp workflow run deploy-all again"),
    true,
  );
});
