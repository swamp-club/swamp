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
import { join, SEPARATOR } from "@std/path";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { Commit } from "../../domain/datastore_v3/commit.ts";
import {
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { runPartition, runPut } from "./commit_log_test_helpers.ts";
import type { ObservedBaseEntry } from "../../domain/datastore_v3/observed_base.ts";
import {
  BASE_LOAD_ATTEMPTS,
  OBSERVED_BASE_STAGING_PREFIX,
  SERVE_PARTITION_PAGE,
  serveAccessCheck,
  ServeCatchUp,
  serveLogCheck,
} from "./serve_catch_up.ts";
import {
  SERVE_UPSTREAM_DIVERGED_CODE,
  ServeCommitsCompactedError,
  ServeReplyTooLargeError,
  ServeUpstreamDivergedError,
  ServeUpstreamError,
  ServeUpstreamUpgradeRequiredError,
} from "./serve_upstream_errors.ts";
import {
  ServeCopyReplacedError,
  ServeUpstreamState,
} from "./serve_upstream_state.ts";
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
  readonly appends: number[];
}

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

async function other(seq: number, partition = MODEL): Promise<Commit> {
  const op = partition === MODEL
    ? await savePut(`m${seq}`, 1)
    : await runPut(`run ${seq}`);
  return serveStamped(seq, [op], partition);
}

async function another(seq: number, partition = MODEL): Promise<Commit> {
  const op = partition === MODEL
    ? await savePut(`b${seq}`, 1)
    : await runPut(`b run ${seq}`);
  return serveStamped(seq, [op], partition, `another-${seq}`);
}

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

async function inNamespace(commit: Commit, namespace: string) {
  return await Commit.fromJSON({ ...commit.toJSON(), namespace });
}

function halvings(): number[] {
  const limits = [SERVE_PARTITION_PAGE];
  while (limits.at(-1)! > 1) limits.push(Math.ceil(limits.at(-1)! / 2));
  return limits;
}

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

Deno.test("ServeCatchUp.catchUp: the command's own commit, read back by its partition and met again in the feed, appends nothing (swamp-club#4457)", async () => {
  await withCheckout(async ({ state, store, serve, catchUp, appends }) => {
    serve.land(await other(1));
    await catchUp.catchUp(signal());
    assertEquals(state.feedCursor(), 1);

    serve.land(await other(2));
    await catchUp.catchUpPartition("", MODEL, signal());
    assertEquals(appends, [1, 2]);
    assertEquals(state.feedCursor(), 1, "the read-back leaves the cursor");

    assertEquals(await catchUp.catchUp(signal()), { applied: 0 });
    assertEquals(appends, [1, 2], "the own commit is not appended again");
    assertEquals(await copySeqs(store), [1, 2]);
    assertEquals(state.feedCursor(), 2);
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
    assertEquals(serve.partitionReads, [{
      after: 1,
      limit: SERVE_PARTITION_PAGE,
      held: 1,
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
    // a serve that does not check the anchor with the page is asked on its
    // own, before the page it sent is applied
    assertEquals(swapped.requests.partitionCommits, 1);
    assertEquals(appends, [1, 2, 3]);
    assertEquals(await copySeqs(store, OTHER), []);
    assertEquals(state.feedCursor(), 3);
    assertEquals(state.feedAnchor(), anchor);
  });
});

Deno.test("ServeCatchUp.catchUp: a serve that checks the anchor with the page refuses it in that one read, before anything is applied", async () => {
  await withCheckout(async (checkout) => {
    const { store, state, serve, catchUp, appends } = checkout;
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await catchUp.catchUp(signal());
    const anchor = state.feedAnchor();

    const swapped = new FakeServe();
    swapped.checksAnchors = true;
    swapped.land(await another(1, OTHER));
    swapped.land(await another(2, OTHER));
    const error = await assertRejects(
      () => through(swapped, checkout).catchUp(signal()),
      ServeUpstreamDivergedError,
    );

    assertEquals(error.divergence, { kind: "behind", serveHead: 0 });
    assertEquals(swapped.anchorsAsked, [anchor!]);
    assertEquals(swapped.requests.changes, 1);
    assertEquals(swapped.requests.partitionCommits, 0, "no read of its own");
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

    assertEquals(serve.partitionReads, [{ after: 2, limit: 1, held: 3 }]);
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
    assertEquals(serve.partitionReads, [
      { after: 0, limit: SERVE_PARTITION_PAGE },
      { after: 0, limit: half },
      { after: half, limit: half },
      { after: 2 * half, limit: half, held: 2 * half },
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

function stagingFiles(dir: string): string[] {
  return [...Deno.readDirSync(dir)].map((entry) => entry.name).filter((name) =>
    name.startsWith(OBSERVED_BASE_STAGING_PREFIX)
  );
}

async function compactServe(serve: FakeServe, point: number) {
  const entries: ObservedBaseEntry[] = [];
  const seqs = new Map<string, number>();
  const records: ObservedBaseEntry[] = [];
  for (const entry of serve.feed.slice(0, point)) {
    const commit = await Commit.fromJSON(entry.json);
    seqs.set(commit.partition.toString(), commit.seq);
    for (const op of commit.ops) {
      if (op.kind !== "put") continue;
      records.push({
        kind: "record",
        namespace: "",
        partition: commit.partition.toString(),
        key: op.key.toString(),
        record: {
          sha256: op.sha256,
          content: { inline: (op.content as { inline: string }).inline },
        },
      });
    }
  }
  for (const [partition, seq] of seqs) {
    entries.push({
      kind: "partition",
      namespace: "",
      partition,
      seq,
      names: [{ name: "m1", highWater: 3, removed: [[2, 2]] }],
    });
  }
  entries.push(...records);
  serve.compactionPoint = point;
  serve.base = { point, entries };
  for (const [partition, seq] of seqs) {
    serve.compactedThrough.set(partition, seq);
  }
}

async function seqsAfter(
  store: SqliteCommitStore,
  after: number,
  partition = MODEL,
) {
  return (await store.readPartition("", partition, after + 1, 10_000)).map((
    c,
  ) => c.commit.seq);
}

Deno.test("ServeCatchUp.catchUp: a fresh copy of a compacted serve loads the base, then reads the feed on from the point", async () => {
  await withCheckout(async ({ dir, store, state, serve, catchUp, appends }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await compactServe(serve, 3);
    serve.land(await other(4));

    assertEquals(await catchUp.catchUp(signal()), { applied: 1 });
    assertEquals(appends, [4]);
    assertEquals((await store.head("", MODEL)).seq, 4);
    assertEquals(await seqsAfter(store, 3), [4]);
    assertEquals(state.feedCursor(), 4);
    assert((await store.compactionPoint()) >= 3);
    assertEquals(await store.dataHighWater("", MODEL, "m1"), 3);
    const base = await store.readCompactedBase(undefined, 100);
    assertEquals(
      base.entries.filter((e) => e.kind === "record").length,
      3,
    );
    assertEquals(state.serveHead("", MODEL.toString()), 3);
    assertEquals(stagingFiles(dir), []);
  });
});

Deno.test("ServeCatchUp.catchUp: the base load starts again when serve's point moves between pages", async () => {
  await withCheckout(async ({ store, state, serve, catchUp }) => {
    for (let seq = 1; seq <= 4; seq++) serve.land(await other(seq));
    await compactServe(serve, 4);
    const moved = serve.base!;
    await compactServe(serve, 3);
    serve.basePageSize = 1;
    serve.beforeBasePage = (page) => {
      if (page === 1) {
        serve.base = moved;
        serve.compactionPoint = 4;
      }
    };

    await catchUp.catchUp(signal());
    assertEquals(serve.baseReads.map((read) => read.after).slice(0, 3), [
      undefined,
      "1",
      undefined,
    ]);
    assertEquals((await store.head("", MODEL)).seq, 4);
    assertEquals(state.feedCursor(), 4);
  });
});

Deno.test("ServeCatchUp.catchUp: a base whose point never holds still fails, and leaves the copy as it was", async () => {
  await withCheckout(async ({ dir, store, state, serve, catchUp }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await compactServe(serve, 3);
    serve.basePageSize = 1;
    serve.beforeBasePage = () => {
      serve.base = { ...serve.base!, point: serve.base!.point + 1 };
    };

    const error = await assertRejects(
      () => catchUp.catchUp(signal()),
      ServeUpstreamError,
    );
    assertEquals(error.status, 503);
    assertEquals(serve.baseReads.length, 2 * BASE_LOAD_ATTEMPTS);
    assertEquals(await store.compactionPoint(), 0);
    assertEquals((await store.head("", MODEL)).seq, 0);
    assertEquals(state.feedCursor(), 0);
    assertEquals(stagingFiles(dir), []);
  });
});

Deno.test("ServeCatchUp.catchUp: a serve with no base route keeps the commits_compacted refusal", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    serve.compactionPoint = 3;

    const error = await assertRejects(
      () => catchUp.catchUp(signal()),
      ServeCommitsCompactedError,
    );
    assertEquals(error.point, 3);
    assertEquals(serve.baseReads.length, 1);
    assertEquals(await store.compactionPoint(), 0);
  });
});

Deno.test("ServeCatchUp.catchUp: a load cut off between pages leaves the copy untouched, and the next catch-up loads it", async () => {
  await withCheckout(async ({ dir, store, state, serve, catchUp }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await compactServe(serve, 3);
    serve.basePageSize = 1;
    const abort = new AbortController();
    serve.beforeBasePage = (page) => {
      if (page === 1) abort.abort(new Error("cut off"));
    };

    await assertRejects(() => catchUp.catchUp(abort.signal));
    assertEquals(await store.compactionPoint(), 0);
    assertEquals((await store.head("", MODEL)).seq, 0);
    assertEquals(state.feedCursor(), 0);
    assertEquals(stagingFiles(dir), []);

    serve.beforeBasePage = undefined;
    await catchUp.catchUp(signal());
    assertEquals((await store.head("", MODEL)).seq, 3);
    assertEquals(state.feedCursor(), 3);
  });
});

Deno.test("ServeCatchUp.catchUp: a load cut off after the install reads as behind the point, and loads the base again", async () => {
  await withCheckout(async ({ store, state, serve, catchUp }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await compactServe(serve, 3);
    serve.land(await other(4));
    const record = state.recordBaseLoaded.bind(state);
    let failures = 1;
    state.recordBaseLoaded = (...args) => {
      if (failures-- > 0) throw new Error("cut off");
      record(...args);
    };

    await assertRejects(() => catchUp.catchUp(signal()), Error, "cut off");
    assert((await store.compactionPoint()) >= 3);
    assertEquals(state.feedCursor(), 0);

    const reads = serve.baseReads.length;
    await catchUp.catchUp(signal());
    assert(serve.baseReads.length > reads);
    assertEquals((await store.head("", MODEL)).seq, 4);
    assertEquals(await seqsAfter(store, 3), [4]);
    assertEquals(state.feedCursor(), 4);
  });
});

Deno.test("ServeCatchUp.catchUp: a partition the base held nothing of reads on from its compacted seq", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    serve.land(await other(1, OTHER), { hidden: true });
    serve.land(await other(2, OTHER), { hidden: true });
    await compactServe(serve, 3);
    serve.base!.point = 5;
    serve.compactionPoint = 5;
    serve.compactedThrough.set(OTHER.toString(), 2);
    serve.land(await other(3, OTHER));

    await catchUp.catchUp(signal());
    assertEquals(await copySeqs(store, OTHER), [3]);
    assertEquals(
      serve.partitionReads.map((read) => read.after).slice(-2),
      [0, 2],
    );
  });
});

Deno.test("ServeCatchUp.catchUpPartition: a partition compacted past a copy with no base loads the base first, then reads on", async () => {
  await withCheckout(async ({ store, state, serve, catchUp }) => {
    for (let seq = 1; seq <= 2; seq++) serve.land(await other(seq));
    await compactServe(serve, 2);
    serve.land(await other(3));

    assertEquals(await catchUp.catchUpPartition("", MODEL, signal()), 3);
    assert(serve.baseReads.length > 0, "the base was loaded");
    assertEquals(state.basePoint(), 2);
    assertEquals(await seqsAfter(store, 2), [3]);
  });
});

Deno.test("ServeCatchUp.catchUp: a gap in a partition compacted past a copy that never loaded a base loads the base, never skipping what was compacted", async () => {
  await withCheckout(async ({ store, state, serve, catchUp }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    serve.land(await other(1, OTHER), { hidden: true });
    serve.land(await other(2, OTHER), { hidden: true });
    await catchUp.catchUp(signal());
    assertEquals(state.feedCursor(), 5);
    await compactServe(serve, 5);
    assertEquals(serve.baseReads.length, 0);
    serve.hidden.clear();
    serve.land(await other(3, OTHER));

    await catchUp.catchUp(signal());
    assert(serve.baseReads.length > 0, "the base was loaded");
    assertEquals(state.basePoint(), 5);
    assertEquals(
      (await store.readCompactedBase(undefined, 100)).entries.filter((e) =>
        e.kind === "record" && e.partition === OTHER.toString()
      ).length,
      1,
    );
    assertEquals(await seqsAfter(store, 2, OTHER), [3]);
    assertEquals(state.feedCursor(), 6);
  });
});

Deno.test("ServeCatchUp.catchUp: a load that finds another process loaded the base while it waited for the lease does not load it again", async () => {
  await withCheckout(async (checkout) => {
    const { dir, store, state, serve } = checkout;
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await compactServe(serve, 3);
    serve.land(await other(4));
    const otherStore = SqliteCommitStore.open(join(dir, "commits.db"), {
      follower: true,
    });
    const otherState = ServeUpstreamState.open(join(dir, "serve_upstream.db"));
    try {
      const first = new ServeCatchUp({
        client: serve,
        commitStore: otherStore,
        state: otherState,
        // Another process: the same directory, but not this process's
        // in-process chain, which only the lease orders against it.
        copyDir: `${dir}${SEPARATOR}.`,
        namespace: "",
        lockCopy: () => Promise.resolve(() => Promise.resolve()),
      });
      let locks = 0;
      const second = new ServeCatchUp({
        client: serve,
        commitStore: store,
        state,
        copyDir: dir,
        namespace: "",
        lockCopy: async () => {
          locks++;
          await first.catchUp(signal());
          return () => Promise.resolve();
        },
      });
      await second.catchUp(signal());
      assertEquals(locks, 1);
      assertEquals(serve.baseReads.length, 1);
      assertEquals((await store.head("", MODEL)).seq, 4);
      assertEquals(state.feedCursor(), 4);
      assertEquals(stagingFiles(dir), []);
    } finally {
      otherState.close();
      await otherStore.close();
    }
  });
});

Deno.test("ServeCatchUp.catchUp: two handles of one copy in one process load the base once", async () => {
  await withCheckout(async (checkout) => {
    const { dir, store, state, serve } = checkout;
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await compactServe(serve, 3);
    serve.basePageSize = 1;
    const otherStore = SqliteCommitStore.open(join(dir, "commits.db"), {
      follower: true,
    });
    const otherState = ServeUpstreamState.open(join(dir, "serve_upstream.db"));
    try {
      const handles = [
        through(serve, checkout),
        new ServeCatchUp({
          client: serve,
          commitStore: otherStore,
          state: otherState,
          copyDir: dir,
          namespace: "",
        }),
      ];
      await Promise.all(handles.map((handle) => handle.catchUp(signal())));
      const pages = serve.base!.entries.length;
      assertEquals(serve.baseReads.length, pages);
      assertEquals((await store.head("", MODEL)).seq, 3);
      assertEquals(
        (await store.readCompactedBase(undefined, 100)).entries.filter((e) =>
          e.kind === "record"
        ).length,
        3,
      );
      assertEquals(state.feedCursor(), 3);
      assertEquals(stagingFiles(dir), []);
    } finally {
      otherState.close();
      await otherStore.close();
    }
  });
});

Deno.test("ServeCatchUp.catchUp: after a base load, the next page's anchor still refuses a serve rolled back to another commit", async () => {
  await withCheckout(async (checkout) => {
    const { state, serve, catchUp } = checkout;
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    await compactServe(serve, 3);
    serve.land(await other(4));
    await catchUp.catchUp(signal());
    assertEquals(state.feedAnchor()?.seq, 4);

    const restored = new FakeServe();
    for (let seq = 1; seq <= 3; seq++) restored.land(await other(seq));
    await compactServe(restored, 3);
    restored.land(await another(4));
    const error = await assertRejects(
      () => through(restored, checkout).catchUp(signal()),
      ServeUpstreamDivergedError,
    );
    assertEquals(error.divergence.kind, "other-commit");
  });
});

Deno.test("serveAccessCheck: records each access serve sends, warns once when it differs from the copy's, ignores what is not a fingerprint and never throws (swamp-club#4089)", async () => {
  await withCheckout(async ({ state }) => {
    const captured: LogRecord[] = [];
    await configure({
      sinks: { capture: (record: LogRecord) => captured.push(record) },
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
    try {
      const check = serveAccessCheck(state, SERVE_URL);
      check("a1");
      check("a1");
      assertEquals(state.access(), { built: "a1", seen: "a1" });
      assertEquals(captured.length, 0);
      check("b2");
      check("c3");
      check("b2");
      assertEquals(state.access(), { built: "a1", seen: "b2" });
      assertEquals(captured.length, 1, "warned once");
      assertStringIncludes(
        captured[0].message.map((part) => String(part)).join(""),
        "the next command rebuilds",
      );
      check("Not A Fingerprint");
      check("x".repeat(129));
      assertEquals(state.access().seen, "b2");
      serveAccessCheck({
        access: () => ({}),
        recordAccessSeen: () => {
          throw new Error("database is locked");
        },
      }, SERVE_URL)("d4");
    } finally {
      await reset();
    }
  });
});

Deno.test("serveAccessCheck: warns only for a mismatch the reply records, and within the cooldown says the rebuild waits (swamp-club#4089)", async () => {
  await withCheckout(async ({ state }) => {
    const captured: LogRecord[] = [];
    await configure({
      sinks: { capture: (record: LogRecord) => captured.push(record) },
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
    const texts = () =>
      captured.map((record) => record.message.map(String).join(""));
    try {
      state.stampCaller("token-a");
      state.recordAccessSeen("a1");
      state.beginCallerReset();
      state.finishCallerReset("token-a", 1_000);
      state.recordAccessSeen("a1");
      serveAccessCheck(state, SERVE_URL, () => 2_000)("b2");
      assertEquals(texts().length, 1);
      assertStringIncludes(texts()[0], "changed again within 10 minutes");
      assert(!texts()[0].includes("the next command rebuilds"));
      serveAccessCheck(state, SERVE_URL, () => 3_000)("b2");
      serveAccessCheck(state, SERVE_URL, () => 3_000)("c3");
      assertEquals(texts().length, 1);
    } finally {
      await reset();
    }
  });
});

Deno.test("ServeCatchUp.catchUp: a reset of the copy by another command while this one pages the feed refuses the rest, so the new copy is never told it holds pages it does not (swamp-club#4089)", async () => {
  await withCheckout(async ({ state, serve, catchUp }) => {
    serve.feedPageSize = 2;
    for (let seq = 1; seq <= 5; seq++) serve.land(await other(seq));
    let reads = 0;
    serve.tooLarge = (route) => {
      if (route === "changes" && ++reads === 2) {
        const other = ServeUpstreamState.open(state.path);
        try {
          other.beginCallerReset();
          other.finishCallerReset("token-a", 1_000);
        } finally {
          other.close();
        }
      }
      return false;
    };

    await assertRejects(
      () => catchUp.catchUp(signal()),
      ServeCopyReplacedError,
    );
    const reset = ServeUpstreamState.open(state.path);
    try {
      assertEquals(
        reset.feedCursor(),
        0,
        "the reset copy reads from the start",
      );
      assertEquals(reset.feedAnchor(), undefined);
    } finally {
      reset.close();
    }
  });
});

Deno.test("ServeCatchUp.applyStamped: a commit serve stamped is taken only on the copy's head, when serve names that head as its parent", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    serve.land(await other(1));
    await catchUp.catchUp(signal());
    const second = await other(2);

    // serve could not name the parent: the caller reads the partition
    assertEquals(
      await catchUp.applyStamped("", MODEL, second.toJSON(), undefined),
      false,
    );
    // not the next commit on the copy's head
    assertEquals(
      await catchUp.applyStamped(
        "",
        MODEL,
        (await other(3)).toJSON(),
        "other-2",
      ),
      false,
    );
    assertEquals(await copySeqs(store, MODEL), [1]);

    const error = await assertRejects(
      () => catchUp.applyStamped("", MODEL, second.toJSON(), "another-1"),
      ServeUpstreamDivergedError,
    );
    assertEquals(error.divergence, {
      kind: "other-commit",
      serveTxnId: "another-1",
    });
    assertEquals(await copySeqs(store, MODEL), [1]);

    assertEquals(
      await catchUp.applyStamped("", MODEL, second.toJSON(), "other-1"),
      true,
    );
    assertEquals(await copySeqs(store, MODEL), [1, 2]);
    assertEquals(serve.requests.partitionCommits, 0);
  });
});

Deno.test("ServeCatchUp.catchUp: a page sent with a lock is applied without reading it again, and one with more to come is read on from its cursor", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    const asked = catchUp.request();
    const first = await serve.changes(asked.cursor, signal(), 2);
    assertEquals(first.more, true);
    const reads = serve.requests.changes;

    await catchUp.catchUp(signal(), { requested: asked, page: first });

    assertEquals(await copySeqs(store, MODEL), [1, 2, 3]);
    // one read for what the lock's page left, from where it ended
    assertEquals(serve.requests.changes, reads + 1);
    assertEquals(serve.changesReads.at(-1)?.cursor, first.cursor);
  });
});

Deno.test("ServeCatchUp.catchUp: a page asked for where the copy no longer stands is not used", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    serve.land(await other(1));
    const stale = { cursor: 99 };
    const page = { changes: [], cursor: 120, more: false };
    await catchUp.catchUp(signal(), { requested: stale, page });
    // read from the copy's own cursor instead
    assertEquals(serve.changesReads.at(-1)?.cursor, 0);
    assertEquals(await copySeqs(store, MODEL), [1]);
  });
});

Deno.test("ServeCatchUp.catchUp: a page sent with a lock and overtaken by the feed is applied from where the copy now stands, without reading it again (swamp-club#4574)", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    for (let seq = 1; seq <= 3; seq++) serve.land(await other(seq));
    const asked = catchUp.request();
    const page = await serve.changes(asked.cursor, signal(), 10);
    // the feed moves the copy past the first commit meanwhile
    const feed = await serve.changes(asked.cursor, signal(), 1);
    await catchUp.catchUp(signal(), {
      requested: asked,
      page: { ...feed, more: false },
    });
    assertEquals(await copySeqs(store, MODEL), [1]);
    const reads = serve.requests.changes;
    const partitionReads = serve.requests.partitionCommits;

    await catchUp.catchUp(signal(), { requested: asked, page });

    assertEquals(await copySeqs(store, MODEL), [1, 2, 3]);
    assertEquals(serve.requests.changes, reads);
    assertEquals(serve.requests.partitionCommits, partitionReads);
  });
});

Deno.test("ServeCatchUp.catchUp: an overtaken page whose entry at the copy's cursor is another commit is not used", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    for (let seq = 1; seq <= 2; seq++) serve.land(await other(seq));
    const asked = catchUp.request();
    const page = await serve.changes(asked.cursor, signal(), 10);
    const feed = await serve.changes(asked.cursor, signal(), 1);
    await catchUp.catchUp(signal(), {
      requested: asked,
      page: { ...feed, more: false },
    });
    const reads = serve.requests.changes;
    // the copy's commit at that cursor is not the page's
    const forged = {
      ...page,
      changes: page.changes.map((change, i) =>
        i === 0 ? { ...change, cursor: change.cursor + 1000 } : change
      ),
    };

    await catchUp.catchUp(signal(), { requested: asked, page: forged });

    assertEquals(serve.requests.changes, reads + 1);
    assertEquals(await copySeqs(store, MODEL), [1, 2]);
  });
});

Deno.test("ServeCatchUp.catchUp: a fresh copy appends a page of commits in shared transactions, not one each (swamp-club#4574)", async () => {
  await withCheckout(async ({ store, serve, catchUp }) => {
    for (let seq = 1; seq <= 200; seq++) serve.land(await other(seq));
    const before = store.appendTransactions;

    await catchUp.catchUp(signal());

    assertEquals((await copySeqs(store, MODEL)).length, 200);
    const used = store.appendTransactions - before;
    // up to 64 commits share one transaction
    assert(used <= Math.ceil(200 / 64), `${used} transactions for 200`);
  });
});
