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
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import {
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { runPartition, runPut } from "./commit_log_test_helpers.ts";
import { SERVE_PARTITION_PAGE, ServeCatchUp } from "./serve_catch_up.ts";
import { ServeCommitsCompactedError } from "./serve_upstream_errors.ts";
import { ServeUpstreamState } from "./serve_upstream_state.ts";
import {
  FakeServe,
  removeTempDir,
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
      catchUp: new ServeCatchUp({ client: serve, commitStore: store, state }),
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
