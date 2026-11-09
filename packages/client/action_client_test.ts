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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { SwampActionClient } from "./action_client.ts";
import type { TokenSource } from "./delegated_tokens.ts";
import { SwampHttpError } from "./http_errors.ts";
import {
  type Answer,
  FAST,
  scriptedFetch,
  SERVE,
} from "./http_test_helpers.ts";

const RUN_ID = "2b6f1c9e-1d4a-4f4e-9a0b-7c3d2e1f0a9b";
const DECISION = {
  workflowIdOrName: "deploy",
  runId: RUN_ID,
  stepName: "gate",
  suspendedAt: "2026-01-01T00:00:00.000Z",
};

function actions(answers: Answer[], token: TokenSource | string = "tok") {
  const scripted = scriptedFetch(answers);
  return {
    client: new SwampActionClient(SERVE, {
      token,
      fetch: scripted.fetch,
      ...FAST,
    }),
    sent: scripted.sent,
  };
}

const started = (replayed: boolean): Answer => ({
  status: 202,
  body: {
    requestId: "q",
    type: "workflow.run",
    data: { runId: RUN_ID, workflowName: "deploy", replayed },
  },
});

const failure = (
  status: number,
  code: string,
  headers?: Record<string, string>,
): Answer => ({
  status,
  body: { code, message: `m ${code}`, requestId: "q" },
  ...(headers ? { headers } : {}),
});

Deno.test("SwampActionClient.run: started, replayed, refused, not found and a reused key are outcomes", async () => {
  const { client, sent } = actions([
    started(false),
    started(true),
    failure(403, "forbidden"),
    failure(404, "not_found"),
    failure(409, "idempotency_conflict"),
  ]);
  const payload = { workflowIdOrName: "deploy", idempotencyKey: "slack:1" };
  assertEquals(await client.run(payload), {
    kind: "started",
    runId: RUN_ID,
    workflowName: "deploy",
  });
  assertEquals((await client.run(payload)).kind, "replayed");
  assertEquals(await client.run(payload), {
    kind: "refused",
    message: "m forbidden",
  });
  assertEquals((await client.run(payload)).kind, "not_found");
  assertEquals((await client.run(payload)).kind, "idempotency_conflict");
  assertEquals(sent[0].body, { type: "workflow.run", payload });
  assertEquals(sent[0].url, `${SERVE}/api/v1/action`);
});

Deno.test("SwampActionClient.run: after a lost reply or still_working it sends the same key again and gets the replay", async () => {
  const { client, sent } = actions([
    "network_error",
    failure(503, "still_working", { "retry-after": "0" }),
    started(true),
  ]);
  const out = await client.run({
    workflowIdOrName: "deploy",
    idempotencyKey: "k",
  });
  assertEquals(out.kind, "replayed");
  assertEquals(
    sent.map((s) => (s.body.payload as Record<string, string>).idempotencyKey),
    ["k", "k", "k"],
  );
});

Deno.test("SwampActionClient.approve: an unknown outcome is answered, never sent twice", async () => {
  const { client, sent } = actions([failure(500, "outcome_unknown")]);
  assertEquals(await client.approve(DECISION), {
    kind: "outcome_unknown",
    requestId: "q",
  });
  const lost = actions(["network_error"]);
  assertEquals((await lost.client.reject(DECISION)).kind, "outcome_unknown");
  assertEquals(sent.length + lost.sent.length, 2);
});

Deno.test("SwampActionClient.approve: decided, and each gate refusal by name", async () => {
  const decided = {
    runId: RUN_ID,
    workflowName: "deploy",
    stepName: "gate",
    approved: true,
    decidedBy: "user:pat",
    reason: null,
    allGatesDecided: true,
  };
  const codes = [
    "already_decided",
    "gate_closed",
    "gate_not_open",
    "gate_reopened",
    "ambiguous_gate",
  ];
  const { client } = actions([
    {
      status: 200,
      body: { requestId: "q", type: "workflow.approve", data: decided },
    },
    ...codes.map((c) => failure(409, c)),
    failure(403, "forbidden"),
  ]);
  const first = await client.approve(DECISION);
  assert(first.kind === "decided");
  assertEquals(first.decision.decidedBy, "user:pat");
  for (const code of codes) {
    assertEquals((await client.approve(DECISION)).kind, code);
  }
  assertEquals((await client.approve(DECISION)).kind, "refused");
});

Deno.test("SwampActionClient.resume: started, not suspended and not resumable", async () => {
  const { client } = actions([
    { ...started(false) as object, status: 202 } as Answer,
    failure(409, "run_not_suspended"),
    failure(409, "run_not_resumable"),
  ]);
  const payload = { workflowIdOrName: "deploy", runId: RUN_ID };
  assertEquals((await client.resume(payload)).kind, "started");
  assertEquals((await client.resume(payload)).kind, "not_suspended");
  assertEquals((await client.resume(payload)).kind, "not_resumable");
});

Deno.test("SwampActionClient.signal: delivered, pending, accepted, an invalid payload and a settled wait", async () => {
  const receipt = { id: "s", receivedAt: "t", submittedBy: "user:pat" };
  const { client } = actions([
    {
      status: 200,
      body: {
        requestId: "q",
        type: "workflow.signal",
        data: { waitId: "w", signal: { ...receipt, waitId: "w" } },
      },
    },
    {
      status: 202,
      body: {
        requestId: "q",
        type: "workflow.signal",
        data: { pending: { signal: receipt, heldUntil: "t" } },
      },
    },
    {
      status: 202,
      body: {
        requestId: "q",
        type: "workflow.signal",
        data: { accepted: { signal: receipt } },
      },
    },
    {
      status: 422,
      body: {
        code: "invalid_payload",
        message: "m",
        errors: ["x is required"],
      },
    },
    failure(409, "already_settled"),
  ]);
  const by = { workflow: "deploy", key: "ready", payload: {} };
  assertEquals((await client.signal(by)).kind, "delivered");
  assertEquals((await client.signal(by)).kind, "pending");
  assertEquals((await client.signal(by)).kind, "accepted");
  assertEquals(await client.signal(by), {
    kind: "invalid_payload",
    errors: ["x is required"],
  });
  assertEquals((await client.signal(by)).kind, "already_settled");
});

Deno.test("SwampActionClient: a 401 asks the token source once for another token and sends again", async () => {
  const asked: string[] = [];
  const source: TokenSource = {
    accessToken: () => Promise.resolve("old"),
    unauthorized: (refused) => {
      asked.push(refused);
      return Promise.resolve("new");
    },
  };
  const { client, sent } = actions([
    failure(401, "unauthorized"),
    started(false),
  ], source);
  assertEquals(
    (await client.run({ workflowIdOrName: "d", idempotencyKey: "k" })).kind,
    "started",
  );
  assertEquals(asked, ["old"]);
  assertEquals(sent.map((s) => s.authorization), ["Bearer old", "Bearer new"]);

  const twice = actions([
    failure(401, "unauthorized"),
    failure(401, "unauthorized"),
  ], source);
  const error = await assertRejects(
    () => twice.client.approvals(),
    SwampHttpError,
  );
  assertEquals(error.code, "unauthorized");
});

Deno.test("SwampActionClient: a fixed token refused with 401 is not sent again", async () => {
  const { client, sent } = actions([failure(401, "unauthorized")], "fixed");
  const error = await assertRejects(() => client.approvals(), SwampHttpError);
  assertEquals(error.code, "unauthorized");
  assertEquals(sent.length, 1);
});

Deno.test("SwampActionClient: rate limits are retried after Retry-After; a type serve lacks is action_unavailable", async () => {
  const { client, sent } = actions([
    failure(429, "rate_limited", { "retry-after": "0" }),
    {
      status: 200,
      body: {
        requestId: "q",
        type: "workflow.approvals",
        data: { approvals: [], expired: [] },
      },
    },
  ]);
  assertEquals(await client.approvals(), { approvals: [], expired: [] });
  assertEquals(sent.length, 2);

  const old = actions([failure(404, "type_not_allowed")]);
  const error = await assertRejects(
    () => old.client.approvals(),
    SwampHttpError,
  );
  assertEquals(error.code, "action_unavailable");
  assertEquals(error.actionType, "workflow.approvals");
});

Deno.test("SwampActionClient: the token never appears in an error, JSON or printed form", async () => {
  const secret = "swda1.0f4b7c4e-8d55-4c1a-9f1e-3a2b1c0d9e8f." + "b".repeat(64);
  const { client } = actions([
    {
      status: 500,
      body: { code: "action_failed", message: `failed for ${secret}` },
    },
  ], secret);
  const error = await assertRejects(() => client.approvals(), SwampHttpError);
  for (
    const text of [
      error.message,
      String(error),
      JSON.stringify(error),
      Deno.inspect(error),
      String(error.stack),
      JSON.stringify(client),
      Deno.inspect(client),
    ]
  ) {
    assert(!text.includes(secret), text);
  }
});
