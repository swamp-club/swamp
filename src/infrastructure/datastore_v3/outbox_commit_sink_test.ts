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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { outboxKeyOf } from "../../domain/datastore_v3/commit_outbox.ts";
import {
  modelCommit,
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { createOutboxCommitSink } from "./outbox_commit_sink.ts";
import { SqliteCommitOutbox } from "./sqlite_commit_outbox.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";

async function withStores(
  fn: (
    store: SqliteCommitStore,
    outbox: SqliteCommitOutbox,
    dir: string,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-outbox-sink-" });
  const store = SqliteCommitStore.open(join(dir, "commits.db"));
  const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
  try {
    await fn(store, outbox, dir);
  } finally {
    await store.close();
    await outbox.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("createOutboxCommitSink: a writer that lost its lease neither prepares nor appends", async () => {
  await withStores(async (store, outbox) => {
    let current = true;
    const sink = createOutboxCommitSink({
      commitStore: store,
      outbox,
      assertWriterCurrent: () => {
        if (!current) throw new Error("fenced");
      },
    });
    const commit = modelCommit(1, [await savePut("a", 1)]);
    current = false;
    await assertRejects(
      () =>
        sink.outbox!.prepare({
          commit,
          unitId: "u",
          base: { seq: 0, txnId: undefined },
        }),
      Error,
      "fenced",
    );
    assertThrows(() => sink.append(commit), Error, "fenced");
    assertEquals(await outbox.hasEntries(), false);
  });
});

Deno.test("createOutboxCommitSink: reports the head with its commit's txnId", async () => {
  await withStores(async (store, outbox) => {
    const sink = createOutboxCommitSink({ commitStore: store, outbox });
    assertEquals(await sink.outbox!.headIdentity("", modelPartition()), {
      seq: 0,
      txnId: undefined,
    });
    await sink.append(modelCommit(1, [await savePut("a", 1)]));
    assertEquals(await sink.outbox!.headIdentity("", modelPartition()), {
      seq: 1,
      txnId: "txn-1",
    });
  });
});

Deno.test("createOutboxCommitSink: a settle or discard that fails is owed, and retried durably when asked", async () => {
  await withStores(async (store, outbox) => {
    const sink = createOutboxCommitSink({ commitStore: store, outbox });
    const landed = modelCommit(1, [await savePut("a", 1)]);
    const failed = modelCommit(1, [await savePut("b", 1)], {
      txnId: "txn-failed",
    });
    for (const commit of [landed, failed]) {
      await sink.outbox!.prepare({
        commit,
        unitId: "u",
        base: { seq: 0, txnId: undefined },
      });
    }
    const calls: string[] = [];
    const settle = outbox.settle.bind(outbox);
    const discard = outbox.discard.bind(outbox);
    let fail = true;
    outbox.settle = (keys) => {
      calls.push(`settle:${keys.length}`);
      return fail
        ? Promise.reject(new Error("database is locked"))
        : settle(keys);
    };
    outbox.discard = (keys) => {
      calls.push(`discard:${keys.length}`);
      return fail
        ? Promise.reject(new Error("database is locked"))
        : discard(keys);
    };
    await assertRejects(
      () => sink.outbox!.settle([outboxKeyOf(landed)]),
      Error,
      "locked",
    );
    await assertRejects(
      () => sink.outbox!.discard([outboxKeyOf(failed)]),
      Error,
      "locked",
    );
    assertEquals((await outbox.entries()).entries.length, 2);
    fail = false;
    await sink.retryOwedRemovals();
    assertEquals(await outbox.hasEntries(), false);
    // The owed discard's failure was reported, so the retry is durable.
    assertEquals(calls, ["settle:1", "discard:1", "discard:2"]);
  });
});
