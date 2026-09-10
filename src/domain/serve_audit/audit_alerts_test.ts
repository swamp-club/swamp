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
import { type AlertRuleConfig, AlertRuleEngine } from "./audit_alerts.ts";
import { createAuditEvent } from "./audit_event.ts";
import type { AuditEvent } from "./audit_event.ts";

function makeEvent(
  overrides?: Partial<Parameters<typeof createAuditEvent>[0]>,
): AuditEvent {
  return createAuditEvent({
    instanceId: "test-instance",
    category: "auth",
    stage: "response",
    outcome: "denied",
    action: "auth.login",
    resourceKind: "session",
    resourceName: "login",
    principalKind: "user",
    principalId: "attacker",
    initiatedBy: "attacker",
    sourceIp: "10.0.0.1",
    requestId: crypto.randomUUID(),
    ...overrides,
  });
}

function bruteForceRule(
  overrides?: Partial<AlertRuleConfig>,
): AlertRuleConfig {
  return {
    name: "brute-force-auth",
    description: "Multiple denied auth attempts",
    match: { category: "auth", outcome: "denied" },
    threshold: { count: 3, windowSeconds: 60 },
    action: { type: "log" },
    ...overrides,
  };
}

Deno.test("AlertRuleEngine: matches event by category", () => {
  const now = 1000;
  const engine = new AlertRuleEngine(
    [bruteForceRule({ threshold: { count: 1, windowSeconds: 60 } })],
    () => now,
  );
  const event = makeEvent({ category: "auth", outcome: "denied" });
  const fired = engine.evaluate(event);
  assertEquals(fired.length, 1);
  assertEquals(fired[0].ruleName, "brute-force-auth");
});

Deno.test("AlertRuleEngine: does not match unrelated category", () => {
  const now = 1000;
  const engine = new AlertRuleEngine(
    [bruteForceRule({ threshold: { count: 1, windowSeconds: 60 } })],
    () => now,
  );
  const event = makeEvent({ category: "execution", outcome: "denied" });
  const fired = engine.evaluate(event);
  assertEquals(fired.length, 0);
});

Deno.test("AlertRuleEngine: matches by category and outcome", () => {
  const now = 1000;
  const engine = new AlertRuleEngine(
    [bruteForceRule({ threshold: { count: 1, windowSeconds: 60 } })],
    () => now,
  );

  const denied = makeEvent({ category: "auth", outcome: "denied" });
  assertEquals(engine.evaluate(denied).length, 1);
});

Deno.test("AlertRuleEngine: does not match wrong outcome", () => {
  const now = 1000;
  const engine = new AlertRuleEngine(
    [bruteForceRule({ threshold: { count: 1, windowSeconds: 60 } })],
    () => now,
  );

  const success = makeEvent({ category: "auth", outcome: "success" });
  assertEquals(engine.evaluate(success).length, 0);
});

Deno.test("AlertRuleEngine: does not fire below threshold", () => {
  let now = 1000;
  const engine = new AlertRuleEngine([bruteForceRule()], () => now);

  engine.evaluate(makeEvent());
  now += 1000;
  const fired = engine.evaluate(makeEvent());
  assertEquals(fired.length, 0);

  const statuses = engine.status();
  assertEquals(statuses[0].state, "armed");
  assertEquals(statuses[0].windowCount, 2);
});

Deno.test("AlertRuleEngine: fires when threshold is met", () => {
  let now = 1000;
  const engine = new AlertRuleEngine([bruteForceRule()], () => now);

  engine.evaluate(makeEvent());
  now += 1000;
  engine.evaluate(makeEvent());
  now += 1000;
  const fired = engine.evaluate(makeEvent());
  assertEquals(fired.length, 1);
  assertEquals(fired[0].ruleName, "brute-force-auth");
  assertEquals(fired[0].windowCount, 3);
  assertEquals(fired[0].action, { type: "log" });

  const statuses = engine.status();
  assertEquals(statuses[0].state, "cooldown");
});

Deno.test("AlertRuleEngine: cooldown prevents re-firing", () => {
  let now = 1000;
  const engine = new AlertRuleEngine([bruteForceRule()], () => now);

  for (let i = 0; i < 3; i++) {
    engine.evaluate(makeEvent());
    now += 1000;
  }

  const fired = engine.evaluate(makeEvent());
  assertEquals(fired.length, 0);

  const statuses = engine.status();
  assertEquals(statuses[0].state, "cooldown");
});

Deno.test("AlertRuleEngine: cooldown expires when window drops below threshold", () => {
  let now = 0;
  const engine = new AlertRuleEngine(
    [bruteForceRule({ threshold: { count: 3, windowSeconds: 5 } })],
    () => now,
  );

  for (let i = 0; i < 3; i++) {
    engine.evaluate(makeEvent());
    now += 1000;
  }
  assertEquals(engine.status()[0].state, "cooldown");

  now += 10_000;
  engine.evaluate(makeEvent());
  assertEquals(engine.status()[0].state, "armed");
});

Deno.test("AlertRuleEngine: re-fires after cooldown expires and threshold met again", () => {
  let now = 0;
  const engine = new AlertRuleEngine(
    [bruteForceRule({ threshold: { count: 3, windowSeconds: 5 } })],
    () => now,
  );

  for (let i = 0; i < 3; i++) {
    engine.evaluate(makeEvent());
    now += 1000;
  }
  assertEquals(engine.status()[0].state, "cooldown");

  now += 10_000;

  for (let i = 0; i < 2; i++) {
    engine.evaluate(makeEvent());
    now += 500;
  }
  const fired = engine.evaluate(makeEvent());
  assertEquals(fired.length, 1);
  assertEquals(fired[0].ruleName, "brute-force-auth");
});

Deno.test("AlertRuleEngine: recursion guard skips system/alert.* events", () => {
  const now = 1000;
  const engine = new AlertRuleEngine(
    [{
      name: "catch-all",
      match: {},
      threshold: { count: 1, windowSeconds: 60 },
      action: { type: "log" },
    }],
    () => now,
  );

  const alertEvent = makeEvent({
    category: "system",
    action: "alert.fired",
    outcome: "success",
  });
  const fired = engine.evaluate(alertEvent);
  assertEquals(fired.length, 0);
  assertEquals(engine.status()[0].windowCount, 0);
});

Deno.test("AlertRuleEngine: recursion guard allows non-alert system events", () => {
  const now = 1000;
  const engine = new AlertRuleEngine(
    [{
      name: "catch-all",
      match: {},
      threshold: { count: 1, windowSeconds: 60 },
      action: { type: "log" },
    }],
    () => now,
  );

  const systemEvent = makeEvent({
    category: "system",
    action: "instance.started",
    outcome: "success",
  });
  const fired = engine.evaluate(systemEvent);
  assertEquals(fired.length, 1);
});

Deno.test("AlertRuleEngine: status returns current state of all rules", () => {
  const now = 1000;
  const engine = new AlertRuleEngine(
    [
      bruteForceRule(),
      {
        name: "secret-access",
        match: { category: "secrets" },
        threshold: { count: 1, windowSeconds: 30 },
        action: { type: "webhook", url: "https://example.com/alert" },
      },
    ],
    () => now,
  );

  const statuses = engine.status();
  assertEquals(statuses.length, 2);
  assertEquals(statuses[0].name, "brute-force-auth");
  assertEquals(statuses[0].state, "armed");
  assertEquals(statuses[0].windowCount, 0);
  assertEquals(statuses[0].lastFiredAt, undefined);
  assertEquals(statuses[1].name, "secret-access");
  assertEquals(statuses[1].state, "armed");
});

Deno.test("AlertRuleEngine: window entries expire after windowSeconds", () => {
  let now = 0;
  const engine = new AlertRuleEngine(
    [bruteForceRule({ threshold: { count: 3, windowSeconds: 5 } })],
    () => now,
  );

  engine.evaluate(makeEvent());
  now += 1000;
  engine.evaluate(makeEvent());

  now += 10_000;
  engine.evaluate(makeEvent());

  const statuses = engine.status();
  assertEquals(statuses[0].windowCount, 1);
  assertEquals(statuses[0].state, "armed");
});

Deno.test("AlertRuleEngine: matches by principal", () => {
  const now = 1000;
  const engine = new AlertRuleEngine(
    [{
      name: "admin-watch",
      match: { principal: "admin" },
      threshold: { count: 1, windowSeconds: 60 },
      action: { type: "log" },
    }],
    () => now,
  );

  assertEquals(
    engine.evaluate(makeEvent({ principalId: "user1" })).length,
    0,
  );
  assertEquals(
    engine.evaluate(makeEvent({ principalId: "admin" })).length,
    1,
  );
});

Deno.test("AlertRuleEngine: fired event includes description and webhook action", () => {
  const now = 1000;
  const engine = new AlertRuleEngine(
    [{
      name: "secret-alert",
      description: "Sensitive vault access",
      match: { category: "secrets" },
      threshold: { count: 1, windowSeconds: 60 },
      action: { type: "webhook", url: "https://pagerduty.example.com/alert" },
    }],
    () => now,
  );

  const event = makeEvent({ category: "secrets", outcome: "success" });
  const fired = engine.evaluate(event);
  assertEquals(fired.length, 1);
  assertEquals(fired[0].ruleDescription, "Sensitive vault access");
  assertEquals(fired[0].action, {
    type: "webhook",
    url: "https://pagerduty.example.com/alert",
  });
  assertEquals(fired[0].matchedEventId, event.id);
});

Deno.test("AlertRuleEngine: lastFiredAt is set after firing", () => {
  const now = 5000;
  const engine = new AlertRuleEngine(
    [bruteForceRule({ threshold: { count: 1, windowSeconds: 60 } })],
    () => now,
  );

  engine.evaluate(makeEvent());
  const statuses = engine.status();
  assertEquals(statuses[0].lastFiredAt, new Date(5000).toISOString());
});
