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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { setColorEnabled } from "@std/fmt/colors";
import type { WorkflowRunView } from "../../libswamp/workflows/workflow_run_view.ts";
import { renderWorkflowRunDisplay } from "./workflow_run_display.ts";
import {
  deeplyNestedAttributes,
  nestedTreeDepth,
} from "../output/json_stream_test_helpers.ts";

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

function decided(
  approval: NonNullable<
    WorkflowRunView["jobs"][number]["steps"][number]["approval"]
  >,
): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "release",
    status: "succeeded",
    jobs: [{
      name: "main",
      status: "succeeded",
      steps: [{ name: "review", status: "succeeded", approval }],
    }],
  };
}

Deno.test("renderWorkflowRunDisplay: a decision names the client it came through", () => {
  const approved = captureOutput(() =>
    renderWorkflowRunDisplay(
      decided({
        status: "approved",
        approvedBy: "user:bob",
        approvedAt: "2026-11-05T14:03:00.000Z",
        client: "direct:cli",
      }),
      "log",
    )
  );
  assertStringIncludes(approved, "by user:bob via direct:cli at");
  const rejected = captureOutput(() =>
    renderWorkflowRunDisplay(
      decided({
        status: "rejected",
        rejectedBy: "user:bob",
        rejectedAt: "2026-11-05T14:03:00.000Z",
        client: "integration:ops-slack",
      }),
      "log",
    )
  );
  assertStringIncludes(rejected, "by user:bob via integration:ops-slack at");
});

Deno.test("renderWorkflowRunDisplay: a decision with no client reads as before", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(
      decided({
        status: "approved",
        approvedBy: "user:bob",
        approvedAt: "2026-11-05T14:03:00.000Z",
      }),
      "log",
    )
  );
  assertStringIncludes(output, "by user:bob at");
  assertEquals(output.includes(" via "), false);
});

Deno.test("renderWorkflowRunDisplay: a decision names who decided by the username serve recorded", () => {
  const approved = captureOutput(() =>
    renderWorkflowRunDisplay(
      decided({
        status: "approved",
        approvedBy: "user:0f3a-sub",
        approvedByUsername: "bob",
        approvedAt: "2026-11-05T14:03:00.000Z",
        client: "direct:dashboard",
      }),
      "log",
    )
  );
  assertStringIncludes(
    approved,
    "Approved by user:bob via direct:dashboard at",
  );
  assertEquals(approved.includes("0f3a-sub"), false);
  const rejected = captureOutput(() =>
    renderWorkflowRunDisplay(
      decided({
        status: "rejected",
        rejectedBy: "user:0f3a-sub",
        rejectedByUsername: "bob",
        rejectedAt: "2026-11-05T14:03:00.000Z",
      }),
      "log",
    )
  );
  assertStringIncludes(rejected, "Rejected by user:bob at");
  assertEquals(rejected.includes("0f3a-sub"), false);
});

Deno.test("renderWorkflowRunDisplay: a recorded username cannot write control sequences to the terminal", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(
      decided({
        status: "rejected",
        rejectedBy: "user:0f3a-sub",
        rejectedByUsername: "bob\x1b[2J",
        rejectedAt: "2026-11-05T14:03:00.000Z",
      }),
      "log",
    )
  );
  assertEquals(output.includes("\x1b[2J"), false);
  assertStringIncludes(output, "Rejected by user:bob");
});

Deno.test("renderWorkflowRunDisplay: a token decision whose id is the username reads as before", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(
      decided({
        status: "approved",
        approvedBy: "user:stack72",
        approvedAt: "2026-11-05T14:03:00.000Z",
        client: "direct:token",
      }),
      "log",
    )
  );
  assertStringIncludes(output, "Approved by user:stack72 via direct:token at");
});

Deno.test("renderWorkflowRunDisplay: json mode keeps the id and adds the username beside it", () => {
  const view = decided({
    status: "approved",
    approvedBy: "user:0f3a-sub",
    approvedByUsername: "bob",
    approvedAt: "2026-11-05T14:03:00.000Z",
  });
  const output = captureOutput(() => renderWorkflowRunDisplay(view, "json"));
  const approval = JSON.parse(output).jobs[0].steps[0].approval;
  assertEquals(approval.approvedBy, "user:0f3a-sub");
  assertEquals(approval.approvedByUsername, "bob");
});

Deno.test("renderWorkflowRunDisplay: json mode prints a run whose attributes nest past JSON.stringify's stack limit", () => {
  const view: WorkflowRunView = {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "release",
    status: "succeeded",
    jobs: [{
      name: "main",
      status: "succeeded",
      steps: [{
        name: "deep",
        status: "succeeded",
        dataArtifacts: [{
          dataId: "d-1",
          name: "main",
          version: 1,
          tags: {},
          attributes: deeplyNestedAttributes(),
        }],
      }],
    }],
  };
  assertThrows(() => JSON.stringify(view, null, 2), RangeError);
  const parsed = JSON.parse(
    captureOutput(() => renderWorkflowRunDisplay(view, "json")),
  );
  assertEquals(parsed.status, "succeeded");
  assertEquals(
    nestedTreeDepth(parsed.jobs[0].steps[0].dataArtifacts[0].attributes),
    { depth: 6_000, leaf: [0, 1, 2] },
  );
});

function endedRun(
  status: WorkflowRunView["status"],
  extra: Partial<WorkflowRunView>,
): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "release",
    status,
    jobs: [],
    ...extra,
  };
}

Deno.test("renderWorkflowRunDisplay: an interrupted run names its reason and why serve left it", () => {
  const out = captureOutput(() =>
    renderWorkflowRunDisplay(
      endedRun("interrupted", {
        interruptReason: "server_shutdown",
        autoContinuation: {
          count: 0,
          refused: {
            at: DEADLINE,
            reason: "unguarded_step",
            steps: ["deploy"],
            message: "Step deploy was cut off and has no guard.",
          },
        },
      }),
      "log",
    )
  );
  assertStringIncludes(out, "Interrupted: server_shutdown");
  assertStringIncludes(
    out,
    "Not continued automatically (unguarded_step): Step deploy was cut off",
  );
});

Deno.test("renderWorkflowRunDisplay: a run serve continued says so once it moves on", () => {
  const out = captureOutput(() =>
    renderWorkflowRunDisplay(
      endedRun("succeeded", {
        autoContinuation: {
          count: 1,
          continuedAt: DEADLINE,
          interruptReason: "server_crash",
          resetSteps: ["deploy"],
        },
      }),
      "log",
    )
  );
  assertStringIncludes(out, "Continued automatically after server_crash");
  assertStringIncludes(out, "deploy");
  assertEquals(out.includes("Not continued"), false);
});

Deno.test("renderWorkflowRunDisplay: a run parked for a restart reads as parked, not interrupted", () => {
  const out = captureOutput(() =>
    renderWorkflowRunDisplay(
      endedRun("interrupted", {
        interruptReason: "server_restart",
        parked: true,
      }),
      "log",
    )
  );
  assertStringIncludes(
    out,
    "Parked for a serve restart: the next serve process continues it under the same run id unless the workflow sets autoContinue: false",
  );
  assertStringIncludes(out, "Result: PARKED");
  assertEquals(out.includes("Interrupted:"), false);
});

Deno.test("renderWorkflowRunDisplay: a parked run serve refused promises no continuation and names why", () => {
  const out = captureOutput(() =>
    renderWorkflowRunDisplay(
      endedRun("interrupted", {
        interruptReason: "server_restart",
        parked: true,
        autoContinuation: {
          count: 0,
          refused: {
            at: DEADLINE,
            reason: "opted_out",
            steps: [],
            message: "The workflow sets autoContinue: false.",
          },
        },
      }),
      "log",
    )
  );
  assertEquals(out.includes("continues it"), false);
  assertStringIncludes(out, "Parked for a serve restart");
  assertStringIncludes(
    out,
    "Not continued automatically (opted_out): The workflow sets autoContinue: false.",
  );
});

function childRun(
  inheritedPlacement?: WorkflowRunView["inheritedPlacement"],
): WorkflowRunView {
  return {
    id: "run-2",
    workflowId: "wf-2",
    workflowName: "child",
    status: "succeeded",
    jobs: [],
    ...(inheritedPlacement ? { inheritedPlacement } : {}),
  };
}

Deno.test("renderWorkflowRunDisplay: a nested run names the step whose placement it inherited", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(
      childRun({
        target: "w-a",
        labels: { fleet: "web" },
        source: { workflowName: "caddy", jobName: "install", stepName: "sudo" },
      }),
      "log",
    )
  );
  assertStringIncludes(
    output,
    "Placement inherited from caddy / install / sudo by steps that place nothing themselves: target w-a, labels fleet=web",
  );
});

Deno.test("renderWorkflowRunDisplay: a run that inherited nothing prints no placement line", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(childRun(), "log")
  );
  assertEquals(output.includes("Placement inherited"), false);
});

Deno.test("renderWorkflowRunDisplay: json mode carries the inherited placement", () => {
  const inherited = {
    platform: "linux",
    source: { workflowName: "caddy", jobName: "install", stepName: "sudo" },
  };
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(childRun(inherited), "json")
  );
  assertEquals(JSON.parse(output).inheritedPlacement, inherited);
});

function fanOutView(
  fanOut?: NonNullable<WorkflowRunView["jobs"][number]["fanOut"]>,
): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "fleet",
    status: "failed",
    jobs: [{
      name: "patch",
      status: "failed",
      steps: [{ name: "apply[a]", status: "failed", error: "boom" }],
      ...(fanOut !== undefined ? { fanOut } : {}),
    }],
  };
}

const FAN_OUT = {
  selector: { labels: { role: "web" } },
  policy: { offline: "wait", minWorkers: 1 },
  plannedLanes: 3,
  batches: [["a"], ["b", "c"]],
  budget: { allowed: 0, used: 1 },
  members: [
    {
      worker: "a",
      disposition: "dispatch",
      batch: 0,
      lane: "failed" as const,
      failedSteps: [{ step: "apply[a]", error: "boom" }],
      assertions: [{
        step: "verify[a]",
        severity: "high",
        message: "health was red",
      }],
    },
    {
      worker: "b",
      disposition: "waiting",
      reason: "disconnected",
      batch: 1,
      lane: "held" as const,
    },
    { worker: "c", disposition: "dispatch", batch: 1, lane: "held" as const },
    { worker: "d", disposition: "excluded", reason: "draining" },
  ],
  halts: [
    {
      reason: "budget" as const,
      batch: 0,
      maxFailures: 0,
      failed: ["a"],
      held: ["b", "c"],
    },
    { reason: "gate_rejected" as const, gate: "canary" as const, held: ["b"] },
  ],
  gates: [
    {
      kind: "plan" as const,
      step: "patch[approve-plan]",
      status: "approved" as const,
      approval: {
        status: "approved" as const,
        approvedBy: "user:u-1",
        approvedByUsername: "ops",
        approvedAt: "2026-01-01T00:00:30.000Z",
      },
    },
    {
      kind: "canary" as const,
      step: "patch[approve-canary]",
      status: "rejected" as const,
      approval: {
        status: "rejected" as const,
        rejectedBy: "user-2",
        rejectedAt: "2026-01-01T00:02:00.000Z",
        reason: "canary red",
      },
    },
  ],
  resume: {
    at: "2026-01-01T00:01:00.000Z",
    rerun: ["b", "c"],
    kept: ["a"],
  },
};

Deno.test("renderWorkflowRunDisplay: a fan-out job shows its selector, policy, batches, members, gates, halts and latest resume", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(fanOutView(FAN_OUT), "log")
  );
  for (
    const line of [
      "    Fan-out: role=web; offline wait, minWorkers 1",
      "      Planned lanes: 3; budget: 1 used, 0 failed lane(s) allowed",
      "      Batch 1: a",
      "      Batch 2: b, c",
      "        a: dispatch, batch 1, failed",
      "          failed apply[a]: boom",
      "          assertion verify[a] (high): health was red",
      "        b: waiting (disconnected), batch 2, held",
      "        d: excluded (draining), no lane",
      "        plan: approved by user:ops at 2026-01-01 00:00:30 UTC",
      "        canary: rejected by user-2 at 2026-01-01 00:02:00 UTC",
      "          Reason: canary red",
      "        attempt 1: budget spent in batch 1 (0 failed lane(s) allowed); failed a; held b, c",
      "        canary gate rejected: held b",
      "      Latest resume at 2026-01-01 00:01:00 UTC: rerun b, c; kept a",
    ]
  ) assertStringIncludes(output, line);
});

Deno.test("renderWorkflowRunDisplay: a fan-out view escapes worker names, labels and errors, and says what the record lacks", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay(
      fanOutView({
        ...FAN_OUT,
        selector: { labels: { "ro\u001b[2Jle": "w\neb" } },
        policy: undefined,
        members: [{
          worker: "a\u001b[31m",
          disposition: "dispatch",
          batch: 0,
          lane: "failed",
          failedSteps: [{ step: "apply[a]", error: "line1\nforged line" }],
        }],
        halts: [],
        gates: [],
        resume: undefined,
      }),
      "log",
    )
  );
  assertEquals(output.includes("\u001b"), false);
  assertEquals(output.includes("\nforged line"), false);
  assertStringIncludes(output, "policy not recorded");
});

Deno.test("renderWorkflowRunDisplay: a run without a fan-out view prints exactly as before, in log and json", () => {
  const plain = fanOutView();
  assertEquals(
    captureOutput(() => renderWorkflowRunDisplay(plain, "log")),
    [
      "Workflow: fleet (Run ID: run-1)",
      "  ✗ patch",
      "    ✗ apply[a]",
      "      -> boom",
      "Result: FAILED",
    ].join("\n"),
  );
  assertEquals(
    JSON.parse(captureOutput(() => renderWorkflowRunDisplay(plain, "json"))),
    plain,
  );
});

Deno.test("renderWorkflowRunDisplay: a step error and a rejection reason cannot drive the terminal, and the error keeps its line breaks", () => {
  const output = captureOutput(() =>
    renderWorkflowRunDisplay({
      id: "run-1",
      workflowId: "wf-1",
      workflowName: "fleet",
      status: "failed",
      jobs: [{
        name: "main",
        status: "failed",
        steps: [
          {
            name: "apply",
            status: "failed",
            error: "worker said \u001b[2Jcleared\nsecond line",
          },
          {
            name: "gate",
            status: "failed",
            approval: {
              status: "rejected",
              rejectedBy: "user-2",
              rejectedAt: "2026-01-01T00:02:00.000Z",
              reason: "no\u001b[31m\nforged",
            },
          },
        ],
      }],
    }, "log")
  );
  assertEquals(output.includes("\u001b"), false);
  assertStringIncludes(output, "-> worker said \\x1b[2Jcleared\nsecond line");
  assertStringIncludes(output, "Reason: no\\x1b[31m\\x0aforged");
});
