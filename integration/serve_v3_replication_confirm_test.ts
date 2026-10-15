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
 * Serve's write confirmation against a real Litestream sidecar and a file
 * replica (swamp-club#3489, Phase 4D3): a write request's replies are held
 * by `confirmRequest` until `confirmV3Replicated` has synced and published
 * a head covering its commits, and concurrent requests share syncs. The
 * crash-and-takeover case is in `datastore_v3_litestream_restore_test.ts`,
 * which runs machines as workers.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  closeV3Datastores,
  confirmV3Replicated,
  holdV3Writer,
  v3CommitMark,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { unixLitestreamControl } from "../src/infrastructure/datastore_v3/litestream/litestream_control_client.ts";
import { confirmRequest, send } from "../src/serve/handlers/shared.ts";
import type { ServerMessage } from "../src/serve/protocol.ts";
import {
  commitIn,
  type ReplicationEnv,
  SIDECAR_TESTS_IGNORED,
  withReplicationEnv,
} from "./datastore_v3_litestream_helpers.ts";

const ignore = SIDECAR_TESTS_IGNORED;

/** The highest high-water mark any published head covers, read in place. */
function publishedCursor(env: ReplicationEnv): number {
  let highest = -1;
  const lineages = join(env.datastorePath, "_control", "lineage");
  let fences: Deno.DirEntry[];
  try {
    fences = [...Deno.readDirSync(lineages)];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return highest;
    throw error;
  }
  for (const fence of fences) {
    for (const entry of Deno.readDirSync(join(lineages, fence.name))) {
      if (!entry.name.startsWith("head-")) continue;
      const head = JSON.parse(
        Deno.readTextFileSync(join(lineages, fence.name, entry.name)),
      ) as { mark: { cursor: number } };
      highest = Math.max(highest, head.mark.cursor);
    }
  }
  return highest;
}

/** A reply as the client got it, with what was replicated at that moment. */
interface Reply {
  readonly message: ServerMessage;
  /** The request's own last commit, or -1 when it committed nothing. */
  readonly committed: number;
  /** The highest published head when the reply went out. */
  readonly published: number;
}

/** Each write request's own last commit, by request id. */
const ownCommits = new Map<string, number>();

/**
 * A socket that records, as each reply goes out, how far the checkout has
 * committed and how far the published heads reach: synchronously, so a
 * later sync cannot make a reply look covered after the fact.
 */
function observingSocket(env: ReplicationEnv) {
  const replies: Reply[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      replies.push({
        message: JSON.parse(data),
        committed: ownCommits.get(JSON.parse(data).id) ?? -1,
        published: publishedCursor(env),
      });
    },
  } as unknown as WebSocket;
  return { socket, replies };
}

/** Serve's context as serve.ts builds it while replication is on. */
function confirmingCtx(env: ReplicationEnv) {
  return {
    confirmReplicated: () => confirmV3Replicated(env.datastorePath),
    replicationMark: () => v3CommitMark(env.datastorePath),
  };
}

/** A write request: commits, then replies inside its handler, as serve's do. */
function writeRequest(
  env: ReplicationEnv,
  socket: WebSocket,
  id: string,
): Promise<void> {
  return confirmRequest(confirmingCtx(env), socket, id, async () => {
    await commitIn(env, 1);
    // Its own commit: concurrent requests commit around it.
    ownCommits.set(
      id,
      v3DatastoreFor(env.repoDir, env.config).commitStore.highWaterMark()
        .cursor,
    );
    send(socket, { type: "done", id });
  });
}

/** Counts the sidecar syncs and can fail the next ones. */
function countingControl() {
  const state = { syncs: 0, failNext: 0 };
  return {
    state,
    control: {
      info: unixLitestreamControl.info,
      sync: (socket: string, db: string, deadline: number) => {
        state.syncs++;
        if (state.failNext > 0) {
          state.failNext--;
          return Promise.reject(new Error("the sidecar did not answer"));
        }
        return unixLitestreamControl.sync(socket, db, deadline);
      },
    },
  };
}

Deno.test({
  name:
    "serve write confirmation: a write answers only once a published head covers its commit",
  ignore,
  async fn() {
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      const { socket, replies } = observingSocket(env);
      await writeRequest(env, socket, "w1");
      assertEquals(replies.map((r) => r.message.type), ["done"]);
      const [reply] = replies;
      assert(reply.committed > 0);
      assert(
        reply.published >= reply.committed,
        `published ${reply.published} before committed ${reply.committed}`,
      );
      await closeV3Datastores();
    });
  },
});

Deno.test({
  name:
    "serve write confirmation: concurrent writes share syncs, and each answers covered",
  ignore,
  async fn() {
    const counting = countingControl();
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      const { socket, replies } = observingSocket(env);
      const before = counting.state.syncs;
      const requests = 8;
      await Promise.all(
        Array.from(
          { length: requests },
          (_, i) => writeRequest(env, socket, `w${i}`),
        ),
      );
      const syncs = counting.state.syncs - before;
      assertEquals(replies.length, requests);
      for (const reply of replies) {
        assertEquals(reply.message.type, "done");
        assert(
          reply.published >= reply.committed,
          `a reply went out at ${reply.committed} with heads at ${reply.published}`,
        );
      }
      assert(syncs >= 1, "the writes were confirmed by a sync");
      assert(syncs < requests, `${syncs} syncs for ${requests} writes`);
      await closeV3Datastores();
    }, { deps: { control: counting.control } });
  },
});

Deno.test({
  name:
    "serve write confirmation: an unconfirmed sync fails the request, and the next sync ships its commit",
  ignore,
  async fn() {
    const counting = countingControl();
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      const { socket, replies } = observingSocket(env);
      counting.state.failNext = 1;
      await writeRequest(env, socket, "w1");
      assertEquals(replies.length, 1);
      const failed = replies[0].message as {
        type: string;
        error: { code: string };
      };
      assertEquals(failed.type, "error");
      assertEquals(failed.error.code, "datastore_v3_replication_unconfirmed");
      const unconfirmed = replies[0].committed;
      assert(replies[0].published < unconfirmed);
      await writeRequest(env, socket, "w2");
      assertEquals(replies[1].message.type, "done");
      assert(replies[1].published >= unconfirmed);
      await closeV3Datastores();
    }, { deps: { control: counting.control } });
  },
});

Deno.test({
  name:
    "serve write confirmation: a request that commits nothing makes no sync",
  ignore,
  async fn() {
    const counting = countingControl();
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      const { socket, replies } = observingSocket(env);
      await writeRequest(env, socket, "w1");
      const after = counting.state.syncs;
      await confirmRequest(confirmingCtx(env), socket, "r1", () => {
        send(socket, { type: "done", id: "r1" });
        return Promise.resolve();
      });
      assertEquals(counting.state.syncs, after);
      assertEquals(replies.map((r) => r.message.id), ["w1", "r1"]);
      await closeV3Datastores();
    }, { deps: { control: counting.control } });
  },
});

Deno.test({
  name:
    "serve write confirmation: a request that commits nothing never waits on another writer's unconfirmed commit",
  ignore,
  async fn() {
    const counting = countingControl();
    await withReplicationEnv(async (env) => {
      await holdV3Writer(env.config, env.repoDir, { retakeLost: true });
      const { socket, replies } = observingSocket(env);
      await writeRequest(env, socket, "w1");
      // A background write nothing confirms, while the sidecar fails.
      await commitIn(env, 1);
      counting.state.failNext = 1;
      const before = counting.state.syncs;
      await confirmRequest(confirmingCtx(env), socket, "r1", () => {
        send(socket, { type: "done", id: "r1" });
        return Promise.resolve();
      });
      assertEquals(counting.state.syncs, before);
      assertEquals(replies.map((r) => r.message.type), ["done", "done"]);
      await closeV3Datastores().catch(() => {});
    }, { deps: { control: counting.control } });
  },
});
