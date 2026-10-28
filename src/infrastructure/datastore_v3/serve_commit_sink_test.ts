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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  blobPut,
  dataKey,
  modelCommit,
  modelIntent,
  modelPartition,
  savePut,
  sha256Of,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { contextHook, unitOptions } from "./commit_log_test_helpers.ts";
import { createCommitLogUnitOfWork } from "./commit_log_unit_of_work.ts";
import type { OutboxCommitSink } from "./outbox_commit_sink.ts";
import { ServeCatchUp } from "./serve_catch_up.ts";
import {
  createServeCommitSink,
  MAX_CARRIED_CHUNKS,
  SERVE_SEQ_GAP_ATTEMPTS,
} from "./serve_commit_sink.ts";
import {
  CachedServeStorage,
  ServeChunkStorage,
} from "./serve_datastore_storage.ts";
import {
  ServeChunksMissingError,
  ServeUnreachableError,
  ServeUpstreamDivergedError,
} from "./serve_upstream_errors.ts";
import { ServeUpstreamState } from "./serve_upstream_state.ts";
import {
  FakeServe,
  removeTempDir,
  SERVE_FENCE,
  SERVE_PRINCIPAL,
  SERVE_WRITER,
  serveStamped,
} from "./serve_upstream_test_helpers.ts";
import { SqliteCommitOutbox } from "./sqlite_commit_outbox.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";

const MODEL = modelPartition();
const NO_SYNC = {
  syncFile: () => Promise.resolve(),
  syncDirectory: () => Promise.resolve(),
};

interface Checkout {
  readonly store: SqliteCommitStore;
  readonly state: ServeUpstreamState;
  readonly outbox: SqliteCommitOutbox;
  readonly serve: FakeServe;
  readonly catchUp: ServeCatchUp;
  /** The checkout's chunk cache, serve behind it, as a checkout opens. */
  readonly cache: CachedServeStorage;
  readonly sink: OutboxCommitSink;
}

/** A serve-mode checkout over a fake serve, wired as a v3 handle wires it. */
async function withCheckout(fn: (c: Checkout) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-sink-" });
  const store = SqliteCommitStore.open(join(dir, "commits.db"), {
    follower: true,
  });
  const state = ServeUpstreamState.open(join(dir, "serve_upstream.db"));
  const outbox = new SqliteCommitOutbox(join(dir, "outbox.db"));
  const serve = new FakeServe();
  const catchUp = new ServeCatchUp({
    client: serve,
    commitStore: store,
    state,
    copyDir: dir,
  });
  const cache = new CachedServeStorage(
    join(dir, "datastore"),
    new ServeChunkStorage(serve),
    NO_SYNC,
  );
  const lifetime = new AbortController();
  const sink = createServeCommitSink({
    client: serve,
    commitStore: store,
    catchUp,
    chunkCache: cache,
    outbox,
    signal: () => lifetime.signal,
  });
  try {
    await fn({ store, state, outbox, serve, catchUp, cache, sink });
  } finally {
    lifetime.abort();
    state.close();
    await outbox.close();
    await store.close();
    await removeTempDir(dir);
  }
}

function bytesOf(length: number, salt = 0): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7 + salt) % 251;
  return bytes;
}

/** A change a unit stages: content too large to inline, one chunk. */
function blobChange(name: string, salt = 0) {
  return {
    partition: MODEL,
    put: {
      intent: modelIntent({ kind: "data.save", name, version: 1 }),
      key: dataKey(name, 1),
      content: bytesOf(100 * 1024, salt),
    },
  };
}

/**
 * `count` chunks put into the checkout's cache, as a unit's commit group
 * puts them, and a commit at `seq` whose blob names them all.
 */
async function chunkedCommit(
  cache: CachedServeStorage,
  count: number,
  seq = 1,
): Promise<{ commit: Commit; hashes: string[] }> {
  const hashes: string[] = [];
  const signal = new AbortController().signal;
  for (let i = 0; i < count; i++) {
    const text = `chunk-${i}`;
    const sha256 = await sha256Of(text);
    await cache.put(
      "_default",
      sha256,
      new TextEncoder().encode(text),
      signal,
    );
    hashes.push(sha256);
  }
  const parts = await Promise.all(
    hashes.map((sha256, i) => ({ sha256, size: `chunk-${i}`.length })),
  );
  const blob = BlobRef.create({
    sha256: await sha256Of("whole"),
    size: parts.reduce((total, part) => total + part.size, 0),
    parts,
  });
  const commit = modelCommit(seq, [await blobPut("big", 1, blob)], {
    fence: 3,
    principal: "local-should-not-be-sent",
  });
  return { commit, hashes };
}

async function copyCommit(store: SqliteCommitStore, seq: number) {
  const [change] = await store.readPartition("", MODEL, seq, 1);
  assert(change !== undefined && change.commit.seq === seq, `seq ${seq}`);
  return change.commit;
}

/** Another caller's commit at serve's next seq. */
async function otherWriter(serve: FakeServe, options = { hidden: false }) {
  const seq = serve.head(MODEL) + 1;
  serve.land(
    serveStamped(seq, [await savePut(`other${seq}`, 1)], MODEL),
    options,
  );
}

Deno.test("createServeCommitSink: a unit's commit lands at serve with serve's stamp in the copy, one chunks/has, and only the chunks serve lacks", async () => {
  await withCheckout(async ({ store, outbox, serve, cache, sink }) => {
    const uow = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, cache, { fence: 3 }),
    );
    await uow.stageOp(blobChange("a"));
    await uow.commit();

    assertEquals(serve.posted.length, 1);
    const [posted] = serve.posted;
    // Serve stamps the principal, writer and fence: the envelope names none.
    assertEquals(Object.keys(posted.envelope).sort(), [
      "expectedSeq",
      "ops",
      "txnId",
    ]);
    assertEquals(posted.envelope.expectedSeq, 0);
    assertEquals(posted.chunks.length, 1, "the blob's one chunk is carried");
    assertEquals(serve.uploads, []);
    assertEquals(serve.requests.hasChunks, 1, "one chunks/has per commit");
    assertEquals(serve.requests.getChunk, 0);

    const local = await copyCommit(store, 1);
    assertEquals(local.txnId, posted.envelope.txnId);
    assertEquals(local.principal, SERVE_PRINCIPAL);
    assertEquals(local.fence, SERVE_FENCE);
    assertEquals(local.writer, SERVE_WRITER);
    assertEquals(await outbox.hasEntries(), false, "the entry was settled");
  });
});

Deno.test("createServeCommitSink: a second commit naming a chunk serve holds carries no chunk", async () => {
  await withCheckout(async ({ serve, cache, sink }) => {
    const first = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, cache),
    );
    await first.stageOp(blobChange("a"));
    await first.commit();
    const second = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, cache),
    );
    // The same bytes under another name: the same chunk.
    await second.stageOp(blobChange("b"));
    await second.commit();

    assertEquals(serve.posted.map((p) => p.chunks.length), [1, 0]);
    assertEquals(serve.posted[1].envelope.expectedSeq, 1);
    assertEquals(serve.requests.hasChunks, 2);
  });
});

Deno.test("createServeCommitSink: the envelope is expectedSeq, txnId and ops only, with the chunks serve lacks", async () => {
  await withCheckout(async ({ serve, cache, sink }) => {
    const { commit, hashes } = await chunkedCommit(cache, 3);
    serve.chunks.set(hashes[1], new TextEncoder().encode("chunk-1"));

    assertEquals(await sink.append(commit), { kind: "appended", seq: 1 });

    const [posted] = serve.posted;
    assertEquals(posted.envelope, {
      expectedSeq: 0,
      txnId: commit.txnId,
      ops: commit.toJSON().ops,
    });
    assertEquals(posted.chunks, [hashes[0], hashes[2]]);
    assertEquals(serve.hasAsked, [hashes]);
  });
});

Deno.test("createServeCommitSink: more than 1024 missing chunks upload the extras with the commit's partition", async () => {
  await withCheckout(async ({ serve, cache, sink }) => {
    const { commit, hashes } = await chunkedCommit(
      cache,
      MAX_CARRIED_CHUNKS + 6,
    );

    assertEquals(await sink.append(commit), { kind: "appended", seq: 1 });

    const [posted] = serve.posted;
    assertEquals(posted.chunks.length, MAX_CARRIED_CHUNKS);
    assertEquals(serve.uploads.length, 6);
    for (const upload of serve.uploads) {
      assertEquals(upload.partition, MODEL.toString(), "never without one");
    }
    assertEquals(
      new Set([...posted.chunks, ...serve.uploads.map((u) => u.sha256)]),
      new Set(hashes),
    );
  });
});

Deno.test("createServeCommitSink: a duplicate reply is a duplicate, and the copy holds serve's commit", async () => {
  await withCheckout(async ({ store, serve, sink }) => {
    const commit = modelCommit(1, [await savePut("a", 1)]);
    serve.land(serveStamped(1, commit.ops, MODEL, commit.txnId));

    assertEquals(await sink.append(commit), { kind: "duplicate", seq: 1 });
    assertEquals((await copyCommit(store, 1)).principal, "bob@example.com");
  });
});

Deno.test("createServeCommitSink: a stale seq records serve's head, catches the partition up, and refuses as a seq gap", async () => {
  await withCheckout(async ({ store, state, serve, catchUp, sink }) => {
    await otherWriter(serve);
    await otherWriter(serve, { hidden: true });
    const commit = modelCommit(1, [await savePut("a", 1)]);

    const error = await assertRejects(
      () => sink.append(commit),
      CommitRejectedError,
    );
    assertEquals(error.reason, "seq-gap");
    assertEquals(state.serveHead("", MODEL.toString()), 2);
    assertEquals((await store.head("", MODEL)).seq, 1, "the readable one");
    assertEquals(await catchUp.headOf("", MODEL), 2);
    assertEquals(await sink.head("", MODEL), {
      seq: 2,
      highestFence: SERVE_FENCE,
    });
    assertEquals(await sink.outbox!.headIdentity("", MODEL), {
      seq: 2,
      txnId: undefined,
    });
  });
});

Deno.test("createServeCommitSink: a unit rebuilds a stale commit on serve's new head with the same txnId", async () => {
  await withCheckout(async ({ store, serve, cache, sink }) => {
    await otherWriter(serve);
    await otherWriter(serve, { hidden: true });
    const uow = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, cache),
    );
    await uow.stageOp(blobChange("a"));
    await uow.commit();

    assertEquals(serve.posted.map((p) => p.envelope.expectedSeq), [0, 2]);
    assertEquals(
      serve.posted[0].envelope.txnId,
      serve.posted[1].envelope.txnId,
    );
    assertEquals(
      serve.commitAt(MODEL, 3)?.txnId,
      serve.posted[0].envelope.txnId,
    );
    const seqs = (await store.readPartition("", MODEL, 1, 10)).map((c) =>
      c.commit.seq
    );
    assertEquals(seqs, [1, 3], "the hidden commit stays a hole");
  });
});

Deno.test("createServeCommitSink: a busy partition that moves on every send still lands within the sink's seq-gap attempts", async () => {
  await withCheckout(async ({ serve, cache, sink }) => {
    assertEquals(sink.seqGapAttempts, SERVE_SEQ_GAP_ATTEMPTS);
    let moves = 3;
    serve.beforePost = async () => {
      if (moves-- > 0) await otherWriter(serve);
    };
    const uow = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, cache),
    );
    await uow.stageOp(blobChange("a"));
    await uow.commit();

    assertEquals(serve.posted.length, 4);
    assertEquals(new Set(serve.posted.map((p) => p.envelope.txnId)).size, 1);
    assertEquals(
      serve.commitAt(MODEL, 4)?.txnId,
      serve.posted[0].envelope.txnId,
    );
  });
});

Deno.test("createServeCommitSink: chunks serve collected before the commit are resent once, without asking again", async () => {
  await withCheckout(async ({ serve, cache, sink }) => {
    const { commit, hashes } = await chunkedCommit(cache, 2);
    for (const [i, hash] of hashes.entries()) {
      serve.chunks.set(hash, new TextEncoder().encode(`chunk-${i}`));
    }
    serve.postFaults.push({ kind: "collect", hashes: [hashes[1]] });

    assertEquals(await sink.append(commit), { kind: "appended", seq: 1 });
    assertEquals(serve.posted.map((p) => p.chunks), [[], [hashes[1]]]);
    assertEquals(serve.requests.hasChunks, 1);
  });
});

Deno.test("createServeCommitSink: chunks missing a second time are the caller's", async () => {
  await withCheckout(async ({ serve, cache, sink }) => {
    const { commit, hashes } = await chunkedCommit(cache, 2);
    for (const [i, hash] of hashes.entries()) {
      serve.chunks.set(hash, new TextEncoder().encode(`chunk-${i}`));
    }
    serve.postFaults.push(
      { kind: "collect", hashes: [hashes[0]] },
      { kind: "collect", hashes: [hashes[1]] },
    );

    await assertRejects(() => sink.append(commit), ServeChunksMissingError);
    assertEquals(serve.posted.length, 2);
  });
});

Deno.test("createServeCommitSink: a commit serve never received is not looked for at serve", async () => {
  await withCheckout(async ({ serve, sink }) => {
    const commit = modelCommit(1, [await savePut("a", 1)]);
    serve.postFaults.push({ kind: "never" });

    const error = await assertRejects(
      () => sink.append(commit),
      ServeUnreachableError,
    );
    assertEquals(error.sent, "never");
    const reads = serve.requests.partitionCommits;
    assertEquals(
      await sink.outbox!.landedSeq!("", MODEL, commit.txnId),
      undefined,
    );
    assertEquals(serve.requests.partitionCommits, reads, "serve not asked");
  });
});

Deno.test("createServeCommitSink: a unit whose commit serve never received fails and keeps no outbox entry", async () => {
  await withCheckout(async ({ store, outbox, serve, cache, sink }) => {
    serve.postFaults.push({ kind: "never" });
    const uow = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, cache),
    );
    await uow.stageOp(blobChange("a"));
    const reads = serve.requests.partitionCommits;
    const error = await assertRejects(() => uow.commit());
    assert(
      error instanceof ServeUnreachableError ||
        error instanceof Error && error.cause instanceof ServeUnreachableError,
      String(error),
    );

    assertEquals(serve.requests.partitionCommits, reads, "serve not asked");
    assertEquals(serve.head(MODEL), 0);
    assertEquals((await store.head("", MODEL)).seq, 0);
    assertEquals(await outbox.hasEntries(), false);
  });
});

Deno.test("createServeCommitSink: a commit that may have reached serve is found by catching up", async () => {
  await withCheckout(async ({ store, serve, sink }) => {
    const commit = modelCommit(1, [await savePut("a", 1)]);
    serve.postFaults.push({ kind: "maybe" });

    const error = await assertRejects(
      () => sink.append(commit),
      ServeUnreachableError,
    );
    assertEquals(error.sent, "maybe");
    assertEquals(await sink.outbox!.landedSeq!("", MODEL, commit.txnId), 1);
    assertEquals((await copyCommit(store, 1)).principal, SERVE_PRINCIPAL);
  });
});

Deno.test("createServeCommitSink: a unit whose reply was lost lands once its commit is found at serve", async () => {
  await withCheckout(async ({ store, outbox, serve, cache, sink }) => {
    serve.postFaults.push({ kind: "maybe" });
    const uow = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, cache),
    );
    await uow.stageOp(blobChange("a"));
    await uow.commit();

    assertEquals(serve.posted.length, 1, "not sent twice");
    assertEquals(serve.head(MODEL), 1);
    assertEquals((await copyCommit(store, 1)).principal, SERVE_PRINCIPAL);
    assertEquals(await outbox.hasEntries(), false);
    assertEquals(serve.requests.hasChunks, 1);
  });
});

Deno.test("createServeCommitSink: a landed commit whose catch-up fails records serve's head from the reply", async () => {
  await withCheckout(async ({ store, serve, catchUp, sink }) => {
    const commit = modelCommit(1, [await savePut("a", 1)]);
    serve.partitionFaults = 1;

    assertEquals(await sink.append(commit), { kind: "appended", seq: 1 });
    assertEquals((await store.head("", MODEL)).seq, 0, "the copy is behind");
    assertEquals(await catchUp.headOf("", MODEL), 1);
  });
});

Deno.test("createServeCommitSink: headIdentity is the copy's, with its txnId, when the copy is at serve's head", async () => {
  await withCheckout(async ({ serve, catchUp, sink }) => {
    await otherWriter(serve);
    await catchUp.catchUp(new AbortController().signal);
    assertEquals(await sink.outbox!.headIdentity("", MODEL), {
      seq: 1,
      txnId: "other-1",
    });
  });
});

Deno.test("createServeCommitSink: a unit whose stale commit meets a serve behind the copy fails with the divergence and keeps no outbox entry", async () => {
  await withCheckout(async ({ store, outbox, serve, catchUp, cache, sink }) => {
    await otherWriter(serve);
    await otherWriter(serve);
    await catchUp.catchUp(new AbortController().signal);
    assertEquals((await store.head("", MODEL)).seq, 2);
    // Serve restored to an earlier point: its partition ends at seq 1.
    serve.logs.get(MODEL.toString())!.splice(1);

    const uow = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, cache),
    );
    await uow.stageOp(blobChange("a"));
    const error = await assertRejects(
      () => uow.commit(),
      ServeUpstreamDivergedError,
    );
    assertEquals(error.divergence, { kind: "behind", serveHead: 1 });
    assertEquals(serve.head(MODEL), 1, "serve took nothing");
    assertEquals((await store.head("", MODEL)).seq, 2);
    assertEquals(await outbox.hasEntries(), false);
  });
});

Deno.test("createServeCommitSink: a commit that lands on a serve without the copy's head commit lands, and is warned about", async () => {
  await withCheckout(async ({ serve, catchUp, sink }) => {
    await otherWriter(serve);
    await otherWriter(serve);
    await catchUp.catchUp(new AbortController().signal);
    // Serve's commit at the copy's head is now another log's.
    const log = serve.logs.get(MODEL.toString())!;
    const swapped = serveStamped(2, [await savePut("b2", 1)], MODEL, "b-2");
    log[1] = { ...log[1], txnId: swapped.txnId, json: swapped.toJSON() };

    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (record: LogRecord) => records.push(record) },
      loggers: [
        {
          category: ["datastore", "v3", "serve"],
          lowestLevel: "warning",
          sinks: ["capture"],
        },
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
      ],
      reset: true,
    });
    let result;
    try {
      result = await sink.append(modelCommit(3, [await savePut("a", 1)]));
    } finally {
      await reset();
    }

    assertEquals(result, { kind: "appended", seq: 3 });
    const warnings = records.map((r) => r.message.map(String).join(""));
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assert(warnings[0].includes("saved to serve"), warnings[0]);
    assert(warnings[0].includes("commit 2 of partition"), warnings[0]);
  });
});
