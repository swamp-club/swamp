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
 * The v3 read model with record keys that two partitions write
 * (swamp-club#3256): a same-key definition rename puts the new name's record
 * at the key the old name's partition then tombstones. A partition catch-up
 * applies one partition's commits ahead of the change feed, so the file must
 * follow feed positions, not the order commits are applied in.
 *
 * The property runs random histories through random mixes of store and
 * partition catch-ups, and checks the result against an in-order replay and
 * against an independent spec of the in-order result.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { putOp, tombstoneOp } from "../src/domain/datastore_v3/op.ts";
import type { Op } from "../src/domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../src/domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import { READ_MODEL_STATE_FILE } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import {
  base64Of,
  commitOf,
  readTree,
  sha256Hex,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const NAMES = ["alpha", "beta", "gamma"] as const;
type Name = typeof NAMES[number];

const KEYS = [
  "config/models/aws/3f0e7d1c-2b4a-4c6d-8e9f-0a1b2c3d4e5f.yaml",
  "config/models/aws/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.yaml",
] as const;

function partitionFor(name: Name): PartitionKey {
  return partitionOf({ kind: "config", definitionKind: "model", name });
}

/** One op of a history: a put of `text` at a key, or a tombstone of it. */
interface OpSpec {
  readonly key: number;
  readonly text?: string;
}

interface CommitSpec {
  readonly name: Name;
  readonly ops: readonly OpSpec[];
}

async function buildOp(name: Name, spec: OpSpec): Promise<Op> {
  const key = RecordKey.create(KEYS[spec.key]);
  const definition = { kind: "model" as const, name };
  return spec.text === undefined
    ? tombstoneOp({ intent: { kind: "definition.delete", definition }, key })
    : await putOp({
      intent: { kind: "definition.edit", definition },
      key,
      inline: base64Of(new TextEncoder().encode(spec.text)),
    });
}

/**
 * Appends a history to the store, in order. Returns the commits that landed,
 * in feed order (the store refuses nothing here, but a refusal would drop the
 * commit, as the store drops it).
 */
async function appendHistory(
  env: V3Env,
  history: readonly CommitSpec[],
  afterEach: (landed: LandedCommit) => Promise<void> = () => Promise.resolve(),
): Promise<LandedCommit[]> {
  const seqs = new Map<Name, number>();
  const landed: LandedCommit[] = [];
  for (const spec of history) {
    const seq = (seqs.get(spec.name) ?? 0) + 1;
    const ops: Op[] = [];
    for (const op of spec.ops) ops.push(await buildOp(spec.name, op));
    try {
      await env.store.append(
        commitOf({
          seq,
          partition: partitionFor(spec.name),
          namespace: "",
          ops,
        }),
      );
    } catch (error) {
      if (!(error instanceof CommitRejectedError)) throw error;
      continue;
    }
    seqs.set(spec.name, seq);
    const commit = { name: spec.name, ops: spec.ops };
    landed.push(commit);
    await afterEach(commit);
  }
  return landed;
}

interface LandedCommit {
  readonly name: Name;
  readonly ops: readonly OpSpec[];
}

/**
 * The independent spec of the in-order result: a key's file holds the bytes
 * of its latest put in feed order, unless a later tombstone from that put's
 * own partition removed it. Within one commit the last op of a key wins.
 */
async function expectedFiles(
  landed: readonly LandedCommit[],
): Promise<Record<string, string>> {
  const expected: Record<string, string> = {};
  for (let key = 0; key < KEYS.length; key++) {
    let latest: { index: number; name: Name; text: string } | undefined;
    const finals = landed.map((commit) =>
      commit.ops.filter((op) => op.key === key).at(-1)
    );
    finals.forEach((op, index) => {
      if (op?.text !== undefined) {
        latest = { index, name: landed[index].name, text: op.text };
      }
    });
    if (latest === undefined) continue;
    const owner = latest;
    const removed = finals.some((op, index) =>
      index > owner.index && op !== undefined && op.text === undefined &&
      landed[index].name === owner.name
    );
    if (!removed) {
      expected[KEYS[key]] = await sha256Hex(
        new TextEncoder().encode(owner.text),
      );
    }
  }
  return Object.fromEntries(
    Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** The read model's ownership rows, in key order. */
function ownership(env: V3Env): unknown[] {
  const db = new DatabaseSync(join(env.stateDir, READ_MODEL_STATE_FILE), {
    readOnly: true,
  });
  try {
    return db.prepare(
      "SELECT namespace, record_key, owner, mark, present FROM materialised_keys ORDER BY namespace, record_key",
    ).all();
  } finally {
    db.close();
  }
}

async function files(env: V3Env): Promise<Record<string, string>> {
  return Object.fromEntries(await readTree(env.cacheRoot("")));
}

const signal = () => AbortSignal.timeout(30_000);

type CatchUp = "none" | "store" | Name;

/**
 * Appends a history, catching the read model up after each commit as
 * `plan` says, then catches up fully. Returns what landed.
 */
async function runInterleaved(
  env: V3Env,
  history: readonly CommitSpec[],
  plan: readonly CatchUp[],
): Promise<LandedCommit[]> {
  const readModel = env.openReadModel({ pageSize: 2 });
  try {
    let step = 0;
    const landed = await appendHistory(env, history, async () => {
      const catchUp = plan[step++ % plan.length];
      if (catchUp === "store") await readModel.catchUp(signal());
      else if (catchUp !== "none") {
        await readModel.catchUpPartition("", partitionFor(catchUp), signal());
      }
    });
    await readModel.catchUp(signal());
    return landed;
  } finally {
    await readModel.close();
  }
}

/** Replays every commit in feed order with a fresh state. */
async function replayInOrder(env: V3Env): Promise<void> {
  await Deno.remove(join(env.stateDir, READ_MODEL_STATE_FILE));
  const readModel = env.openReadModel();
  try {
    await readModel.catchUp(signal());
  } finally {
    await readModel.close();
  }
}

const put = (key: number, text: string): OpSpec => ({ key, text });
const tomb = (key: number): OpSpec => ({ key });

/** A same-key rename alpha → beta: beta puts the key, then alpha tombstones it. */
const SAME_KEY_RENAME: CommitSpec[] = [
  { name: "alpha", ops: [put(0, "alpha's definition")] },
  { name: "beta", ops: [put(0, "beta's definition")] },
  { name: "alpha", ops: [tomb(0)] },
];

for (
  const [label, plan] of [
    ["in feed order", ["store"]],
    ["with the new name's partition caught up first", ["none", "beta"]],
    ["with the old name's partition caught up first", ["alpha", "none"]],
  ] as const
) {
  Deno.test(`read model, shared key: a same-key rename keeps the new name's file ${label}`, async () => {
    await withV3Env(async (env) => {
      const landed = await runInterleaved(env, SAME_KEY_RENAME, plan);
      assertEquals(await files(env), await expectedFiles(landed));
      assertEquals(Object.keys(await files(env)), [KEYS[0]]);
    });
  });
}

Deno.test("read model, shared key: an older put applied after a newer one leaves the newer file (swamp-club#3256)", async () => {
  // The order a review found broke a digest-only rule: the new name's
  // partition is caught up before the store catch-up applies the old name's
  // earlier put and its tombstone.
  await withV3Env(async (env) => {
    await appendHistory(env, SAME_KEY_RENAME);
    const readModel = env.openReadModel();
    try {
      await readModel.catchUpPartition("", partitionFor("beta"), signal());
      await readModel.catchUp(signal());
    } finally {
      await readModel.close();
    }
    assertEquals(await files(env), {
      [KEYS[0]]: await sha256Hex(new TextEncoder().encode("beta's definition")),
    });
  });
});

Deno.test("read model, shared key: an orphaned record does not keep a deleted file", async () => {
  // A same-key rename whose tombstone never landed leaves alpha's record
  // live; deleting beta still removes the file, in any catch-up order.
  const history: CommitSpec[] = [
    { name: "alpha", ops: [put(0, "alpha's definition")] },
    { name: "beta", ops: [put(0, "beta's definition")] },
    { name: "beta", ops: [tomb(0)] },
  ];
  for (const plan of [["store"], ["none", "none", "beta"], ["beta"]]) {
    await withV3Env(async (env) => {
      await runInterleaved(env, history, plan as CatchUp[]);
      assertEquals(await files(env), {});
    });
  }
});

Deno.test("read model, shared key: a rename back and forth ends with the latest owner's bytes", async () => {
  const history: CommitSpec[] = [
    ...SAME_KEY_RENAME,
    { name: "alpha", ops: [put(0, "alpha again")] },
    { name: "beta", ops: [tomb(0)] },
  ];
  for (const plan of [["store"], ["alpha"], ["beta"], ["none", "beta"]]) {
    await withV3Env(async (env) => {
      await runInterleaved(env, history, plan as CatchUp[]);
      assertEquals(await files(env), {
        [KEYS[0]]: await sha256Hex(new TextEncoder().encode("alpha again")),
      });
    });
  }
});

const arbOp = fc.record({
  key: fc.integer({ min: 0, max: KEYS.length - 1 }),
  text: fc.option(fc.constantFrom("one", "two", "three"), {
    nil: undefined,
  }),
}, { requiredKeys: ["key"] });

const arbHistory = fc.array(
  fc.record({
    name: fc.constantFrom(...NAMES),
    ops: fc.array(arbOp, { minLength: 1, maxLength: 2 }),
  }),
  { minLength: 1, maxLength: 10 },
);

const arbPlan = fc.array(
  fc.constantFrom<CatchUp>("none", "store", ...NAMES),
  { minLength: 1, maxLength: 10 },
);

Deno.test("read model, shared key: any mix of store and partition catch-ups ends as an in-order replay, and as the spec says", async () => {
  await fc.assert(
    fc.asyncProperty(arbHistory, arbPlan, async (history, plan) => {
      await withV3Env(async (env) => {
        const landed = await runInterleaved(env, history, plan);
        const interleavedFiles = await files(env);
        const interleavedOwnership = ownership(env);
        assertEquals(interleavedFiles, await expectedFiles(landed));

        await replayInOrder(env);
        assertEquals(await files(env), interleavedFiles);
        assertEquals(ownership(env), interleavedOwnership);
      });
    }),
    { numRuns: 150 },
  );
});
