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
import { evaluateApprovalTimeout } from "./approval_timeout.ts";
import type { StepTaskData } from "./step_task.ts";

const gate = (timeout?: number): StepTaskData => ({
  type: "manual_approval",
  prompt: "Approve?",
  timeout,
});

Deno.test("evaluateApprovalTimeout: reports expired once the deadline lapses", () => {
  const startedAt = new Date("2026-05-29T00:00:00.000Z");
  const now = new Date("2026-05-29T00:00:04.000Z");

  const result = evaluateApprovalTimeout(startedAt, gate(1), now);

  assertEquals(result, {
    expired: true,
    elapsedSeconds: 4,
    timeoutSeconds: 1,
  });
});

Deno.test("evaluateApprovalTimeout: not expired while inside the window", () => {
  const startedAt = new Date("2026-05-29T00:00:00.000Z");
  const now = new Date("2026-05-29T00:00:00.500Z");

  const result = evaluateApprovalTimeout(startedAt, gate(1), now);

  assertEquals(result, {
    expired: false,
    elapsedSeconds: 0.5,
    timeoutSeconds: 1,
  });
});

Deno.test("evaluateApprovalTimeout: exactly at the deadline is not yet expired", () => {
  const startedAt = new Date("2026-05-29T00:00:00.000Z");
  const now = new Date("2026-05-29T00:00:01.000Z");

  const result = evaluateApprovalTimeout(startedAt, gate(1), now);

  assertEquals(result?.expired, false);
});

Deno.test("evaluateApprovalTimeout: undefined when no timeout is configured", () => {
  const startedAt = new Date("2026-05-29T00:00:00.000Z");
  const now = new Date("2026-05-29T01:00:00.000Z");

  assertEquals(
    evaluateApprovalTimeout(startedAt, gate(undefined), now),
    undefined,
  );
});

Deno.test("evaluateApprovalTimeout: undefined when the step never started", () => {
  const now = new Date("2026-05-29T01:00:00.000Z");

  assertEquals(evaluateApprovalTimeout(undefined, gate(1), now), undefined);
});

Deno.test("evaluateApprovalTimeout: undefined for non-approval tasks", () => {
  const startedAt = new Date("2026-05-29T00:00:00.000Z");
  const now = new Date("2026-05-29T01:00:00.000Z");
  const modelTask: StepTaskData = {
    type: "model_method",
    modelIdOrName: "shell-echo",
    methodName: "execute",
  };

  assertEquals(evaluateApprovalTimeout(startedAt, modelTask, now), undefined);
});

Deno.test("evaluateApprovalTimeout: undefined when task data is absent", () => {
  const startedAt = new Date("2026-05-29T00:00:00.000Z");
  const now = new Date("2026-05-29T01:00:00.000Z");

  assertEquals(evaluateApprovalTimeout(startedAt, undefined, now), undefined);
});
