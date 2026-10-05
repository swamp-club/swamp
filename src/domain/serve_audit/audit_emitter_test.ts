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
import { waitFor } from "@swamp-club/swamp-testing";
import { verifyChain } from "./audit_chain.ts";
import type { AuditEvent, ChainedAuditEvent } from "./audit_event.ts";
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

function createFlakySink(
  name: string,
  durable: boolean,
): AuditSink & {
  failing: boolean;
  writes: number;
  received: ChainedAuditEvent[];
} {
  const sink = {
    name,
    durable,
    failing: false,
    writes: 0,
    received: [] as ChainedAuditEvent[],
    write(events: readonly AuditEvent[]): Promise<void> {
      sink.writes++;
      if (sink.failing) return Promise.reject(new Error(`${name} failed`));
      sink.received.push(...(events as ChainedAuditEvent[]));
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return sink;
}

function createHangingSink(
  name: string,
  durable = false,
): AuditSink & {
  writes: number;
  batches: AuditEvent[][];
  release(): void;
  fail(): void;
} {
  const pending: (() => void)[] = [];
  const failing: ((error: Error) => void)[] = [];
  const sink = {
    name,
    durable,
    writes: 0,
    batches: [] as AuditEvent[][],
    write(events: readonly AuditEvent[]): Promise<void> {
      sink.writes++;
      sink.batches.push([...events]);
      return new Promise<void>((resolve, reject) => {
        pending.push(resolve);
        failing.push(reject);
      });
    },
    release(): void {
      failing.length = 0;
      for (const resolve of pending.splice(0)) resolve();
    },
    fail(): void {
      pending.length = 0;
      for (const reject of failing.splice(0)) reject(new Error("late failure"));
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
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

Deno.test("AuditEmitter: durable retry delivers the sequence and digest other sinks saw", async () => {
  const durableSink = createFlakySink("durable", true);
  durableSink.failing = true;
  const nonDurableSink = createMockSink("non-durable", false);
  const emitter = new AuditEmitter([durableSink, nonDurableSink]);
  const initialSeq = emitter.chainState.sequence;

  emitter.emit(makeEvent("test"));
  await emitter.flush();

  assertEquals(nonDurableSink.written.length, 1);
  assertEquals(durableSink.received.length, 0);

  durableSink.failing = false;
  await emitter.flush();

  const [seen] = nonDurableSink.written.flat() as ChainedAuditEvent[];
  assertEquals(durableSink.received.length, 1);
  assertEquals(durableSink.received[0].sequence, seen.sequence);
  assertEquals(durableSink.received[0].digest, seen.digest);
  assertEquals(emitter.chainState.sequence, initialSeq + 1);
  await emitter.close();
});

Deno.test("AuditEmitter: durable sink receives every event while a non-durable sink keeps failing", async () => {
  let now = 0;
  const durableSink = createFlakySink("durable", true);
  const failingSink = createFlakySink("failing", false);
  failingSink.failing = true;
  const emitter = new AuditEmitter({
    sinks: [durableSink, failingSink],
    capacity: 4,
    now: () => now,
  });

  const actions: string[] = [];
  for (let i = 0; i < 12; i++) {
    actions.push(`action-${i}`);
    emitter.emit(makeEvent(`action-${i}`));
    await emitter.flush();
  }

  assertEquals(durableSink.received.map((e) => e.action), actions);
  assertEquals((await verifyChain(durableSink.received)).valid, true);

  // Once its backoff ends the failing sink is moved up to what is still
  // held, and the events it missed are counted against it alone.
  now += 60_000;
  await emitter.flush();
  assertEquals(emitter.droppedEvents("failing"), 8);
  assertEquals(emitter.droppedEvents("durable"), 0);
  await emitter.close();
});

Deno.test("AuditEmitter: replay to a lagging sink keeps the durable chain valid", async () => {
  let now = 0;
  const durableSink = createFlakySink("durable", true);
  const laggingSink = createFlakySink("lagging", false);
  laggingSink.failing = true;
  const emitter = new AuditEmitter({
    sinks: [durableSink, laggingSink],
    now: () => now,
  });

  for (let i = 0; i < 3; i++) {
    emitter.emit(makeEvent(`action-${i}`));
    await emitter.flush();
    now += 60_000;
  }
  laggingSink.failing = false;
  emitter.emit(makeEvent("action-3"));
  await emitter.flush();

  assertEquals(durableSink.received.map((e) => e.sequence), [1, 2, 3, 4]);
  assertEquals((await verifyChain(durableSink.received)).valid, true);
  // The replayed copies are the ones the durable sink recorded.
  assertEquals(laggingSink.received, durableSink.received);
  await emitter.close();
});

Deno.test("AuditEmitter: hanging non-durable sink does not delay durable writes", async () => {
  const hanging = createHangingSink("hanging");
  const durableSink = createFlakySink("durable", true);
  const emitter = new AuditEmitter([hanging, durableSink]);

  emitter.emit(makeEvent("test"));
  await waitFor(
    () => durableSink.received.length === 1,
    "durable write while the non-durable sink hangs",
  );
  assertEquals(hanging.writes, 1);

  hanging.release();
  await emitter.close();
});

Deno.test("AuditEmitter: timed-out sink gets no second write while the first is pending", async () => {
  let now = 0;
  const hanging = createHangingSink("hanging");
  const durableSink = createFlakySink("durable", true);
  const emitter = new AuditEmitter({
    sinks: [hanging, durableSink],
    sinkTimeoutMs: 20,
    now: () => now,
  });

  emitter.emit(makeEvent("first"));
  await emitter.flush();
  now += 60_000;
  emitter.emit(makeEvent("second"));
  await emitter.flush();

  assertEquals(durableSink.received.length, 2);
  assertEquals(hanging.writes, 1);

  hanging.release();
  await waitFor(async () => {
    now += 60_000;
    await emitter.flush();
    return hanging.writes === 2;
  }, "a new write once the pending one settled");
  await emitter.close();
});

Deno.test("AuditEmitter: a timed-out write that later succeeds resumes delivery without a new event", async () => {
  const hanging = createHangingSink("hanging");
  const emitter = new AuditEmitter({
    sinks: [createMockSink("durable"), hanging],
    sinkTimeoutMs: 20,
  });

  emitter.emit(makeEvent("first"));
  await emitter.flush();
  emitter.emit(makeEvent("second"));
  await emitter.flush();
  assertEquals(hanging.writes, 1);

  hanging.release();
  await waitFor(() => hanging.writes === 2, "delivery to resume by itself");

  // The late success counted as delivered, so only the newer event is sent.
  assertEquals(hanging.batches[1].map((e) => e.action), ["second"]);
  hanging.release();
  await emitter.close();
});

Deno.test("AuditEmitter: a timed-out write that later fails backs off from when it failed", async () => {
  let now = 0;
  const hanging = createHangingSink("hanging");
  const emitter = new AuditEmitter({
    sinks: [createMockSink("durable"), hanging],
    sinkTimeoutMs: 20,
    sinkBackoffBaseMs: 1_000,
    now: () => now,
  });

  emitter.emit(makeEvent("first"));
  await emitter.flush();
  assertEquals(hanging.writes, 1);

  // The sink answers with an error long after the timeout's own backoff.
  now += 5_000;
  hanging.fail();
  await emitter.flush();
  assertEquals(hanging.writes, 1);

  now += 1_000;
  await emitter.flush();
  assertEquals(hanging.writes, 2);
  hanging.release();
  await emitter.close();
});

Deno.test("AuditEmitter: a timed-out durable write is not written again while it is pending", async () => {
  const durableSink = createHangingSink("wal", true);
  const emitter = new AuditEmitter({
    sinks: [durableSink],
    sinkTimeoutMs: 20,
    durableRetryMs: 1,
  });

  emitter.emit(makeEvent("first"));
  await emitter.flush();
  assert(emitter.durableStalled);
  emitter.emit(makeEvent("second"));
  await emitter.flush();
  assertEquals(durableSink.writes, 1);

  durableSink.release();
  await waitFor(() => durableSink.writes === 2, "delivery to resume by itself");
  // The late success counted as delivered, so only the newer event is sent.
  assertEquals(durableSink.batches[1].map((e) => e.action), ["second"]);
  durableSink.release();
  await waitFor(() => !emitter.durableStalled, "the stall to clear");
  await emitter.close();
  assertEquals(durableSink.writes, 2);
});

Deno.test("AuditEmitter: a timed-out durable write that later fails is retried once it settles", async () => {
  const durableSink = createHangingSink("wal", true);
  const emitter = new AuditEmitter({
    sinks: [durableSink],
    sinkTimeoutMs: 20,
    durableRetryMs: 1,
  });

  emitter.emit(makeEvent("first"));
  await emitter.flush();
  assertEquals(durableSink.writes, 1);

  durableSink.fail();
  await waitFor(
    () => durableSink.writes === 2,
    "the failed batch to be retried",
  );
  assertEquals(durableSink.batches[1].map((e) => e.action), ["first"]);
  durableSink.release();
  await emitter.close();
});

Deno.test("AuditEmitter: sinks with the same name each receive every event when one fails", async () => {
  const first = createFlakySink("webhook:siem.example.com", false);
  const second = createFlakySink("webhook:siem.example.com", false);
  second.failing = true;
  const emitter = new AuditEmitter({
    sinks: [createMockSink("durable"), first, second],
    sinkBackoffBaseMs: 1,
  });

  emitter.emit(makeEvent("one"));
  emitter.emit(makeEvent("two"));
  await emitter.flush();
  assertEquals(first.received.length, 2);

  second.failing = false;
  await waitFor(async () => {
    await emitter.flush();
    return second.received.length === 2;
  }, "the failed sink to catch up");
  assertEquals(second.received.map((e) => e.action), ["one", "two"]);
  assertEquals(emitter.droppedEvents("webhook:siem.example.com#2"), 0);
  await emitter.close();
});

Deno.test("AuditEmitter: replaceSinks keeps the cursor of each same-named sink", async () => {
  const durableSink = createMockSink("durable");
  const first = createFlakySink("syslog:collector:514", false);
  const second = createFlakySink("syslog:collector:514", false);
  second.failing = true;
  const emitter = new AuditEmitter({ sinks: [durableSink, first, second] });

  emitter.emit(makeEvent("before"));
  await emitter.flush();

  const newFirst = createFlakySink("syslog:collector:514", false);
  const newSecond = createFlakySink("syslog:collector:514", false);
  emitter.replaceSinks([durableSink, newFirst, newSecond]);
  emitter.emit(makeEvent("after"));
  await emitter.flush();

  assertEquals(newFirst.received.map((e) => e.action), ["after"]);
  assertEquals(newSecond.received.map((e) => e.action), ["before", "after"]);
  await emitter.close();
});

Deno.test("AuditEmitter: a replaced sink's late success does not move its replacement's cursor", async () => {
  const durableSink = createMockSink("durable");
  const hanging = createHangingSink("external");
  const emitter = new AuditEmitter({
    sinks: [durableSink, hanging],
    sinkTimeoutMs: 20,
    sinkBackoffBaseMs: 1,
  });

  emitter.emit(makeEvent("first"));
  await emitter.flush();
  assertEquals(hanging.writes, 1);

  const replacement = createFlakySink("external", false);
  replacement.failing = true;
  emitter.replaceSinks([durableSink, replacement]);
  hanging.release();
  emitter.emit(makeEvent("second"));
  await emitter.flush();

  replacement.failing = false;
  await waitFor(async () => {
    await emitter.flush();
    return replacement.received.length === 2;
  }, "the replacement to receive both events");
  assertEquals(replacement.received.map((e) => e.action), ["first", "second"]);
  await emitter.close();
});

Deno.test("AuditEmitter: close does not retry a failed durable write while sinks flush", async () => {
  const durableSink = createFlakySink("durable", true);
  durableSink.failing = true;
  let writesWhenFlushBegan = -1;
  durableSink.flush = async () => {
    writesWhenFlushBegan = durableSink.writes;
    // Outlast the retry delay, so a retry timer left armed would fire here.
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const emitter = new AuditEmitter({
    sinks: [durableSink],
    durableRetryMs: 1,
  });

  emitter.emit(makeEvent("test"));
  await emitter.close();

  assertEquals(durableSink.writes, writesWhenFlushBegan);
});

Deno.test("AuditEmitter: a sink whose write never settles keeps counting what it misses", async () => {
  const hanging = createHangingSink("hanging");
  const emitter = new AuditEmitter({
    sinks: [createMockSink("durable"), hanging],
    capacity: 2,
    sinkTimeoutMs: 20,
  });

  emitter.emit(makeEvent("first"));
  await emitter.flush();
  for (let i = 0; i < 5; i++) {
    emitter.emit(makeEvent(`more-${i}`));
    await emitter.flush();
  }

  assertEquals(hanging.writes, 1);
  assertEquals(emitter.droppedEvents("hanging"), 4);
  hanging.release();
  await emitter.close();
});

Deno.test("AuditEmitter: events lost to buffer overflow are not counted as a sink's lag", async () => {
  const now = 0;
  const durableSink = createFlakySink("durable", true);
  const failingSink = createFlakySink("failing", false);
  failingSink.failing = true;
  const emitter = new AuditEmitter({
    sinks: [durableSink, failingSink],
    capacity: 2,
    now: () => now,
  });

  emitter.emit(makeEvent("action-1"));
  await emitter.flush();
  // Four events before the next drain: two are overwritten unchained.
  for (let i = 2; i <= 5; i++) emitter.emit(makeEvent(`action-${i}`));
  await emitter.flush();

  assertEquals(
    durableSink.received.map((e) => e.action),
    ["action-1", "action-4", "action-5"],
  );
  assertEquals(emitter.droppedEvents("durable"), 0);
  assertEquals(emitter.droppedEvents("failing"), 1);
  await emitter.close();
});

Deno.test("AuditEmitter: always-throwing sink is retried on a backoff, not back to back", async () => {
  let now = 0;
  const failingSink = createFlakySink("failing", false);
  failingSink.failing = true;
  const emitter = new AuditEmitter({
    sinks: [createMockSink("durable"), failingSink],
    sinkBackoffBaseMs: 1_000,
    now: () => now,
  });

  emitter.emit(makeEvent("first"));
  await emitter.flush();
  assertEquals(failingSink.writes, 1);

  for (let i = 0; i < 5; i++) {
    emitter.emit(makeEvent(`more-${i}`));
    await emitter.flush();
  }
  assertEquals(failingSink.writes, 1);

  now += 1_000;
  await emitter.flush();
  assertEquals(failingSink.writes, 2);

  // The second failure doubles the wait.
  now += 1_999;
  await emitter.flush();
  assertEquals(failingSink.writes, 2);
  now += 1;
  await emitter.flush();
  assertEquals(failingSink.writes, 3);
  await emitter.close();
});

Deno.test("AuditEmitter: failed durable write is retried without a new event", async () => {
  const durableSink = createFlakySink("durable", true);
  durableSink.failing = true;
  const emitter = new AuditEmitter({
    sinks: [durableSink],
    durableRetryMs: 5,
  });

  emitter.emit(makeEvent("test"));
  await emitter.flush();
  assertEquals(durableSink.received.length, 0);

  durableSink.failing = false;
  await waitFor(
    () => durableSink.received.length === 1,
    "durable retry timer to redeliver",
  );
  await emitter.close();
});

Deno.test("AuditEmitter: replaceSinks clears the backoff of a replaced sink", async () => {
  const now = 0;
  const durableSink = createMockSink("durable");
  const failingSink = createFlakySink("external", false);
  failingSink.failing = true;
  const emitter = new AuditEmitter({
    sinks: [durableSink, failingSink],
    now: () => now,
  });

  emitter.emit(makeEvent("before"));
  await emitter.flush();
  assertEquals(failingSink.writes, 1);

  const replacement = createFlakySink("external", false);
  emitter.replaceSinks([durableSink, replacement]);
  emitter.emit(makeEvent("after"));
  await emitter.flush();

  assertEquals(
    replacement.received.map((e) => e.action),
    ["before", "after"],
  );
  assertEquals(failingSink.writes, 1);
  await emitter.close();
});

Deno.test("AuditEmitter: alert rules count an event once however often it is replayed", async () => {
  let now = 0;
  const durableSink = createFlakySink("durable", true);
  const failingSink = createFlakySink("failing", false);
  failingSink.failing = true;
  const rule: AlertRuleConfig = {
    name: "two-denials",
    match: { category: "auth", outcome: "denied" },
    threshold: { count: 2, windowSeconds: 60 },
    action: { type: "log" },
  };
  const emitter = new AuditEmitter({
    sinks: [durableSink, failingSink],
    alertEngine: new AlertRuleEngine([rule]),
    now: () => now,
  });

  emitter.emit({ ...makeEvent("login"), outcome: "denied" });
  for (let i = 0; i < 3; i++) {
    await emitter.flush();
    now += 60_000;
  }

  assertEquals(failingSink.writes, 3);
  assertEquals(durableSink.received.map((e) => e.action), ["login"]);
  await emitter.close();
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
  await emitter.close();
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

Deno.test("AuditEmitter: hot-reload preserves chain state across sink swap", async () => {
  const sink1 = createMockSink("sink1");
  const emitter = new AuditEmitter([sink1]);

  emitter.emit(makeEvent("before-swap"));
  await emitter.flush();

  const seqAfterFirst = emitter.chainState.sequence;
  assert(seqAfterFirst >= 1, "chain should have advanced");

  const sink2 = createMockSink("sink2");
  emitter.replaceSinks([sink2]);

  emitter.emit(makeEvent("after-swap"));
  await emitter.flush();

  const seqAfterSecond = emitter.chainState.sequence;
  assertEquals(
    seqAfterSecond,
    seqAfterFirst + 1,
    "chain sequence should be continuous across sink swap (no gap, no reset)",
  );

  const event2 = sink2.written.flat()[0];
  assertEquals(event2.sequence, seqAfterFirst + 1);
});

Deno.test("AuditEmitter: replaceSinks with empty list stops event delivery without crash", async () => {
  const sink = createMockSink("original");
  const emitter = new AuditEmitter([sink]);

  emitter.emit(makeEvent("before-empty"));
  await emitter.flush();
  assertEquals(sink.written.flat().length, 1);

  emitter.replaceSinks([]);

  emitter.emit(makeEvent("after-empty"));
  await emitter.flush();

  assertEquals(
    sink.written.flat().length,
    1,
    "original sink should not receive events after replacement",
  );
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
  await emitter.close();
});
