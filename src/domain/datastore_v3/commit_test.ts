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

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Commit, type CommitProps, MAX_COMMIT_OPS } from "./commit.ts";
import { createIntent } from "./intent.ts";
import { leaseOp, type Op, tombstoneOp } from "./op.ts";
import { partitionOf } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";
import {
  base64,
  modelCommit,
  modelPartition,
  savePut,
  sha256Of,
  versionOp,
} from "./v3_test_helpers.ts";

function props(ops: readonly Op[]): CommitProps {
  return {
    seq: 1,
    partition: modelPartition(),
    namespace: "team-a",
    txnId: "txn-1",
    writer: { host: "h", pid: 1, instance: "i" },
    at: "2026-10-11T00:00:00Z",
    ops,
  };
}

Deno.test("Commit.create: builds a v3 envelope with every optional field", async () => {
  const commit = Commit.create({
    ...props([await savePut("vpc", 1), versionOp("vpc", 1)]),
    executedAt: "2026-10-10T23:59:59.123Z",
    clockOffsetMs: -12.5,
    principal: "user:alice",
    fence: 3,
  });
  const json = commit.toJSON();
  assertEquals(json.v, 3);
  assertEquals(json.partition, modelPartition().toString());
  assertEquals(json.principal, "user:alice");
  assertEquals(json.fence, 3);
  assertEquals(json.ops.length, 2);
  assert(Object.isFrozen(commit.ops));
});

Deno.test("Commit.create: rejects a malformed envelope", async () => {
  const ops = [await savePut("vpc", 1)];
  const invalid: Partial<CommitProps>[] = [
    { seq: 0 },
    { seq: 1.5 },
    { txnId: "" },
    { namespace: "x".repeat(1025) },
    { writer: { host: "", pid: 1, instance: "i" } },
    { writer: { host: "h", pid: 0, instance: "i" } },
    { at: "yesterday" },
    { at: "2026-10-11T00:00:00+01:00" },
    { executedAt: "2026-13-45T00:00:00Z" },
    { clockOffsetMs: Number.NaN },
    { principal: "" },
    { fence: -1 },
    { ops: [] },
  ];
  for (const override of invalid) {
    assertThrows(
      () => Commit.create({ ...props(ops), ...override }),
      Error,
      undefined,
      JSON.stringify(override),
    );
  }
});

Deno.test("Commit.create: rejects more than the op limit", () => {
  const op = leaseOp({ holder: "h", fence: 1 });
  assertThrows(
    () => Commit.create(props(new Array(MAX_COMMIT_OPS + 1).fill(op))),
    Error,
    "at most",
  );
});

Deno.test("Commit.create: rejects an op whose intent belongs to another partition", () => {
  const runIntent = createIntent({
    kind: "run.update",
    run: {
      workflowId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      runId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    },
  });
  const op = tombstoneOp({
    intent: runIntent,
    key: RecordKey.create("workflow-runs/x/workflow-run-y.yaml"),
  });
  assertThrows(() => Commit.create(props([op])), Error, "belongs to partition");
});

Deno.test("Commit.create: rejects a data-version op outside a model partition", () => {
  assertThrows(
    () =>
      Commit.create({
        ...props([versionOp("vpc", 1)]),
        partition: partitionOf({ kind: "lockfile" }),
      }),
    Error,
    "model partition",
  );
});

Deno.test("Commit.create: rejects op-shaped literals", () => {
  assertThrows(
    () =>
      Commit.create(
        props([{ kind: "lease", holder: "h", fence: 1 } as unknown as Op]),
      ),
    TypeError,
    "op factories",
  );
});

Deno.test("Commit.fromJSON: round-trips a commit", async () => {
  const commit = modelCommit(4, [
    await savePut("vpc", 2, "body", { sha256: "d".repeat(64) }),
    versionOp("vpc", 2),
    leaseOp({ holder: "serve-1", fence: 2 }),
  ], { fence: 2 });
  const parsed = await Commit.fromJSON(JSON.parse(JSON.stringify(commit)));
  assert(parsed.equals(commit) && commit.equals(parsed));
});

Deno.test("Commit.fromJSON: recomputes inline digests rather than trusting the input", async () => {
  const commit = modelCommit(1, [await savePut("vpc", 1, "real bytes")]);
  const json = JSON.parse(JSON.stringify(commit));
  const parsed = await Commit.fromJSON(json);
  const put = parsed.ops[0];
  assert(put.kind === "put");
  assertEquals(put.sha256, await sha256Of("real bytes"));

  json.ops[0].inline = base64("tampered");
  const tampered = await Commit.fromJSON(json);
  const tamperedPut = tampered.ops[0];
  assert(tamperedPut.kind === "put");
  assertEquals(tamperedPut.sha256, await sha256Of("tampered"));
});

Deno.test("Commit.fromJSON: rejects other versions, unknown fields and bad partitions", async () => {
  const json = JSON.parse(
    JSON.stringify(modelCommit(1, [await savePut("vpc", 1)])),
  );
  await assertRejects(() => Commit.fromJSON({ ...json, v: 2 }), Error, "v2");
  await assertRejects(() => Commit.fromJSON({ ...json, extra: 1 }), Error);
  await assertRejects(
    () => Commit.fromJSON({ ...json, partition: "model--x" }),
    Error,
  );
  await assertRejects(() => Commit.fromJSON({ ...json, ops: {} }), TypeError);
  await assertRejects(() => Commit.fromJSON([]), TypeError);
});

Deno.test("Commit.equals: differs when any field differs", async () => {
  const ops = [await savePut("vpc", 1)];
  const a = modelCommit(1, ops);
  assert(a.equals(modelCommit(1, ops)));
  assert(!a.equals(modelCommit(2, ops)));
  assert(!a.equals(modelCommit(1, ops, { fence: 1 })));
});

Deno.test("Commit.create: rejects calendar dates that do not exist", async () => {
  const ops = [await savePut("vpc", 1)];
  for (
    const at of [
      "2026-02-30T00:00:00Z",
      "2026-04-31T12:00:00Z",
      "2026-10-11T24:00:00Z",
    ]
  ) {
    assertThrows(
      () => Commit.create({ ...props(ops), at }),
      Error,
      "ISO 8601",
      at,
    );
  }
  Commit.create({ ...props(ops), at: "2028-02-29T00:00:00.123Z" });
});
