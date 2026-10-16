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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  renderWorkflowScheduleList,
  renderWorkflowSchedulePause,
  renderWorkflowScheduleResume,
} from "./workflow_schedule.ts";

await initializeLogging({});

function capture(fn: () => void): string {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return stripAnsiCode(output.join("\n"));
}

const PAUSE = {
  workflowId: "11111111-1111-4111-8111-111111111111",
  workflowName: "nightly-gc",
  schedule: "0 3 * * *",
  reason: "stalling serve",
  pausedBy: "user:ops",
  pausedAt: "2026-10-16T12:00:00.000Z",
  until: "2026-10-16T14:00:00.000Z",
  replaced: false,
};

Deno.test("renderWorkflowSchedulePause: json mode prints the pause", () => {
  const parsed = JSON.parse(
    capture(() => renderWorkflowSchedulePause("json", PAUSE)),
  );
  assertEquals(parsed, PAUSE);
});

Deno.test("renderWorkflowSchedulePause: log mode names the workflow, reason and until", () => {
  const text = capture(() => renderWorkflowSchedulePause("log", PAUSE));
  assertStringIncludes(text, "Paused schedule: nightly-gc (0 3 * * *)");
  assertStringIncludes(text, "Reason: stalling serve");
  assertStringIncludes(text, "Until: 2026-10-16T14:00:00.000Z");
  assertStringIncludes(text, "manual and webhook runs still run");
});

Deno.test("renderWorkflowSchedulePause: log mode escapes control characters", () => {
  const text = capture(() =>
    renderWorkflowSchedulePause("log", { ...PAUSE, reason: "a\x1b[31mb" })
  );
  assertStringIncludes(text, "a\\x1b[31mb");
});

Deno.test("renderWorkflowScheduleResume: both modes, paused and not", () => {
  const data = {
    workflowId: PAUSE.workflowId,
    workflowName: "nightly-gc",
    wasPaused: true,
  };
  assertEquals(
    JSON.parse(capture(() => renderWorkflowScheduleResume("json", data))),
    data,
  );
  assertStringIncludes(
    capture(() => renderWorkflowScheduleResume("log", data)),
    "Resumed schedule: nightly-gc",
  );
  assertStringIncludes(
    capture(() =>
      renderWorkflowScheduleResume("log", { ...data, wasPaused: false })
    ),
    "Not paused: nightly-gc",
  );
});

Deno.test("renderWorkflowScheduleList: log mode shows paused, active and orphaned entries", () => {
  const text = capture(() =>
    renderWorkflowScheduleList("log", {
      schedules: [
        {
          workflowId: PAUSE.workflowId,
          workflowName: "nightly-gc",
          schedule: "0 3 * * *",
          source: "definition",
          nextRun: "2026-10-17T03:00:00.000Z",
          paused: true,
          reason: "stalling serve",
          pausedBy: "user:ops",
          pausedAt: PAUSE.pausedAt,
          orphaned: false,
        },
        {
          workflowId: "22222222-2222-4222-8222-222222222222",
          workflowName: "report",
          schedule: "0 8 * * *",
          source: "override",
          nextRun: "2026-10-17T08:00:00.000Z",
          paused: false,
          orphaned: false,
        },
        {
          workflowId: "33333333-3333-4333-8333-333333333333",
          workflowName: "gone",
          schedule: null,
          source: null,
          nextRun: null,
          paused: true,
          pausedBy: "user:ops",
          orphaned: true,
        },
      ],
    })
  );
  assertStringIncludes(text, "nightly-gc - paused");
  assertStringIncludes(text, "(skipped while paused)");
  assertStringIncludes(text, "report - active");
  assertStringIncludes(text, "(serve.yaml override)");
  assertStringIncludes(text, "gone - paused (orphaned)");
  assertStringIncludes(
    text,
    "swamp workflow schedule resume 33333333-3333-4333-8333-333333333333",
  );
});

Deno.test("renderWorkflowScheduleList: empty list in both modes", () => {
  assertStringIncludes(
    capture(() => renderWorkflowScheduleList("log", { schedules: [] })),
    "No scheduled workflows.",
  );
  assertEquals(
    JSON.parse(
      capture(() => renderWorkflowScheduleList("json", { schedules: [] })),
    ),
    { schedules: [] },
  );
});
