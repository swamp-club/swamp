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
import { assertEquals, assertThrows } from "@std/assert";
import type { WorkflowSignalData } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { captureStdout, hintTestContext } from "./command_hint_test_helpers.ts";
import { parseSignalPayload, renderSignalResult } from "./workflow_signal.ts";

const RUN_ID = "8603d973-24ca-4f36-9c04-7b7c39a4a41a";
const WAIT_ID = "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90";

function signalled(
  overrides: Partial<WorkflowSignalData> = {},
): WorkflowSignalData {
  return {
    waitId: WAIT_ID,
    workflowId: "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a",
    workflowName: "release",
    runId: RUN_ID,
    jobName: "release",
    stepName: "review",
    signal: {
      id: "2b1c0d9e-7f4b-4c55-9a3e-0a5c1e8e8f7a",
      waitId: WAIT_ID,
      receivedAt: "2026-01-01T00:00:00.000Z",
      submittedBy: "tester",
    },
    awaitingResume: true,
    resumeCommand: `swamp workflow resume release --run ${RUN_ID}`,
    ...overrides,
  };
}

Deno.test("parseSignalPayload: parses JSON and leaves judging its shape to the wait", () => {
  assertEquals(parseSignalPayload('{"verdict":"ship"}'), { verdict: "ship" });
  assertEquals(parseSignalPayload("[1]"), [1]);
  assertEquals(parseSignalPayload("null"), null);
});

Deno.test("parseSignalPayload: text that is not JSON is a user error naming the flag", () => {
  for (const raw of ["", "{verdict: ship}", "ship", "{"]) {
    assertThrows(
      () => parseSignalPayload(raw),
      UserError,
      "--payload is not valid JSON",
    );
  }
});

Deno.test("renderSignalResult: log mode prints the resume command on one line", () => {
  const lines = captureStdout(() =>
    renderSignalResult(hintTestContext(), signalled())
  );
  assertEquals(lines, [
    `After the signal: swamp workflow resume release --run ${RUN_ID}`,
  ]);
});

Deno.test("renderSignalResult: log mode says so when the run still waits on something else", () => {
  const lines = captureStdout(() =>
    renderSignalResult(hintTestContext(), signalled({ awaitingResume: false }))
  );
  assertEquals(lines, [
    `The run still waits on something else. Once that settles: swamp workflow resume release --run ${RUN_ID}`,
  ]);
});

Deno.test("renderSignalResult: quiet prints no command", () => {
  const lines = captureStdout(() =>
    renderSignalResult(hintTestContext({ verbosity: "quiet" }), signalled())
  );
  assertEquals(lines, []);
});

Deno.test("renderSignalResult: json mode prints the whole result as one document", () => {
  const data = signalled();
  const lines = captureStdout(() =>
    renderSignalResult(hintTestContext({ outputMode: "json" }), data)
  );
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), data);
});

Deno.test("renderSignalResult: the resume command carries the repository target, in log and JSON modes", () => {
  const target = " --repo-dir /repo";
  const resume =
    `swamp workflow resume release --run ${RUN_ID} --repo-dir /repo`;

  const log = captureStdout(() =>
    renderSignalResult(hintTestContext(), signalled(), target)
  );
  assertEquals(log, [`After the signal: ${resume}`]);

  const json = captureStdout(() =>
    renderSignalResult(
      hintTestContext({ outputMode: "json" }),
      signalled(),
      target,
    )
  );
  assertEquals(JSON.parse(json[0]).resumeCommand, resume);
});
