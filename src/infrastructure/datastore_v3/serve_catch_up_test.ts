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

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { Commit } from "../../domain/datastore_v3/commit.ts";
import {
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { runPartition, runPut } from "./commit_log_test_helpers.ts";
import {
  SERVE_PARTITION_PAGE,
  ServeCatchUp,
  serveLogCheck,
} from "./serve_catch_up.ts";
import {
  SERVE_UPSTREAM_DIVERGED_CODE,
  ServeCommitsCompactedError,
  ServeReplyTooLargeError,
  ServeUpstreamDivergedError,
  ServeUpstreamUpgradeRequiredError,
} from "./serve_upstream_errors.ts";
import { ServeUpstreamState } from "./serve_upstream_state.ts";
import {
  FakeServe,
  removeTempDir,
  SERVE_URL,
  serveStamped,
} from "./serve_upstream_test_helpers.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";

const MODEL = modelPartition();
const OTHER = runPartition();

interface Checkout {
  readonly dir: string;
  readonly store: SqliteCommitStore;
  readonly state: ServeUpstreamState;
  readonly serve: FakeServe;
  readonly catchUp: ServeCatchUp;
  /** The seqs `append` was called with, in order. */
  readonly appends: number[];
}

/** A serve-mode checkout over a fake serve; `append` is recorded. */
async function withCheckout(fn: (c: Checkout) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-catch-up-" });
  const store = SqliteCommitStore.open(join(dir, "commits.db"), {
    follower: true,
  });
  const state = ServeUpstreamState.open(join(dir, "serve_upstream.db"));
  const serve = new FakeServe();
  const appends: number[] = [];
  const append = store.append.bind(store);
  store.append = (commit: Commit) => {
    appends.push(commit.seq);
    return append(commit);
  };
  try {
    await fn({
      dir,
      store,
      state,
      serve,
      catchUp: new ServeCatchUp({
        client: serve,
        commitStore: store,
        state,
        copyDir: dir,
        namespace: "",
      }),
      appends,
    });
  } finally {
    state.close();
    await store.close();
    await removeTempDir(dir);
  }
}

/** Serve's commit at `seq` of `partition`, another caller's save. */
async function other(seq: number, partition = MODEL): Promise<Commit> {
  const op = partition === MODEL
    ? await savePut(`m${seq}`, 1)
    : await runPut(`run ${seq}`);
  return serveStamped(seq, [op], partition);
}

/**
 * Another serve's commit at `seq` of `partition`: another log, so another
 * txnId at the same seq.
 */
async function another(seq: number, partition = MODEL): Promise<Commit> {
  const op = partition === MODEL
    ? await savePut(`b${seq}`, 1)
    : await runPut(`b run ${seq}`);
  return serveStamped(seq, [op], partition, `another-${seq}`);
}

/** A catch-up of the same copy through `serve`, as the address now answers. */
function through(
  serve: FakeServe,
  { dir, store, state }: Pick<Checkout, "dir" | "store" | "state">,
  namespace = "",
): ServeCatchUp {
  return new ServeCatchUp({
    client: serve,
    commitStore: store,
    state,
    copyDir: dir,
    namespace,
  });
}

/** `commit` as serve would stamp it in namespace `namespace`. */
async function inNamespace(commit: Commit, namespace: string) {
  return await Commit.fromJSON({ ...commit.toJSON(), namespace });
}

/** The halving a refused page goes through, from a full page down to one. */
function halvings(): number[] {
  const limits = [SERVE_PARTITION_PAGE];
  while (limits.at(-1)! > 1) limits.push(Math.ceil(limits.at(-1)! / 2));
  return limits;
}

/** The seqs the copy holds of `partition`. */
async function copySeqs(store: SqliteCommitStore, partition = MODEL) {
  return (await store.readPartition("", partition, 1, 10_000)).map((c) =>
    c.commit.seq
  );
}

const signal = () => new AbortController().signal;

Deno.test("ServeCatchUp.catchUp: applies the feed in order across pages and moves the cursor to serve's", async () => {
  await withCheckout(async ({ store, state, serve, catchUp, appends }) => {
    serve.feedPageSize = 2;
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    serve.land(await other(1, OTHER));
    serve.land(await other(2, OTHER));

    const report = await catchUp.catchUp(signal());

    assertEquals(report, { applied: 5 });
    assertEquals(appends, [1, 2, 3, 1, 2]);
    assertEquals(await copySeqs(store), [1, 2, 3]);
    assertEquals(await copySeqs(store, OTHER), [1, 2]);
    assertEquals(state.feedCursor(), 5);
    assertEquals(serve.requests.changes, 3);
    // The stored commit is serve's, as serve stamped it.
    const [first] = await store.readPartition("", MODEL, 1, 1);
    assertEquals(first.commit.principal, "bob@example.com");
    assertEquals(first.commit.writer.instance, "serve");
  });
});

Deno.test("ServeCatchUp.catchUp: a page that fails to apply leaves the cursor at the last page applied", async () => {
  await withCheckout(async ({ store, state, serve, catchUp }) => {
    serve.feedPageSize = 2;
    for (let seq = 1; seq <= 4; seq++) serve.land(await other(seq));
    const append = store.append.bind(store);
    let fail = true;
    store.append = (commit: Commit) => {
      if (fail && commit.seq === 4) {
        return Promise.reject(new Error("disk full"));
      }
      return append(commit);
    };

    await assertRejects(() => catchUp.catchUp(signal()), Error, "disk full");
    assertEquals(state.feedCursor(), 2, "only the first page was applied");
    assertEquals(await copySeqs(store), [1, 2, 3]);

    fail = false;
    assertEquals(await catchUp.catchUp(signal()), { applied: 1 });
    assertEquals(state.feedCursor(), 4);
    assertEquals(await copySeqs(store), [1, 2, 3, 4]);
  });
});

Deno.test("ServeCatchUp.catchUp: replaying pages already applied appends nothing", async () => {
  await withCheckout(async ({ dir, store, serve, appends }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    const first = ServeUpstreamState.open(join(dir, "first.db"));
    try {
      await new ServeCatchUp({
        client: serve,
        commitStore: store,
        state: first,
        copyDir: dir,
        namespace: "",
      })
        .catchUp(signal());
    } finally {
      first.close();
    }
    assertEquals(appends, [1, 2, 3]);

    // A crash after the appends and before the cursor moved: the next
    // catch-up reads the same pages again, from cursor 0.
    const fresh = ServeUpstreamState.open(join(dir, "fresh.db"));
    try {
      const report = await new ServeCatchUp({
        client: serve,
        commitStore: store,
        state: fresh,
        copyDir: dir,
        namespace: "",
      }).catchUp(signal());
      assertEquals(report, { applied: 0 });
      assertEquals(fresh.feedCursor(), 3);
    } finally {
      fresh.close();
    }
    assertEquals(appends, [1, 2, 3], "no seq at or below the head appended");
    assertEquals(await copySeqs(store), [1, 2, 3]);
  });
});

Deno.test("ServeCatchUp.catchUp: a commit serve filters leaves a hole and later commits still apply", async () => {
  await withCheckout(async ({ store, state, serve, catchUp }) => {
    serve.land(await other(1));
    serve.land(await other(2), { hidden: true });
    serve.land(await other(3));

    await catchUp.catchUp(signal());

    assertEquals(await copySeqs(store), [1, 3]);
    assertEquals((await store.head("", MODEL)).seq, 3);
    // The gap before seq 3 was read from the partition, up to seq 2 only.
    assertEquals(serve.partitionReads, [{
      after: 1,
      limit: SERVE_PARTITION_PAGE,
    }]);
    assertEquals(state.serveHead("", MODEL.toString()), 3);
  });
});

Deno.test("ServeCatchUp.catchUp: a commit past the head + 1 reads the partition and brings commits a changed grant now shows", async () => {
  await withCheckout(async ({ store, state, serve, catchUp }) => {
    serve.land(await other(1));
    serve.land(await other(2), { hidden: true });
    await catchUp.catchUp(signal());
    assertEquals(await copySeqs(store), [1]);
    assertEquals(state.feedCursor(), 2, "the feed passed the hidden commit");

    // A grant now lets this caller read seq 2; the feed has moved past it.
    serve.hidden.clear();
    serve.land(await other(3));
    await catchUp.catchUp(signal());

    assertEquals(await copySeqs(store), [1, 2, 3]);
    assertEquals(state.serveHead("", MODEL.toString()), 3);
  });
});

Deno.test("ServeCatchUp.catchUpPartition: a page filtered to nothing still moves the read on, page by page", async () => {
  await withCheckout(async ({ store, state, serve, catchUp }) => {
    const total = 2 * SERVE_PARTITION_PAGE + 3;
    serve.landUnreadable(MODEL, total - 1);
    serve.land(await other(total));

    const head = await catchUp.catchUpPartition("", MODEL, signal());

    assertEquals(head, total);
    assertEquals(await copySeqs(store), [total]);
    assertEquals(
      serve.partitionReads.map((read) => read.after),
      [0, SERVE_PARTITION_PAGE, 2 * SERVE_PARTITION_PAGE],
    );
    assert(
      serve.partitionReads.every((read) => read.limit === SERVE_PARTITION_PAGE),
    );
    assertEquals(state.serveHead("", MODEL.toString()), total);
  });
});

Deno.test("ServeCatchUp.catchUpPartition: an empty partition is one read that records head 0", async () => {
  await withCheckout(async ({ state, serve, catchUp }) => {
    assertEquals(await catchUp.catchUpPartition("", MODEL, signal()), 0);
    assertEquals(serve.requests.partitionCommits, 1);
    assertEquals(state.serveHead("", MODEL.toString()), 0);
  });
});

Deno.test("ServeCatchUp.catchUpPartition: a commit of another partition in the reply is refused", async () => {
  await withCheckout(async ({ serve, catchUp }) => {
    serve.land(await other(1, OTHER));
    const read = serve.partitionCommits.bind(serve);
    serve.partitionCommits = (_partition, after, s, limit) =>
      read(OTHER, after, s, limit);
    await assertRejects(
      () => catchUp.catchUpPartition("", MODEL, signal()),
      Error,
      "Serve answered a read of partition",
    );
  });
});

Deno.test("ServeCatchUp.headOf: the higher of the copy's head and serve's last reported", async () => {
  await withCheckout(async ({ serve, catchUp }) => {
    assertEquals(await catchUp.headOf("", MODEL), 0);
    catchUp.recordServeHead("", MODEL, 5);
    assertEquals(await catchUp.headOf("", MODEL), 5);
    assertEquals(await catchUp.headOf("", OTHER), 0, "per partition");

    for (let seq = 1; seq <= 7; seq++) serve.land(await other(seq));
    await catchUp.catchUp(signal());
    assertEquals(await catchUp.headOf("", MODEL), 7);
    // A head reported lower never moves it back.
    catchUp.recordServeHead("", MODEL, 2);
    assertEquals(await catchUp.headOf("", MODEL), 7);
  });
});

Deno.test("ServeCatchUp.catchUp: serve's 410 commits_compacted propagates and the cursor stays", async () => {
  await withCheckout(async ({ state, serve, catchUp }) => {
    serve.changesFault = new ServeCommitsCompactedError(9, "compacted");
    const error = await assertRejects(
      () => catchUp.catchUp(signal()),
      ServeCommitsCompactedError,
    );
    assertEquals(error.status, 410);
    assertEquals(state.feedCursor(), 0);
  });
});

Deno.test("ServeCatchUp.catchUp: concurrent callers share one run, and a later call starts another", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    serve.land(await other(1));
    let open!: () => void;
    serve.changesGate = new Promise((resolve) => open = resolve);

    const first = catchUp.catchUp(signal());
    const second = catchUp.catchUp(signal());
    assert(first === second, "the second caller shares the first run");
    open();
    assertEquals(await first, { applied: 1 });
    assertEquals(serve.requests.changes, 1);

    serve.changesGate = undefined;
    serve.land(await other(2));
    assertEquals(await catchUp.catchUp(signal()), { applied: 1 });
    assertEquals(serve.requests.changes, 2);
    assertEquals(await copySeqs(store), [1, 2]);
  });
});

Deno.test("ServeCatchUp.catchUp: an aborted signal reads nothing", async () => {
  await withCheckout(async ({ serve, catchUp }) => {
    const controller = new AbortController();
    controller.abort(new Error("closing"));
    await assertRejects(
      () => catchUp.catchUp(controller.signal),
      Error,
      "closing",
    );
    assertEquals(serve.requests.changes, 0);
  });
});

Deno.test("ServeCatchUp.catchUp: a serve without the feed anchor is refused before anything is read into the copy", async () => {
  await withCheckout(async (checkout) => {
    const { dir, store, state, serve, catchUp, appends } = checkout;
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await catchUp.catchUp(signal());
    const anchor = state.feedAnchor();
    assertEquals(anchor?.seq, 3);

    // The address now reaches another serve, with its own datastore.
    const swapped = new FakeServe();
    swapped.land(await another(1, OTHER));
    swapped.land(await another(2, OTHER));
    const error = await assertRejects(
      () => through(swapped, checkout).catchUp(signal()),
      ServeUpstreamDivergedError,
    );

    assertEquals(error.code, SERVE_UPSTREAM_DIVERGED_CODE);
    assertEquals(error.serveUrl, SERVE_URL);
    assertEquals(error.copyDir, dir);
    assertEquals(error.divergence, { kind: "behind", serveHead: 0 });
    assertEquals(swapped.requests.changes, 0, "the feed was never read");
    assertEquals(appends, [1, 2, 3]);
    assertEquals(await copySeqs(store, OTHER), []);
    assertEquals(state.feedCursor(), 3);
    assertEquals(state.feedAnchor(), anchor);
  });
});

Deno.test("ServeCatchUp.catchUp: a serve with another commit at the anchor's seq is refused", async () => {
  await withCheckout(async (checkout) => {
    const { serve, catchUp } = checkout;
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await catchUp.catchUp(signal());

    const swapped = new FakeServe();
    for (let seq = 1; seq <= 4; seq++) swapped.land(await another(seq));
    const error = await assertRejects(
      () => through(swapped, checkout).catchUp(signal()),
      ServeUpstreamDivergedError,
    );
    assertEquals(error.commit?.seq, 3);
    assertEquals(error.commit?.txnId, "other-3");
    assertEquals(error.divergence, {
      kind: "other-commit",
      serveTxnId: "another-3",
    });
  });
});

Deno.test("ServeCatchUp.catchUp: the same serve passes the anchor check with one small read, and the anchor moves on", async () => {
  await withCheckout(async ({ store, state, serve, catchUp }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await catchUp.catchUp(signal());
    assertEquals(serve.partitionReads, [], "a copy with no anchor checks none");

    serve.land(await other(1, OTHER));
    assertEquals(await catchUp.catchUp(signal()), { applied: 1 });

    assertEquals(serve.partitionReads, [{ after: 2, limit: 1 }]);
    assertEquals(await copySeqs(store, OTHER), [1]);
    assertEquals(state.feedAnchor(), {
      namespace: "",
      partition: OTHER.toString(),
      seq: 1,
      txnId: "other-1",
    });
  });
});

Deno.test("ServeCatchUp.catchUp: an anchor serve withholds, may not show, or compacted cannot be checked and is not refused", async () => {
  for (const hide of ["withheld", "not-found", "compacted"] as const) {
    await withCheckout(async ({ store, state, serve, catchUp }) => {
      for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
      await catchUp.catchUp(signal());
      if (hide === "withheld") serve.hidden.add("other-3");
      if (hide === "not-found") {
        serve.unreadablePartitions.add(MODEL.toString());
      }
      if (hide === "compacted") serve.compactedThrough.set(MODEL.toString(), 3);
      serve.land(await other(1, OTHER));

      assertEquals(await catchUp.catchUp(signal()), { applied: 1 }, hide);
      assertEquals(await copySeqs(store, OTHER), [1], hide);
      // The page applied records an anchor that can be checked.
      assertEquals(state.feedAnchor()?.partition, OTHER.toString(), hide);
    });
  }
});

Deno.test("ServeCatchUp.catchUp: a compaction that leaves the anchor alone passes the check", async () => {
  await withCheckout(async ({ serve, catchUp }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await catchUp.catchUp(signal());
    serve.compactedThrough.set(MODEL.toString(), 2);
    serve.land(await other(4));
    assertEquals(await catchUp.catchUp(signal()), { applied: 1 });
  });
});

Deno.test("ServeCatchUp.catchUpPartition: a serve behind the copy's head is refused, and nothing is read into the copy", async () => {
  await withCheckout(async (checkout) => {
    const { state, serve, catchUp, appends } = checkout;
    for (let seq = 1; seq <= 5; seq++) serve.land(await other(seq));
    await catchUp.catchUp(signal());

    // Restored to an earlier point: the same log, cut at seq 3.
    const restored = new FakeServe();
    for (let seq = 1; seq <= 3; seq++) restored.land(await other(seq));
    const error = await assertRejects(
      () => through(restored, checkout).catchUpPartition("", MODEL, signal()),
      ServeUpstreamDivergedError,
    );
    assertEquals(error.commit, {
      namespace: "",
      partition: MODEL.toString(),
      seq: 5,
      txnId: "other-5",
    });
    assertEquals(error.divergence, { kind: "behind", serveHead: 3 });
    assertEquals(appends, [1, 2, 3, 4, 5]);
    assertEquals(
      state.serveHead("", MODEL.toString()),
      0,
      "the lower head is checked before it is recorded",
    );
  });
});

Deno.test("ServeCatchUp.catchUpPartition: another commit at the copy's head seq is refused", async () => {
  await withCheckout(async (checkout) => {
    const { serve, catchUp, appends } = checkout;
    for (let seq = 1; seq <= 2; seq++) serve.land(await other(seq));
    await catchUp.catchUp(signal());

    const swapped = new FakeServe();
    for (let seq = 1; seq <= 3; seq++) swapped.land(await another(seq));
    const error = await assertRejects(
      () => through(swapped, checkout).catchUpPartition("", MODEL, signal()),
      ServeUpstreamDivergedError,
    );
    assertEquals(error.divergence, {
      kind: "other-commit",
      serveTxnId: "another-2",
    });
    assertEquals(appends, [1, 2]);
  });
});

Deno.test("ServeCatchUp.catchUpPartition: reads from the copy's head commit in the same request, and a withheld head checks the head only", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    for (let seq = 1; seq <= 2; seq++) serve.land(await other(seq));
    await catchUp.catchUp(signal());
    serve.land(await other(3));

    assertEquals(await catchUp.catchUpPartition("", MODEL, signal()), 3);
    assertEquals(serve.partitionReads.at(-1)?.after, 1);
    assertEquals(await copySeqs(store), [1, 2, 3]);

    serve.hidden.add("other-3");
    serve.land(await other(4));
    assertEquals(await catchUp.catchUpPartition("", MODEL, signal()), 4);
    assertEquals(await copySeqs(store), [1, 2, 3, 4]);
  });
});

Deno.test("ServeCatchUp.catchUpPartition: serve compacted through exactly the copy's head reads on from it unchecked", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await catchUp.catchUp(signal());
    serve.land(await other(4));
    serve.compactedThrough.set(MODEL.toString(), 3);
    const before = serve.partitionReads.length;

    assertEquals(await catchUp.catchUpPartition("", MODEL, signal()), 4);
    assertEquals(serve.partitionReads.slice(before).map((r) => r.after), [
      2,
      3,
    ]);
    assertEquals(await copySeqs(store), [1, 2, 3, 4]);
  });
});

Deno.test("ServeCatchUp.catchUpPartition: a copy head on a page boundary still reads every page after it", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    serve.landUnreadable(MODEL, SERVE_PARTITION_PAGE - 1);
    const end = 2 * SERVE_PARTITION_PAGE + 1;
    for (let seq = SERVE_PARTITION_PAGE; seq <= end; seq++) {
      serve.land(await other(seq));
    }
    // The copy holds serve's commit at the boundary, as a feed page left it.
    await store.append(await other(SERVE_PARTITION_PAGE));

    assertEquals(await catchUp.catchUpPartition("", MODEL, signal()), end);
    const seqs = await copySeqs(store);
    assertEquals(seqs.length, end - SERVE_PARTITION_PAGE + 1);
    assertEquals(seqs.at(-1), end);
  });
});

Deno.test("ServeUpstreamDivergedError: names the address, the copy and how to start a fresh one", () => {
  const error = new ServeUpstreamDivergedError(
    SERVE_URL,
    "/repo/.swamp/_datastore_v3_copies/serve-abc",
    { namespace: "", partition: "model/a", seq: 3, txnId: "t3" },
    { kind: "behind", serveHead: 0 },
  );
  assertInstanceOf(error, ServeUpstreamDivergedError);
  assertEquals(error.code, SERVE_UPSTREAM_DIVERGED_CODE);
  for (
    const part of [
      SERVE_URL,
      "/repo/.swamp/_datastore_v3_copies/serve-abc",
      "commit 3 of partition model/a",
      "head for that partition is 0",
      "move /repo/.swamp/_datastore_v3_copies/serve-abc aside",
      "outbox",
    ]
  ) {
    assert(error.message.includes(part), part);
  }
});

Deno.test("serveLogCheck: records the first log serve names, passes it again, and refuses another or none", async () => {
  await withCheckout(({ dir, state }) => {
    const check = serveLogCheck(state, SERVE_URL, dir);
    assertEquals(state.serveLogId(), undefined);
    check("log-a");
    assertEquals(state.serveLogId(), "log-a");
    check("log-a");

    let error: unknown;
    try {
      check("log-b");
    } catch (caught) {
      error = caught;
    }
    assertInstanceOf(error, ServeUpstreamDivergedError);
    assertEquals(error.code, SERVE_UPSTREAM_DIVERGED_CODE);
    assertEquals(error.commit, undefined);
    assertEquals(error.divergence, {
      kind: "other-log",
      copyLogId: "log-a",
      serveLogId: "log-b",
    });
    assert(error.message.includes("log log-b"), error.message);
    assertEquals(state.serveLogId(), "log-a", "the recorded log stays");

    let missing: unknown;
    try {
      check(undefined);
    } catch (caught) {
      missing = caught;
    }
    assertInstanceOf(missing, ServeUpstreamUpgradeRequiredError);
    assert(missing.message.includes("Upgrade swamp on serve"));
    return Promise.resolve();
  });
});

Deno.test("ServeCatchUp.catchUp: a feed page holding a commit of another namespace is refused whole, and nothing of it is applied", async () => {
  await withCheckout(async ({ store, state, serve, catchUp, appends }) => {
    serve.land(await other(1));
    serve.land(await inNamespace(await other(1, OTHER), "team-b"));
    serve.land(await other(2));

    await assertRejects(
      () => catchUp.catchUp(signal()),
      Error,
      "Serve answered the changes feed with a commit of",
    );
    assertEquals(appends, [], "the copy's own commits before it too");
    assertEquals(await copySeqs(store), []);
    assertEquals(state.feedCursor(), 0);
    assertEquals(state.feedAnchor(), undefined);
  });
});

Deno.test("ServeCatchUp.catchUp: a copy of a named namespace refuses the feed's commits of the solo one", async () => {
  await withCheckout(async (checkout) => {
    const { serve, appends } = checkout;
    serve.land(await other(1));

    await assertRejects(
      () => through(serve, checkout, "team-a").catchUp(signal()),
      Error,
      "in namespace ",
    );
    assertEquals(appends, []);
  });
});

Deno.test("ServeCatchUp.catchUpPartition: a page retried at half the limit and filtered moves the read on by that limit, leaving no gap", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    serve.landUnreadable(MODEL, 600);
    const end = 1100;
    for (let seq = 601; seq <= end; seq++) serve.land(await other(seq));
    serve.tooLarge = (route, limit) =>
      route === "partition" && limit === SERVE_PARTITION_PAGE;
    const half = SERVE_PARTITION_PAGE / 2;

    assertEquals(await catchUp.catchUpPartition("", MODEL, signal()), end);

    const seqs = await copySeqs(store);
    assertEquals(seqs.length, end - 600);
    assertEquals(seqs[0], 601);
    assertEquals(seqs.at(-1), end);
    // The first retried page held only filtered commits: the next read
    // starts half a page on, not a whole one, and keeps the half limit.
    assertEquals(serve.partitionReads, [
      { after: 0, limit: SERVE_PARTITION_PAGE },
      { after: 0, limit: half },
      { after: half, limit: half },
      { after: 2 * half, limit: half },
    ]);
  });
});

Deno.test("ServeCatchUp.catchUpPartition: a retried first page is still checked against the copy's head", async () => {
  await withCheckout(async (checkout) => {
    const { serve, catchUp, appends } = checkout;
    for (let seq = 1; seq <= 2; seq++) serve.land(await other(seq));
    await catchUp.catchUp(signal());

    const swapped = new FakeServe();
    for (let seq = 1; seq <= 3; seq++) swapped.land(await another(seq));
    swapped.tooLarge = (_route, limit) => limit === SERVE_PARTITION_PAGE;
    const error = await assertRejects(
      () => through(swapped, checkout).catchUpPartition("", MODEL, signal()),
      ServeUpstreamDivergedError,
    );
    assertEquals(error.divergence, {
      kind: "other-commit",
      serveTxnId: "another-2",
    });
    assertEquals(swapped.partitionReads.map((read) => read.limit), [
      SERVE_PARTITION_PAGE,
      SERVE_PARTITION_PAGE / 2,
    ]);
    assertEquals(appends, [1, 2]);
  });
});

Deno.test("ServeCatchUp.catchUp: a feed page too large is asked again at half the limit, applies every commit once in order, and logs each retry", async () => {
  await withCheckout(async ({ state, serve, catchUp, appends }) => {
    serve.feedPageSize = 2;
    for (let seq = 1; seq <= 5; seq++) serve.land(await other(seq));
    serve.tooLarge = (route, limit) =>
      route === "changes" && (limit === undefined || limit > 2);
    const captured: LogRecord[] = [];
    await configure({
      sinks: { capture: (record: LogRecord) => captured.push(record) },
      loggers: [
        {
          category: ["datastore", "v3", "serve"],
          lowestLevel: "debug",
          sinks: ["capture"],
        },
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
      ],
      reset: true,
    });
    try {
      assertEquals(await catchUp.catchUp(signal()), { applied: 5 });
    } finally {
      await reset();
    }

    assertEquals(appends, [1, 2, 3, 4, 5]);
    assertEquals(state.feedCursor(), 5);
    const refused = halvings().filter((limit) => limit > 2);
    assertEquals(
      serve.changesReads.map((read) => read.limit),
      [...refused, 2, 2, 2],
      "the halved limit carries over to the next pages",
    );
    assertEquals(
      serve.changesReads.map((read) => read.cursor),
      [...refused.map(() => 0), 0, 2, 4],
    );
    const retries = captured.map((r) =>
      r.message.map((p) => String(p)).join("")
    );
    assertEquals(retries.length, refused.length);
    assertStringIncludes(retries[0], "changes");
    assertStringIncludes(retries[0], "asking for 500");
  });
});

Deno.test("ServeCatchUp.catchUpPartition: a serve whose every page is too large is refused at one commit, after one read per halving", async () => {
  await withCheckout(async ({ serve, catchUp, appends }) => {
    serve.land(await other(1));
    serve.tooLarge = () => true;

    await assertRejects(
      () => catchUp.catchUpPartition("", MODEL, signal()),
      ServeReplyTooLargeError,
    );
    assertEquals(serve.partitionReads.map((read) => read.limit), halvings());
    assertEquals(halvings().length, 11, "ten retries after the first read");
    assertEquals(appends, []);
  });
});
