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

// `swamp datastore claim` and `release` on a filesystem v3 datastore
// (swamp-club#4063): a claim makes serve the datastore's owner, a direct
// writer that finds it refuses with `datastore_claimed` once it holds the
// writer lease, reads and the owner serve keep working, and a release
// restores direct writing. The race tests run the other writer in a Worker,
// with module state of its own, as another process.

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  DATASTORE_CLAIMED_CODE,
  DatastoreClaimedError,
  DatastoreOwner,
} from "../src/domain/datastore_v3/datastore_owner.ts";
import {
  modelPartition,
  savePut,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  closeV3Datastores,
  v3ClaimCommitLog,
  v3DatastoreConfigOf,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { advanceV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { plantV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import {
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import type { V3OwnerCheck } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { consumeStream } from "../src/libswamp/stream.ts";
import {
  datastoreClaim,
  type DatastoreClaimData,
} from "../src/libswamp/datastores/claim.ts";
import {
  datastoreRelease,
  type DatastoreReleaseData,
} from "../src/libswamp/datastores/release.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";
import {
  handleDatastoreClaim,
  handleDatastoreRelease,
} from "../src/serve/handlers/admin_handlers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type {
  ClaimRaceMessage,
  ClaimRaceRequest,
} from "./datastore_v3_claim_race_worker.ts";
import { join } from "@std/path";

await initializeLogging({});

const OWNER = "https://swamp.example.com";

/** Opens `repoDir` to write, as a command does, with `ownerCheck`. */
async function hold(repoDir: string, ownerCheck?: V3OwnerCheck) {
  return await requireInitializedRepoUnlocked({
    repoDir,
    outputMode: "json",
    ...(ownerCheck !== undefined ? { v3OwnerCheck: ownerCheck } : {}),
  });
}

/** The claim log of `repoDir`'s datastore, under a claimer's hold. */
async function claimLog(repoDir: string) {
  const context = await hold(repoDir, { as: "claimer" });
  return v3ClaimCommitLog(
    context.repoDir,
    await v3DatastoreConfigOf(context.repoDir, context.datastoreConfig),
  );
}

/** `swamp datastore claim --address address` in `repoDir`, serve stopped. */
async function claim(
  repoDir: string,
  address: string,
): Promise<DatastoreClaimData> {
  try {
    let data: DatastoreClaimData | undefined;
    await consumeStream(
      datastoreClaim(createLibSwampContext({}), {
        commitLog: await claimLog(repoDir),
      }, { address }),
      {
        catching_up: () => {},
        completed: (e) => {
          data = e.data;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );
    return data!;
  } finally {
    await closeV3Datastores();
  }
}

/** `swamp datastore release` in `repoDir`, serve stopped. */
async function release(repoDir: string): Promise<DatastoreReleaseData> {
  try {
    let data: DatastoreReleaseData | undefined;
    await consumeStream(
      datastoreRelease(createLibSwampContext({}), {
        commitLog: await claimLog(repoDir),
      }),
      {
        completed: (e) => {
          data = e.data;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );
    return data!;
  } finally {
    await closeV3Datastores();
  }
}

/** A writing command's start in `repoDir`, then its end. */
async function write(repoDir: string, ownerCheck?: V3OwnerCheck) {
  try {
    await hold(repoDir, ownerCheck);
  } finally {
    await closeV3Datastores();
  }
}

/** Commits one data version through the handle's sink, as serve commits. */
async function commitOne(repoDir: string): Promise<void> {
  const context = await requireInitializedRepoReadOnly({
    repoDir,
    outputMode: "json",
  });
  const config = await v3DatastoreConfigOf(
    context.repoDir,
    context.datastoreResolver.config(),
  );
  const handle = v3DatastoreFor(context.repoDir, config);
  const head = await handle.commitStore.head(
    handle.namespace,
    modelPartition(),
  );
  await handle.appendForwarded({
    partition: modelPartition(),
    txnId: crypto.randomUUID(),
    expectedSeq: head.seq,
    principal: "test",
    ops: [await savePut("a", head.seq + 1)],
  });
}

function commitsDb(datastorePath: string): string {
  return join(datastorePath, "commits.db");
}

/** The log's high-water mark, read from the file. */
function highWater(datastorePath: string): number {
  const store = SqliteCommitStore.open(commitsDb(datastorePath));
  try {
    return store.highWaterMark().cursor;
  } finally {
    store.close().catch(() => {});
  }
}

Deno.test("datastore claim: a direct writer is refused with datastore_claimed while reads and the owner serve work, and a release restores direct writing", async () => {
  await withV3RowRepos({}, async (repos) => {
    await closeV3Datastores();
    const claimed = await claim(repos.repoA, "HTTPS://Swamp.Example.com/");
    assertEquals(claimed.address, OWNER);
    assertEquals(claimed.alreadyClaimed, false);

    const refused = await assertRejects(
      () => write(repos.repoB),
      DatastoreClaimedError,
    );
    assertEquals(refused.code, DATASTORE_CLAIMED_CODE);
    assert(refused.message.includes(OWNER), refused.message);

    // Reads stay allowed.
    await requireInitializedRepoReadOnly({
      repoDir: repos.repoB,
      outputMode: "json",
    });
    await closeV3Datastores();

    // The owner serve writes; another serve does not, nor one without its
    // address.
    await write(repos.repoB, { as: "serve", address: `${OWNER}:443` });
    await assertRejects(
      () =>
        write(repos.repoB, {
          as: "serve",
          address: "https://other.example.com",
        }),
      DatastoreClaimedError,
      "not the owner's",
    );
    await assertRejects(
      () => write(repos.repoB, { as: "serve", address: undefined }),
      DatastoreClaimedError,
      "--address",
    );

    const released = await release(repos.repoA);
    assertEquals(released, {
      released: true,
      address: OWNER,
      claimedAt: claimed.claimedAt,
    });
    await write(repos.repoB);
  });
});

Deno.test("datastore claim: a direct writer is refused with datastore_claimed at once while another process holds the lease, never with writer_busy after the lock timeout", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await closeV3Datastores();
    await claim(repos.repoA, OWNER);
    // As serve holds it: a live process's lease, far from expiring.
    const lease = await plantV3WriterLease(datastorePath, {
      pid: Deno.pid,
      ttlMs: 10 * 60_000,
    });
    try {
      const refused = await assertRejects(
        () => write(repos.repoB),
        DatastoreClaimedError,
      );
      assertEquals(refused.code, DATASTORE_CLAIMED_CODE);
    } finally {
      await lease.release();
    }
  });
});

Deno.test("datastore claim: claiming again for the same address changes nothing, another address is refused, and releasing an unclaimed datastore is a no-op", async () => {
  await withV3RowRepos({}, async (repos) => {
    await closeV3Datastores();
    assertEquals(await release(repos.repoA), { released: false });
    const first = await claim(repos.repoA, OWNER);
    const again = await claim(repos.repoB, `${OWNER}/`);
    assertEquals(again, { ...first, alreadyClaimed: true });
    await assertRejects(
      () => claim(repos.repoB, "https://other.example.com"),
      DatastoreClaimedError,
      "datastore release",
    );
    await closeV3Datastores();
  });
});

Deno.test("datastore claim: a claim that lands while serve's lease had moved stops serve committing; its own claim does not", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await closeV3Datastores();
    try {
      const context = await hold(repos.repoA, { as: "serve", address: OWNER });
      const config = await v3DatastoreConfigOf(
        context.repoDir,
        context.datastoreConfig,
      );
      await commitOne(repos.repoA);

      // Serve's own claim, through its hold, keeps it the owner.
      const log = v3ClaimCommitLog(context.repoDir, config);
      await log.claim(
        DatastoreOwner.create({
          address: OWNER,
          claimedAt: new Date().toISOString(),
          claimedAtCursor: log.highWaterCursor(),
        }),
      );
      await advanceV3WriterLease(datastorePath);
      await commitOne(repos.repoA);

      // A claim for another address written under the moved fence, as a
      // direct claim lands while serve's lease had lapsed.
      await log.claim(
        DatastoreOwner.create({
          address: "https://other.example.com",
          claimedAt: new Date().toISOString(),
          claimedAtCursor: log.highWaterCursor(),
        }),
      );
      const before = highWater(datastorePath);
      await advanceV3WriterLease(datastorePath);
      await assertRejects(
        () => commitOne(repos.repoA),
        DatastoreClaimedError,
        "not the owner's",
      );
      assertEquals(highWater(datastorePath), before);
    } finally {
      await closeV3Datastores();
    }
  });
});

/** A WebSocket that records what serve sends on it. */
function recordingSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    sent,
  } as unknown as WebSocket & { sent: string[] };
}

/** Serve's connection context over its own hold of `repoDir`. */
async function serveContext(repoDir: string): Promise<ConnectionContext> {
  const context = await hold(repoDir, { as: "serve", address: OWNER });
  return {
    repoDir: context.repoDir,
    repoContext: context.repoContext,
    datastoreConfig: context.datastoreConfig,
    datastoreResolver: context.datastoreResolver,
    authConfig: {
      mode: "none",
      admins: [],
      allowedCollectives: [],
      allowedUsers: [],
      oauthProvider: "",
      groupsField: "collectives",
      restrictedModelTypes: [],
      restrictedCommands: [],
      approveRequiresExplicitGrant: false,
      signalRequiresExplicitGrant: false,
      tagRequiresExplicitGrant: false,
    },
    ownerAddress: OWNER,
  } as unknown as ConnectionContext;
}

Deno.test("datastore claim: a claim through serve, which holds the lease, makes it the owner: serve keeps writing, direct writers are refused until serve releases it", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await closeV3Datastores();
    try {
      const ctx = await serveContext(repos.repoA);
      const socket = recordingSocket();
      await handleDatastoreClaim(
        socket,
        ctx,
        "claim-1",
        { address: `${OWNER}/` },
        new AbortController(),
        null,
      );
      const frame = JSON.parse(socket.sent[0]);
      assertEquals(frame.type, "datastore.claim", socket.sent[0]);
      assertEquals(frame.payload.data.address, OWNER);
      assertEquals(frame.payload.data.alreadyClaimed, false);
      // Serve is the owner: it keeps committing.
      await commitOne(repos.repoA);
    } finally {
      await closeV3Datastores();
    }

    await assertRejects(() => write(repos.repoB), DatastoreClaimedError);
    const store = SqliteCommitStore.open(commitsDb(datastorePath));
    try {
      assertEquals(store.owner()?.address, OWNER);
    } finally {
      await store.close();
    }

    try {
      const ctx = await serveContext(repos.repoA);
      const socket = recordingSocket();
      await handleDatastoreRelease(
        socket,
        ctx,
        "release-1",
        new AbortController(),
        null,
      );
      const frame = JSON.parse(socket.sent[0]);
      assertEquals(frame.type, "datastore.release", socket.sent[0]);
      assertEquals(frame.payload.data.released, true);
      assertEquals(frame.payload.data.address, OWNER);
    } finally {
      await closeV3Datastores();
    }
    await write(repos.repoB);
  });
});

/** Starts the race worker writing `repoDir`; resolves its messages. */
function startWriter(request: ClaimRaceRequest) {
  const messages: ClaimRaceMessage[] = [];
  const worker = new Worker(
    new URL("./datastore_v3_claim_race_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  worker.onmessage = (event: MessageEvent<ClaimRaceMessage>) => {
    messages.push(event.data);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    messages.push({ failed: event.message });
  };
  worker.postMessage(request);
  const seen = (test: (m: ClaimRaceMessage) => boolean) =>
    waitFor(
      () => messages.some(test) || messages.some((m) => "failed" in m),
      "the writer's message",
      { timeoutMs: 60_000 },
    ).then(() => {
      const failed = messages.find((m) => "failed" in m);
      if (failed !== undefined && "failed" in failed) {
        throw new Error(`the writer failed: ${failed.failed}`);
      }
      return messages.find(test)!;
    });
  return { worker, messages, seen };
}

Deno.test("datastore claim: a writer that holds the lease when the claim is asked for commits before the claim, never after it", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await closeV3Datastores();
    const writer = startWriter({
      repoDir: repos.repoB,
      datastorePath,
      id: crypto.randomUUID(),
    });
    try {
      await writer.seen((m) => "held" in m);
      // The claim waits for the writer's lease.
      const claiming = claim(repos.repoA, OWNER);
      writer.worker.postMessage("commit");
      const committed = await writer.seen((m) => "committed" in m);
      await writer.seen((m) => "done" in m);
      const claimed = await claiming;
      assert("committed" in committed);
      assert(
        committed.committed <= claimed.claimedAtCursor,
        `the writer's commit ${committed.committed} is after the claim at ${claimed.claimedAtCursor}`,
      );
    } finally {
      writer.worker.terminate();
      await closeV3Datastores();
    }
  });
});

Deno.test("datastore claim: a writer that waits for the lease while the claim lands is refused once it holds it, and commits nothing", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await closeV3Datastores();
    // The claimer holds the lease before the writer starts.
    const log = await claimLog(repos.repoA);
    const writer = startWriter({
      repoDir: repos.repoB,
      datastorePath,
      id: crypto.randomUUID(),
    });
    try {
      // The writer waits for the lease the claimer holds, past every check
      // before it.
      await writer.seen((m) => "waiting" in m);
      let data: DatastoreClaimData | undefined;
      await consumeStream(
        datastoreClaim(createLibSwampContext({}), { commitLog: log }, {
          address: OWNER,
        }),
        {
          catching_up: () => {},
          completed: (e) => {
            data = e.data;
          },
          error: (e) => {
            throw new Error(e.error.message);
          },
        },
      );
      const mark = highWater(datastorePath);
      await closeV3Datastores();
      // A writer that took the lease past the claim reports held instead.
      const outcome = await writer.seen((m) => "refused" in m || "held" in m);
      assertEquals(outcome, { refused: DATASTORE_CLAIMED_CODE });
      assertEquals(
        writer.messages.some((m) => "held" in m || "committed" in m),
        false,
      );
      assertEquals(highWater(datastorePath), mark);
      assertEquals(data?.claimedAtCursor, mark);
    } finally {
      writer.worker.terminate();
      await closeV3Datastores();
    }
  });
});
