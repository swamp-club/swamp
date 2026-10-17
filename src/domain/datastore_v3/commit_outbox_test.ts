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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Commit, type CommitWriter } from "./commit.ts";
import {
  COMPACTED_TXN_RETENTION_MS,
  decideFenceChain,
  dropsAfterRefusal,
  type FenceChain,
  OUTBOX_RETRY_BOUND_MS,
  type OutboxEntry,
  planOutboxRecovery,
  sameHead,
  sweepMayOverlap,
} from "./commit_outbox.ts";
import { DEFAULT_COMPACTION_POLICY } from "./compaction_policy.ts";
import { putOp } from "./op.ts";
import { partitionOf } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";
import { createIntent } from "./intent.ts";
import { modelPartition, savePut } from "./v3_test_helpers.ts";
import { WRITER_LEASE_CLOCK_SKEW_MS } from "./writer_lease.ts";

const DEAD: CommitWriter = { host: "host-a", pid: 4242, instance: "dead-1" };
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

async function entry(
  sequence: number,
  overrides: {
    fence?: number;
    unitId?: string;
    run?: boolean;
    createdAt?: number;
    writer?: CommitWriter;
  } = {},
): Promise<OutboxEntry> {
  const run = overrides.run === true;
  const partition = run
    ? partitionOf({ kind: "run", workflowId: WORKFLOW_ID, runId: RUN_ID })
    : modelPartition();
  const op = run
    ? await putOp({
      intent: createIntent({
        kind: "run.update",
        run: { workflowId: WORKFLOW_ID, runId: RUN_ID },
      }),
      key: RecordKey.create(`workflow-runs/${WORKFLOW_ID}/${RUN_ID}.yaml`),
      inline: btoa("run"),
    })
    : await savePut(`n${sequence}`, 1);
  const fence = overrides.fence ?? 5;
  return {
    sequence,
    createdAt: overrides.createdAt ?? NOW - 1000,
    unitId: overrides.unitId ?? "unit-1",
    base: { seq: sequence - 1, txnId: undefined },
    commit: Commit.create({
      seq: sequence,
      partition,
      namespace: "",
      txnId: `txn-${sequence}`,
      writer: overrides.writer ?? DEAD,
      fence,
      at: new Date(NOW).toISOString(),
      ops: [op],
    }),
  };
}

const CHAIN: FenceChain = { lastFence: 6, chainStart: 3, floor: 4 };

function judge(chain: FenceChain = CHAIN) {
  return { chain, now: NOW, writerAlive: () => false };
}

Deno.test("COMPACTED_TXN_RETENTION_MS: outlasts the retry bound plus the lease's clock skew", () => {
  assert(
    COMPACTED_TXN_RETENTION_MS >
      OUTBOX_RETRY_BOUND_MS + WRITER_LEASE_CLOCK_SKEW_MS,
  );
  // Days, not hours, and no longer than compaction keeps commits anyway.
  assert(OUTBOX_RETRY_BOUND_MS >= 24 * 60 * 60 * 1000);
  assert(OUTBOX_RETRY_BOUND_MS <= DEFAULT_COMPACTION_POLICY.retainMs);
});

Deno.test("sameHead: compares the seq, and the txnId when both sides know it", () => {
  assert(sameHead({ seq: 3, txnId: "a" }, { seq: 3, txnId: "a" }));
  assert(!sameHead({ seq: 3, txnId: "a" }, { seq: 3, txnId: "b" }));
  assert(!sameHead({ seq: 3, txnId: "a" }, { seq: 4, txnId: "a" }));
  assert(sameHead({ seq: 3, txnId: "a" }, { seq: 3, txnId: undefined }));
  assert(sameHead({ seq: 0, txnId: undefined }, { seq: 0, txnId: undefined }));
});

Deno.test("decideFenceChain: one above the last fence continues, a gap or a drop restarts", () => {
  const first = decideFenceChain(undefined, 4);
  assertEquals(first, { lastFence: 4, chainStart: 4, floor: 0 });
  const floored = { ...decideFenceChain(first, 5), floor: 5 };
  assertEquals(decideFenceChain(floored, 5), floored, "the same hold again");
  assertEquals(decideFenceChain(floored, 6), {
    lastFence: 6,
    chainStart: 4,
    floor: 5,
  });
  assertEquals(decideFenceChain(floored, 8), {
    lastFence: 8,
    chainStart: 8,
    floor: 5,
  }, "another writer took fence 6 or 7");
  assertEquals(decideFenceChain(floored, 2), {
    lastFence: 2,
    chainStart: 2,
    floor: 0,
  }, "the lease records were recreated");
  assertThrows(() => decideFenceChain(first, 0));
});

Deno.test("planOutboxRecovery: drops entries from before the chain or below the floor, and expired ones", async () => {
  const kept = await entry(1, { fence: 4 });
  const stale = await entry(2, { fence: 2 });
  const overtaken = await entry(3, { fence: 3 });
  const expired = await entry(4, {
    fence: 6,
    createdAt: NOW - OUTBOX_RETRY_BOUND_MS - 1,
  });
  const plan = planOutboxRecovery(
    [expired, overtaken, stale, kept],
    judge(),
  );
  assertEquals(plan.sends, [kept]);
  assertEquals(
    plan.drops.map((drop) => [drop.entry.sequence, drop.reason]),
    [[2, "stale-fence"], [3, "overtaken"], [4, "expired"]],
  );
  assertEquals(plan.skipped, []);
});

Deno.test("planOutboxRecovery: an unfenced entry is never landed", async () => {
  const unfenced = await entry(1);
  const plan = planOutboxRecovery([{
    ...unfenced,
    commit: Commit.create({
      seq: 1,
      partition: unfenced.commit.partition,
      namespace: "",
      txnId: "txn-1",
      writer: DEAD,
      at: unfenced.commit.at,
      ops: unfenced.commit.ops,
    }),
  }], judge());
  assertEquals(plan.drops.map((drop) => drop.reason), ["stale-fence"]);
});

Deno.test("planOutboxRecovery: leaves a live writer's entries, and orders a unit's run entries last", async () => {
  const live: CommitWriter = { host: "host-a", pid: 1, instance: "live" };
  const run = await entry(1, { run: true });
  const model = await entry(2);
  const theirs = await entry(3, { writer: live });
  const plan = planOutboxRecovery([run, model, theirs], {
    ...judge(),
    writerAlive: (writer) => writer.instance === "live",
  });
  assertEquals(plan.sends, [model, run]);
  assertEquals(plan.skipped, [theirs]);
});

Deno.test("planOutboxRecovery: a dropped entry takes its unit's run entries, not another unit's", async () => {
  const dropped = await entry(1, { fence: 2, unitId: "u1" });
  const ownRun = await entry(2, { run: true, unitId: "u1" });
  const otherRun = await entry(3, { run: true, unitId: "u2" });
  const plan = planOutboxRecovery([dropped, ownRun, otherRun], judge());
  assertEquals(plan.sends, [otherRun]);
  assertEquals(
    plan.drops.map((drop) => [drop.entry.sequence, drop.reason]),
    [[1, "stale-fence"], [2, "unit-dropped"]],
  );
});

Deno.test("dropsAfterRefusal: a refused data entry takes its unit's run entries; a refused run entry takes nothing", async () => {
  const data = await entry(1, { unitId: "u1" });
  const run = await entry(2, { run: true, unitId: "u1" });
  const other = await entry(3, { run: true, unitId: "u2" });
  assertEquals(dropsAfterRefusal(data, [run, other]), [run]);
  assertEquals(dropsAfterRefusal(run, [other]), []);
});

Deno.test("sweepMayOverlap: only a quiet, unmoved epoch skips the check", () => {
  const quiet = { epoch: 2, active: false };
  assert(!sweepMayOverlap(quiet, quiet));
  assert(sweepMayOverlap(quiet, { epoch: 3, active: false }));
  assert(sweepMayOverlap({ epoch: 2, active: true }, quiet));
  assert(sweepMayOverlap(quiet, { epoch: 2, active: true }));
});

Deno.test("planOutboxRecovery: an entry a recovery left for its live writer is not overtaken by the floor that recovery raised (swamp-club#3564)", async () => {
  const left = { ...await entry(1, { fence: 3 }), leftAtFence: 4 };
  const overtaken = await entry(2, { fence: 3 });
  const process = { host: "h#pid:[1]", bootId: "b", startTime: "t" };
  const stillAlive = planOutboxRecovery([left, overtaken], {
    ...judge(),
    writerAlive: (_writer, recorded) => recorded === process,
  });
  assertEquals(stillAlive.skipped, []);
  assertEquals(stillAlive.sends, [left]);
  assertEquals(
    stillAlive.drops.map((drop) => [drop.entry.sequence, drop.reason]),
    [[2, "overtaken"]],
  );
  // While its writer, named by the identity it prepared under, runs, it is
  // left again.
  const live = { ...left, writerProcess: process };
  assertEquals(
    planOutboxRecovery([live], {
      ...judge(),
      writerAlive: (_writer, recorded) => recorded === process,
    }).skipped,
    [live],
  );
});
