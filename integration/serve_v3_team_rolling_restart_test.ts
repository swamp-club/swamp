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
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  v3ServeControlPlaneAt,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  type PendingRunOwner,
  RunTrackerStore,
} from "../src/infrastructure/persistence/run_tracker_store.ts";
import { processHostIdentity } from "../src/infrastructure/runtime/process.ts";
import { replayPendingRuns } from "../src/serve/boot_reconciliation.ts";
import { InstanceHeartbeatService } from "../src/serve/instance_heartbeat.ts";
import { pendingOwnerLiveness } from "../src/serve/pending_run_owner.ts";
import {
  parseWebhookFlag,
  RUN_ID_HEADER,
  WebhookService,
} from "../src/serve/webhook.ts";
import { hmacSha256Hex } from "../src/serve/webhook_verifiers.ts";
import type {
  TeamNodeRequest,
  TeamNodeResponse,
  TeamNodeState,
} from "./serve_v3_team_machine_worker.ts";
import { startLoadedWorker } from "./graph_worker.ts";

await initializeLogging({});

/** only the fast cadence a departing leader starts can promote a follower */
const TICK_MS = 3_600_000;

/** bounds a worker that never answers, instead of hanging the run */
const REQUEST_TIMEOUT_MS = 60_000;

/** a handover on the 1 s cadence, with room for a loaded machine */
const HANDOVER_TIMEOUT_MS = 30_000;

interface Node {
  readonly name: string;
  readonly instanceId: string;
  send(request: TeamNodeRequest): Promise<unknown>;
  state(): Promise<TeamNodeState>;
  /** serve's graceful stop: its feed sockets, leadership, datastore and lease */
  close(): Promise<void>;
}

interface Team {
  /** each start of a name is a new serve process on that host */
  start(
    name: string,
    options?: { readonly steppingDown?: boolean },
  ): Promise<Node>;
  /** the nodes not yet closed */
  live(): readonly Node[];
}

async function withTeam(fn: (team: Team) => Promise<void>): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-team-roll-" }),
  );
  const datastorePath = join(root, "ds");
  await initializeV3Datastore(datastorePath, "test");
  const workers: Worker[] = [];
  const running = new Set<Node>();
  const starts = new Map<string, number>();
  try {
    await fn({
      async start(name, options = {}) {
        const run = (starts.get(name) ?? 0) + 1;
        starts.set(name, run);
        let pending:
          | { done(value: unknown): void; fail(error: Error): void }
          | undefined;
        const worker = await startLoadedWorker<TeamNodeResponse>(
          new URL("./serve_v3_team_machine_worker.ts", import.meta.url),
          {
            loadTimeoutMs: 20_000,
            attempts: 3,
            onMessage: (response) => {
              if (response.ok) pending?.done(response.value);
              else {
                pending?.fail(
                  new Error(
                    `node-${name}: ${response.code}: ${response.error}`,
                  ),
                );
              }
            },
            onError: (event) => {
              event.preventDefault();
              pending?.fail(new Error(event.message));
            },
          },
        );
        workers.push(worker);
        let queue: Promise<unknown> = Promise.resolve();
        let dead: Error | undefined;
        const call = (request: TeamNodeRequest) => {
          if (dead !== undefined) return Promise.reject(dead);
          let timer: ReturnType<typeof setTimeout> | undefined;
          return new Promise<unknown>((done, fail) => {
            timer = setTimeout(() => {
              dead = new Error(
                `node-${name}: ${request.kind} did not answer within ${REQUEST_TIMEOUT_MS}ms`,
              );
              worker.terminate();
              fail(dead);
            }, REQUEST_TIMEOUT_MS);
            pending = { done, fail };
            worker.postMessage(request);
          }).finally(() => clearTimeout(timer));
        };
        const send = (request: TeamNodeRequest) => {
          const next = queue.then(() => call(request));
          queue = next.catch(() => {});
          return next;
        };
        const instanceId = `instance-${name}-${run}-${
          crypto.randomUUID().slice(0, 8)
        }`;
        await send({
          kind: "init",
          hostname: `node-${name}`,
          datastorePath,
          repoDir: join(root, name),
          instanceId,
        });
        const node: Node = {
          name,
          instanceId,
          send,
          state: () => send({ kind: "state" }) as Promise<TeamNodeState>,
          close: async () => {
            running.delete(node);
            await send({ kind: "close" });
            worker.terminate();
          },
        };
        running.add(node);
        await send({
          kind: "start",
          tickMs: TICK_MS,
          feed: { steppingDown: options.steppingDown ?? true },
        });
        return node;
      },
      live: () => [...running],
    });
  } finally {
    for (const node of running) {
      await node.send({ kind: "close" }).catch(() => {});
    }
    for (const worker of workers) worker.terminate();
    await Deno.remove(root, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

async function leaders(team: Team): Promise<Node[]> {
  const leading: Node[] = [];
  for (const node of team.live()) {
    if ((await node.state()).role === "leader") leading.push(node);
  }
  return leading;
}

/** every follower's feed is open on the leader, so a frame can reach it */
async function followingLive(team: Team, leader: Node): Promise<void> {
  const fence = (await leader.state()).fence!;
  for (const node of team.live()) {
    if (node === leader) continue;
    await waitFor(
      async () => {
        const state = await node.state();
        return state.leader === leader.instanceId &&
          state.leaderFence === fence && state.feedLive === true;
      },
      `node-${node.name} to follow node-${leader.name}'s feed`,
      { timeoutMs: HANDOVER_TIMEOUT_MS },
    );
  }
}

/** one node leads at a fence above `above`, and every other names it */
async function handedOver(team: Team, above: number): Promise<Node> {
  let next: Node | undefined;
  await waitFor(
    async () => {
      const leading = await leaders(team);
      if (leading.length !== 1) return false;
      const fence = (await leading[0].state()).fence!;
      if (fence <= above) return false;
      for (const node of team.live()) {
        if (node === leading[0]) continue;
        const state = await node.state();
        if (
          state.role !== "follower" ||
          state.leader !== leading[0].instanceId || state.leaderFence !== fence
        ) return false;
      }
      next = leading[0];
      return true;
    },
    "a follower to lead at a higher fence, named by the others",
    { timeoutMs: HANDOVER_TIMEOUT_MS },
  );
  return next!;
}

/** what serve's shutdown does on a leader: tell the followers, then stop */
async function stepDown(
  team: Team,
  leader: Node,
  expectFrame: boolean,
): Promise<void> {
  const followers = team.live().filter((node) => node !== leader);
  await leader.send({ kind: "stepDown" });
  if (expectFrame) {
    for (const node of followers) {
      await waitFor(
        async () => {
          const state = await node.state();
          return state.awaitingNewLeader === true &&
            state.goings?.[0] === "frame";
        },
        `node-${node.name} to hear the leader is stepping down`,
        { timeoutMs: HANDOVER_TIMEOUT_MS },
      );
    }
  }
  await leader.close();
}

/** commits made through the leader, at every node and in the feed of each follower */
async function assertCommitsEverywhere(
  team: Team,
  leader: Node,
  made: readonly number[],
): Promise<void> {
  const head = await leader.send({ kind: "head" }) as number;
  for (const node of team.live()) {
    assertEquals(await node.send({ kind: "head" }), head, `node-${node.name}`);
    const cursors = new Set(await node.send({ kind: "cursors" }) as number[]);
    assertEquals(
      made.filter((cursor) => !cursors.has(cursor)),
      [],
      `commits missing at node-${node.name}`,
    );
    if (node === leader) continue;
    await waitFor(
      async () => ((await node.state()).feedApplied ?? 0) >= head,
      `node-${node.name}'s feed to apply the leader's head`,
      { timeoutMs: HANDOVER_TIMEOUT_MS },
    );
  }
}

async function commitThrough(leader: Node, made: number[]): Promise<void> {
  assertEquals(await leader.send({ kind: "commit" }), undefined);
  made.push(await leader.send({ kind: "head" }) as number);
}

Deno.test({
  name:
    "serve team rolling restart: a leader stepping down tells its followers, which try the lease on the fast cadence, so one leads once it lets go and the other names it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async (team) => {
      const a = await team.start("a");
      assertEquals((await a.state()).role, "leader");
      const b = await team.start("b");
      const c = await team.start("c");
      await followingLive(team, a);
      const before = (await a.state()).fence!;
      for (const node of [b, c]) {
        const state = await node.state();
        assertEquals(state.awaitingNewLeader, false);
        assertEquals(state.goings, []);
      }

      await stepDown(team, a, true);
      const next = await handedOver(team, before);

      // no tick was sent and the tick is an hour: the cadence took the lease
      const promoted = await next.state();
      assertEquals(promoted.events, ["lead"]);
      assert(promoted.takes! >= 2, `takes ${promoted.takes}`);
      const other = next === b ? c : b;
      const following = await other.state();
      assertEquals(following.role, "follower");
      assertEquals(following.leader, next.instanceId);
      assertEquals(following.leaderFence, promoted.fence);
      // the higher fence ended its wait: it is back on its tick
      assertEquals(following.awaitingNewLeader, false);
      assertEquals(following.goings?.[0], "frame");
      assertEquals(following.events, []);
      // it follows the new leader's feed
      await followingLive(team, next);
    });
  },
});

Deno.test({
  name:
    "serve team rolling restart: restarting each node in turn, the leader last, keeps one leader at every step and every commit at every node",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async (team) => {
      const made: number[] = [];
      let leader = await team.start("a");
      await team.start("b");
      await team.start("c");
      await followingLive(team, leader);
      await commitThrough(leader, made);
      await assertCommitsEverywhere(team, leader, made);

      for (const name of ["b", "c"]) {
        const node = team.live().find((each) => each.name === name)!;
        await node.close();
        await commitThrough(leader, made);
        const restarted = await team.start(name);
        assertEquals((await restarted.state()).role, "follower");
        assertEquals(
          (await leaders(team)).map((each) => each.instanceId),
          [leader.instanceId],
        );
        await followingLive(team, leader);
        await commitThrough(leader, made);
        await assertCommitsEverywhere(team, leader, made);
      }

      const before = (await leader.state()).fence!;
      await stepDown(team, leader, true);
      leader = await handedOver(team, before);
      assert(leader.name !== "a");
      await commitThrough(leader, made);
      const restarted = await team.start("a");
      assertEquals((await restarted.state()).role, "follower");
      assertEquals(
        (await leaders(team)).map((each) => each.instanceId),
        [leader.instanceId],
      );
      await followingLive(team, leader);
      await commitThrough(leader, made);
      await assertCommitsEverywhere(team, leader, made);
      assertEquals(made.length, 7);
      assertEquals(new Set(made).size, made.length);
    });
  },
});

Deno.test({
  name:
    "serve team rolling restart: a leader from before the stepping-down frame sends none, and its followers start the fast cadence when its feed socket closes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async (team) => {
      const a = await team.start("a", { steppingDown: false });
      const b = await team.start("b");
      const c = await team.start("c");
      await followingLive(team, a);
      const before = (await a.state()).fence!;

      await a.send({ kind: "stepDown" });
      // a commit after it reaches each follower's feed; a frame would come first
      const made: number[] = [];
      await commitThrough(a, made);
      await assertCommitsEverywhere(team, a, made);
      for (const node of [b, c]) {
        const state = await node.state();
        assertEquals(state.goings, []);
        assertEquals(state.awaitingNewLeader, false);
      }

      await a.close();
      const next = await handedOver(team, before);
      const other = next === b ? c : b;
      const following = await other.state();
      assertEquals(following.goings?.[0], "closed");
      assertEquals(following.leader, next.instanceId);
      assertEquals((await next.state()).goings?.[0], "closed");
    });
  },
});

const SECRET = "shhh";
const BODY = '{"event":"push"}';

async function delivery(): Promise<Request> {
  const signature = await hmacSha256Hex(new TextEncoder().encode(BODY), SECRET);
  return new Request("http://localhost/hooks/gh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body: BODY,
  });
}

Deno.test({
  name:
    "serve team rolling restart: a delivery a stopping leader queues is left to it while its heartbeat runs, then replayed once by the next leader",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-team-roll-hook-" });
    const datastorePath = join(dir, "ds");
    await initializeV3Datastore(datastorePath, "test");
    const store = v3ServeControlPlaneAt({
      type: "filesystem",
      path: datastorePath,
    });
    const oldTracker = new RunTrackerStore(join(dir, "old-runs.db"));
    const newTracker = new RunTrackerStore(join(dir, "new-runs.db"));
    const endpoint = await parseWebhookFlag(`/hooks/gh:deploy:${SECRET}`);
    const host = processHostIdentity();
    // a process on this host that is still exiting: its pid lives on
    const oldOwner: PendingRunOwner = {
      instanceId: `old-${crypto.randomUUID()}`,
      pid: Deno.ppid,
      host,
    };
    const newOwner: PendingRunOwner = {
      instanceId: `new-${crypto.randomUUID()}`,
      pid: Deno.pid,
      host,
    };
    const heartbeat = new InstanceHeartbeatService(store, oldOwner.instanceId, {
      intervalMs: TICK_MS,
    });
    let oldStarts = 0;
    const executed: unknown[] = [];
    const old = new WebhookService({
      repoDir: dir,
      syncGate: undefined,
      repoContext: {} as RepositoryContext,
      datastoreConfig: {} as DatastoreConfig,
      endpoints: [endpoint],
      runTracker: oldTracker,
      controlPlaneStore: store,
      shuttingDown: () => true,
      queuesForNextLeader: () => true,
      pendingRunOwner: oldOwner,
      executeWorkflow: () => {
        oldStarts++;
        return Promise.reject(new Error("a stopping leader starts nothing"));
      },
    });
    const next = new WebhookService({
      repoDir: dir,
      syncGate: undefined,
      repoContext: {} as RepositoryContext,
      datastoreConfig: {} as DatastoreConfig,
      endpoints: [endpoint],
      runTracker: newTracker,
      controlPlaneStore: store,
      pendingRunOwner: newOwner,
      executeWorkflow: (_dir, _context, _config, input) => {
        executed.push(input.webhook?.body);
        return Promise.resolve();
      },
    });
    try {
      await heartbeat.start();
      const reply = await old.handleRequest(await delivery());
      assertEquals(reply?.status, 200);
      const runId = reply!.headers.get(RUN_ID_HEADER);
      await reply?.body?.cancel();
      assert(runId !== null);
      assertEquals(await store.list("pending-runs/"), [
        `pending-runs/${runId}`,
      ]);
      assertEquals(oldTracker.findAllPendingRuns(), []);
      assertEquals(oldStarts, 0);

      const replayedRuns = new Set<string>();
      const replay = (deferred: Set<string>) =>
        replayPendingRuns({
          runTracker: newTracker,
          webhookService: next,
          controlPlaneStore: store,
          configuredWebhookWorkflows: new Set(["deploy"]),
          configuredWebhookRoutes: new Set(["/hooks/gh"]),
          configuredCronWorkflows: new Set(),
          ownerAlive: pendingOwnerLiveness({
            instanceId: newOwner.instanceId,
            controlPlaneStore: store,
            unjudgedOwner: "gone",
          }),
          deferred,
          claimAs: newOwner,
          replayedRuns,
        });

      const whileRunning = new Set<string>();
      assertEquals(await replay(whileRunning), 0);
      assertEquals([...whileRunning], [runId]);

      // the old process stopped its heartbeat on the way out; its pid lives on
      await heartbeat.stop({ leaveStoppedRecord: true });
      assertEquals(await replay(new Set()), 1);
      await waitFor(() => executed.length === 1, "the replayed run");
      assertEquals(executed, [JSON.parse(BODY)]);

      assertEquals(await replay(new Set()), 0);
      assertEquals(executed.length, 1);
      assertEquals(oldStarts, 0);
    } finally {
      await heartbeat.stop().catch(() => {});
      await old.stop();
      await next.stop();
      oldTracker.close();
      newTracker.close();
      await closeV3Datastores();
      await Deno.remove(dir, { recursive: true }).catch((error) => {
        if (Deno.build.os !== "windows") throw error;
      });
    }
  },
});
