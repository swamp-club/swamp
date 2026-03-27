// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  ModelMethodRunPayload,
  SerializedError,
  SerializedEvent,
  ServerMessage,
  ServerRequest,
  WorkflowRunPayload,
} from "./protocol.ts";

// ── WorkflowRunPayload ──────────────────────────────────────────────────

Deno.test("WorkflowRunPayload - minimal payload", () => {
  const payload: WorkflowRunPayload = {
    workflowIdOrName: "deploy",
  };
  assertEquals(payload.workflowIdOrName, "deploy");
  assertEquals(payload.inputs, undefined);
  assertEquals(payload.verbose, undefined);
});

Deno.test("WorkflowRunPayload - full payload", () => {
  const payload: WorkflowRunPayload = {
    workflowIdOrName: "deploy",
    inputs: { env: "prod" },
    lastEvaluated: true,
    driver: "docker",
    verbose: true,
    runtimeTags: { region: "us-east-1" },
  };
  assertEquals(payload.workflowIdOrName, "deploy");
  assertEquals(payload.inputs, { env: "prod" });
  assertEquals(payload.lastEvaluated, true);
  assertEquals(payload.driver, "docker");
  assertEquals(payload.verbose, true);
  assertEquals(payload.runtimeTags, { region: "us-east-1" });
});

// ── ModelMethodRunPayload ───────────────────────────────────────────────

Deno.test("ModelMethodRunPayload - minimal payload", () => {
  const payload: ModelMethodRunPayload = {
    modelIdOrName: "my-server",
    methodName: "start",
  };
  assertEquals(payload.modelIdOrName, "my-server");
  assertEquals(payload.methodName, "start");
});

Deno.test("ModelMethodRunPayload - full payload", () => {
  const payload: ModelMethodRunPayload = {
    modelIdOrName: "my-server",
    methodName: "start",
    inputs: { force: true },
    lastEvaluated: false,
    driver: "shell",
    runtimeTags: { tier: "staging" },
  };
  assertEquals(payload.inputs, { force: true });
  assertEquals(payload.driver, "shell");
});

// ── ServerRequest discriminated union ───────────────────────────────────

Deno.test("ServerRequest - workflow.run variant", () => {
  const req: ServerRequest = {
    type: "workflow.run",
    id: "req-1",
    payload: { workflowIdOrName: "deploy" },
  };
  assertEquals(req.type, "workflow.run");
  assertEquals(req.id, "req-1");
  if (req.type === "workflow.run") {
    assertEquals(req.payload.workflowIdOrName, "deploy");
  }
});

Deno.test("ServerRequest - model.method.run variant", () => {
  const req: ServerRequest = {
    type: "model.method.run",
    id: "req-2",
    payload: { modelIdOrName: "db", methodName: "migrate" },
  };
  assertEquals(req.type, "model.method.run");
  if (req.type === "model.method.run") {
    assertEquals(req.payload.modelIdOrName, "db");
    assertEquals(req.payload.methodName, "migrate");
  }
});

Deno.test("ServerRequest - cancel variant", () => {
  const req: ServerRequest = {
    type: "cancel",
    id: "req-3",
  };
  assertEquals(req.type, "cancel");
  assertEquals(req.id, "req-3");
});

// ── SerializedEvent / SerializedError ───────────────────────────────────

Deno.test("SerializedEvent - allows arbitrary extra properties", () => {
  const event: SerializedEvent = {
    kind: "step_completed",
    jobId: "j1",
    stepId: "s1",
  };
  assertEquals(event.kind, "step_completed");
  assertEquals(event.jobId, "j1");
});

Deno.test("SerializedError - with and without details", () => {
  const withDetails: SerializedError = {
    code: "validation_error",
    message: "Bad input",
    details: { field: "name" },
  };
  assertEquals(withDetails.details, { field: "name" });

  const withoutDetails: SerializedError = {
    code: "not_found",
    message: "Not found",
  };
  assertEquals(withoutDetails.details, undefined);
});

// ── ServerMessage discriminated union ───────────────────────────────────

Deno.test("ServerMessage - event variant", () => {
  const msg: ServerMessage = {
    type: "event",
    id: "req-1",
    event: { kind: "started", runId: "r1" },
  };
  assertEquals(msg.type, "event");
  if (msg.type === "event") {
    assertEquals(msg.event.kind, "started");
  }
});

Deno.test("ServerMessage - error variant", () => {
  const msg: ServerMessage = {
    type: "error",
    id: "req-1",
    error: { code: "internal", message: "Server error" },
  };
  assertEquals(msg.type, "error");
  if (msg.type === "error") {
    assertEquals(msg.error.code, "internal");
  }
});

Deno.test("ServerMessage - discriminated union narrows correctly", () => {
  const messages: ServerMessage[] = [
    {
      type: "event",
      id: "1",
      event: { kind: "completed", run: {} },
    },
    {
      type: "error",
      id: "2",
      error: { code: "cancelled", message: "Cancelled" },
    },
  ];

  const types = messages.map((m) => m.type);
  assertEquals(types, ["event", "error"]);
});

Deno.test("ServerRequest - round-trips through JSON", () => {
  const req: ServerRequest = {
    type: "workflow.run",
    id: "req-42",
    payload: {
      workflowIdOrName: "build",
      inputs: { version: "1.0.0" },
      verbose: true,
    },
  };
  const json = JSON.stringify(req);
  const parsed = JSON.parse(json) as ServerRequest;
  assertEquals(parsed.type, "workflow.run");
  assertEquals(parsed.id, "req-42");
  if (parsed.type === "workflow.run") {
    assertEquals(parsed.payload.workflowIdOrName, "build");
    assertEquals(parsed.payload.inputs, { version: "1.0.0" });
  }
});
