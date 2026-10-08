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
import { setColorEnabled } from "@std/fmt/colors";
import type { WorkflowRunView } from "../../libswamp/workflows/workflow_run_view.ts";
import { renderWorkflowRunDisplay } from "./workflow_run_display.ts";

function captureOutput(fn: () => void): string {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  setColorEnabled(false);
  try {
    fn();
  } finally {
    console.log = origLog;
    setColorEnabled(true);
  }
  return lines.join("\n");
}

const WAIT_ID = "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90";
const DEADLINE = "2026-10-09T00:00:00.000Z";

function suspendedOn(
  wait: NonNullable<WorkflowRunView["jobs"][number]["steps"][number]["wait"]>,
): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "release",
    status: "suspended",
    jobs: [{
      name: "main",
      status: "waiting",
      steps: [{ name: "review", status: "waiting", wait }],
    }],
  };
}

Deno.test("renderWorkflowRunDisplay: a step waiting on an open wait shows the wait ID and deadline", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(
      suspendedOn({ id: WAIT_ID, deadline: DEADLINE }),
      "log",
    )
  );
  assertStringIncludes(
    output,
    `waiting for signal ${WAIT_ID} until ${DEADLINE}`,
  );
  assertEquals(output.includes("received"), false);
});

Deno.test("renderWorkflowRunDisplay: a step signalled before its resume shows the receipt, not an open wait", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(
      suspendedOn({
        id: WAIT_ID,
        deadline: DEADLINE,
        receipt: {
          id: "sig-1",
          waitId: WAIT_ID,
          receivedAt: "2026-10-08T12:00:00.000Z",
          submittedBy: "user:ada",
        },
      }),
      "log",
    )
  );
  assertStringIncludes(
    output,
    `signal sig-1 received for wait ${WAIT_ID} from user:ada at 2026-10-08T12:00:00.000Z; a resume applies it`,
  );
  assertEquals(output.includes("waiting for signal"), false);
});

Deno.test("renderWorkflowRunDisplay: json mode prints the receipt as the view carries it", () => {
  const view = suspendedOn({
    id: WAIT_ID,
    deadline: DEADLINE,
    receipt: {
      id: "sig-1",
      waitId: WAIT_ID,
      receivedAt: "2026-10-08T12:00:00.000Z",
      submittedBy: "user:ada",
    },
  });
  const output = captureOutput(() => renderWorkflowRunDisplay(view, "json"));
  assertEquals(JSON.parse(output), view);
});
