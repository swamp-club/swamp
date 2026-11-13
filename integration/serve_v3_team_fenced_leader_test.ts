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

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { walk } from "@std/fs";
import { basename, join } from "@std/path";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import { ServeCatchUp } from "../src/infrastructure/datastore_v3/serve_catch_up.ts";
import {
  type AnchorVerdict,
  type ChangeEntry,
  ServeDatastoreClient,
} from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import {
  serveErrorFromReply,
  ServeUpstreamDivergedError,
} from "../src/infrastructure/datastore_v3/serve_upstream_errors.ts";
import {
  SERVE_UPSTREAM_STATE_FILE,
  ServeUpstreamState,
} from "../src/infrastructure/datastore_v3/serve_upstream_state.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { SqliteCommitOutbox } from "../src/infrastructure/datastore_v3/sqlite_commit_outbox.ts";
import {
  COMMIT_OUTBOX_FILE,
  COMMITS_DB_FILE,
  initializeV3Datastore,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  killSidecarAtTeardown,
  SIDECAR_TESTS_IGNORED,
} from "./datastore_v3_litestream_helpers.ts";
import {
  blobSaveOps,
  commitBody,
  post,
  sha256Hex,
} from "./serve_datastore_api_harness.ts";
import type { Frame } from "./serve_request_harness.ts";
import { captureLogs } from "./remote_secrets_baseline_harness.ts";
import {
  type Client,
  dataOf,
  json,
  type Scratch,
  serveEnv,
  startProxy,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type {
  FencedNodeRequest,
  FencedNodeResponse,
  FencedNodeState,
  Opened,
  StoredCommit,
} from "./serve_v3_team_fenced_leader_node_worker.ts";

await initializeLogging({});

const TOKENS: Record<string, string> = { "alice-token": "user:alice" };
const ALICE = "user:alice";

const LEASE_TTL_MS = 1_500;

/** the lease's TTL plus the 10 s clock skew a takeover waits out */
const STALL_MS = 14_000;

// a worker that never answers fails the test instead of hanging the run
const REQUEST_TIMEOUT_MS = 120_000;

interface Node {
  readonly name: string;
  send(request: FencedNodeRequest): Promise<unknown>;
  state(): Promise<FencedNodeState>;
}

interface Team {
  readonly root: string;
  readonly modelType: ModelType;
  readonly modelId: string;
  readonly partition: string;
  readonly a: Node;
  readonly b: Node;
  readonly aOrigin: string;
  readonly bOrigin: string;
}

async function withTeam(fn: (team: Team) => Promise<void>): Promise<void> {
  // under /tmp: macOS TMPDIR is too long for the sidecar's socket path
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-f43-" }),
  );
  const datastorePath = join(root, "ds");
  const privateRoot = join(root, "priv");
  const replica = JSON.stringify({ type: "file", path: join(root, "replica") });
  await withMockedEnv(
    { [V3_REPLICA_ENV]: replica },
    () => initializeV3Datastore(datastorePath, "test"),
  );
  const modelType = ModelType.create(
    `test/fenced-leader-${crypto.randomUUID().slice(0, 8)}`,
  );
  const workers: Worker[] = [];
  const nodes: Node[] = [];
  const pids = new Set<number>();
  const node = async (name: string): Promise<Node> => {
    const worker = new Worker(
      new URL("./serve_v3_team_fenced_leader_node_worker.ts", import.meta.url),
      { type: "module" },
    );
    workers.push(worker);
    let queue: Promise<unknown> = Promise.resolve();
    let dead: Error | undefined;
    const call = (request: FencedNodeRequest) => {
      if (dead !== undefined) return Promise.reject(dead);
      const limit = REQUEST_TIMEOUT_MS +
        (request.kind === "pause" ? request.ms : 0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      return new Promise<unknown>((done, fail) => {
        timer = setTimeout(() => {
          dead = new Error(
            `node-${name}: ${request.kind} did not answer within ${limit}ms`,
          );
          worker.terminate();
          fail(dead);
        }, limit);
        worker.onmessage = (event: MessageEvent<FencedNodeResponse>) => {
          const response = event.data;
          if (response.ok) done(response.value);
          else fail(new Error(`node-${name}: ${response.error}`));
        };
        worker.onerror = (event) => {
          event.preventDefault();
          fail(new Error(event.message));
        };
        worker.postMessage(request);
      }).finally(() => clearTimeout(timer));
    };
    const send = (request: FencedNodeRequest) => {
      const next = queue.then(() => call(request));
      queue = next.catch(() => {});
      return next;
    };
    await send({
      kind: "init",
      hostname: `node-${name}`,
      replica,
      privateRoot,
      datastorePath,
      repoDir: join(root, name),
      modelType: modelType.normalized,
      tokens: TOKENS,
    });
    const created: Node = {
      name,
      send,
      state: () => send({ kind: "state" }) as Promise<FencedNodeState>,
    };
    nodes.push(created);
    return created;
  };
  try {
    const a = await node("a");
    const lead = await a.send({ kind: "open", ttlMs: LEASE_TTL_MS }) as Opened;
    assertEquals(lead.role, "writer");
    const modelId = await a.send({ kind: "saveModel", name: "vpc" }) as string;
    await a.send({ kind: "materialize", admins: [ALICE] });
    // a follower restores its copy from what the replica holds
    await a.send({ kind: "confirm" });
    const b = await node("b");
    const follow = await b.send({ kind: "open" }) as Opened;
    assertEquals(follow.role, "follower");
    await fn({
      root,
      modelType,
      modelId,
      partition: partitionOf({ kind: "model", type: modelType, id: modelId })
        .toString(),
      a,
      b,
      aOrigin: lead.origin,
      bOrigin: follow.origin,
    });
  } finally {
    for (const each of [...nodes].reverse()) {
      for (
        const pid of await each.send({ kind: "pids" }).catch(
          () => [],
        ) as number[]
      ) {
        pids.add(pid);
      }
      await each.send({ kind: "close" }).catch(() => {});
    }
    for (const worker of workers) worker.terminate();
    for (const pid of pids) killSidecarAtTeardown(pid);
    await waitFor(
      () => [...pids].every((pid) => !hostLitestreamProcesses.isAlive(pid)),
      "every sidecar to stop",
    );
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

interface Sent {
  readonly txnId: string;
  readonly reply: Promise<Reply>;
}

/** what a member's command sends to land one data version */
function commitThrough(
  team: Team,
  origin: string,
  version: number,
  expectedSeq: number,
): Sent {
  const txnId = crypto.randomUUID();
  const reply = (async () => {
    const content = new TextEncoder().encode(
      `vpc version ${version} ${crypto.randomUUID()}`,
    );
    const body = commitBody({
      expectedSeq,
      txnId,
      ops: await blobSaveOps(
        { modelType: team.modelType, model: { id: team.modelId } },
        "vpc",
        version,
        content,
      ),
      chunks: [{ sha256: await sha256Hex(content), size: content.length }],
    }, [content]);
    return await post(
      `${origin}/api/v1/datastore/_default/partitions/${
        encodeURIComponent(team.partition)
      }/commits`,
      "alice-token",
      body,
    );
  })();
  return { txnId, reply };
}

/** the error class and code a member's client maps a refused reply to */
function clientError(reply: Reply, origin: string): string {
  const error = serveErrorFromReply(reply.status, reply.json, origin);
  return `${error.name}:${(error as { code?: string }).code ?? ""}`;
}

async function storedAt(
  node: Node,
  team: Team,
  seq: number,
): Promise<StoredCommit | undefined> {
  const at = await node.send({
    kind: "partitionAt",
    partition: team.partition,
    seq,
  }) as { head: number; commit?: StoredCommit };
  return at.commit;
}

function member(origin: string): ServeDatastoreClient {
  // one attempt, so what is recorded is this node's own answer
  return new ServeDatastoreClient({
    baseUrl: origin,
    token: "alice-token",
    maxAttempts: 1,
    readRefusalBudgetMs: 0,
  });
}

/** the seqs and txnIds a member reads of the partition, or the refusal */
async function partitionRead(
  origin: string,
  team: Team,
): Promise<{ seq: number; txnId: string }[] | string> {
  const client = member(origin);
  try {
    const page = await client.partitionCommits(
      partitionOf({
        kind: "model",
        type: team.modelType,
        id: team.modelId,
      }),
      0,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
    return page.commits.map((raw) => {
      const commit = raw as { seq: number; txnId: string };
      return { seq: commit.seq, txnId: commit.txnId };
    });
  } catch (error) {
    return refusalOf(error);
  } finally {
    client.close();
  }
}

/** the txnIds a member reads of the partition through GET changes */
async function changesRead(
  origin: string,
  team: Team,
): Promise<string[] | string> {
  const client = member(origin);
  try {
    const page = await client.changes(
      0,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
    return page.changes.map((change) =>
      change.commit as { partition: string; txnId: string }
    ).filter((commit) => commit.partition === team.partition).map((commit) =>
      commit.txnId
    );
  } catch (error) {
    return refusalOf(error);
  } finally {
    client.close();
  }
}

/** serve's verdict on a member copy whose feed follows `held` */
async function anchorAt(
  origin: string,
  team: Team,
  held: StoredCommit,
): Promise<AnchorVerdict | string> {
  const client = member(origin);
  try {
    const page = await client.changes(
      0,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      1,
      {
        namespace: held.namespace,
        partition: team.partition,
        seq: held.seq,
        txnId: held.txnId,
      },
    );
    return page.anchor ?? "no verdict";
  } catch (error) {
    return refusalOf(error);
  } finally {
    client.close();
  }
}

function refusalOf(error: unknown): string {
  return `${(error as Error).name}:${
    (error as { code?: string }).code ?? (error as Error).message
  }`;
}

interface FeedRead {
  /** commits.head's cursor, or the code it was refused with */
  readonly head: unknown;
  /** the partition's txnIds the first commits.subscribe page sent */
  readonly sent: string[] | string;
  readonly page?: { readonly changes: ChangeEntry[]; readonly cursor: number };
}

/** what the node's commit feed sends a member from cursor 0 */
async function feedRead(node: Node, team: Team): Promise<FeedRead> {
  const headFrames = await node.send({
    kind: "feedHead",
    principal: ALICE,
  }) as Frame[];
  const head = headFrames[0]?.type === "error"
    ? headFrames[0].error?.code
    : headFrames[0]?.payload?.cursor;
  const frames = await node.send({
    kind: "feedSubscribe",
    principal: ALICE,
    cursor: 0,
  }) as Frame[];
  const first = frames[0];
  if (first === undefined) return { head, sent: "no frame" };
  if (first.type === "error") {
    return { head, sent: first.error?.code ?? "error" };
  }
  const changes = (first.payload?.changes ?? []) as {
    cursor: number;
    commit: { partition: string; txnId: string };
  }[];
  return {
    head,
    sent: changes.filter((change) => change.commit.partition === team.partition)
      .map((change) => change.commit.txnId),
    page: { changes, cursor: first.payload?.cursor as number },
  };
}

/** stalls the leader past its lease while the follower takes the lead */
async function takeOverDuringStall(
  team: Team,
  release?: string,
): Promise<void> {
  const before = (await team.a.state()).fence!;
  const stalled = team.a.send({
    kind: "pause",
    ms: STALL_MS,
    ...(release !== undefined ? { release } : {}),
  });
  await waitFor(
    async () => {
      await team.b.send({ kind: "tick" });
      return (await team.b.state()).role === "leader";
    },
    "the follower to take the lead",
    { timeoutMs: 40_000 },
  );
  await stalled;
  const after = await team.b.state();
  assert(after.fence! > before, `fence ${after.fence} after ${before}`);
}

/** the old leader's renewal has seen the higher fence */
async function oldLeaderSeesLoss(team: Team): Promise<void> {
  await waitFor(
    async () => !(await team.a.state()).holdsCurrentLease,
    "the old leader's renewal to find its lease lost",
    { timeoutMs: 30_000 },
  );
}

async function oldLeaderStops(team: Team): Promise<void> {
  await waitFor(
    async () => {
      await team.a.send({ kind: "tick" });
      return (await team.a.state()).events.includes("lost");
    },
    "the old leader to notice it lost the lead",
    { timeoutMs: 30_000 },
  );
}

/** a member copy fed the old leader's feed page, then caught up by ServeCatchUp */
async function memberCopy(
  team: Team,
  fed: FeedRead,
  catchUpFrom: readonly string[],
): Promise<{ held?: string; caughtUp: string[] }> {
  const dir = join(team.root, `member-${crypto.randomUUID().slice(0, 8)}`);
  await Deno.mkdir(dir);
  const store = SqliteCommitStore.open(join(dir, "commits.db"), {
    follower: true,
  });
  const state = ServeUpstreamState.open(join(dir, SERVE_UPSTREAM_STATE_FILE));
  const through = (origin: string) =>
    new ServeCatchUp({
      client: member(origin),
      commitStore: store,
      state,
      copyDir: dir,
      namespace: "",
      lockCopy: () => Promise.resolve(() => Promise.resolve()),
    });
  try {
    const page = fed.page;
    if (page !== undefined) {
      const catchUp = through(team.aOrigin);
      await catchUp.catchUp(AbortSignal.timeout(REQUEST_TIMEOUT_MS), {
        requested: catchUp.request(),
        page: { changes: page.changes, cursor: page.cursor, more: false },
      });
    }
    const caughtUp: string[] = [];
    for (const origin of catchUpFrom) {
      try {
        await through(origin).catchUp(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
        caughtUp.push("caught-up");
      } catch (error) {
        caughtUp.push(
          error instanceof ServeUpstreamDivergedError
            ? `${error.code}:${error.divergence.kind}`
            : refusalOf(error),
        );
      }
    }
    const [change] = await store.readPartition(
      "",
      partitionOf({ kind: "model", type: team.modelType, id: team.modelId }),
      2,
      1,
    );
    return {
      ...(change?.commit.seq === 2 ? { held: change.commit.txnId } : {}),
      caughtUp,
    };
  } finally {
    state.close();
    await store.close();
  }
}

type InFlight = {
  /** the commit stage the member's commit is held at */
  readonly stage: "append" | "confirm_replicated";
  /** released in the turn the leader resumes, or once it saw the loss */
  readonly release: "at-resume" | "after-loss";
};

interface Reads {
  readonly partition: { seq: number; txnId: string }[] | string;
  readonly changes: string[] | string;
  readonly feed: FeedRead;
}

interface Observed {
  readonly first: Reply;
  readonly firstTxn: string;
  readonly reply?: Reply;
  readonly replyError?: string;
  readonly sentTxn?: string;
  /** the old leader while the commit was held, before the stall */
  readonly heldState?: FencedNodeState;
  readonly aAt2?: StoredCommit;
  readonly bAt1?: StoredCommit;
  /** the new leader's seq 2 straight after its takeover */
  readonly bAt2Restored?: StoredCommit;
  /** a commit through the old leader once it resumed */
  readonly lateAtA: Reply;
  readonly lateAtAError: string;
  readonly aAt2AfterLate?: StoredCommit;
  /** the old leader once its renewal saw the higher fence, before its tick */
  readonly lostState: FencedNodeState;
  readonly lostReads: Reads;
  /** the new leader's own commit at seq 2 */
  readonly atB: Reply;
  readonly bAt2: StoredCommit;
  /** a member copy fed by the old leader's feed, caught up from b then a */
  readonly copy: { held?: string; caughtUp: string[] };
  readonly anchorAtB?: AnchorVerdict | string;
  readonly stoppedState: FencedNodeState;
  readonly stoppedReads: Reads;
}

async function reads(team: Team): Promise<Reads> {
  return {
    partition: await partitionRead(team.aOrigin, team),
    changes: await changesRead(team.aOrigin, team),
    feed: await feedRead(team.a, team),
  };
}

/** a stalls past its lease and b takes over, with `inFlight` held inside a */
async function failover(inFlight?: InFlight): Promise<Observed> {
  let observed: Observed | undefined;
  await withTeam(async (team) => {
    const firstSent = commitThrough(team, team.aOrigin, 1, 0);
    const first = await firstSent.reply;
    let sent: Sent | undefined;
    let heldState: FencedNodeState | undefined;
    if (inFlight !== undefined) {
      await team.a.send({ kind: "hold", stage: inFlight.stage });
      sent = commitThrough(team, team.aOrigin, 2, 1);
      await waitFor(
        async () =>
          await team.a.send({ kind: "held", stage: inFlight.stage }) === true,
        `the member's commit to reach ${inFlight.stage}`,
      );
      heldState = await team.a.state();
    }
    await takeOverDuringStall(
      team,
      inFlight?.release === "at-resume" ? inFlight.stage : undefined,
    );
    const bAt2Restored = await storedAt(team.b, team, 2);
    if (inFlight?.release === "after-loss") {
      await oldLeaderSeesLoss(team);
      await team.a.send({ kind: "release", stage: inFlight.stage });
    }
    const reply = await sent?.reply;
    const late = await commitThrough(team, team.aOrigin, 3, 1).reply;
    await oldLeaderSeesLoss(team);
    const lostState = await team.a.state();
    const lostReads = await reads(team);
    const aAt2 = await storedAt(team.a, team, 2);
    const atB = await commitThrough(team, team.bOrigin, 2, 1).reply;
    const bAt2 = (await storedAt(team.b, team, 2))!;
    const copy = await memberCopy(team, lostReads.feed, [
      team.bOrigin,
      team.aOrigin,
    ]);
    const anchorAtB = aAt2 === undefined
      ? undefined
      : await anchorAt(team.bOrigin, team, aAt2);
    await oldLeaderStops(team);
    observed = {
      first,
      firstTxn: firstSent.txnId,
      ...(reply !== undefined
        ? {
          reply,
          ...(reply.status === 200
            ? {}
            : { replyError: clientError(reply, team.aOrigin) }),
        }
        : {}),
      ...(sent !== undefined ? { sentTxn: sent.txnId } : {}),
      ...(heldState !== undefined ? { heldState } : {}),
      ...(aAt2 !== undefined ? { aAt2 } : {}),
      bAt1: await storedAt(team.b, team, 1),
      ...(bAt2Restored !== undefined ? { bAt2Restored } : {}),
      lateAtA: late,
      lateAtAError: clientError(late, team.aOrigin),
      lostState,
      lostReads,
      atB,
      bAt2,
      copy,
      ...(anchorAtB !== undefined ? { anchorAtB } : {}),
      stoppedState: await team.a.state(),
      stoppedReads: await reads(team),
    };
  });
  return observed!;
}

const NOT_LEADER = "ServeNotLeaderError:serve_not_leader";

/** what the unconfirmed-leader gate already covers, whatever the in-flight commit did */
function assertOldLeaderGated(observed: Observed): void {
  assertEquals(
    [observed.lateAtA.status, observed.lateAtA.json.code],
    [503, "serve_not_leader"],
  );
  assertEquals(observed.lateAtAError, NOT_LEADER);
  assertEquals(observed.lostState.role, "leader");
  assertEquals(observed.lostState.leadUnconfirmed, true);
  assertEquals(observed.lostState.holdsCurrentLease, false);
  assert(
    observed.lostState.currentFence! > observed.lostState.fence!,
    JSON.stringify(observed.lostState),
  );
  assertEquals(observed.lostReads.partition, NOT_LEADER);
  assertEquals(observed.lostReads.changes, NOT_LEADER);
  assertEquals(observed.lostReads.feed.head, "serve_not_leader");
  assertEquals(observed.lostReads.feed.sent, "serve_not_leader");
  assertEquals(observed.stoppedState.role, "follower");
  assertEquals(observed.stoppedState.events, ["lead", "lost"]);
  assertEquals(observed.stoppedReads.partition, NOT_LEADER);
  assertEquals(observed.stoppedReads.changes, NOT_LEADER);
  assertEquals(observed.stoppedReads.feed.head, "serve_not_leader");
  assertEquals(observed.stoppedReads.feed.sent, "serve_not_leader");
  assertEquals(
    observed.copy.caughtUp[1],
    NOT_LEADER,
    "a member catching up from the old leader",
  );
  // the new leader holds what was confirmed before the stall, and leads on
  assertEquals(observed.first.status, 200);
  assertEquals(observed.bAt1?.txnId, observed.firstTxn);
  assertEquals([observed.atB.status, observed.atB.json.seq], [200, 2]);
  assertEquals(observed.bAt2.fence, observed.lostState.currentFence);
}

/** an in-flight commit the old leader appended once it was taken over */
function assertNoOrphanAppend(observed: Observed, reply: string): void {
  assertEquals(observed.aAt2, undefined, "the old leader appended seq 2");
  assertEquals(observed.replyError, reply);
}

/** a leader that may have been taken over feeds nothing */
function assertFeedReplicatedOnly(observed: Observed): void {
  assertEquals(observed.lostReads.feed.sent, "serve_not_leader");
  assertEquals(observed.copy.held, observed.bAt2.txnId);
}

/** a member copy that took the old leader's commit converges on the new leader */
function assertCopyRepaired(observed: Observed): void {
  assertEquals(observed.copy.caughtUp[0], "caught-up");
  assertEquals(observed.copy.held, observed.bAt2.txnId);
}

const sidecar = {
  ignore: SIDECAR_TESTS_IGNORED,
  sanitizeOps: false,
  sanitizeResources: false,
};

Deno.test({
  ...sidecar,
  name:
    "serve team failover (F43): a member commit confirmed before the leader stalls is at the new leader, and the resumed old leader takes no commit, answers no read and, once stopped, serves no feed (swamp-club#4581)",
  fn: async () => {
    const observed = await failover();
    assertOldLeaderGated(observed);
    // confirmed replicated before the stall, so the feed agrees with the new leader
    assertEquals(observed.first.json.seq, 1);
    assertEquals(observed.copy.caughtUp[0], "caught-up");
    assertEquals(observed.copy.held, observed.bAt2.txnId);
  },
});

Deno.test({
  ...sidecar,
  name:
    "serve team failover (F43): a member commit held before its append, released once the old leader's renewal saw the higher fence, is refused as fenced and lands nowhere (swamp-club#4581)",
  fn: async () => {
    const observed = await failover({ stage: "append", release: "after-loss" });
    assertOldLeaderGated(observed);
    assertEquals(observed.heldState?.holdsCurrentLease, true);
    assertEquals(
      [observed.reply?.status, observed.reply?.json.code],
      [409, "datastore_v3_writer_fenced"],
    );
    assertNoOrphanAppend(
      observed,
      "ServeUpstreamError:datastore_v3_writer_fenced",
    );
    assertEquals(observed.bAt2Restored, undefined);
    assertFeedReplicatedOnly(observed);
    assertCopyRepaired(observed);
  },
});

Deno.test({
  ...sidecar,
  name:
    "serve team failover (F43): a member commit held before its append and released as the old leader resumes leaves the old leader gated for reads and new commits (swamp-club#4581)",
  fn: async () => {
    const observed = await failover({ stage: "append", release: "at-resume" });
    assertOldLeaderGated(observed);
    assertEquals(observed.heldState?.holdsCurrentLease, true);
    assertEquals(observed.bAt2Restored, undefined);
  },
});

Deno.test({
  ...sidecar,
  name:
    "serve team failover (F43): a member commit released as the old leader resumes is not appended at the old fence (swamp-club#4581, step 2)",
  fn: async () => {
    assertNoOrphanAppend(
      await failover({ stage: "append", release: "at-resume" }),
      "ServeNotLeaderError:serve_not_leader",
    );
  },
});

Deno.test({
  ...sidecar,
  name:
    "serve team failover (F43): the old leader's feed never sends a commit appended as it resumed (swamp-club#4581, step 3)",
  fn: async () => {
    assertFeedReplicatedOnly(
      await failover({ stage: "append", release: "at-resume" }),
    );
  },
});

Deno.test({
  ...sidecar,
  name:
    "serve team failover (F43): a member copy fed the commit appended as the old leader resumed converges on the new leader (swamp-club#4581, step 5)",
  fn: async () => {
    assertCopyRepaired(
      await failover({ stage: "append", release: "at-resume" }),
    );
  },
});

Deno.test({
  ...sidecar,
  name:
    "serve team failover (F43): a member commit appended before the stall and not yet replicated is kept from the feed while the leader holds its lease, missing from the new leader, and the resumed old leader stays gated for reads and new commits (swamp-club#4581)",
  fn: async () => {
    const observed = await failover({
      stage: "confirm_replicated",
      release: "after-loss",
    });
    assertOldLeaderGated(observed);
    assertEquals(observed.heldState?.holdsCurrentLease, true);
    assertEquals(observed.aAt2?.txnId, observed.sentTxn);
    assertEquals(observed.aAt2?.fence, observed.lostState.fence);
    // the feed's published bound holds while the lease does
    assertEquals(
      observed.heldState?.feedBound,
      observed.heldState!.head - 1,
    );
    assertEquals(observed.bAt2Restored, undefined);
    assertNotEquals(observed.bAt2.txnId, observed.sentTxn);
    assertEquals(
      [
        observed.reply?.status,
        observed.reply?.json.code,
        observed.reply?.json.seq,
      ],
      [503, "datastore_v3_writer_fenced", 2],
    );
  },
});

Deno.test({
  ...sidecar,
  name:
    "serve team failover (F43): the old leader's feed never sends a commit appended before the stall that the new leader never had (swamp-club#4581, step 3)",
  fn: async () => {
    assertFeedReplicatedOnly(
      await failover({ stage: "confirm_replicated", release: "after-loss" }),
    );
  },
});

Deno.test({
  ...sidecar,
  name:
    "serve team failover (F43): a member copy fed the commit the new leader never had converges on the new leader (swamp-club#4581, step 5)",
  fn: async () => {
    assertCopyRepaired(
      await failover({ stage: "confirm_replicated", release: "after-loss" }),
    );
  },
});

const MEMBER_DATA_ID = "6a1f3c2e-8b4d-4e7f-9a0b-1c2d3e4f5a6b";

type Outcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

async function outcomeOf(work: Promise<unknown>): Promise<Outcome> {
  try {
    await work;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: refusalOf(error) };
  }
}

interface MemberFiles {
  readonly commitsDb: string;
  readonly outbox: string;
}

/** the member's serve-mode copy, under its checkout's local copies */
async function memberFiles(client: Client): Promise<MemberFiles> {
  const found: string[] = [];
  for await (const entry of walk(client.repoDir, { includeDirs: false })) {
    if (basename(entry.path) === COMMITS_DB_FILE) found.push(entry.path);
  }
  assertEquals(found.length, 1, JSON.stringify(found));
  return {
    commitsDb: found[0],
    outbox: join(found[0], "..", COMMIT_OUTBOX_FILE),
  };
}

async function outboxTxns(files: MemberFiles): Promise<string[]> {
  const outbox = new SqliteCommitOutbox(files.outbox);
  try {
    const listing = await outbox.entries();
    return [
      ...listing.entries.map((entry) => entry.commit.txnId),
      ...listing.unreadable.map(({ key }) => key.txnId),
    ];
  } finally {
    await outbox.close();
  }
}

interface CopyRow {
  readonly seq: number;
  readonly txnId: string;
  readonly fence?: number;
}

async function copyRows(files: MemberFiles, team: Team): Promise<CopyRow[]> {
  const store = SqliteCommitStore.open(files.commitsDb, { follower: true });
  try {
    const changes = await store.readPartition(
      "",
      partitionOf({ kind: "model", type: team.modelType, id: team.modelId }),
      1,
      100,
    );
    return changes.map(({ commit }) => ({
      seq: commit.seq,
      txnId: commit.txnId,
      ...(commit.fence !== undefined ? { fence: commit.fence } : {}),
    }));
  } finally {
    await store.close();
  }
}

/** a commit POST the proxy forwarded, with the node that answered */
interface ProxiedCommit {
  readonly to: "a" | "b";
  readonly status: number;
  readonly code?: string;
  readonly seq?: number;
  readonly txnId?: string;
  /** the error the member's client maps a refusal to */
  readonly error?: string;
}

interface MemberObserved {
  readonly aFence: number;
  readonly first: Outcome;
  readonly mayLandTxn: string;
  readonly mayLand: Outcome;
  readonly copyAfterMayLand: CopyRow[];
  readonly outboxAfterMayLand: string[];
  readonly settle: Outcome;
  readonly further: Outcome;
  readonly outboxAfterFurther: string[];
  readonly bRows: { seq: number; txnId: string }[] | string;
  readonly bAt2?: StoredCommit;
  readonly copyRows: CopyRow[];
  readonly anchorAtB: AnchorVerdict | string;
  readonly commits: ProxiedCommit[];
  readonly warnings: string[];
}

/**
 * a member checkout writes through a proxy that follows the leader, as a load
 * balancer would; its second save is held at confirm_replicated on a, b takes
 * over, and a's fenced reply reaches the member's real commit sink
 */
async function memberMayLand(): Promise<MemberObserved> {
  let observed: MemberObserved | undefined;
  await withTeam(async (team) => {
    // the member's repositories resolve the type in this thread
    modelRegistry.register({
      type: team.modelType,
      version: "2026.01.01.1",
      methods: {
        noop: {
          description: "does nothing",
          kind: "read",
          arguments: z.object({}),
          execute: () => Promise.resolve({}),
        },
      },
    });
    let upstream = team.aOrigin;
    const commits: ProxiedCommit[] = [];
    const proxy = startProxy(() => upstream, async (request, forward) => {
      const to = upstream === team.aOrigin ? "a" : "b";
      const response = await forward();
      if (
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/commits")
      ) {
        const body = await response.clone().json() as Record<
          string,
          unknown
        >;
        const commit = body.commit as { txnId?: string } | undefined;
        commits.push({
          to,
          status: response.status,
          ...(typeof body.code === "string" ? { code: body.code } : {}),
          ...(typeof body.seq === "number" ? { seq: body.seq } : {}),
          ...(commit?.txnId !== undefined ? { txnId: commit.txnId } : {}),
          ...(response.status !== 200
            ? {
              error: clientError(
                { status: response.status, json: body },
                proxy.origin,
              ),
            }
            : {}),
        });
      }
      return response;
    });
    try {
      await withScratch(async (scratch: Scratch) => {
        const member = await scratch.client("member");
        const env = serveEnv(proxy, "alice-token");
        const save = (version: number) =>
          writeCommand(
            scratch,
            member,
            env,
            (repos) =>
              repos.unifiedDataRepo.save(
                team.modelType,
                team.modelId,
                dataOf("vpc", MEMBER_DATA_ID),
                json({ version }),
              ),
          );
        let partial: Omit<MemberObserved, "warnings"> | undefined;
        const logs = await captureLogs(async () => {
          const first = await outcomeOf(save(1));
          const aFence = (await team.a.state()).fence!;
          await team.a.send({ kind: "hold", stage: "confirm_replicated" });
          const held = outcomeOf(save(2));
          await waitFor(
            async () =>
              await team.a.send({
                kind: "held",
                stage: "confirm_replicated",
              }) === true,
            "the member's commit to reach confirm_replicated",
          );
          const mayLandTxn = (await storedAt(team.a, team, 2))!.txnId;
          await takeOverDuringStall(team);
          upstream = team.bOrigin;
          await oldLeaderSeesLoss(team);
          await team.a.send({ kind: "release", stage: "confirm_replicated" });
          const mayLand = await held;
          const files = await memberFiles(member);
          const copyAfterMayLand = await copyRows(files, team);
          const outboxAfterMayLand = await outboxTxns(files);
          const settle = await outcomeOf(
            writeCommand(scratch, member, env, () => Promise.resolve()),
          );
          const further = await outcomeOf(save(3));
          const rows = await copyRows(files, team);
          const at2 = rows.find((row) => row.seq === 2);
          const bAt2 = await storedAt(team.b, team, 2);
          partial = {
            aFence,
            first,
            mayLandTxn,
            mayLand,
            copyAfterMayLand,
            outboxAfterMayLand,
            settle,
            further,
            outboxAfterFurther: await outboxTxns(files),
            bRows: await partitionRead(team.bOrigin, team),
            ...(bAt2 !== undefined ? { bAt2 } : {}),
            copyRows: rows,
            anchorAtB: at2 === undefined
              ? "the copy holds no seq 2"
              : await anchorAt(team.bOrigin, team, {
                seq: at2.seq,
                txnId: at2.txnId,
                namespace: "",
              }),
            commits: [...commits],
          };
        });
        observed = {
          ...partial!,
          warnings: logs.filter((log) =>
            log.level === "warning" || log.level === "error"
          ).map((log) => `${log.category}: ${log.text}`),
        };
      });
    } finally {
      await proxy.close();
      modelRegistry.invalidateType(team.modelType);
    }
  });
  return observed!;
}

Deno.test({
  ...sidecar,
  name:
    "serve team failover (F43): a member checkout's save that the old leader answers as may-land lands exactly once at the new leader through the real commit sink, and the member's copy matches the new leader (swamp-club#4581, step 4)",
  fn: async () => {
    const observed = await memberMayLand();
    const report = JSON.stringify(observed, null, 2);
    assertEquals(observed.first, { ok: true }, report);
    // the fenced old leader answered the held commit with a seq, which the
    // member's client maps to may-land
    assertEquals(
      observed.commits.filter((commit) => commit.to === "a").at(-1),
      {
        to: "a",
        status: 503,
        code: "datastore_v3_writer_fenced",
        seq: 2,
        error: "ServeCommitMayLandError:datastore_v3_commit_may_land",
      },
      report,
    );
    // the save's own command lands it at the new leader under the same txnId
    assertEquals(observed.mayLand, { ok: true }, report);
    assertEquals(
      observed.commits.filter((commit) => commit.txnId === observed.mayLandTxn),
      [{ to: "b", status: 200, seq: 2, txnId: observed.mayLandTxn }],
      report,
    );
    // never the old leader's stamping, which the 503 reply carried no copy of
    assert(observed.bAt2 !== undefined, report);
    assertEquals(observed.bAt2.txnId, observed.mayLandTxn, report);
    assert(observed.bAt2.fence! > observed.aFence, report);
    assertEquals(
      observed.copyAfterMayLand.find((row) => row.seq === 2),
      { seq: 2, txnId: observed.mayLandTxn, fence: observed.bAt2.fence },
      report,
    );
    assertEquals(observed.outboxAfterMayLand, [], report);
    // further commands land nothing again
    assertEquals(observed.settle, { ok: true }, report);
    assertEquals(observed.further, { ok: true }, report);
    assertEquals(observed.outboxAfterFurther, [], report);
    assert(typeof observed.bRows !== "string", report);
    assertEquals(
      observed.bRows.filter((row) => row.txnId === observed.mayLandTxn),
      [{ seq: 2, txnId: observed.mayLandTxn }],
      report,
    );
    assertEquals(observed.bRows.map((row) => row.seq), [1, 2, 3], report);
    // the copy is b's partition, seq for seq
    assertEquals(
      observed.copyRows.map(({ seq, txnId }) => ({ seq, txnId })),
      observed.bRows,
      report,
    );
    assertEquals(observed.anchorAtB, { verdict: "held" }, report);
    assertEquals(
      observed.warnings.filter((warning) =>
        /serve_upstream_diverged|no longer holds the commits/.test(warning)
      ),
      [],
      report,
    );
  },
});
