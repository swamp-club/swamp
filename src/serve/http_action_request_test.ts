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
import { ANONYMOUS_PRINCIPAL } from "./http_caller_auth.ts";
import {
  type ActionRequest,
  HTTP_ACTION_RULES,
  parseActionRequest,
} from "./http_action_request.ts";
import { validateServerRequest } from "./connection.ts";
import { HTTP_ACTION_TYPES } from "./protocol.ts";

// deno-lint-ignore no-explicit-any
type ActionBody = Record<string, any>;

const RUN_ID = "0b6f9a44-5c0d-4a6e-9a43-7a4f3f0c1d2e";

const VALID: Record<string, Record<string, unknown> | undefined> = {
  "workflow.run": { workflowIdOrName: "w", idempotencyKey: "button-1" },
  "workflow.resume": { workflowIdOrName: "w", runId: RUN_ID },
  "workflow.history.get": { runId: RUN_ID },
  "workflow.approvals": undefined,
  "workflow.approve": {
    workflowIdOrName: "w",
    runId: RUN_ID,
    stepName: "gate",
    suspendedAt: "2026-11-06T10:00:00.000Z",
  },
  "workflow.reject": {
    workflowIdOrName: "w",
    runId: RUN_ID,
    stepName: "gate",
    suspendedAt: "2026-11-06T10:00:00.000Z",
    reason: "no",
  },
  "workflow.signal": { workflow: "w", key: "k", payload: { go: true } },
};

function frameOf(request: ActionRequest): ActionBody {
  assert(request.ok, JSON.stringify(request));
  return JSON.parse(request.frame);
}

const named = { anonymous: false };

Deno.test("parseActionRequest: every listed type has a rule and a frame serve accepts", () => {
  assertEquals(
    new Set(Object.keys(HTTP_ACTION_RULES)),
    new Set(HTTP_ACTION_TYPES),
  );
  for (const type of HTTP_ACTION_TYPES) {
    const frame = frameOf(
      parseActionRequest({ type, payload: VALID[type] }, named),
    );
    assertEquals(frame.type, type);
    assertEquals(typeof validateServerRequest(frame), "object", type);
  }
});

Deno.test("parseActionRequest: serve sets its own fields", () => {
  const resume = frameOf(
    parseActionRequest({
      type: "workflow.resume",
      payload: VALID["workflow.resume"],
    }, named),
  );
  assertEquals(resume.payload.suspendedOnly, true);
  const status = frameOf(
    parseActionRequest({
      type: "workflow.history.get",
      payload: VALID["workflow.history.get"],
    }, named),
  );
  assertEquals(status.payload, { workflowIdOrName: RUN_ID, exactRun: true });
  const approve = frameOf(
    parseActionRequest({
      type: "workflow.approve",
      payload: VALID["workflow.approve"],
    }, named),
  );
  assertEquals(approve.payload.strictGate, true);
  assertEquals(approve.payload.decidedBy, undefined);
  const signal = frameOf(
    parseActionRequest({
      type: "workflow.signal",
      payload: VALID["workflow.signal"],
    }, named),
  );
  assertEquals(signal.payload.acceptsPending, true);
  assertEquals(signal.payload.acceptsReceipt, true);
});

Deno.test("parseActionRequest: with authorization off a decision names the anonymous principal", () => {
  const frame = frameOf(
    parseActionRequest({
      type: "workflow.reject",
      payload: VALID["workflow.reject"],
    }, { anonymous: true }),
  );
  assertEquals(frame.payload.decidedBy, ANONYMOUS_PRINCIPAL);
});

Deno.test("parseActionRequest: run ids reach serve in canonical form", () => {
  const frame = frameOf(
    parseActionRequest({
      type: "workflow.history.get",
      payload: { runId: RUN_ID.toUpperCase() },
    }, named),
  );
  assertEquals(frame.payload.workflowIdOrName, RUN_ID);
});

Deno.test("parseActionRequest: a request id is always serve's own", () => {
  const request = parseActionRequest({ type: "workflow.approvals" }, named);
  assert(request.ok);
  assertEquals(frameOf(request).id, request.requestId);
  const claimed = parseActionRequest(
    { type: "workflow.approvals", id: "mine" },
    named,
  );
  assertEquals(claimed.ok, false);
});

Deno.test("parseActionRequest: a type not on the list is told apart from a bad payload", () => {
  const unlisted = parseActionRequest(
    { type: "vault.get", payload: {} },
    named,
  );
  assertEquals(unlisted, {
    ok: false,
    reason: "type_not_allowed",
    type: "vault.get",
  });
  const inherited = parseActionRequest({ type: "toString" }, named);
  assertEquals(inherited.ok, false);
  const bad = parseActionRequest({ type: "workflow.run", payload: {} }, named);
  assert(!bad.ok && bad.reason === "invalid_request");
  assertEquals(parseActionRequest("nope", named).ok, false);
  assertEquals(parseActionRequest(null, named).ok, false);
});

const REFUSED_FIELDS: Record<string, string[]> = {
  "workflow.run": [
    "lockHolderTokens",
    "decidedBy",
    "initiatedBy",
    "client",
    "skipAllChecks",
    "skipCheckNames",
    "skipCheckLabels",
    "skipAllReports",
    "skipReportNames",
    "skipReportLabels",
    "reportNames",
    "reportLabels",
    "lastEvaluated",
    "verbose",
    "noSupersede",
  ],
  "workflow.resume": ["from", "fromJob", "suspendedOnly", "lockHolderTokens"],
  "workflow.history.get": ["exactRun", "workflowIdOrName"],
  "workflow.approve": ["decidedBy", "strictGate", "client"],
  "workflow.reject": ["decidedBy", "strictGate", "client"],
  "workflow.signal": ["acceptsPending", "acceptsReceipt", "submittedBy"],
  "workflow.approvals": ["anything"],
};

Deno.test("parseActionRequest: a field naming an identity, lock or check is refused", () => {
  for (const [type, fields] of Object.entries(REFUSED_FIELDS)) {
    for (const field of fields) {
      const request = parseActionRequest({
        type,
        payload: { ...VALID[type], [field]: "claimed" },
      }, named);
      assert(!request.ok, `${type} took ${field}`);
      assertEquals(request.reason, "invalid_request");
    }
  }
});
