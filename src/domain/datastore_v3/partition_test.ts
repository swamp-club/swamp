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

import { assertEquals, assertThrows } from "@std/assert";
import { Commit } from "./commit.ts";
import { createIntent } from "./intent.ts";
import { dataVersionOp, leaseOp, putOp, tombstoneOp } from "./op.ts";
import { CommitRejectedError, Partition } from "./partition.ts";
import { partitionOf } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";
import {
  base64,
  dataKey,
  deleteVersion,
  metadata,
  modelCommit,
  modelIntent,
  modelPartition,
  savePut,
  sha256Of,
  versionOp,
} from "./v3_test_helpers.ts";

/** Asserts `fn` throws a CommitRejectedError with `reason`. */
function assertRejected(fn: () => unknown, reason: string): void {
  const error = assertThrows(fn, CommitRejectedError);
  assertEquals(error.reason, reason);
}

/** A snapshot of everything a partition exposes. */
function snapshot(partition: Partition) {
  return {
    seq: partition.seq,
    fence: partition.highestFence,
    holder: partition.leaseHolder,
    records: partition.recordKeys().map((key) => [
      key,
      partition.record(RecordKey.create(key))?.sha256,
    ]),
    names: partition.dataNames().map((name) => [
      name,
      partition.versions(name),
      partition.latest(name),
      partition.highWater(name),
    ]),
  };
}

Deno.test("Partition.append: applies a commit and advances seq", async () => {
  const partition = Partition.empty(modelPartition());
  const result = partition.append(
    modelCommit(1, [await savePut("vpc", 1), versionOp("vpc", 1)]),
  );
  assertEquals(result, { kind: "appended", seq: 1 });
  assertEquals(partition.seq, 1);
  assertEquals(
    partition.record(dataKey("vpc", 1))?.sha256,
    await sha256Of("vpc@1"),
  );
  assertEquals(partition.latest("vpc"), 1);
  assertEquals(partition.hasTxn("txn-1"), true);
});

Deno.test("Partition.append: accepts only the next seq", async () => {
  const partition = Partition.empty(modelPartition());
  const op = await savePut("vpc", 1);
  assertRejected(() => partition.append(modelCommit(2, [op])), "seq-gap");
  partition.append(modelCommit(1, [op]));
  assertRejected(
    () => partition.append(modelCommit(1, [op], { txnId: "other" })),
    "seq-gap",
  );
  assertRejected(() => partition.append(modelCommit(3, [op])), "seq-gap");
});

Deno.test("Partition.append: a repeated txnId is a no-op, even with a stale seq", async () => {
  const partition = Partition.empty(modelPartition());
  const commit = modelCommit(1, [await savePut("vpc", 1), versionOp("vpc", 1)]);
  partition.append(commit);
  const before = snapshot(partition);
  assertEquals(partition.append(commit), { kind: "duplicate" });
  assertEquals(
    partition.append(modelCommit(5, [versionOp("vpc", 9)], { txnId: "txn-1" })),
    { kind: "duplicate" },
  );
  assertEquals(snapshot(partition), before);
});

Deno.test("Partition.append: refuses a commit for another partition", () => {
  const partition = Partition.empty(partitionOf({ kind: "lockfile" }));
  assertRejected(
    () => partition.append(modelCommit(1, [versionOp("vpc", 1)])),
    "partition-mismatch",
  );
  assertEquals(partition.seq, 0);
});

Deno.test("Partition.append: data versions only grow and are never reused", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 1), versionOp("vpc", 2)]));
  assertEquals(partition.versions("vpc"), [1, 2]);
  assertEquals(partition.latest("vpc"), 2);
  assertRejected(
    () => partition.append(modelCommit(2, [versionOp("vpc", 2)])),
    "version-not-increasing",
  );

  partition.append(modelCommit(2, [deleteVersion("vpc", 2)]));
  assertEquals(partition.latest("vpc"), 1);
  assertEquals(partition.highWater("vpc"), 2);
  // Version 2 was deleted, but its number is not handed out again.
  assertRejected(
    () => partition.append(modelCommit(3, [versionOp("vpc", 2)])),
    "version-not-increasing",
  );
  partition.append(modelCommit(3, [versionOp("vpc", 3)]));
  assertEquals(partition.latest("vpc"), 3);
});

Deno.test("Partition.append: deleting every version leaves no latest but keeps the high-water mark", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 1), versionOp("vpc", 2)]));
  partition.append(
    modelCommit(2, [deleteVersion("vpc", 1), deleteVersion("vpc", 2)]),
  );
  assertEquals(partition.versions("vpc"), []);
  assertEquals(partition.latest("vpc"), undefined);
  assertEquals(partition.highWater("vpc"), 2);
});

Deno.test("Partition.append: a whole-name delete removes only the versions it names", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 1)]));
  // Another writer adds version 2 before the delete lands.
  partition.append(modelCommit(2, [versionOp("vpc", 2)]));
  partition.append(
    modelCommit(3, [
      deleteVersion("vpc", 1),
      tombstoneOp({
        intent: modelIntent({ kind: "data.delete", name: "vpc" }),
        key: RecordKey.create("data/@swamp/aws-ec2/x/vpc/latest"),
      }),
    ]),
  );
  assertEquals(partition.versions("vpc"), [2]);
  assertEquals(partition.latest("vpc"), 2);
});

Deno.test("Partition.append: a put with a stale expect is refused and changes nothing", async () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [await savePut("vpc", 1, "a", "absent")]));
  const before = snapshot(partition);

  const absentAgain = modelCommit(2, [await savePut("vpc", 1, "b", "absent")]);
  assertRejected(() => partition.append(absentAgain), "expect-failed");

  const stale = modelCommit(2, [
    versionOp("vpc", 2),
    await savePut("vpc", 1, "b", { sha256: await sha256Of("not a") }),
  ]);
  assertRejected(() => partition.append(stale), "expect-failed");
  assertEquals(snapshot(partition), before);

  partition.append(
    modelCommit(2, [
      await savePut("vpc", 1, "b", { sha256: await sha256Of("a") }),
    ]),
  );
  assertEquals(
    partition.record(dataKey("vpc", 1))?.sha256,
    await sha256Of("b"),
  );
});

Deno.test("Partition.append: tombstone expect 'present'", async () => {
  const partition = Partition.empty(modelPartition());
  assertRejected(
    () =>
      partition.append(modelCommit(1, [deleteVersion("vpc", 1, "present")])),
    "expect-failed",
  );
  partition.append(modelCommit(1, [await savePut("vpc", 1)]));
  partition.append(modelCommit(2, [deleteVersion("vpc", 1, "present")]));
  assertEquals(partition.record(dataKey("vpc", 1)), undefined);
  assertRejected(
    () =>
      partition.append(modelCommit(3, [deleteVersion("vpc", 1, "present")])),
    "expect-failed",
  );
});

Deno.test("Partition.append: ops in one commit see each other's effects in order", async () => {
  const partition = Partition.empty(modelPartition());
  partition.append(
    modelCommit(1, [
      await savePut("vpc", 1, "a", "absent"),
      await savePut("vpc", 1, "b", { sha256: await sha256Of("a") }),
      deleteVersion("vpc", 1, "present"),
      await savePut("vpc", 1, "c", "absent"),
    ]),
  );
  assertEquals(
    partition.record(dataKey("vpc", 1))?.sha256,
    await sha256Of("c"),
  );
});

Deno.test("Partition.append: fences never go down", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 1)], { fence: 5 }));
  assertEquals(partition.highestFence, 5);
  assertRejected(
    () => partition.append(modelCommit(2, [versionOp("vpc", 2)], { fence: 4 })),
    "stale-fence",
  );
  partition.append(modelCommit(2, [versionOp("vpc", 2)], { fence: 5 }));
  partition.append(modelCommit(3, [versionOp("vpc", 3)], { fence: 6 }));
  assertEquals(partition.highestFence, 6);
  assertEquals(partition.seq, 3);
});

Deno.test("Partition.append: accepts an unfenced commit before any fence", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 1)]));
  partition.append(modelCommit(2, [versionOp("vpc", 2)]));
  assertEquals(partition.highestFence, undefined);
  assertEquals(partition.seq, 2);
});

Deno.test("Partition.append: refuses an unfenced commit once a fence was seen", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 1)], { fence: 1 }));
  const before = snapshot(partition);
  assertRejected(
    () => partition.append(modelCommit(2, [versionOp("vpc", 2)])),
    "unfenced",
  );
  assertEquals(snapshot(partition), before);

  // A fence seen only through a lease op counts too.
  const leased = Partition.empty(modelPartition());
  leased.append(modelCommit(1, [leaseOp({ holder: "serve-a", fence: 3 })]));
  assertRejected(
    () => leased.append(modelCommit(2, [versionOp("vpc", 1)])),
    "unfenced",
  );
  leased.append(modelCommit(2, [versionOp("vpc", 1)], { fence: 3 }));
  assertEquals(leased.seq, 2);
});

Deno.test("Partition.append: lease ops raise the fence and name the holder", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [leaseOp({ holder: "serve-a", fence: 1 })]));
  partition.append(
    modelCommit(2, [leaseOp({ holder: "serve-b", fence: 2 })], { fence: 1 }),
  );
  assertEquals(partition.leaseHolder, "serve-b");
  assertEquals(partition.highestFence, 2);
  assertRejected(
    () =>
      partition.append(
        modelCommit(3, [leaseOp({ holder: "serve-a", fence: 1 })], {
          fence: 2,
        }),
      ),
    "stale-fence",
  );
  assertEquals(partition.leaseHolder, "serve-b");
});

Deno.test("Partition.append: a lock-file edit with a stale expect is refused", async () => {
  const lockfile = partitionOf({ kind: "lockfile" });
  const partition = Partition.empty(lockfile);
  const write = (text: string, expect: "absent" | { sha256: string }) =>
    putOp({
      intent: createIntent({ kind: "lockfile.write" }),
      key: RecordKey.create("config/upstream_extensions.json"),
      inline: base64(text),
      expect,
    });
  const commit = async (
    seq: number,
    text: string,
    expect: "absent" | { sha256: string },
  ) =>
    Commit.create({
      seq,
      partition: lockfile,
      namespace: "",
      txnId: `lock-${seq}-${text}`,
      writer: { host: "h", pid: 1, instance: "i" },
      at: "2026-10-11T00:00:00Z",
      ops: [await write(text, expect)],
    });
  partition.append(await commit(1, "{}", "absent"));
  // Two installs both read "{}"; the first to commit wins, the second loses.
  const first = await commit(2, "{a}", { sha256: await sha256Of("{}") });
  const second = await commit(3, "{b}", { sha256: await sha256Of("{}") });
  partition.append(first);
  assertRejected(() => partition.append(second), "expect-failed");
  assertEquals(
    partition.record(RecordKey.create("config/upstream_extensions.json"))
      ?.sha256,
    await sha256Of("{a}"),
  );
});

Deno.test("Partition.append: a misrouted commit is refused even when its txnId landed here", () => {
  const partition = Partition.empty(partitionOf({ kind: "lockfile" }));
  const lockfileCommit = Commit.create({
    seq: 1,
    partition: partitionOf({ kind: "lockfile" }),
    namespace: "",
    txnId: "shared-txn",
    writer: { host: "h", pid: 1, instance: "i" },
    at: "2026-10-11T00:00:00Z",
    ops: [leaseOp({ holder: "h", fence: 1 })],
  });
  partition.append(lockfileCommit);
  assertRejected(
    () =>
      partition.append(
        modelCommit(1, [versionOp("vpc", 1)], { txnId: "shared-txn" }),
      ),
    "partition-mismatch",
  );
});

Deno.test("Partition.append: deleting a version of a name never written lists no name", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [deleteVersion("ghost", 3)]));
  assertEquals(partition.dataNames(), []);
  partition.append(modelCommit(2, [versionOp("ghost", 1)]));
  assertEquals(partition.dataNames(), ["ghost"]);
});

Deno.test("Partition.append: a data rename is two data-version ops in one commit", async () => {
  const partition = Partition.empty(modelPartition());
  partition.append(
    modelCommit(1, [
      await savePut("old", 1),
      versionOp("old", 1),
      await savePut("old", 2),
      versionOp("old", 2),
    ], { fence: 1 }),
  );
  assertEquals(partition.latest("old"), 2);

  // Today's rename saves the content under the new name, then writes a
  // marker version on the old name carrying `renamedTo`.
  const marker = dataVersionOp({
    key: RecordKey.create(
      "data/@swamp/aws-ec2/6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b/old/3/metadata.yaml",
    ),
    metadata: { ...metadata("old", 3) as object, renamedTo: "new" },
  });
  partition.append(
    modelCommit(2, [
      await putOp({
        intent: modelIntent({ kind: "data.rename", name: "old", to: "new" }),
        key: dataKey("new", 1),
        inline: base64("old@2"),
        expect: "absent",
      }),
      versionOp("new", 1),
      marker,
    ], { fence: 1 }),
  );

  assertEquals(partition.latest("new"), 1);
  assertEquals(partition.latest("old"), 3);
  assertEquals(partition.highWater("new"), 1);
  assertEquals(partition.highWater("old"), 3);
  assertEquals(partition.versions("old"), [1, 2, 3]);

  // The marker must be above the old name's high-water mark.
  assertRejected(
    () =>
      partition.append(
        modelCommit(3, [versionOp("new", 2), versionOp("old", 3)], {
          fence: 1,
        }),
      ),
    "version-not-increasing",
  );
});

/** A partition with a fence, a lease holder, records and data names. */
async function populated(): Promise<Partition> {
  const partition = Partition.empty(modelPartition());
  partition.append(
    modelCommit(1, [await savePut("a", 1), versionOp("a", 1)], { fence: 2 }),
  );
  partition.append(
    modelCommit(2, [leaseOp({ holder: "serve-1", fence: 3 })], { fence: 3 }),
  );
  return partition;
}

/** The prior-txnId lookup for {@link populated}'s two commits. */
function populatedTxns(txnId: string): boolean {
  return txnId === "txn-1" || txnId === "txn-2";
}

Deno.test("Partition.restore: round-trips a partition's state", async () => {
  const partition = await populated();
  const restored = Partition.restore(
    modelPartition(),
    JSON.parse(JSON.stringify(partition.snapshot())),
    populatedTxns,
  );
  assertEquals(snapshot(restored), snapshot(partition));
  assertEquals(restored.leaseHolder, "serve-1");
  assertEquals(restored.hasTxn("txn-1"), true);
  assertEquals(restored.hasTxn("txn-3"), false);
  assertEquals(restored.snapshot(), partition.snapshot());
});

Deno.test("Partition.restore: the snapshot leaves txnIds out, and the lookup keeps retries no-ops", async () => {
  const partition = await populated();
  const value = JSON.parse(JSON.stringify(partition.snapshot()));
  assertEquals("txnIds" in value, false);

  // A retry of a commit from before the snapshot, sent with the next seq.
  const retry = modelCommit(3, [await savePut("a", 3), versionOp("a", 3)], {
    txnId: "txn-1",
    fence: 3,
  });
  const restored = Partition.restore(modelPartition(), value, populatedTxns);
  assertEquals(restored.append(retry), { kind: "duplicate" });
  assertEquals(restored.seq, 2);

  // Why the lookup must be exact: without it the retry would apply twice.
  const blind = Partition.restore(modelPartition(), value, () => false);
  assertEquals(blind.append(retry), { kind: "appended", seq: 3 });
});

Deno.test("Partition.restore: an empty partition round-trips", () => {
  const partition = Partition.empty(modelPartition());
  const restored = Partition.restore(
    modelPartition(),
    partition.snapshot(),
    () => false,
  );
  assertEquals(restored.seq, 0);
  assertEquals(restored.highestFence, undefined);
});

Deno.test("Partition.restore: refuses a damaged snapshot", async () => {
  const good = (await populated()).snapshot();
  const other = partitionOf({ kind: "definition", id: crypto.randomUUID() });
  const damaged: [string, unknown][] = [
    ["not an object", "snapshot"],
    ["another version", { ...good, v: 2 }],
    ["another partition", { ...good, partition: other.toString() }],
    ["an unknown field", { ...good, extra: true }],
    ["a negative seq", { ...good, seq: -1 }],
    ["a negative fence", { ...good, highestFence: -1 }],
    ["an empty lease holder", { ...good, leaseHolder: "" }],
    ["a txnIds list", { ...good, txnIds: ["txn-1", "txn-2"] }],
    ["a lease holder without a fence", { ...good, highestFence: undefined }],
    ["a digest that is not SHA-256 hex", {
      ...good,
      records: [[good.records[0][0], "not-a-digest"]],
    }],
    ["an invalid record key", {
      ...good,
      records: [["../escape", good.records[0][1]]],
    }],
    ["a repeated record", {
      ...good,
      records: [good.records[0], good.records[0]],
    }],
    ["a live version above the high-water mark", {
      ...good,
      names: [{ name: "a", live: [2], highWater: 1 }],
    }],
    ["a zero high-water mark", {
      ...good,
      names: [{ name: "a", live: [], highWater: 0 }],
    }],
    ["a repeated data name", {
      ...good,
      names: [good.names[0], good.names[0]],
    }],
  ];
  for (const [label, value] of damaged) {
    assertThrows(
      () => Partition.restore(modelPartition(), value, populatedTxns),
      Error,
      "Invalid snapshot",
      label,
    );
  }
});
