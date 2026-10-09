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
  evaluateApprovalTimeout,
  gateTimeoutSeconds,
} from "./approval_timeout.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";

Deno.test("evaluateApprovalTimeout: reports expired once the deadline lapses", () => {
  const startedAt = new Date("2026-05-29T00:00:00.000Z");
  const now = new Date("2026-05-29T00:00:04.000Z");

  const result = evaluateApprovalTimeout(startedAt, 1, now);

  assertEquals(result, {
    expired: true,
    elapsedSeconds: 4,
    timeoutSeconds: 1,
  });
});

Deno.test("evaluateApprovalTimeout: not expired while inside the window", () => {
  const startedAt = new Date("2026-05-29T00:00:00.000Z");
  const now = new Date("2026-05-29T00:00:00.500Z");

  const result = evaluateApprovalTimeout(startedAt, 1, now);

  assertEquals(result, {
    expired: false,
    elapsedSeconds: 0.5,
    timeoutSeconds: 1,
  });
});

Deno.test("evaluateApprovalTimeout: exactly at the deadline is not yet expired", () => {
  const startedAt = new Date("2026-05-29T00:00:00.000Z");
  const now = new Date("2026-05-29T00:00:01.000Z");

  const result = evaluateApprovalTimeout(startedAt, 1, now);

  assertEquals(result?.expired, false);
});

Deno.test("evaluateApprovalTimeout: undefined when no timeout is configured", () => {
  const startedAt = new Date("2026-05-29T00:00:00.000Z");
  const now = new Date("2026-05-29T01:00:00.000Z");

  assertEquals(evaluateApprovalTimeout(startedAt, undefined, now), undefined);
});

Deno.test("evaluateApprovalTimeout: undefined when the step never started", () => {
  const now = new Date("2026-05-29T01:00:00.000Z");

  assertEquals(evaluateApprovalTimeout(undefined, 1, now), undefined);
});

const gate = (name: string, timeout?: number): Step =>
  Step.create({ name, task: StepTask.manualApproval("Approve?", timeout) });

Deno.test("gateTimeoutSeconds: the timeout the step run holds wins over the definition", () => {
  assertEquals(
    gateTimeoutSeconds(
      { stepName: "gate", approvalTimeout: 60 },
      [gate("gate", 3600)],
    ),
    60,
  );
});

Deno.test("gateTimeoutSeconds: the timeout the step run holds needs no step in the definition", () => {
  assertEquals(
    gateTimeoutSeconds(
      {
        stepName: "approve-prod",
        approvalTimeout: 60,
        forEachTemplate: "approve-${{ self.env }}",
      },
      [],
    ),
    60,
  );
  assertEquals(
    gateTimeoutSeconds({ stepName: "gate", approvalTimeout: 60 }, undefined),
    60,
  );
});

Deno.test("gateTimeoutSeconds: a step run without one takes the timeout of the step of its name", () => {
  assertEquals(
    gateTimeoutSeconds({ stepName: "gate" }, [
      gate("other", 5),
      gate("gate", 9),
    ]),
    9,
  );
});

Deno.test("gateTimeoutSeconds: a forEach iteration without one takes the timeout of the step it was expanded from", () => {
  assertEquals(
    gateTimeoutSeconds(
      { stepName: "approve-prod", forEachTemplate: "approve-${{ self.env }}" },
      [gate("approve-${{ self.env }}", 30)],
    ),
    30,
  );
});

Deno.test("gateTimeoutSeconds: undefined when neither the step run nor the definition has a timeout", () => {
  assertEquals(
    gateTimeoutSeconds({ stepName: "gate" }, [gate("gate")]),
    undefined,
  );
  assertEquals(gateTimeoutSeconds({ stepName: "gate" }, []), undefined);
  assertEquals(gateTimeoutSeconds({ stepName: "gate" }, undefined), undefined);
  assertEquals(gateTimeoutSeconds(undefined, [gate("gate", 5)]), undefined);
});

Deno.test("gateTimeoutSeconds: undefined when the step of that name is not a gate", () => {
  const modelStep = Step.create({
    name: "deploy",
    task: StepTask.model("shell-echo", "execute"),
  });

  assertEquals(
    gateTimeoutSeconds({ stepName: "deploy" }, [modelStep]),
    undefined,
  );
});
