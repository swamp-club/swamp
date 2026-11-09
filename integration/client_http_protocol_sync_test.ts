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
import * as client from "../packages/client/http_protocol.ts";
import { ACTION_OUTCOME_CODES } from "../packages/client/action_client.ts";
import { HTTP_ACTION_TYPES } from "../src/serve/protocol.ts";
import {
  HTTP_ACTION_FAILURE_TABLES,
  HTTP_ACTION_ROUTE_CODES,
} from "../src/serve/http_action_reply.ts";
import { SIGNAL_STATUS } from "../src/serve/signal_http.ts";
import { DELEGATION_ROUTE_CODES } from "../src/serve/delegation_routes.ts";
import { REFRESH_REFUSAL_REASONS } from "../src/domain/access/delegation.ts";
import { parseActionRequest } from "../src/serve/http_action_request.ts";
import {
  AMBIGUOUS_GATE_CODE,
  GATE_REOPENED_CODE,
} from "../src/libswamp/workflows/gate_refusals.ts";

const sorted = (values: Iterable<string>) => [...values].sort();

Deno.test("swamp-lib HTTP protocol: action types match serve's", () => {
  assertEquals(sorted(client.HTTP_ACTION_TYPES), sorted(HTTP_ACTION_TYPES));
});

Deno.test("swamp-lib HTTP protocol: route codes and refusal reasons match serve's", () => {
  assertEquals(
    sorted(client.DELEGATION_ROUTE_CODES),
    sorted(DELEGATION_ROUTE_CODES),
  );
  assertEquals(
    sorted(client.REFRESH_REFUSAL_REASONS),
    sorted(REFRESH_REFUSAL_REASONS),
  );
  assertEquals(
    sorted(client.HTTP_ACTION_ROUTE_CODES),
    sorted(HTTP_ACTION_ROUTE_CODES),
  );
});

Deno.test("swamp-lib HTTP protocol: every code the action client maps is one serve can send", () => {
  const sent = new Set<string>([
    ...HTTP_ACTION_ROUTE_CODES,
    ...Object.keys(SIGNAL_STATUS),
    GATE_REOPENED_CODE,
    AMBIGUOUS_GATE_CODE,
    "forbidden",
  ]);
  for (const table of Object.values(HTTP_ACTION_FAILURE_TABLES)) {
    for (const failure of Object.values(table)) sent.add(failure.code);
  }
  for (const code of ACTION_OUTCOME_CODES) {
    assert(sent.has(code), `serve never sends ${code}`);
  }
});

Deno.test("swamp-lib HTTP protocol: each request payload the client builds is one serve accepts", () => {
  const runId = crypto.randomUUID();
  const samples: [string, unknown][] = [
    [
      "workflow.run",
      {
        workflowIdOrName: "deploy",
        idempotencyKey: "slack:1234",
        inputs: { env: "dev" },
        runtimeTags: { team: "a" },
      } satisfies client.RunActionPayload,
    ],
    [
      "workflow.resume",
      {
        workflowIdOrName: "deploy",
        runId,
      } satisfies client.ResumeActionPayload,
    ],
    ["workflow.history.get", { runId } satisfies client.HistoryActionPayload],
    ["workflow.approvals", {}],
    [
      "workflow.approve",
      {
        workflowIdOrName: "deploy",
        runId,
        stepName: "gate",
        jobName: "main",
        suspendedAt: new Date(0).toISOString(),
        reason: "ok",
      } satisfies client.DecisionActionPayload,
    ],
    [
      "workflow.reject",
      {
        workflowIdOrName: "deploy",
        runId,
        stepName: "gate",
        suspendedAt: new Date(0).toISOString(),
      } satisfies client.DecisionActionPayload,
    ],
    [
      "workflow.signal",
      {
        waitId: "w1",
        payload: {},
        idempotencyKey: "k1",
      } satisfies client.SignalActionPayload,
    ],
    [
      "workflow.signal",
      {
        workflow: "deploy",
        key: "ready",
        payload: {},
      } satisfies client.SignalActionPayload,
    ],
  ];
  for (const [type, payload] of samples) {
    const parsed = parseActionRequest({ type, payload }, { anonymous: false });
    assert(parsed.ok, `${type}: ${JSON.stringify(parsed)}`);
  }
});
