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
