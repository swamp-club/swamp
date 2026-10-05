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
import fc from "fast-check";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { verifyChain } from "./audit_chain.ts";
import { AuditEmitter } from "./audit_emitter.ts";
import type { AuditEvent, ChainedAuditEvent } from "./audit_event.ts";
import { createAuditEvent } from "./audit_event.ts";
import type { AuditSink } from "./audit_sink.ts";
import { waitFor } from "@swamp-club/swamp-testing";

await initializeLogging({});

type Step =
  | { kind: "emit" }
  | { kind: "fail" }
  | { kind: "recover" }
  | { kind: "advance"; ms: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Step>({ kind: "emit" }) },
  { weight: 1, arbitrary: fc.constant<Step>({ kind: "fail" }) },
  { weight: 1, arbitrary: fc.constant<Step>({ kind: "recover" }) },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 1, max: 120_000 }).map((ms): Step => ({
      kind: "advance",
      ms,
    })),
  },
);

function collectingSink(
  name: string,
  durable: boolean,
): AuditSink & { failing: boolean; received: ChainedAuditEvent[] } {
  const sink = {
    name,
    durable,
    failing: false,
    received: [] as ChainedAuditEvent[],
    write(events: readonly AuditEvent[]): Promise<void> {
      if (sink.failing) return Promise.reject(new Error(`${name} failed`));
      sink.received.push(...(events as ChainedAuditEvent[]));
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return sink;
}

Deno.test("AuditEmitter property: durable output is complete, ordered and chained whatever a non-durable sink does", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(stepArb, { maxLength: 40 }),
      fc.integer({ min: 1, max: 6 }),
      async (steps, capacity) => {
        let now = 0;
        const durable = collectingSink("durable", true);
        const external = collectingSink("external", false);
        const emitter = new AuditEmitter({
          sinks: [external, durable],
          capacity,
          now: () => now,
        });

        const emitted: string[] = [];
        for (const step of steps) {
          if (step.kind === "fail") external.failing = true;
          if (step.kind === "recover") external.failing = false;
          if (step.kind === "advance") now += step.ms;
          if (step.kind === "emit") {
            const event = createAuditEvent({
              instanceId: "inst-1",
              category: "auth",
              stage: "response",
              outcome: "success",
              action: `action-${emitted.length}`,
              resourceKind: "access",
              resourceName: "*",
              principalKind: "user",
              principalId: "test-user",
              initiatedBy: "user:test-user",
              sourceIp: "127.0.0.1",
              requestId: crypto.randomUUID(),
            });
            emitted.push(event.id);
            emitter.emit(event);
          }
          await emitter.flush();
        }
        await emitter.close();

        assertEquals(durable.received.map((e) => e.id), emitted);
        assertEquals(
          durable.received.map((e) => e.sequence),
          emitted.map((_, i) => i + 1),
        );
        assertEquals((await verifyChain(durable.received)).valid, true);

        // Whatever reached the other sink is what the durable sink holds,
        // in the same order and never twice.
        const bySequence = new Map(
          durable.received.map((e) => [e.sequence, e]),
        );
        let previous = 0;
        for (const event of external.received) {
          assertEquals(event, bySequence.get(event.sequence));
          assertEquals(event.sequence > previous, true);
          previous = event.sequence;
        }
        assertEquals(
          external.received.length + emitter.droppedEvents("external") <=
            emitted.length,
          true,
        );
      },
    ),
    { numRuns: 100 },
  );
});

function makeEvent(index: number): AuditEvent {
  return createAuditEvent({
    instanceId: "inst-1",
    category: "auth",
    stage: "response",
    outcome: "success",
    action: `action-${index}`,
    resourceKind: "access",
    resourceName: "*",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
  });
}

type DurableStep =
  | { kind: "emit" }
  | { kind: "hang" }
  | { kind: "settle"; succeed: boolean };

const durableStepArb: fc.Arbitrary<DurableStep> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<DurableStep>({ kind: "emit" }) },
  { weight: 2, arbitrary: fc.constant<DurableStep>({ kind: "hang" }) },
  {
    weight: 2,
    arbitrary: fc.boolean().map((succeed): DurableStep => ({
      kind: "settle",
      succeed,
    })),
  },
);

/**
 * A durable sink whose writes hang while `hanging` is set, until settled.
 * Counts how many of its writes are outstanding at once.
 */
function hangingDurableSink(): AuditSink & {
  hanging: boolean;
  received: ChainedAuditEvent[];
  outstanding: number;
  maxOutstanding: number;
  settle(succeed: boolean): void;
} {
  const pending: {
    events: ChainedAuditEvent[];
    succeed(): void;
    fail(): void;
  }[] = [];
  const sink = {
    name: "wal",
    durable: true,
    hanging: false,
    received: [] as ChainedAuditEvent[],
    outstanding: 0,
    maxOutstanding: 0,
    write(events: readonly AuditEvent[]): Promise<void> {
      sink.outstanding++;
      sink.maxOutstanding = Math.max(sink.maxOutstanding, sink.outstanding);
      const batch = [...events] as ChainedAuditEvent[];
      if (!sink.hanging) {
        sink.outstanding--;
        sink.received.push(...batch);
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        pending.push({
          events: batch,
          succeed: () => {
            sink.outstanding--;
            sink.received.push(...batch);
            resolve();
          },
          fail: () => {
            sink.outstanding--;
            reject(new Error("late failure"));
          },
        });
      });
    },
    settle(succeed: boolean): void {
      for (const write of pending.splice(0)) {
        if (succeed) write.succeed();
        else write.fail();
      }
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return sink;
}

Deno.test("AuditEmitter property: a durable write that times out is never sent again while pending, and nothing is stored twice", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(durableStepArb, { maxLength: 25 }),
      async (steps) => {
        const durable = hangingDurableSink();
        const emitter = new AuditEmitter({
          sinks: [durable],
          capacity: 1_000,
          sinkTimeoutMs: 2,
          durableRetryMs: 1,
        });

        let emitted = 0;
        for (const step of steps) {
          if (step.kind === "hang") durable.hanging = true;
          if (step.kind === "settle") {
            durable.hanging = false;
            durable.settle(step.succeed);
          }
          if (step.kind === "emit") emitter.emit(makeEvent(emitted++));
          await emitter.flush();
        }
        durable.hanging = false;
        durable.settle(true);
        await waitFor(async () => {
          await emitter.flush();
          return durable.received.length >= emitted;
        }, "the durable sink to catch up once every write settled");
        await emitter.close();

        assertEquals(durable.maxOutstanding <= 1, true);
        assertEquals(
          durable.received.map((e) => e.sequence),
          Array.from({ length: emitted }, (_, i) => i + 1),
        );
        assertEquals((await verifyChain(durable.received)).valid, true);
      },
    ),
    { numRuns: 40 },
  );
});

type PairStep =
  | { kind: "emit" }
  | { kind: "fail" | "recover"; sink: 0 | 1 }
  | { kind: "advance"; ms: number };

const pairStepArb: fc.Arbitrary<PairStep> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<PairStep>({ kind: "emit" }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom<"fail" | "recover">("fail", "recover"),
      sink: fc.constantFrom<0 | 1>(0, 1),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 1, max: 120_000 }).map((ms): PairStep => ({
      kind: "advance",
      ms,
    })),
  },
);

Deno.test("AuditEmitter property: sinks that share a name each receive every event whatever the other does", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(pairStepArb, { maxLength: 40 }),
      async (steps) => {
        let now = 0;
        const durable = collectingSink("durable", true);
        const pair = [
          collectingSink("webhook:siem.example.com", false),
          collectingSink("webhook:siem.example.com", false),
        ];
        const emitter = new AuditEmitter({
          sinks: [durable, ...pair],
          capacity: 1_000,
          now: () => now,
        });

        let emitted = 0;
        for (const step of steps) {
          if (step.kind === "fail") pair[step.sink].failing = true;
          if (step.kind === "recover") pair[step.sink].failing = false;
          if (step.kind === "advance") now += step.ms;
          if (step.kind === "emit") emitter.emit(makeEvent(emitted++));
          await emitter.flush();
        }
        for (const sink of pair) sink.failing = false;
        now += 120_000;
        await emitter.flush();
        await emitter.close();

        const sequences = durable.received.map((e) => e.sequence);
        assertEquals(sequences.length, emitted);
        for (const sink of pair) {
          assertEquals(sink.received.map((e) => e.sequence), sequences);
        }
      },
    ),
    { numRuns: 100 },
  );
});
