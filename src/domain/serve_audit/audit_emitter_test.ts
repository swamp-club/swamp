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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { AuditEmitter } from "./audit_emitter.ts";
import type { AuditEvent } from "./audit_event.ts";
import { createAuditEvent } from "./audit_event.ts";
import type { AuditSink } from "./audit_sink.ts";
import { type AlertRuleConfig, AlertRuleEngine } from "./audit_alerts.ts";
import {
  generateHmacKeyBytes,
  HmacKeyRegistry,
  importHmacKey,
} from "./audit_hmac.ts";

await initializeLogging({});

function makeEvent(action: string): AuditEvent {
  return createAuditEvent({
    instanceId: "inst-1",
    category: "auth",
    stage: "response",
    outcome: "success",
    action,
    resourceKind: "access",
    resourceName: "*",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
  });
}

function createMockSink(
  name: string,
  durable = true,
): AuditSink & {
  written: AuditEvent[][];
  flushed: number;
  closed: boolean;
} {
  const sink = {
    name,
    durable,
    written: [] as AuditEvent[][],
    flushed: 0,
    closed: false,
    write(events: readonly AuditEvent[]): Promise<void> {
      sink.written.push([...events]);
      return Promise.resolve();
    },
    flush(): Promise<void> {
      sink.flushed++;
      return Promise.resolve();
    },
    close(): Promise<void> {
      sink.closed = true;
      return Promise.resolve();
    },
  };
  return sink;
}

Deno.test("AuditEmitter: emits events to sinks via drain", async () => {
  const sink = createMockSink("test");
  const emitter = new AuditEmitter([sink]);
  const event = makeEvent("access.check");

  emitter.emit(event);

  await emitter.flush();

  assertEquals(sink.written.length, 1);
  assertEquals(sink.written[0].length, 1);
  assertEquals(sink.written[0][0].action, "access.check");
});

Deno.test("AuditEmitter: batches multiple events in single drain", async () => {
  const sink = createMockSink("test");
  const emitter = new AuditEmitter([sink]);

  emitter.emit(makeEvent("a"));
  emitter.emit(makeEvent("b"));
  emitter.emit(makeEvent("c"));

  await emitter.flush();

  assertEquals(sink.written.length, 1);
  assertEquals(sink.written[0].length, 3);
});

Deno.test("AuditEmitter: supports multiple sinks", async () => {
  const sinkA = createMockSink("a");
  const sinkB = createMockSink("b");
  const emitter = new AuditEmitter([sinkA, sinkB]);

  emitter.emit(makeEvent("test"));
  await emitter.flush();

  assertEquals(sinkA.written.length, 1);
  assertEquals(sinkB.written.length, 1);
});

Deno.test("AuditEmitter: chain state preserved when non-durable sink fails but durable succeeds", async () => {
  const durableSink = createMockSink("durable", true);
  const nonDurableSink: AuditSink = {
    name: "non-durable",
    durable: false,
    write(): Promise<void> {
      return Promise.reject(new Error("non-durable failed"));
    },
    flush(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  const emitter = new AuditEmitter([durableSink, nonDurableSink]);
  const initialSeq = emitter.chainState.sequence;

  emitter.emit(makeEvent("test"));
  await emitter.flush();

  assertEquals(durableSink.written.length, 1);
  assertEquals(emitter.chainState.sequence, initialSeq + 1);
});

Deno.test("AuditEmitter: chain state rolled back when only non-durable sink succeeds", async () => {
  const failingDurable: AuditSink = {
    name: "durable",
    durable: true,
    write(): Promise<void> {
      return Promise.reject(new Error("durable failed"));
    },
    flush(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  const nonDurableSink = createMockSink("non-durable", false);
  const emitter = new AuditEmitter([failingDurable, nonDurableSink]);
  const initialSeq = emitter.chainState.sequence;

  emitter.emit(makeEvent("test"));
  await emitter.flush();

  assertEquals(nonDurableSink.written.length, 1);
  assertEquals(emitter.chainState.sequence, initialSeq);
});

Deno.test("AuditEmitter: sink error does not propagate to caller", async () => {
  const failingSink: AuditSink = {
    name: "failing",
    durable: true,
    write(): Promise<void> {
      return Promise.reject(new Error("sink failure"));
    },
    flush(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  const emitter = new AuditEmitter([failingSink]);

  emitter.emit(makeEvent("test"));
  await emitter.flush();
});

Deno.test("AuditEmitter: close flushes then closes all sinks", async () => {
  const sink = createMockSink("test");
  const emitter = new AuditEmitter([sink]);

  emitter.emit(makeEvent("test"));
  await emitter.close();

  assertEquals(sink.written.length, 1);
  assertEquals(sink.flushed, 1);
  assertEquals(sink.closed, true);
});

Deno.test("AuditEmitter: suppresses success event for already-denied request", async () => {
  const sink = createMockSink("test");
  const emitter = new AuditEmitter([sink]);

  const deniedEvent = createAuditEvent({
    instanceId: "inst-1",
    category: "access",
    stage: "response",
    outcome: "denied",
    action: "vault.get",
    resourceKind: "vault",
    resourceName: "prod",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-dup",
    detail: "unauthorized",
  });

  const falseSuccess = createAuditEvent({
    instanceId: "inst-1",
    category: "secrets",
    stage: "response",
    outcome: "success",
    action: "vault.get",
    resourceKind: "vault",
    resourceName: "prod",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-dup",
  });

  emitter.emit(deniedEvent);
  emitter.emit(falseSuccess);
  await emitter.flush();

  const allEvents = sink.written.flat();
  assertEquals(allEvents.length, 1);
  assertEquals(allEvents[0].outcome, "denied");
});

Deno.test("AuditEmitter: allows success for non-denied request", async () => {
  const sink = createMockSink("test");
  const emitter = new AuditEmitter([sink]);

  const denied = createAuditEvent({
    instanceId: "inst-1",
    category: "access",
    stage: "response",
    outcome: "denied",
    action: "vault.get",
    resourceKind: "vault",
    resourceName: "prod",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-denied",
  });

  const success = createAuditEvent({
    instanceId: "inst-1",
    category: "execution",
    stage: "response",
    outcome: "success",
    action: "model.method.run",
    resourceKind: "model",
    resourceName: "echo",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: "req-ok",
  });

  emitter.emit(denied);
  emitter.emit(success);
  await emitter.flush();

  const allEvents = sink.written.flat();
  assertEquals(allEvents.length, 2);
});

// ── Integration tests for Phase 5 features ──────────────────────────

Deno.test("AuditEmitter: uses HmacKeyRegistry for HMAC when provided", async () => {
  const sink = createMockSink("test");
  const rawKey = await generateHmacKeyBytes();
  const cryptoKey = await importHmacKey(rawKey);
  const registry = new HmacKeyRegistry([{ version: 1, key: cryptoKey }]);
  const emitter = new AuditEmitter({
    sinks: [sink],
    hmacKeyRegistry: registry,
  });

  emitter.emit(makeEvent("access.check"));
  await emitter.flush();

  assertEquals(sink.written.length, 1);
  const event = sink.written[0][0];
  assertEquals(event.hmacKeyVersion, 1);
});

Deno.test("AuditEmitter: alert engine fires on matching events", async () => {
  const sink = createMockSink("test");
  const rule: AlertRuleConfig = {
    name: "test-rule",
    match: { category: "auth", outcome: "denied" },
    threshold: { count: 1, windowSeconds: 60 },
    action: { type: "log" },
  };
  const engine = new AlertRuleEngine([rule]);
  const emitter = new AuditEmitter({
    sinks: [sink],
    alertEngine: engine,
  });

  const deniedEvent = createAuditEvent({
    instanceId: "inst-1",
    category: "auth",
    stage: "response",
    outcome: "denied",
    action: "login",
    resourceKind: "access",
    resourceName: "*",
    principalKind: "user",
    principalId: "attacker",
    initiatedBy: "user:attacker",
    sourceIp: "10.0.0.1",
    requestId: crypto.randomUUID(),
  });

  emitter.emit(deniedEvent);
  await emitter.flush();
  await emitter.flush();

  const allEvents = sink.written.flat();
  assert(
    allEvents.length >= 2,
    `Expected at least 2 events, got ${allEvents.length}`,
  );

  const alertEvent = allEvents.find((e) => e.action === "alert.fired");
  assert(alertEvent, "Expected an alert.fired event");
  assertEquals(alertEvent.category, "system");
  assertEquals(alertEvent.resourceKind, "alert-rule");
  assertEquals(alertEvent.resourceName, "test-rule");
});

Deno.test("AuditEmitter: alert engine recursion guard prevents alert-on-alert", async () => {
  const sink = createMockSink("test");
  const rule: AlertRuleConfig = {
    name: "catch-system",
    match: { category: "system" },
    threshold: { count: 1, windowSeconds: 60 },
    action: { type: "log" },
  };
  const engine = new AlertRuleEngine([rule]);
  const emitter = new AuditEmitter({
    sinks: [sink],
    alertEngine: engine,
  });

  const systemEvent = createAuditEvent({
    instanceId: "inst-1",
    category: "system",
    stage: "response",
    outcome: "success",
    action: "alert.fired",
    resourceKind: "alert-rule",
    resourceName: "other-rule",
    principalKind: "system",
    principalId: "audit-engine",
    initiatedBy: "audit-engine",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
  });

  emitter.emit(systemEvent);
  await emitter.flush();

  const allEvents = sink.written.flat();
  assertEquals(allEvents.length, 1);
});

Deno.test("AuditEmitter: replaceSinks swaps sinks and new sink receives events", async () => {
  const sink1 = createMockSink("sink1");
  const emitter = new AuditEmitter([sink1]);

  emitter.emit(makeEvent("first"));
  await emitter.flush();
  assertEquals(sink1.written.flat().length, 1);

  const sink2 = createMockSink("sink2");
  emitter.replaceSinks([sink2]);

  emitter.emit(makeEvent("second"));
  await emitter.flush();

  assertEquals(sink1.written.flat().length, 1);
  assertEquals(sink2.written.flat().length, 1);
  assertEquals(sink2.written.flat()[0].action, "second");
});

Deno.test("AuditEmitter: sink timeout prevents drain loop blocking", async () => {
  const hangingSink: AuditSink = {
    name: "hanging",
    durable: true,
    write(): Promise<void> {
      return new Promise(() => {});
    },
    flush(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  const emitter = new AuditEmitter({
    sinks: [hangingSink],
    sinkTimeoutMs: 100,
  });

  emitter.emit(makeEvent("test"));
  await emitter.flush();
});
