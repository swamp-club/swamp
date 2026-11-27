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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  dataKey,
  modelIntent,
  modelPartition,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { COMMIT_MAY_LAND_CODE } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { contextHook, unitOptions } from "./commit_log_test_helpers.ts";
import { createCommitLogUnitOfWork } from "./commit_log_unit_of_work.ts";
import { ServeCatchUp } from "./serve_catch_up.ts";
import {
  createServeCommitSink,
  MAY_LAND_RESENDS,
} from "./serve_commit_sink.ts";
import {
  CachedServeStorage,
  ServeChunkStorage,
} from "./serve_datastore_storage.ts";
import { ServeUpstreamState } from "./serve_upstream_state.ts";
import {
  FakeServe,
  type PostFault,
  removeTempDir,
} from "./serve_upstream_test_helpers.ts";
import { SqliteCommitOutbox } from "./sqlite_commit_outbox.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";
import {
  commandMayHaveLanded,
  resetCommandLandedForTesting,
} from "./command_landed.ts";
import {
  offerServeLeaseRelease,
  resetServeLeasesForTesting,
} from "./serve_lease_registry.ts";
import { clearServeUnreachableLatches } from "./serve_datastore_client.ts";

const MODEL = modelPartition();
const NO_SYNC = {
  syncFile: () => Promise.resolve(),
  syncDirectory: () => Promise.resolve(),
};

interface Scenario {
  /** a final checkpoint releasing a lease goes as a batch; otherwise alone */
  readonly batched: boolean;
  readonly faults: readonly PostFault[];
  /** the copy applies serve's changes feed just before this post answers */
  readonly pullBeforePost?: number;
}

interface Outcome {
  readonly error: unknown;
  readonly posts: number;
  readonly batches: number;
  readonly servedHead: number;
  readonly copyHead: number;
  readonly outboxHasEntries: boolean;
  readonly mayHaveLanded: boolean;
}

async function runUnit(scenario: Scenario): Promise<Outcome> {
  resetServeLeasesForTesting();
  resetCommandLandedForTesting();
  clearServeUnreachableLatches();
  const dir = await Deno.makeTempDir({ prefix: "swamp-sink-lost-ack-" });
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
    namespace: "",
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
    serve.takesBatches = true;
    serve.postFaults.push(...scenario.faults);
    let posts = 0;
    serve.beforePost = async () => {
      posts++;
      if (posts === scenario.pullBeforePost) {
        await catchUp.catchUp(lifetime.signal);
      }
    };
    offerServeLeaseRelease(
      "lease-1",
      () => Promise.resolve(),
      () => {},
      () => {},
    );
    const uow = createCommitLogUnitOfWork(
      contextHook(),
      unitOptions(sink, cache),
    );
    await uow.stageOp({
      partition: MODEL,
      put: {
        intent: modelIntent({ kind: "data.save", name: "a", version: 1 }),
        key: dataKey("a", 1),
        content: new TextEncoder().encode("content of a"),
      },
    });
    let error: unknown;
    try {
      if (scenario.batched) await uow.checkpoint({ release: "lease-1" });
      else await uow.checkpoint();
    } catch (caught) {
      error = caught;
    }
    return {
      error,
      posts,
      batches: serve.batches.length,
      servedHead: serve.head(MODEL),
      copyHead: (await store.head("", MODEL)).seq,
      outboxHasEntries: await outbox.hasEntries(),
      mayHaveLanded: commandMayHaveLanded(),
    };
  } finally {
    lifetime.abort();
    state.close();
    await outbox.close();
    await store.close();
    await removeTempDir(dir);
    resetServeLeasesForTesting();
    resetCommandLandedForTesting();
    clearServeUnreachableLatches();
  }
}

const MAY_LAND_THEN_NOT_LEADER: readonly PostFault[] = [
  { kind: "may-land" },
  { kind: "not-leader", inFlight: false },
];

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | undefined)?.code;
}

function assertUnknownOutcome(outcome: Outcome): void {
  assertEquals(
    codeOf(outcome.error),
    COMMIT_MAY_LAND_CODE,
    String(outcome.error),
  );
  assertEquals(outcome.outboxHasEntries, true, "the entry is kept");
  assertEquals(outcome.mayHaveLanded, true);
}

Deno.test("createServeCommitSink: a batched commit serve landed unconfirmed, then refused not-leader on its resend, ends may-land though the copy caught up with it", async () => {
  const outcome = await runUnit({
    batched: true,
    faults: MAY_LAND_THEN_NOT_LEADER,
    pullBeforePost: 2,
  });
  assertEquals(outcome.batches, 1);
  assertEquals(outcome.posts, 2, "the batch item, then one resend alone");
  assertEquals(outcome.servedHead, 1, "serve holds it, unconfirmed");
  assertEquals(outcome.copyHead, 1, "the copy caught up with it");
  assertUnknownOutcome(outcome);
});

Deno.test("createServeCommitSink: a batched commit serve landed unconfirmed, then refused not-leader on its resend, ends may-land, never as nothing changed", async () => {
  const outcome = await runUnit({
    batched: true,
    faults: MAY_LAND_THEN_NOT_LEADER,
  });
  assertEquals(outcome.posts, 2);
  assertEquals(outcome.copyHead, 0);
  assertUnknownOutcome(outcome);
});

Deno.test("createServeCommitSink: a commit sent alone that serve landed unconfirmed, then refused not-leader on its resend, ends may-land though the copy caught up with it", async () => {
  const outcome = await runUnit({
    batched: false,
    faults: MAY_LAND_THEN_NOT_LEADER,
    pullBeforePost: 2,
  });
  assertEquals(outcome.batches, 0, "sent alone");
  assertEquals(outcome.copyHead, 1);
  assertUnknownOutcome(outcome);
});

Deno.test("createServeCommitSink: a commit sent alone that stays unconfirmed through its resends still ends may-land", async () => {
  const outcome = await runUnit({
    batched: false,
    faults: Array.from(
      { length: MAY_LAND_RESENDS + 1 },
      () => ({ kind: "may-land" }) as const,
    ),
  });
  assertEquals(outcome.posts, MAY_LAND_RESENDS + 1);
  assertUnknownOutcome(outcome);
});

Deno.test("createServeCommitSink: a batched may-land whose resend serve answers as landed lands, keeps no entry and notes nothing unknown", async () => {
  const outcome = await runUnit({
    batched: true,
    faults: [{ kind: "may-land" }],
  });
  assertEquals(outcome.error, undefined);
  assertEquals(outcome.posts, 2);
  assertEquals(outcome.servedHead, 1, "appended once");
  assertEquals(outcome.copyHead, 1);
  assertEquals(outcome.outboxHasEntries, false);
  assertEquals(outcome.mayHaveLanded, false);
});
