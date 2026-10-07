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
import type {
  SignalWaitInfo,
  UnreadableWaitInfo,
  WorkflowWaitsData,
} from "../../libswamp/workflows/waits.ts";
import { captureStdout, hintTestContext } from "./command_hint_test_helpers.ts";
import { renderWaits } from "./workflow_waits.ts";

const RUN_ID = "8603d973-24ca-4f36-9c04-7b7c39a4a41a";
const WAIT_ID = "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90";

function wait(overrides: Partial<SignalWaitInfo> = {}): SignalWaitInfo {
  return {
    waitId: WAIT_ID,
    workflowId: "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a",
    workflowName: "release",
    runId: RUN_ID,
    jobName: "release",
    stepName: "review",
    waitingSince: "2026-01-01T00:00:00.000Z",
    deadline: "2026-01-02T00:00:00.000Z",
    expired: false,
    schema: {
      type: "object",
      properties: { verdict: { type: "string", enum: ["ship", "fix"] } },
    },
    nextCommand: `swamp workflow signal ${WAIT_ID} --payload '<json>'`,
    ...overrides,
  };
}

function listed(
  waits: SignalWaitInfo[],
  unreadableWaits: UnreadableWaitInfo[] = [],
): WorkflowWaitsData {
  return { waits, unreadableWaits };
}

const UNREADABLE: UnreadableWaitInfo = {
  workflowId: "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a",
  workflowName: "release",
  runId: RUN_ID,
  jobName: "release",
  stepName: "review",
  nextCommand: `swamp workflow resume release --run ${RUN_ID}`,
};

Deno.test("renderWaits: log mode prints the signal command for an open wait", () => {
  const lines = captureStdout(() =>
    renderWaits(hintTestContext(), listed([wait()]))
  );
  assertEquals(lines, [
    `  swamp workflow signal ${WAIT_ID} --payload '<json>'`,
  ]);
});

Deno.test("renderWaits: log mode prints the resume command for an expired wait", () => {
  const resume = `swamp workflow resume release --run ${RUN_ID}`;
  const lines = captureStdout(() =>
    renderWaits(
      hintTestContext(),
      listed([wait({ expired: true, nextCommand: resume })]),
    )
  );
  assertEquals(lines, [`  ${resume}`]);
});

Deno.test("renderWaits: log mode prints one command per wait, in the order given", () => {
  const other = "11111111-1111-4111-8111-111111111111";
  const lines = captureStdout(() =>
    renderWaits(
      hintTestContext(),
      listed([
        wait(),
        wait({
          waitId: other,
          nextCommand: `swamp workflow signal ${other} --payload '<json>'`,
        }),
      ]),
    )
  );
  assertEquals(lines, [
    `  swamp workflow signal ${WAIT_ID} --payload '<json>'`,
    `  swamp workflow signal ${other} --payload '<json>'`,
  ]);
});

Deno.test("renderWaits: quiet and an empty list print no command", () => {
  assertEquals(
    captureStdout(() =>
      renderWaits(hintTestContext({ verbosity: "quiet" }), listed([wait()]))
    ),
    [],
  );
  assertEquals(
    captureStdout(() => renderWaits(hintTestContext(), listed([]))),
    [],
  );
});

Deno.test("renderWaits: json mode prints every field of every wait", () => {
  const waits = [wait(), wait({ expired: true })];
  const lines = captureStdout(() =>
    renderWaits(hintTestContext({ outputMode: "json" }), listed(waits))
  );
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), { waits, unreadableWaits: [] });
});

Deno.test("renderWaits: json mode prints an empty list as a document", () => {
  const lines = captureStdout(() =>
    renderWaits(hintTestContext({ outputMode: "json" }), listed([]))
  );
  assertEquals(JSON.parse(lines[0]), { waits: [], unreadableWaits: [] });
});

Deno.test("renderWaits: every printed command carries the repository target, in log and JSON modes", () => {
  const target = " --repo-dir /repo";
  const data = listed([wait()], [UNREADABLE]);

  const log = captureStdout(() => renderWaits(hintTestContext(), data, target));
  assertEquals(log, [
    `  swamp workflow signal ${WAIT_ID} --payload '<json>' --repo-dir /repo`,
    `  swamp workflow resume release --run ${RUN_ID} --repo-dir /repo`,
  ]);

  const json = captureStdout(() =>
    renderWaits(hintTestContext({ outputMode: "json" }), data, target)
  );
  const parsed = JSON.parse(json[0]);
  assertEquals(
    parsed.waits[0].nextCommand,
    `swamp workflow signal ${WAIT_ID} --payload '<json>' --repo-dir /repo`,
  );
  assertEquals(
    parsed.unreadableWaits[0].nextCommand,
    `swamp workflow resume release --run ${RUN_ID} --repo-dir /repo`,
  );
});

Deno.test("renderWaits: an unreadable wait is listed with its resume command, and is not an empty list", () => {
  const lines = captureStdout(() =>
    renderWaits(hintTestContext(), listed([], [UNREADABLE]))
  );
  assertEquals(lines, [`  swamp workflow resume release --run ${RUN_ID}`]);

  const json = captureStdout(() =>
    renderWaits(
      hintTestContext({ outputMode: "json" }),
      listed([], [UNREADABLE]),
    )
  );
  assertEquals(JSON.parse(json[0]), {
    waits: [],
    unreadableWaits: [UNREADABLE],
  });
});
