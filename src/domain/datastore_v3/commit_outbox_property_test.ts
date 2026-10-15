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
import fc from "fast-check";
import { Commit } from "./commit.ts";
import {
  decideFenceChain,
  type FenceChain,
  isRunEntry,
  OUTBOX_RETRY_BOUND_MS,
  type OutboxEntry,
  planOutboxRecovery,
} from "./commit_outbox.ts";
import { createIntent } from "./intent.ts";
import { putOp } from "./op.ts";
import { partitionOf } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";
import { modelPartition, savePut } from "./v3_test_helpers.ts";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");

Deno.test("decideFenceChain (property): the chain start is a fence this copy took, and no other writer's fence lies inside the chain", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          // Who takes the next fence: this copy, or another copy.
          ours: fc.boolean(),
          // A recovery completes on this copy at its fence.
          recovers: fc.boolean(),
        }),
        { minLength: 1, maxLength: 40 },
      ),
      (takes) => {
        let chain: FenceChain | undefined;
        const ourFences = new Set<number>();
        let next = 0;
        for (const take of takes) {
          next++;
          if (!take.ours) continue;
          ourFences.add(next);
          chain = decideFenceChain(chain, next);
          if (take.recovers) chain = { ...chain, floor: next };
          assert(ourFences.has(chain.chainStart));
          assert(chain.chainStart <= chain.lastFence);
          assert(chain.floor <= chain.lastFence);
          // Every fence from the start to the last is this copy's.
          for (
            let fence = chain.chainStart;
            fence <= chain.lastFence;
            fence++
          ) {
            assert(ourFences.has(fence), `fence ${fence} is another writer's`);
          }
        }
      },
    ),
  );
});

async function entryOf(
  sequence: number,
  spec: { fence: number; unit: number; run: boolean; ageMs: number },
): Promise<OutboxEntry> {
  const run = {
    workflowId: "33333333-3333-4333-8333-333333333333",
    runId: "44444444-4444-4444-8444-444444444444",
  };
  const op = spec.run
    ? await putOp({
      intent: createIntent({ kind: "run.update", run }),
      key: RecordKey.create(
        `workflow-runs/${run.workflowId}/${run.runId}.yaml`,
      ),
      inline: btoa("r"),
    })
    : await savePut(`n${sequence}`, 1);
  return {
    sequence,
    createdAt: NOW - spec.ageMs,
    unitId: `u${spec.unit}`,
    base: { seq: 0, txnId: undefined },
    commit: Commit.create({
      seq: 1,
      partition: spec.run
        ? partitionOf({ kind: "run", ...run })
        : modelPartition(),
      namespace: "",
      txnId: `t${sequence}`,
      writer: { host: "h", pid: 1, instance: "i" },
      fence: spec.fence,
      at: new Date(NOW).toISOString(),
      ops: [op],
    }),
  };
}

Deno.test("planOutboxRecovery (property): every entry is sent or dropped exactly once, and no sent run entry's unit lost an entry", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          fence: fc.integer({ min: 1, max: 8 }),
          unit: fc.integer({ min: 0, max: 3 }),
          run: fc.boolean(),
          ageMs: fc.constantFrom(0, OUTBOX_RETRY_BOUND_MS + 1),
        }),
        { maxLength: 12 },
      ),
      fc.integer({ min: 1, max: 8 }),
      fc.integer({ min: 0, max: 8 }),
      async (specs, chainStart, floor) => {
        const entries = await Promise.all(
          specs.map((spec, i) => entryOf(i + 1, spec)),
        );
        const plan = planOutboxRecovery([...entries].reverse(), {
          chain: { lastFence: 8, chainStart, floor },
          now: NOW,
          writerAlive: () => false,
        });
        for (const result of [plan]) {
          const seen = [
            ...result.sends,
            ...result.drops.map((drop) => drop.entry),
            ...result.skipped,
          ].map((entry) => entry.sequence).sort((a, b) => a - b);
          assertEquals(seen, entries.map((entry) => entry.sequence));
          for (const sent of result.sends) {
            const fence = sent.commit.fence!;
            assert(fence >= chainStart && fence >= floor);
          }
          const droppedUnits = new Set(
            result.drops.filter((drop) => !isRunEntry(drop.entry)).map((drop) =>
              drop.entry.unitId
            ),
          );
          for (const sent of result.sends.filter(isRunEntry)) {
            assert(!droppedUnits.has(sent.unitId));
          }
          // Within the sends, a unit's run entries follow its others.
          const lastData = new Map<string, number>();
          result.sends.forEach((sent, i) => {
            if (!isRunEntry(sent)) lastData.set(sent.unitId, i);
          });
          result.sends.forEach((sent, i) => {
            if (isRunEntry(sent)) {
              assert((lastData.get(sent.unitId) ?? -1) < i);
            }
          });
        }
      },
    ),
  );
});
