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
import { leaseOp, type Op, tombstoneOp } from "./op.ts";
import {
  type AppendResult,
  CommitRejectedError,
  Partition,
} from "./partition.ts";
import { RecordKey } from "./record_key.ts";
import {
  dataKey,
  modelCommit,
  modelIntent,
  modelPartition,
  savePut,
  sha256Of,
  versionOp,
} from "./v3_test_helpers.ts";

const NAMES = ["a", "b"] as const;
const CONTENTS = ["x", "y", "z"] as const;

const arbName = fc.constantFrom(...NAMES);
const arbVersion = fc.integer({ min: 1, max: 6 });

/** One op, described without building it. */
const arbOpSpec = fc.oneof(
  fc.record({
    kind: fc.constant("put" as const),
    name: arbName,
    version: arbVersion,
    content: fc.constantFrom(...CONTENTS),
    expect: fc.oneof(
      fc.constant(undefined),
      fc.constant("absent" as const),
      fc.constantFrom(...CONTENTS).map((c) => ({ content: c })),
    ),
  }),
  fc.record({
    kind: fc.constant("tombstone" as const),
    name: arbName,
    version: arbVersion,
    versioned: fc.boolean(),
    present: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("data-version" as const),
    name: arbName,
    version: arbVersion,
  }),
  fc.record({
    kind: fc.constant("lease" as const),
    fence: fc.nat({ max: 6 }),
  }),
);

type OpSpec = typeof arbOpSpec extends fc.Arbitrary<infer T> ? T : never;

/** One append, described relative to the partition's state when it runs. */
const arbCommand = fc.record({
  /** 0: the next seq; otherwise an offset from it (a gap or a stale seq). */
  seqOffset: fc.oneof(
    { weight: 4, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.integer({ min: -2, max: 2 }) },
  ),
  /** Reuse an earlier commit's txnId instead of a fresh one. */
  reuseTxn: fc.oneof(
    { weight: 5, arbitrary: fc.constant(undefined) },
    { weight: 1, arbitrary: fc.nat() },
  ),
  fence: fc.option(fc.nat({ max: 6 }), { nil: undefined }),
  ops: fc.array(arbOpSpec, { minLength: 1, maxLength: 4 }),
});

type Command = typeof arbCommand extends fc.Arbitrary<infer T> ? T : never;

/** The tombstoned key of a version-less delete: the name's latest marker. */
function latestKey(name: string): RecordKey {
  return RecordKey.create(`data/model/${name}/latest`);
}

const DIGESTS = new Map<string, string>();
async function digest(content: string): Promise<string> {
  let value = DIGESTS.get(content);
  if (value === undefined) {
    value = await sha256Of(content);
    DIGESTS.set(content, value);
  }
  return value;
}

async function buildOp(spec: OpSpec): Promise<Op> {
  switch (spec.kind) {
    case "put":
      return await savePut(
        spec.name,
        spec.version,
        spec.content,
        spec.expect === undefined || spec.expect === "absent"
          ? spec.expect
          : { sha256: await digest(spec.expect.content) },
      );
    case "tombstone":
      return tombstoneOp({
        intent: modelIntent(
          spec.versioned
            ? { kind: "data.delete", name: spec.name, version: spec.version }
            : { kind: "data.delete", name: spec.name },
        ),
        key: spec.versioned
          ? dataKey(spec.name, spec.version)
          : latestKey(spec.name),
        expect: spec.present ? "present" : undefined,
      });
    case "data-version":
      return versionOp(spec.name, spec.version);
    case "lease":
      return leaseOp({ holder: "serve", fence: spec.fence });
  }
}

/** The reference model: plain data, written straight from the rules. */
interface Model {
  seq: number;
  fence: number | undefined;
  txnIds: string[];
  records: Record<string, string>;
  live: Record<string, number[]>;
  highWater: Record<string, number>;
}

type ModelResult = AppendResult | { kind: "rejected"; reason: string };

async function modelAppend(
  model: Model,
  commit: Commit,
  specs: readonly OpSpec[],
): Promise<{ model: Model; result: ModelResult }> {
  if (model.txnIds.includes(commit.txnId)) {
    return { model, result: { kind: "duplicate" } };
  }
  const reject = (reason: string) => ({
    model,
    result: { kind: "rejected" as const, reason },
  });
  if (commit.seq !== model.seq + 1) return reject("seq-gap");
  const next: Model = structuredClone(model);
  const raise = (fence: number): boolean => {
    if (next.fence !== undefined && fence < next.fence) return false;
    next.fence = fence;
    return true;
  };
  if (commit.fence === undefined) {
    // Once a fence was seen, every commit must carry one.
    if (model.fence !== undefined) return reject("unfenced");
  } else if (!raise(commit.fence)) {
    return reject("stale-fence");
  }
  for (const spec of specs) {
    if (spec.kind === "put") {
      const key = dataKey(spec.name, spec.version).toString();
      const current = next.records[key];
      if (spec.expect === "absent" && current !== undefined) {
        return reject("expect-failed");
      }
      if (
        typeof spec.expect === "object" &&
        current !== await digest(spec.expect.content)
      ) {
        return reject("expect-failed");
      }
      next.records[key] = await digest(spec.content);
    } else if (spec.kind === "tombstone") {
      const key = (spec.versioned
        ? dataKey(spec.name, spec.version)
        : latestKey(spec.name)).toString();
      if (spec.present && next.records[key] === undefined) {
        return reject("expect-failed");
      }
      delete next.records[key];
      if (spec.versioned) {
        next.live[spec.name] = (next.live[spec.name] ?? []).filter((v) =>
          v !== spec.version
        );
      }
    } else if (spec.kind === "data-version") {
      if (spec.version <= (next.highWater[spec.name] ?? 0)) {
        return reject("version-not-increasing");
      }
      next.live[spec.name] = [...(next.live[spec.name] ?? []), spec.version];
      next.highWater[spec.name] = spec.version;
    } else if (!raise(spec.fence)) {
      return reject("stale-fence");
    }
  }
  next.seq = commit.seq;
  next.txnIds.push(commit.txnId);
  return { model: next, result: { kind: "appended", seq: commit.seq } };
}

/** The partition's observable state, in the reference model's shape. */
function observe(partition: Partition) {
  return {
    seq: partition.seq,
    fence: partition.highestFence,
    records: Object.fromEntries(
      partition.recordKeys().map((key) => [
        key,
        partition.record(RecordKey.create(key))?.sha256,
      ]),
    ),
    live: Object.fromEntries(
      NAMES.map((name) => [name, [...partition.versions(name)]]),
    ),
    highWater: Object.fromEntries(
      NAMES.map((name) => [name, partition.highWater(name)]),
    ),
  };
}

function expected(model: Model) {
  return {
    seq: model.seq,
    fence: model.fence,
    records: Object.fromEntries(
      Object.entries(model.records).sort(([a], [b]) => a.localeCompare(b)),
    ),
    live: Object.fromEntries(
      NAMES.map((name) => [
        name,
        [...(model.live[name] ?? [])].sort((a, b) => a - b),
      ]),
    ),
    highWater: Object.fromEntries(
      NAMES.map((name) => [name, model.highWater[name] ?? 0]),
    ),
  };
}

async function run(commands: readonly Command[]): Promise<void> {
  const partition = Partition.empty(modelPartition());
  let model: Model = {
    seq: 0,
    fence: undefined,
    txnIds: [],
    records: {},
    live: {},
    highWater: {},
  };
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
      fc.array(arbCommand, { minLength: 1, maxLength: 25 }),
      run,
    ),
    { numRuns: 200 },
  );
});

Deno.test("Partition.append: a replayed commit never changes the partition", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbCommand, { minLength: 1, maxLength: 10 }),
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
