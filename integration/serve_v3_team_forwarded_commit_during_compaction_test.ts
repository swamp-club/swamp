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

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { Commit } from "../src/domain/datastore_v3/commit.ts";
import type { CommitStoreAppendResult } from "../src/domain/datastore_v3/commit_store.ts";
import { dataVersionOp } from "../src/domain/datastore_v3/op.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import type { ServeLeader } from "../src/domain/datastore_v3/serve_leader.ts";
import {
  COMPACTION_BATCH,
  type SqliteCommitStore,
  type SqliteCompactHistoryOptions,
} from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { UploadLedger } from "../src/infrastructure/datastore_v3/upload_ledger.ts";
import {
  compactQuietly,
  SERVE_COMPACTION_TIMEOUT_MS,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { handleDatastoreRequest } from "../src/serve/datastore_api.ts";
import { matchDatastoreRoute } from "../src/serve/datastore_routes.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { LeaderLink } from "../src/serve/leader_link.ts";
import {
  dataMetadata,
  partitionPath,
  post,
  saveBody,
  type Server,
  TOKENS,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

async function withFollower(
  server: Server,
  leader: ServeLeader,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const leaderLink = new LeaderLink({ leader: () => leader });
  const ctx = {
    ...server.ctx,
    followerGate: {
      role: "follower" as const,
      leader: () => leader,
      isStale: () => false,
    },
    leaderLink,
  } as ConnectionContext;
  const ledger = new UploadLedger();
  const http = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const route = matchDatastoreRoute(new URL(req.url).pathname);
      if (route === undefined) return new Response("no", { status: 404 });
      return await handleDatastoreRequest(req, route, "127.0.0.1", {
        ctx,
        v3: server.v3,
        ledger,
        locks: server.locks,
        authenticate: (token) => {
          const principalId = TOKENS[token];
          return Promise.resolve(
            principalId === undefined
              ? { ok: false, error: "bad token", reason: "secret-mismatch" }
              : {
                ok: true,
                principalId,
                collectives: [],
                groups: [],
                tokenName: token,
                tokenCreatedAt: "2026-01-01T00:00:00Z",
              },
          );
        },
      });
    },
  );
  try {
    await fn(server.url.replace(/:\d+\//, `:${http.addr.port}/`));
  } finally {
    leaderLink.close();
    await http.shutdown();
  }
}

/** Old commits in a partition of their own, past the hourly compaction's floor. */
async function seedCompactable(server: Server, count: number): Promise<void> {
  const id = crypto.randomUUID();
  const partition = partitionOf({ kind: "model", type: server.modelType, id });
  const type = server.modelType.normalized;
  const fence = server.v3.commitStore.writerFence();
  const appends: Promise<CommitStoreAppendResult>[] = [];
  for (let seq = 1; seq <= count; seq++) {
    appends.push(server.v3.commitStore.append(Commit.create({
      seq,
      partition,
      namespace: server.v3.namespace,
      txnId: crypto.randomUUID(),
      writer: { host: "host-a", pid: 4242, instance: "cli-1" },
      at: "2020-01-01T00:00:00.000Z",
      ...(fence === undefined ? {} : { fence }),
      ops: [
        dataVersionOp({
          key: RecordKey.create(
            `data/${type}/${id}/seeded/${seq}/metadata.yaml`,
          ),
          metadata: dataMetadata("seeded", seq),
        }),
      ],
    })));
  }
  await Promise.all(appends);
  await server.v3.catchUp();
}

Deno.test({
  name:
    "team forwarding: a commit forwarded through the follower during the leader's hourly compaction lands before the compaction's last batch (swamp-club#4679)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const leader: ServeLeader = {
        instanceId: "leader-1",
        fence: 4,
        address: new URL(server.url).origin,
        since: "2026-10-29T12:00:00.000Z",
      };
      // The hourly pass keeps the newest 2,500 commits and folds the rest.
      await seedCompactable(server, 2_500 + 4 * COMPACTION_BATCH);

      const store = server.v3.commitStore as SqliteCommitStore;
      const events: string[] = [];
      const txnId = crypto.randomUUID();
      let arrived = false;
      let release = () => {};
      const gate = new Promise<void>((resolve) => release = resolve);
      const append = store.append.bind(store);
      store.append = async (commit) => {
        if (commit.txnId !== txnId) return await append(commit);
        arrived = true;
        // Held at the leader's store until the first batch is inside its
        // transaction, so the append is issued mid-compaction.
        await gate;
        const result = await append(commit);
        events.push("landed");
        return result;
      };
      const compactHistory = store.compactHistory.bind(store);
      store.compactHistory = (through, options = {}) =>
        compactHistory(through, {
          ...options,
          beforeCommit: () => {
            options.beforeCommit?.();
            events.push("batch");
            release();
          },
        } as SqliteCompactHistoryOptions);

      await withFollower(server, leader, async (followerUrl) => {
        const forwarded = post(
          partitionPath(server).replace(server.url, followerUrl),
          "alice-token",
          await saveBody(server, 1, 0, { txnId }),
        );
        await waitFor(() => arrived, "the forwarded commit at the leader");
        await compactQuietly(server.v3, SERVE_COMPACTION_TIMEOUT_MS);
        events.push("compacted");
        // A compaction that ran no batch must fail the assertions, not hang.
        release();
        const landed = await forwarded;
        assertEquals(landed.status, 200, JSON.stringify(landed.json));
      });

      const batches = events.filter((event) => event === "batch").length;
      assert(batches >= 4, `compaction ran ${batches} batches`);
      const before = events.slice(0, events.indexOf("landed"))
        .filter((event) => event === "batch").length;
      assert(
        before < batches,
        `the forwarded commit landed after ${before} of ${batches} batches: ${
          events.join(",")
        }`,
      );
    });
  },
});
