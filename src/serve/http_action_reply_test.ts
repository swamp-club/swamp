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

import { assert, assertEquals } from "@std/assert";
import {
  actionFailure,
  actionReplyForEnd,
  actionReplyForFrame,
  actionResponse,
  DETACHED_ACTION_TYPES,
  HTTP_ACTION_FAILURE_TABLES,
  READ_ACTION_TYPES,
} from "./http_action_reply.ts";
import { HTTP_ACTION_TYPES } from "./protocol.ts";
import type { RegistryErrorCode } from "./active_run_registry.ts";

const ID = "req-1";

const failure = (type: string, code: string, details?: unknown) =>
  actionFailure(type, { code, message: "/home/secret/path.yaml", details }, ID);

Deno.test("actionFailure: pinned codes and statuses", () => {
  const cases: [string, string, unknown, number, string][] = [
    ["workflow.approve", "unauthorized", undefined, 403, "forbidden"],
    ["workflow.run", "unauthorized", undefined, 403, "forbidden"],
    ["workflow.resume", "unauthorized", undefined, 403, "forbidden"],
    ["workflow.history.get", "unauthorized", undefined, 404, "not_found"],
    ["workflow.signal", "unauthorized", undefined, 404, "not_found"],
    ["workflow.run", "consent_required", undefined, 403, "consent_required"],
    [
      "workflow.approve",
      "consent_required",
      undefined,
      403,
      "consent_required",
    ],
    [
      "workflow.signal",
      "consent_required",
      undefined,
      403,
      "consent_required",
    ],
    [
      "workflow.history.get",
      "consent_required",
      undefined,
      403,
      "consent_required",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      { gateState: "decided" },
      409,
      "already_decided",
    ],
    [
      "workflow.reject",
      "workflow_reject_failed",
      { gateState: "decided" },
      409,
      "already_decided",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      { gateState: "expired" },
      409,
      "gate_closed",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      { gateState: "closed" },
      409,
      "gate_closed",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      { gateState: "nested" },
      409,
      "gate_not_open",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      { gateState: "not_reached" },
      409,
      "gate_not_open",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      { gateState: "absent" },
      404,
      "not_found",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      { gateState: "busy" },
      409,
      "busy",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      { gateState: "waiting" },
      500,
      "action_failed",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      { gateState: "ambiguous" },
      409,
      "ambiguous_gate",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      { refusalCode: "gate_reopened" },
      409,
      "gate_reopened",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      { refusalCode: "ambiguous_gate" },
      409,
      "ambiguous_gate",
    ],
    [
      "workflow.approve",
      "workflow_approve_failed",
      undefined,
      500,
      "action_failed",
    ],
    [
      "workflow.resume",
      "workflow_resume_failed",
      { resumeRefusal: "not_found" },
      404,
      "not_found",
    ],
    [
      "workflow.resume",
      "workflow_resume_failed",
      { resumeRefusal: "nested_pending" },
      409,
      "run_not_resumable",
    ],
    [
      "workflow.resume",
      "workflow_resume_failed",
      { resumeRefusal: "refused" },
      409,
      "run_not_resumable",
    ],
    [
      "workflow.resume",
      "workflow_resume_failed",
      { resumeRefusal: "inputs_refused" },
      403,
      "resume_inputs_refused",
    ],
    [
      "workflow.resume",
      "run_not_suspended",
      undefined,
      409,
      "run_not_suspended",
    ],
    [
      "workflow.history.get",
      "workflow_history_get_failed",
      { reason: "not_found" },
      404,
      "not_found",
    ],
    [
      "workflow.history.get",
      "workflow_history_get_failed",
      undefined,
      500,
      "action_failed",
    ],
    [
      "workflow.run",
      "idempotency_conflict",
      undefined,
      409,
      "idempotency_conflict",
    ],
    ["workflow.run", "not_found", undefined, 404, "not_found"],
    ["workflow.run", "workflow_not_found", undefined, 404, "not_found"],
    ["workflow.run", "workflow_load_failed", undefined, 500, "action_failed"],
    [
      "workflow.run",
      "workflow_execution_failed",
      undefined,
      500,
      "action_failed",
    ],
    ["workflow.run", "too_many_requests", undefined, 429, "rate_limited"],
    ["workflow.run", "audit_unavailable", undefined, 503, "audit_unavailable"],
    [
      "workflow.run",
      "access_not_configured",
      undefined,
      503,
      "access_unavailable",
    ],
    ["workflow.run", "cancelled", undefined, 500, "outcome_unknown"],
    ["workflow.run", "something_new", undefined, 500, "action_failed"],
  ];
  for (const [type, code, details, status, replied] of cases) {
    const reply = failure(type, code, details);
    assertEquals(reply.status, status, `${type} ${code}`);
    assertEquals(reply.body.code, replied, `${type} ${code}`);
    assertEquals(reply.body.requestId, ID);
  }
});

Deno.test("actionFailure: every run registry refusal is mapped, and retryable", () => {
  const codes: RegistryErrorCode[] = [
    "already_registered",
    "reserved",
    "global_cap",
    "principal_cap",
    "draining",
  ];
  for (const code of codes) {
    const reply = failure("workflow.run", code);
    assert(
      reply.status === 409 || reply.status === 429 || reply.status === 503,
    );
    assert(reply.retryAfterSeconds !== undefined, code);
  }
});

Deno.test("actionFailure: a fixed reply never carries the handler's text or details", () => {
  for (
    const [type, code, details] of [
      ["workflow.approve", "unauthorized", undefined],
      ["workflow.approve", "workflow_approve_failed", {
        gateState: "decided",
        secret: "x",
      }],
      ["workflow.run", "workflow_load_failed", {
        file: "/home/secret/path.yaml",
      }],
      ["workflow.history.get", "workflow_history_get_failed", {
        reason: "not_found",
        reaped: { at: "t" },
      }],
    ] as const
  ) {
    const text = JSON.stringify(failure(type, code, details).body);
    assertEquals(text.includes("/home/secret"), false, code);
    assertEquals(text.includes("reaped"), false, code);
    assertEquals(text.includes("secret"), false, code);
  }
});

Deno.test("actionFailure: a fixed reply is its code, its fixed text and the request id", () => {
  for (
    const [type, code, details] of [
      ["workflow.history.get", "unauthorized", undefined],
      ["workflow.approve", "unauthorized", undefined],
      ["workflow.approve", "workflow_approve_failed", { gateState: "decided" }],
      ["workflow.run", "something_new", { anything: true }],
    ] as const
  ) {
    const { body } = failure(type, code, details);
    assertEquals(Object.keys(body).sort(), ["code", "message", "requestId"]);
    assertEquals(String(body.message).includes("/home/secret"), false);
  }
});

Deno.test("actionFailure: a refused caller and a missing run read the same", () => {
  const refused = failure("workflow.history.get", "unauthorized");
  const missing = failure(
    "workflow.history.get",
    "workflow_history_get_failed",
    {
      reason: "not_found",
      entityType: "Workflow run or workflow",
    },
  );
  assertEquals(refused, missing);
});

Deno.test("actionFailure: invalid inputs keep their text, with a path withheld", () => {
  const reply = actionFailure("workflow.run", {
    code: "input_validation_failed",
    message: "Input validation failed:\n  x is required",
    details: [{ path: "x" }],
  }, ID);
  assertEquals(reply.status, 400);
  assertEquals(reply.body.code, "invalid_request");
  assert(String(reply.body.message).includes("x is required"));
  assertEquals(reply.body.details, undefined);
  const withPath = failure("workflow.run", "input_validation_failed");
  assertEquals(String(withPath.body.message).includes("/home/secret"), false);
});

Deno.test("actionFailure: a signal refusal keeps the signal route's statuses", () => {
  const settled = actionFailure("workflow.signal", {
    code: "workflow_signal_refused",
    message: "already settled",
    details: { refusal: "already_settled", receipt: { id: "r" } },
  }, ID);
  assertEquals(settled.status, 409);
  assertEquals(settled.body.code, "already_settled");
  assertEquals(settled.body.receipt, { id: "r" });
});

Deno.test("actionReplyForFrame: a detached type settles on its own started event only", () => {
  const started = (extra: Record<string, unknown>) => ({
    type: "event",
    id: ID,
    event: { kind: "started", runId: "r", workflowName: "w", ...extra },
  });
  assertEquals(
    actionReplyForFrame("workflow.run", {
      type: "event",
      event: { kind: "validating_inputs" },
    }, ID),
    undefined,
  );
  assertEquals(
    actionReplyForFrame("workflow.run", started({ parentRunId: "p" }), ID),
    undefined,
  );
  const reply = actionReplyForFrame("workflow.run", started({}), ID)!;
  assertEquals(reply.status, 202);
  assertEquals(reply.body.data, {
    runId: "r",
    workflowName: "w",
    replayed: false,
  });
  const replayed = actionReplyForFrame(
    "workflow.run",
    started({ replayed: true }),
    ID,
  )!;
  assertEquals((replayed.body.data as { replayed: boolean }).replayed, true);
});

Deno.test("actionReplyForFrame: a failure before started is never success or silence", () => {
  const errorEvent = actionReplyForFrame("workflow.run", {
    type: "event",
    event: {
      kind: "error",
      error: { code: "not_found", message: "Workflow not found: w" },
    },
  }, ID)!;
  assertEquals(errorEvent.status, 404);
  const errorFrame = actionReplyForFrame("workflow.run", {
    type: "error",
    error: { code: "global_cap", message: "full" },
  }, ID)!;
  assertEquals(errorFrame.status, 429);
  const noStart = actionReplyForFrame("workflow.resume", { type: "done" }, ID)!;
  assertEquals(noStart.status, 500);
  assertEquals(noStart.body.code, "run_not_started");
  assertEquals(actionReplyForEnd(ID).body.code, "outcome_unknown");
});

Deno.test("actionReplyForFrame: other types settle on their reply", () => {
  const data = { approvals: [] };
  const reply = actionReplyForFrame("workflow.approvals", {
    type: "workflow.approvals",
    payload: { data },
  }, ID)!;
  assertEquals(reply.status, 200);
  assertEquals(reply.body.data, data);
  assertEquals(
    actionReplyForFrame("workflow.approvals", { type: "event", event: {} }, ID),
    undefined,
  );
  assertEquals(
    actionReplyForFrame("workflow.signal", {
      type: "workflow.signal",
      payload: { pending: {} },
    }, ID)!.status,
    202,
  );
  assertEquals(
    actionReplyForFrame("workflow.signal", {
      type: "workflow.signal",
      payload: { data: {} },
    }, ID)!.status,
    200,
  );
});

Deno.test("actionResponse: a retryable failure tells the caller when", () => {
  const { headers, status } = actionResponse(
    failure("workflow.run", "draining"),
  );
  assertEquals(status, 503);
  assertEquals(headers["retry-after"], "5");
});

Deno.test("action types: every listed type is detached, a read or a decision", () => {
  const classified = new Set([
    ...DETACHED_ACTION_TYPES,
    ...READ_ACTION_TYPES,
    "workflow.approve",
    "workflow.reject",
    "workflow.signal",
  ]);
  assertEquals(classified, new Set(HTTP_ACTION_TYPES));
  assert(
    Object.keys(HTTP_ACTION_FAILURE_TABLES.GATE_FAILURES).includes("decided"),
  );
});
