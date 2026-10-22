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
  actionCommand,
  actionErrorCode,
  attachedReply,
  isDelegatedAction,
} from "./local_actions.ts";

const RUN = "321991e2-f182-4bb2-9937-f94c18ed1bfd";

Deno.test("isDelegatedAction: only approve, reject, resume and cancel", () => {
  for (
    const t of [
      "workflow.approve",
      "workflow.reject",
      "workflow.resume",
      "workflow.cancel",
    ]
  ) assertEquals(isDelegatedAction(t), true, t);
  for (
    const t of ["workflow.run", "workflow.search", "cancel", "data.delete", 1]
  ) {
    assertEquals(isDelegatedAction(t), false, String(t));
  }
});

Deno.test("actionCommand: approve and reject name the workflow, the step and the run", () => {
  const payload = {
    workflowIdOrName: "gated",
    stepName: "example",
    runId: RUN,
  };
  assertEquals(actionCommand("workflow.approve", payload), {
    kind: "command",
    args: ["workflow", "approve", "gated", "example", `--run=${RUN}`, "--json"],
    detached: false,
    runId: RUN,
  });
  assertEquals(
    actionCommand("workflow.reject", payload),
    {
      kind: "command",
      args: [
        "workflow",
        "reject",
        "gated",
        "example",
        `--run=${RUN}`,
        "--json",
      ],
      detached: false,
      runId: RUN,
    },
  );
});

Deno.test("actionCommand: a decision's reason is one --reason= argument", () => {
  const payload = {
    workflowIdOrName: "gated",
    stepName: "example",
    runId: RUN,
  };
  for (const verb of ["approve", "reject"] as const) {
    const command = actionCommand(`workflow.${verb}`, {
      ...payload,
      reason: "--force\nchecked the ticket",
    });
    assertEquals(command, {
      kind: "command",
      args: [
        "workflow",
        verb,
        "gated",
        "example",
        `--run=${RUN}`,
        "--reason=--force\nchecked the ticket",
        "--json",
      ],
      detached: false,
      runId: RUN,
    });
    for (const reason of [undefined, "", "   ", 42]) {
      const without = actionCommand(`workflow.${verb}`, { ...payload, reason });
      assertEquals(
        without.kind === "command" &&
          without.args.some((a) => a.startsWith("--reason")),
        false,
      );
    }
  }
});

Deno.test("actionCommand: resume runs on its own; cancel waits", () => {
  const payload = { workflowIdOrName: "@acme/deploy", runId: RUN };
  assertEquals(actionCommand("workflow.resume", payload), {
    kind: "command",
    args: ["workflow", "resume", "@acme/deploy", `--run=${RUN}`, "--json"],
    detached: true,
    runId: RUN,
  });
  assertEquals(actionCommand("workflow.cancel", payload), {
    kind: "command",
    args: ["workflow", "cancel", "@acme/deploy", `--run=${RUN}`, "--json"],
    detached: false,
    runId: RUN,
  });
});

Deno.test("actionCommand: refuses anything that could read as a flag or is missing", () => {
  const cases: Array<[Parameters<typeof actionCommand>[0], unknown]> = [
    ["workflow.approve", {
      workflowIdOrName: "--all",
      stepName: "s",
      runId: RUN,
    }],
    ["workflow.approve", { workflowIdOrName: "w", stepName: "-x", runId: RUN }],
    ["workflow.approve", { workflowIdOrName: "w", runId: RUN }],
    ["workflow.resume", { workflowIdOrName: "w", runId: "--all" }],
    ["workflow.resume", { workflowIdOrName: "w", runId: "abc def" }],
    ["workflow.cancel", { workflowIdOrName: "w" }],
    ["workflow.cancel", { runId: RUN }],
    ["workflow.cancel", { workflowIdOrName: "  ", runId: RUN }],
    ["workflow.cancel", null],
  ];
  for (const [type, payload] of cases) {
    assertEquals(
      actionCommand(type, payload).kind,
      "invalid",
      JSON.stringify(payload),
    );
  }
});

Deno.test("attachedReply: a successful command's JSON is the result's data", () => {
  assertEquals(
    attachedReply("workflow.approve", "r1", {
      code: 0,
      stdout: '{"approved":true,"allGatesDecided":true}\n',
      stderr: "",
    }),
    {
      type: "workflow.approve",
      id: "r1",
      payload: { data: { approved: true, allGatesDecided: true } },
    },
  );
});

Deno.test("attachedReply: a failed command is an error frame with its message", () => {
  assertEquals(
    attachedReply("workflow.cancel", "r2", {
      code: 1,
      stdout: '{"error":"Run not found"}',
      stderr: "",
    }),
    {
      type: "error",
      id: "r2",
      error: { code: "workflow_cancel_failed", message: "Run not found" },
    },
  );
  assertEquals(
    attachedReply("workflow.reject", "r3", {
      code: 1,
      stdout: "",
      stderr: "\x1b[31merror\x1b[0m: something broke\nA second line\n",
    }).type,
    "error",
  );
  assertEquals(actionErrorCode("workflow.approve"), "workflow_approve_failed");
});
