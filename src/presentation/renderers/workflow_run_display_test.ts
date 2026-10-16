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

Deno.test("renderWorkflowRunDisplay: a waiting step whose wait has a key shows the key", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(
      suspendedOn({ id: WAIT_ID, deadline: DEADLINE, key: "kitchen-verdict" }),
      "log",
    )
  );
  assertStringIncludes(
    output,
    `waiting for signal ${WAIT_ID} (key kitchen-verdict) until ${DEADLINE}`,
  );
});

Deno.test("renderWorkflowRunDisplay: a key carrying an escape sequence never reaches stdout raw", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(
      suspendedOn({ id: WAIT_ID, deadline: DEADLINE, key: "k\x1b[2J" }),
      "log",
    )
  );
  assertEquals(output.includes("\x1b"), false);
});

Deno.test("renderWorkflowRunDisplay: a signal held as pending says so, on a waiting step and on one the signal settled", () => {
  const receipt = {
    id: "sig-1",
    waitId: WAIT_ID,
    receivedAt: "2026-10-08T12:00:00.000Z",
    submittedBy: "user:ada",
    heldAsPending: true as const,
  };
  const waiting = captureOutput(() =>
    renderWorkflowRunDisplay(
      suspendedOn({
        id: WAIT_ID,
        deadline: DEADLINE,
        key: "kitchen-verdict",
        receipt,
      }),
      "log",
    )
  );
  assertStringIncludes(
    waiting,
    `signal sig-1 received for wait ${WAIT_ID} (key kitchen-verdict) from user:ada at 2026-10-08T12:00:00.000Z, held as a pending signal until the wait took it; a resume applies it`,
  );

  const settled = suspendedOn({
    id: WAIT_ID,
    deadline: DEADLINE,
    key: "kitchen-verdict",
    receipt,
  });
  settled.status = "succeeded";
  settled.jobs[0].status = "succeeded";
  settled.jobs[0].steps[0].status = "succeeded";
  const done = captureOutput(() => renderWorkflowRunDisplay(settled, "log"));
  assertStringIncludes(
    done,
    `signal sig-1 received for wait ${WAIT_ID} (key kitchen-verdict) from user:ada at 2026-10-08T12:00:00.000Z, held as a pending signal until the wait took it`,
  );
  assertEquals(done.includes("a resume applies it"), false);

  // A receipt of a signal sent to an open wait adds nothing to a settled step.
  const plain = suspendedOn({
    id: WAIT_ID,
    deadline: DEADLINE,
    receipt: { ...receipt, heldAsPending: undefined },
  });
  plain.jobs[0].steps[0].status = "succeeded";
  const plainOutput = captureOutput(() =>
    renderWorkflowRunDisplay(plain, "log")
  );
  assertEquals(plainOutput.includes("sig-1"), false);
});

Deno.test("renderWorkflowRunDisplay: json mode carries the key and the held marker as the view does", () => {
  const view = suspendedOn({
    id: WAIT_ID,
    deadline: DEADLINE,
    key: "kitchen-verdict",
    receipt: {
      id: "sig-1",
      waitId: WAIT_ID,
      receivedAt: "2026-10-08T12:00:00.000Z",
      submittedBy: "user:ada",
      heldAsPending: true,
    },
  });
  const output = captureOutput(() => renderWorkflowRunDisplay(view, "json"));
  assertEquals(JSON.parse(output), view);
});
