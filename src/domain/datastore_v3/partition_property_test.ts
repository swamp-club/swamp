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

/**
 * Model-based property tests for the partition aggregate: random command
 * sequences run against {@link Partition} and against a small reference
 * model written directly from the rules, and the two must agree after every
 * command. The invariants are also checked on the partition alone.
 */

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import type { Commit } from "./commit.ts";
import type { Op } from "./op.ts";
import { CommitRejectedError, Partition } from "./partition.ts";
import {
  arbCommands,
  buildOp,
  type Command,
  emptyModel,
  expected,
  type Model,
  modelAppend,
  type ModelResult,
  NAMES,
  observe,
} from "./v3_test_helpers.ts";
import { modelCommit, modelPartition } from "./v3_test_helpers.ts";

/** How often each refusal came up, over every run of a property. */
const refusals = new Map<string, number>();

async function run(commands: readonly Command[]): Promise<void> {
  const partition = Partition.empty(modelPartition());
  let model: Model = emptyModel();
  const used: string[] = [];
  let fresh = 0;
  for (const command of commands) {
    const seq = Math.max(1, partition.seq + 1 + command.seqOffset);
    const txnId = command.reuseTxn !== undefined && used.length > 0
      ? used[command.reuseTxn % used.length]
      : `txn-${fresh++}`;
    const ops: Op[] = [];
    for (const spec of command.ops) ops.push(await buildOp(spec));
    const commit = modelCommit(seq, ops, { txnId, fence: command.fence });

    const before = observe(partition);
    const highWaterBefore = before.highWater;
    let actual: ModelResult;
    try {
      actual = partition.append(commit);
    } catch (error) {
      if (!(error instanceof CommitRejectedError)) throw error;
      actual = { kind: "rejected", reason: error.reason };
      refusals.set(error.reason, (refusals.get(error.reason) ?? 0) + 1);
    }
    const reference = await modelAppend(model, commit, command.ops);
    model = reference.model;

    // The partition agrees with the reference model.
    assertEquals(actual, reference.result);
    const after = observe(partition);
    assertEquals(after, expected(model));

    // And the invariants hold on the partition alone.
    if (actual.kind === "appended") {
      assertEquals(after.seq, before.seq + 1);
      used.push(txnId);
      assert(partition.hasTxn(txnId));
    } else {
      assertEquals(after, before);
    }
    for (const name of NAMES) {
      const live = partition.versions(name);
      assertEquals(
        partition.latest(name),
        live.length === 0 ? undefined : live[live.length - 1],
      );
      assert(partition.highWater(name) >= highWaterBefore[name]);
      assert(live.every((v) => v <= partition.highWater(name)));
    }
  }
}

Deno.test("Partition.append: agrees with the reference model over random command sequences", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCommands(25),
      run,
    ),
    { numRuns: 200 },
  );
  // The reuse rule was really exercised (swamp-club#3532).
  assert(
    (refusals.get("version-reused") ?? 0) > 20,
    `version-reused came up ${refusals.get("version-reused") ?? 0} times`,
  );
});

Deno.test("Partition.append: a replayed commit never changes the partition", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCommands(10),
      async (commands) => {
        const partition = Partition.empty(modelPartition());
        const landed: Commit[] = [];
        for (const [index, command] of commands.entries()) {
          const ops: Op[] = [];
          for (const spec of command.ops) ops.push(await buildOp(spec));
          const commit = modelCommit(partition.seq + 1, ops, {
            txnId: `t-${index}`,
            fence: command.fence,
          });
          try {
            partition.append(commit);
            landed.push(commit);
          } catch (error) {
            if (!(error instanceof CommitRejectedError)) throw error;
          }
        }
        const before = observe(partition);
        for (const commit of landed) {
          assertEquals(partition.append(commit), { kind: "duplicate" });
        }
        assertEquals(observe(partition), before);
      },
    ),
    { numRuns: 100 },
  );
});

/** Applies a commit, reporting a refusal as a result rather than a throw. */
function tryAppend(partition: Partition, commit: Commit): ModelResult {
  try {
    return partition.append(commit);
  } catch (error) {
    if (!(error instanceof CommitRejectedError)) throw error;
    return { kind: "rejected", reason: error.reason };
  }
}

Deno.test("Partition.restore: a restored snapshot behaves exactly like the partition it came from", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbCommands(15).map((commands) => commands.slice(0, 15)),
      arbCommands(15),
      async (before, after) => {
        const original = Partition.empty(modelPartition());
        const used: string[] = [];
        let fresh = 0;
        const commitFor = async (command: Command): Promise<Commit> => {
          const ops: Op[] = [];
          for (const spec of command.ops) ops.push(await buildOp(spec));
          const txnId = command.reuseTxn !== undefined && used.length > 0
            ? used[command.reuseTxn % used.length]
            : `txn-${fresh++}`;
          return modelCommit(
            Math.max(1, original.seq + 1 + command.seqOffset),
            ops,
            { txnId, fence: command.fence },
          );
        };
        // The prefix lands as much as it can (the next seq, one fence), so
        // the snapshot holds real state: deleted top versions, tombstoned
        // records, a raised fence. Only expect and version checks refuse.
        for (const command of before) {
          const commit = await commitFor({
            ...command,
            seqOffset: 0,
            fence: 1,
          });
          if (tryAppend(original, commit).kind === "appended") {
            used.push(commit.txnId);
          }
        }

        // Through JSON, as the commit store keeps it. The txnIds landed so
        // far are the lookup's; the after phase retries some of them.
        const prior = new Set(used);
        const restored = Partition.restore(
          modelPartition(),
          JSON.parse(JSON.stringify(original.snapshot())),
          (txnId) => prior.has(txnId),
        );
        assertEquals(observe(restored), observe(original));
        assertEquals(restored.leaseHolder, original.leaseHolder);
        assertEquals(restored.snapshot(), original.snapshot());

        for (const command of after) {
          const commit = await commitFor(command);
          const result = tryAppend(original, commit);
          assertEquals(tryAppend(restored, commit), result);
          if (result.kind === "appended") used.push(commit.txnId);
          assertEquals(observe(restored), observe(original));
          assertEquals(restored.leaseHolder, original.leaseHolder);
        }
      },
    ),
    { numRuns: 200 },
  );
});
