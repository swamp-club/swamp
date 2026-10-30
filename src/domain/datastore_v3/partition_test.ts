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
    leaseFence: partition.leaseFence,
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

Deno.test("Partition.appendObserved: accepts any later seq and takes it as the partition's (swamp-club#3985)", async () => {
  const partition = Partition.empty(modelPartition());
  assertEquals(
    partition.appendObserved(modelCommit(3, [await savePut("vpc", 1)])),
    { kind: "appended", seq: 3 },
  );
  assertEquals(partition.seq, 3);
  assertEquals(
    partition.appendObserved(modelCommit(4, [await savePut("vpc", 2)])),
    { kind: "appended", seq: 4 },
  );
  assertEquals(
    partition.appendObserved(modelCommit(9, [await savePut("vpc", 3)])),
    { kind: "appended", seq: 9 },
  );
  assertEquals(partition.seq, 9);
  assertEquals(partition.recordKeys().length, 3);
});

Deno.test("Partition.appendObserved: refuses a seq at or below the partition's under a new txnId", async () => {
  const partition = Partition.empty(modelPartition());
  const op = await savePut("vpc", 1);
  partition.appendObserved(modelCommit(5, [op]));
  const before = snapshot(partition);
  assertRejected(
    () => partition.appendObserved(modelCommit(5, [op], { txnId: "other" })),
    "seq-gap",
  );
  assertRejected(
    () => partition.appendObserved(modelCommit(2, [op], { txnId: "older" })),
    "seq-gap",
  );
  assertEquals(snapshot(partition), before);
});

Deno.test("Partition.appendObserved: a repeated txnId is still a no-op", async () => {
  const partition = Partition.empty(modelPartition());
  const commit = modelCommit(4, [await savePut("vpc", 1), versionOp("vpc", 1)]);
  partition.appendObserved(commit);
  const before = snapshot(partition);
  assertEquals(partition.appendObserved(commit), { kind: "duplicate" });
  assertEquals(
    partition.appendObserved(
      modelCommit(9, [versionOp("vpc", 9)], { txnId: "txn-4" }),
    ),
    { kind: "duplicate" },
  );
  assertEquals(snapshot(partition), before);
});

Deno.test("Partition.appendObserved: keeps the partition and fence rules", () => {
  const partition = Partition.empty(modelPartition());
  assertRejected(
    () =>
      Partition.empty(partitionOf({ kind: "lockfile" })).appendObserved(
        modelCommit(1, [versionOp("vpc", 1)]),
      ),
    "partition-mismatch",
  );
  partition.appendObserved(
    modelCommit(2, [versionOp("vpc", 1)], { fence: 3 }),
  );
  assertRejected(
    () =>
      partition.appendObserved(modelCommit(5, [versionOp("vpc", 2)], {
        fence: 2,
      })),
    "stale-fence",
  );
  assertRejected(
    () => partition.appendObserved(modelCommit(5, [versionOp("vpc", 2)])),
    "unfenced",
  );
  assertEquals(partition.seq, 2);
});

Deno.test("Partition.appendObserved: leaves expect and data-version rules to serve, which judged them with the commits a follower cannot see", async () => {
  const partition = Partition.empty(modelPartition());
  partition.appendObserved(
    modelCommit(2, [versionOp("vpc", 1)], { fence: 3 }),
  );
  // A hidden commit may have recorded the version again or changed the
  // record the expect names: serve accepted these, so the copy takes them.
  partition.appendObserved(
    modelCommit(5, [versionOp("vpc", 1)], { fence: 3 }),
  );
  const mismatched = await savePut("vpc", 1, "x", {
    sha256: await sha256Of("other"),
  });
  partition.appendObserved(modelCommit(7, [mismatched], { fence: 3 }));
  assertEquals(partition.seq, 7);
  // The plain append still refuses both.
  const solo = Partition.empty(modelPartition());
  solo.append(modelCommit(1, [versionOp("vpc", 1)], { fence: 3 }));
  assertRejected(
    () => solo.append(modelCommit(2, [versionOp("vpc", 1)], { fence: 3 })),
    "version-live",
  );
  assertRejected(
    () => solo.append(modelCommit(2, [mismatched], { fence: 3 })),
    "expect-failed",
  );
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

Deno.test("Partition.append: a live data version is never recorded twice", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 1), versionOp("vpc", 2)]));
  assertEquals(partition.versions("vpc"), [1, 2]);
  assertEquals(partition.latest("vpc"), 2);
  assertRejected(
    () => partition.append(modelCommit(2, [versionOp("vpc", 2)])),
    "version-live",
  );
  assertRejected(
    () => partition.append(modelCommit(2, [versionOp("vpc", 1)])),
    "version-live",
  );
  assertEquals(partition.seq, 1);
});

Deno.test("Partition.append: a removed version is never recorded again (swamp-club#3532)", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 1), versionOp("vpc", 2)]));
  partition.append(modelCommit(2, [deleteVersion("vpc", 2)]));
  assertEquals(partition.latest("vpc"), 1);
  assertEquals(partition.highWater("vpc"), 2);
  assertEquals(partition.removed("vpc", 2), true);
  // Another clone may hold version 2's old content.
  assertRejected(
    () => partition.append(modelCommit(3, [versionOp("vpc", 2)])),
    "version-reused",
  );
  // Nor once the name is empty.
  partition.append(modelCommit(3, [deleteVersion("vpc", 1)]));
  assertEquals(partition.versions("vpc"), []);
  for (const version of [1, 2]) {
    assertRejected(
      () => partition.append(modelCommit(4, [versionOp("vpc", version)])),
      "version-reused",
    );
  }
  partition.append(modelCommit(4, [versionOp("vpc", 3)]));
  assertEquals(partition.versions("vpc"), [3]);
  assertEquals(partition.highWater("vpc"), 3);
});

Deno.test("Partition.append: a version removed in the same commit is not recorded again", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 1)]));
  assertRejected(
    () =>
      partition.append(
        modelCommit(2, [deleteVersion("vpc", 1), versionOp("vpc", 1)]),
      ),
    "version-reused",
  );
  assertEquals(partition.seq, 1);
  assertEquals(partition.removed("vpc", 1), false);
});

Deno.test("Partition.append: a version removed before it was recorded may still arrive", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 2)]));
  // A tombstone of a version the name never held live removes nothing, so
  // a deferred version 1 promoted later still records.
  partition.append(modelCommit(2, [deleteVersion("vpc", 1)]));
  assertEquals(partition.removed("vpc", 1), false);
  partition.append(modelCommit(3, [versionOp("vpc", 1)]));
  assertEquals(partition.versions("vpc"), [1, 2]);
});

Deno.test("Partition.append: replay accepts a reuse a store holds from before version-reused", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 1)]));
  partition.append(modelCommit(2, [deleteVersion("vpc", 1)]));
  assertEquals(
    partition.append(modelCommit(3, [versionOp("vpc", 1)]), { replay: true }),
    { kind: "appended", seq: 3 },
  );
  assertEquals(partition.versions("vpc"), [1]);
  assertEquals(partition.removed("vpc", 1), false);
  // Removing it again is remembered, and live commits are checked.
  partition.append(modelCommit(4, [deleteVersion("vpc", 1)]));
  assertRejected(
    () => partition.append(modelCommit(5, [versionOp("vpc", 1)])),
    "version-reused",
  );
  // Replay keeps every other rule.
  partition.append(modelCommit(5, [versionOp("vpc", 2)]));
  assertRejected(
    () =>
      partition.append(modelCommit(6, [versionOp("vpc", 2)]), {
        replay: true,
      }),
    "version-live",
  );
});

Deno.test("Partition.retainDroppedVersions: raises the high-water mark and counts dropped versions removed", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 1)]));
  assertEquals(partition.retainDroppedVersions("vpc", [1]), false);
  assertEquals(partition.retainDroppedVersions("vpc", [2, 3]), true);
  assertEquals(partition.versions("vpc"), [1]);
  assertEquals(partition.highWater("vpc"), 3);
  assertEquals(partition.removed("vpc", 1), false);
  assertEquals(partition.removed("vpc", 3), true);
  assertEquals(partition.retainDroppedVersions("vpc", [2]), false);
  // A name the kept commits never wrote.
  assertEquals(partition.retainDroppedVersions("subnet", [4]), true);
  assertEquals(partition.highWater("subnet"), 4);
  assertRejected(
    () => partition.append(modelCommit(2, [versionOp("subnet", 4)])),
    "version-reused",
  );
});

Deno.test("Partition.append: versions can arrive out of order, as parallel writers finish", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 6)]));
  // Version 5 was allocated first but finished (or was promoted) later.
  partition.append(modelCommit(2, [versionOp("vpc", 5)]));
  assertEquals(partition.versions("vpc"), [5, 6]);
  assertEquals(partition.latest("vpc"), 6);
  assertEquals(partition.highWater("vpc"), 6);
  // In one commit too, and the high-water mark never goes down.
  partition.append(modelCommit(3, [versionOp("vpc", 8), versionOp("vpc", 7)]));
  assertEquals(partition.versions("vpc"), [5, 6, 7, 8]);
  assertEquals(partition.highWater("vpc"), 8);
});

Deno.test("Partition.append: an append re-records a live version only with its data.append put", async () => {
  const partition = Partition.empty(modelPartition());
  partition.append(
    modelCommit(1, [versionOp("vpc", 1), versionOp("vpc", 2)]),
  );
  partition.append(modelCommit(2, [deleteVersion("vpc", 2)]));
  // The latest marker names version 1, below the high-water mark: an
  // append targets it.
  partition.append(
    modelCommit(3, [
      await savePut("vpc", 1, "vpc@1 more", undefined, "data.append"),
      versionOp("vpc", 1),
    ]),
  );
  assertEquals(partition.versions("vpc"), [1]);
  assertEquals(partition.highWater("vpc"), 2);
  // A save put does not stand in for an append, nor does an append of
  // another version or name.
  for (
    const put of [
      await savePut("vpc", 1, "again"),
      await savePut("vpc", 3, "other", undefined, "data.append"),
      await savePut("subnet", 1, "other", undefined, "data.append"),
    ]
  ) {
    assertRejected(
      () => partition.append(modelCommit(4, [put, versionOp("vpc", 1)])),
      "version-live",
    );
  }
  assertEquals(partition.seq, 3);
});

Deno.test("Partition.append: an append put lets through only a later data-version op, once", async () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [versionOp("vpc", 4)]));
  const append = await savePut("vpc", 4, "more", undefined, "data.append");
  // Another writer's save of the live version, ahead of an append in the
  // same commit, is still refused.
  assertRejected(
    () =>
      partition.append(
        modelCommit(2, [versionOp("vpc", 4), append, versionOp("vpc", 4)]),
      ),
    "version-live",
  );
  // One append put lets one op through, not two.
  assertRejected(
    () =>
      partition.append(
        modelCommit(2, [append, versionOp("vpc", 4), versionOp("vpc", 4)]),
      ),
    "version-live",
  );
  partition.append(modelCommit(2, [append, versionOp("vpc", 4)]));
  assertEquals(partition.seq, 2);
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

Deno.test("Partition.append: an expect-failed refusal names the failing record key, message unchanged (swamp-club#3915)", async () => {
  const partition = Partition.empty(modelPartition());
  partition.append(modelCommit(1, [await savePut("vpc", 1, "a", "absent")]));
  // Another reason carries no key.
  const gap = assertThrows(
    () => partition.append(modelCommit(5, [versionOp("vpc", 2)])),
    CommitRejectedError,
  );
  assertEquals(gap.reason, "seq-gap");
  assertEquals(gap.key, undefined);

  const absentAgain = modelCommit(2, [await savePut("vpc", 1, "b", "absent")]);
  const absent = assertThrows(
    () => partition.append(absentAgain),
    CommitRejectedError,
  );
  assertEquals(absent.reason, "expect-failed");
  assertEquals(absent.key?.toString(), dataKey("vpc", 1).toString());
  assertEquals(
    absent.message,
    `Record ${
      dataKey("vpc", 1)
    } in partition ${modelPartition()} is not absent`,
  );

  const present = assertThrows(
    () =>
      partition.append(modelCommit(2, [deleteVersion("vpc", 2, "present")])),
    CommitRejectedError,
  );
  assertEquals(present.reason, "expect-failed");
  assertEquals(present.key?.toString(), dataKey("vpc", 2).toString());
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

Deno.test("Partition.append: a tombstone expecting a digest removes only that version (swamp-club#4097)", async () => {
  const partition = Partition.empty(modelPartition());
  const a = { sha256: await sha256Of("a") };
  const b = { sha256: await sha256Of("b") };
  partition.append(modelCommit(1, [await savePut("vpc", 1, "a")]));
  assertRejected(
    () => partition.append(modelCommit(2, [deleteVersion("vpc", 1, b)])),
    "expect-failed",
  );
  partition.append(modelCommit(2, [deleteVersion("vpc", 1, a)]));
  assertEquals(partition.record(dataKey("vpc", 1)), undefined);
  assertRejected(
    () => partition.append(modelCommit(3, [deleteVersion("vpc", 1, a)])),
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

  // A lease fence is not a writer fence: it never makes a commit unfenced.
  const leased = Partition.empty(modelPartition());
  leased.append(modelCommit(1, [leaseOp({ holder: "serve-a", fence: 3 })]));
  leased.append(modelCommit(2, [versionOp("vpc", 1)]));
  assertEquals(leased.seq, 2);
  assertEquals(leased.highestFence, undefined);
});

Deno.test("Partition.append: lease ops raise the lease fence and name the holder", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(
    modelCommit(1, [leaseOp({ holder: "lease-a", fence: 1 })], { fence: 7 }),
  );
  partition.append(
    modelCommit(2, [leaseOp({ holder: "lease-b", fence: 2 })], { fence: 7 }),
  );
  assertEquals(partition.leaseHolder, "lease-b");
  assertEquals(partition.leaseFence, 2);
  // The writer fence is counted apart: a lease fence below it is fine.
  assertEquals(partition.highestFence, 7);
  const before = snapshot(partition);
  assertRejected(
    () =>
      partition.append(
        modelCommit(3, [leaseOp({ holder: "lease-a", fence: 1 })], {
          fence: 7,
        }),
      ),
    "stale-lease",
  );
  assertEquals(snapshot(partition), before);
  // The same fence again is the same lease's next commit.
  partition.append(
    modelCommit(3, [leaseOp({ holder: "lease-b", fence: 2 })], { fence: 7 }),
  );
  assertEquals(partition.seq, 3);
});

Deno.test("Partition.append: a lease fence above the writer fence never refuses a writer commit", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(
    modelCommit(1, [leaseOp({ holder: "lease-a", fence: 50 })], { fence: 2 }),
  );
  partition.append(modelCommit(2, [versionOp("vpc", 1)], { fence: 2 }));
  assertEquals(partition.highestFence, 2);
  assertEquals(partition.leaseFence, 50);
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

  // The marker must not be a live version of the old name.
  assertRejected(
    () =>
      partition.append(
        modelCommit(3, [versionOp("new", 2), versionOp("old", 3)], {
          fence: 1,
        }),
      ),
    "version-live",
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

Deno.test("Partition.retainVersionsOf: keeps a later state's high-water marks and removed versions not live here", () => {
  const earlier = Partition.empty(modelPartition());
  earlier.append(modelCommit(1, [versionOp("vpc", 1), versionOp("vpc", 2)]));
  const later = Partition.restore(modelPartition(), {
    v: 1,
    partition: modelPartition().toString(),
    seq: 5,
    records: [],
    names: [
      { name: "vpc", live: [5], highWater: 6, removed: [[2, 4]] },
      { name: "subnet", live: [], highWater: 3, removed: [[1, 3]] },
    ],
  }, () => false);
  assertEquals(earlier.retainVersionsOf(later), true);
  assertEquals(earlier.versions("vpc"), [1, 2]);
  assertEquals(earlier.highWater("vpc"), 6);
  // Version 2 is live here, so it is not removed.
  assertEquals(
    [1, 2, 3, 4, 5].map((v) => earlier.removed("vpc", v)),
    [false, false, true, true, false],
  );
  assertEquals(earlier.highWater("subnet"), 3);
  assertEquals(earlier.removed("subnet", 2), true);
  assertEquals(earlier.retainVersionsOf(later), false);
});

Deno.test("Partition.restore: round-trips removed and out-of-order versions", () => {
  const partition = Partition.empty(modelPartition());
  partition.append(
    modelCommit(1, [
      versionOp("a", 1),
      versionOp("a", 2),
      versionOp("a", 3),
      versionOp("a", 5),
    ]),
  );
  partition.append(
    modelCommit(2, [
      deleteVersion("a", 1),
      deleteVersion("a", 2),
      deleteVersion("a", 5),
    ]),
  );
  partition.append(modelCommit(3, [versionOp("a", 4)]));
  const snapshotted = partition.snapshot();
  assertEquals(snapshotted.names, [
    { name: "a", live: [3, 4], highWater: 5, removed: [[1, 2], [5, 5]] },
  ]);
  const restored = Partition.restore(
    modelPartition(),
    JSON.parse(JSON.stringify(snapshotted)),
    () => false,
  );
  assertEquals(snapshot(restored), snapshot(partition));
  assertEquals(restored.versions("a"), [3, 4]);
  assertEquals(restored.highWater("a"), 5);
  assertRejected(
    () => restored.append(modelCommit(4, [versionOp("a", 4)])),
    "version-live",
  );
  assertRejected(
    () => restored.append(modelCommit(4, [versionOp("a", 2)])),
    "version-reused",
  );
});

Deno.test("Partition.restore: a snapshot written before removed versions existed restores with none", () => {
  const restored = Partition.restore(modelPartition(), {
    v: 1,
    partition: modelPartition().toString(),
    seq: 3,
    records: [],
    names: [{ name: "a", live: [1], highWater: 4 }],
  }, () => false);
  assertEquals(restored.highWater("a"), 4);
  assertEquals(restored.removed("a", 2), false);
  // Below the high-water mark and never known removed: it may arrive.
  restored.append(modelCommit(4, [versionOp("a", 2)]));
  assertEquals(restored.versions("a"), [1, 2]);
});

Deno.test("Partition.restore: merges overlapping removed ranges and refuses invalid ones", () => {
  const snapshotWith = (removed: unknown, live = [1]) => ({
    v: 1,
    partition: modelPartition().toString(),
    seq: 1,
    records: [],
    names: [{ name: "a", live, highWater: 9, removed }],
  });
  const merged = Partition.restore(
    modelPartition(),
    snapshotWith([[5, 6], [2, 3], [4, 4], [6, 7]]),
    () => false,
  );
  assertEquals(merged.snapshot().names[0].removed, [[2, 7]]);
  for (
    const removed of [
      "1-2",
      [3],
      [[3, 2]],
      [[0, 2]],
      [[2, 10]],
      [[1, 1]],
      [["2", 3]],
    ]
  ) {
    assertThrows(
      () =>
        Partition.restore(modelPartition(), snapshotWith(removed), () => false),
      Error,
      "Invalid snapshot",
      JSON.stringify(removed),
    );
  }
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
    ["a lease holder without a lease fence", {
      ...good,
      leaseFence: undefined,
    }],
    ["a negative lease fence", { ...good, leaseFence: -1 }],
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
    ["an unknown field in a data name", {
      ...good,
      names: [{ ...good.names[0], extra: 1 }],
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
