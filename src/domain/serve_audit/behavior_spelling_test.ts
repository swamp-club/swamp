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

// The behavior spelling of audit filters, policy rules and alert rules
// (swamp-club#3334): matched in the stored model spelling.

import { assertEquals } from "@std/assert";
import {
  canonicalAuditAction,
  canonicalAuditResource,
  canonicalAuditResourceKind,
  canonicalOptional,
} from "./behavior_spelling.ts";
import { AuditPolicy } from "./audit_policy.ts";
import { AlertRuleEngine } from "./audit_alerts.ts";
import { AuditQueryService } from "./audit_query_service.ts";
import { createAuditEvent } from "./audit_event.ts";
import {
  AuditChainState,
  chainedEvent,
  inMemoryAuditStore,
} from "./behavior_spelling_test_helpers.ts";
import {
  BEHAVIOR_AUDIT_ACTION_PREFIX,
  BEHAVIOR_AUDIT_RESOURCE_PREFIX,
  MODEL_AUDIT_ACTION_PREFIX,
  MODEL_AUDIT_RESOURCE_PREFIX,
} from "../terminology/behavior_aliases.ts";

Deno.test("canonicalAuditAction: behavior. becomes model., nothing else changes", () => {
  assertEquals(canonicalAuditAction("behavior.method.run"), "model.method.run");
  assertEquals(
    canonicalAuditAction(BEHAVIOR_AUDIT_ACTION_PREFIX + "x"),
    MODEL_AUDIT_ACTION_PREFIX + "x",
  );
  for (
    const action of [
      "model.method.run",
      "workflow.run",
      "behaviour.method.run",
      "behaviors.run",
      "audit.query",
      "behavior",
      "",
    ]
  ) {
    assertEquals(canonicalAuditAction(action), action, action);
  }
});

Deno.test("canonicalAuditResource: behavior: becomes model:, nothing else changes", () => {
  assertEquals(canonicalAuditResource("behavior:web"), "model:web");
  assertEquals(
    canonicalAuditResource(BEHAVIOR_AUDIT_RESOURCE_PREFIX + "x"),
    MODEL_AUDIT_RESOURCE_PREFIX + "x",
  );
  for (
    const r of ["model:web", "workflow:w", "behaviour:web", "data:behavior:x"]
  ) {
    assertEquals(canonicalAuditResource(r), r, r);
  }
  assertEquals(canonicalAuditResourceKind("behavior"), "model");
  assertEquals(canonicalAuditResourceKind("behaviour"), "behaviour");
  assertEquals(canonicalAuditResourceKind("workflow"), "workflow");
  assertEquals(canonicalOptional(undefined, canonicalAuditAction), undefined);
  assertEquals(
    canonicalOptional("behavior.x", canonicalAuditAction),
    "model.x",
  );
});

Deno.test("AuditPolicy: a behavior-spelled rule matches the model-spelled action and keeps its configured form", () => {
  const rules = [
    {
      action: "behavior.method.run",
      level: "requestResponse" as const,
      hmac: false,
    },
  ];
  const policy = new AuditPolicy(rules, "metadata");
  assertEquals(
    policy.evaluate("execution", "model.method.run"),
    "requestResponse",
  );
  assertEquals(policy.shouldHmac("execution", "model.method.run"), false);
  assertEquals(policy.evaluate("execution", "workflow.run"), "metadata");
  // The rules as configured, never rewritten.
  assertEquals(policy.rules, rules);
  assertEquals(policy.rules[0].action, "behavior.method.run");
});

Deno.test("AlertRuleEngine: a behavior-spelled rule fires on the model-spelled action", () => {
  const match = { action: "behavior.method.run" };
  const engine = new AlertRuleEngine([{
    name: "r",
    match,
    threshold: { count: 1, windowSeconds: 60 },
    action: { type: "log" },
  }], () => 1000);
  const event = (action: string) =>
    createAuditEvent({
      instanceId: "i",
      category: "execution",
      stage: "response",
      outcome: "success",
      action,
      resourceKind: "model",
      resourceName: "m",
      principalKind: "user",
      principalId: "u",
      initiatedBy: "user:u",
      sourceIp: "127.0.0.1",
      requestId: crypto.randomUUID(),
    });
  assertEquals(engine.evaluate(event("workflow.run")).length, 0);
  assertEquals(engine.evaluate(event("model.method.run")).length, 1);
  assertEquals(match.action, "behavior.method.run");
});

Deno.test("AuditQueryService: behavior-spelled action and resource filters select the model-spelled events", async () => {
  const chain = new AuditChainState();
  const events = [
    await chainedEvent(chain, "model.method.run", "model", "web"),
    await chainedEvent(chain, "model.method.run", "model", "db"),
    await chainedEvent(chain, "workflow.run", "workflow", "web"),
  ];
  const service = new AuditQueryService(inMemoryAuditStore(events));
  const since = new Date(Date.now() - 60_000).toISOString();
  const ids = async (filters: Record<string, string>) =>
    (await service.query({ since, ...filters })).events.map((e) => e.id);
  assertEquals(await ids({ action: "behavior.method.run" }), [
    events[0].id,
    events[1].id,
  ]);
  assertEquals(await ids({ resource: "behavior:web" }), [events[0].id]);
  assertEquals(await ids({ resource: "model:web" }), [events[0].id]);
  assertEquals(await ids({ action: "behaviour.method.run" }), []);
  const streamed: string[] = [];
  for await (
    const batch of service.queryStream({ since, action: "behavior.method.run" })
  ) {
    streamed.push(...batch.map((e) => e.id));
  }
  assertEquals(streamed, [events[0].id, events[1].id]);
});
