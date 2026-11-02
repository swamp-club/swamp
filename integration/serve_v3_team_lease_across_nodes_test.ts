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
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import type { CommitJSON } from "../src/domain/datastore_v3/commit.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  acquireExplicitLease,
  type ExplicitLease,
} from "../src/infrastructure/datastore_v3/explicit_model_leases.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import { ServeDatastoreClient } from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import type { LeaderChange } from "../src/infrastructure/datastore_v3/serve_feed.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
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
import type {
  NodeRequest,
  NodeResponse,
  Opened,
} from "./serve_v3_team_bucket_node_worker.ts";

await initializeLogging({});

const TOKENS: Record<string, string> = {
  "alice-token": "user:alice",
  "bob-token": "user:bob",
};

const HOLD_MS = 600_000;

// a worker that never answers fails the test instead of hanging the run
const REQUEST_TIMEOUT_MS = 120_000;

// one behavior per scenario, so no two share a lease or a sequence
const SCENARIOS = ["one", "two", "three", "four"] as const;
type Scenario = typeof SCENARIOS[number];

interface Node {
  send(request: NodeRequest): Promise<unknown>;
}

interface Team {
  readonly modelType: ModelType;
  readonly leader: Node;
  readonly leaderOrigin: string;
  readonly followerOrigin: string;
  readonly ids: Readonly<Record<Scenario, string>>;
  readonly roots: Readonly<Record<"alice" | "bob", string>>;
}

async function withTeam(
  replicates: boolean,
  fn: (team: Team) => Promise<void>,
): Promise<void> {
  // under /tmp: macOS TMPDIR is too long for the sidecar's socket path
  const root = await Deno.realPath(
    await Deno.makeTempDir(
      replicates
        ? { dir: "/tmp", prefix: "swamp-4278-" }
        : { prefix: "swamp-4278-" },
    ),
  );
  const datastorePath = join(root, "ds");
  const privateRoot = join(root, "priv");
  const replica = replicates
    ? JSON.stringify({ type: "file", path: join(root, "replica") })
    : undefined;
  await withMockedEnv(
    { [V3_REPLICA_ENV]: replica },
    () => initializeV3Datastore(datastorePath, "test"),
  );
  const modelType = ModelType.create(
    `test/team-lease-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type: modelType,
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
  const workers: Worker[] = [];
  const nodes: Node[] = [];
  const pids = new Set<number>();
  const node = async (name: string): Promise<Node> => {
    const worker = new Worker(
      new URL("./serve_v3_team_bucket_node_worker.ts", import.meta.url),
      { type: "module" },
    );
    workers.push(worker);
    let queue: Promise<unknown> = Promise.resolve();
    let dead: Error | undefined;
    const call = (request: NodeRequest) => {
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
        worker.onmessage = (event: MessageEvent<NodeResponse>) => {
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
    const send = (request: NodeRequest) => {
      const next = queue.then(() => call(request));
      queue = next.catch(() => {});
      return next;
    };
    await send({
      kind: "init",
      hostname: `node-${name}`,
      ...(replica !== undefined ? { replica } : {}),
      privateRoot,
      datastorePath,
      repoDir: join(root, name),
      modelType: modelType.normalized,
      tokens: TOKENS,
    });
    const created = { send };
    nodes.push(created);
    return created;
  };
  try {
    const leader = await node("leader");
    const lead = await leader.send({ kind: "open" }) as Opened;
    assertEquals(lead.role, "writer");
    const ids = {} as Record<Scenario, string>;
    for (const scenario of SCENARIOS) {
      ids[scenario] = await leader.send({
        kind: "saveModel",
        name: scenario,
      }) as string;
    }
    // both admins, so only the lease tells their commits apart
    await leader.send({
      kind: "materialize",
      admins: ["user:alice", "user:bob"],
    });
    // a bucket follower restores its copy from what the replica holds
    if (replicates) await leader.send({ kind: "confirm" });
    const follower = await node("follower");
    const follow = await follower.send({
      kind: "open",
      leaderOrigin: lead.origin,
    }) as Opened;
    assertEquals(follow.role, "follower");
    const roots = {
      alice: join(root, "alice-checkout"),
      bob: join(root, "bob-checkout"),
    };
    for (const dir of Object.values(roots)) await Deno.mkdir(dir);
    await fn({
      modelType,
      leader,
      leaderOrigin: lead.origin,
      followerOrigin: follow.origin,
      ids,
      roots,
    });
  } finally {
    // the follower first: the leader's close releases the lease
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
    modelRegistry.invalidateType(modelType);
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

function clientAt(origin: string, token: string): ServeDatastoreClient {
  return new ServeDatastoreClient({ baseUrl: origin, token });
}

function signal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

function lockKey(team: Team, scenario: Scenario): string {
  return `data/${team.modelType.normalized}/${team.ids[scenario]}/.lock`;
}

// what `model lease acquire --for` sends
async function acquire(
  team: Team,
  scenario: Scenario,
  member: "alice" | "bob",
  origin: string,
): Promise<ExplicitLease> {
  const taken = await acquireExplicitLease(
    team.roots[member],
    clientAt(origin, `${member}-token`),
    lockKey(team, scenario),
    HOLD_MS,
    0,
    signal(),
  );
  assertEquals(taken.existing, false);
  return taken.lease;
}

async function commit(
  team: Team,
  scenario: Scenario,
  origin: string,
  token: string,
  version: number,
  expectedSeq: number,
  lease?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const id = team.ids[scenario];
  const content = new TextEncoder().encode(
    `${scenario} version ${version} ${crypto.randomUUID()}`,
  );
  const body = commitBody({
    expectedSeq,
    txnId: crypto.randomUUID(),
    ...(lease === undefined ? {} : { lease }),
    ops: await blobSaveOps(
      { modelType: team.modelType, model: { id } },
      "vpc",
      version,
      content,
    ),
    chunks: [{ sha256: await sha256Hex(content), size: content.length }],
  }, [content]);
  const partition = partitionOf({ kind: "model", type: team.modelType, id });
  return await post(
    `${origin}/api/v1/datastore/_default/partitions/${
      encodeURIComponent(partition.toString())
    }/commits`,
    token,
    body,
  );
}

async function landedAt(
  team: Team,
  scenario: Scenario,
): Promise<CommitJSON[]> {
  const partition = partitionOf({
    kind: "model",
    type: team.modelType,
    id: team.ids[scenario],
  }).toString();
  const changes = await team.leader.send({
    kind: "changesSince",
    cursor: 0,
  }) as LeaderChange[];
  return changes.map((change) => change.commit as CommitJSON).filter((landed) =>
    landed.partition === partition
  );
}

async function landedSeq(
  team: Team,
  scenario: Scenario,
  seq: number,
): Promise<CommitJSON> {
  const found = (await landedAt(team, scenario)).find((landed) =>
    landed.seq === seq
  );
  assert(found !== undefined, `${scenario}: no commit ${seq} at the leader`);
  return found;
}

function leaseOps(landed: CommitJSON): unknown[] {
  return landed.ops.filter((op) => op.kind === "lease");
}

function assertLanded(
  reply: { status: number; json: Record<string, unknown> },
  what: string,
): void {
  assertEquals(reply.status, 200, `${what}: ${JSON.stringify(reply.json)}`);
}

function assertLeaseLost(
  reply: { status: number; json: Record<string, unknown> },
  what: string,
): void {
  assertEquals(
    [reply.status, reply.json.code],
    [409, "commit_lease-lost"],
    `${what}: ${JSON.stringify(reply.json)}`,
  );
  // never says whose lease holds the behavior
  assert(!JSON.stringify(reply.json).includes("alice"), what);
}

async function leaseAtLeaderCommitAtFollower(team: Team): Promise<void> {
  const lease = await acquire(team, "one", "alice", team.leaderOrigin);
  assertLanded(
    await commit(
      team,
      "one",
      team.followerOrigin,
      "alice-token",
      1,
      0,
      lease.leaseId,
    ),
    "alice's commit through the follower",
  );
  const landed = await landedSeq(team, "one", 1);
  assertEquals(landed.principal, "user:alice");
  assertEquals(leaseOps(landed), [
    { kind: "lease", holder: lease.leaseId, fence: lease.fence },
  ]);
}

async function leaseAtFollowerCommitAtLeader(team: Team): Promise<void> {
  const lease = await acquire(team, "two", "alice", team.followerOrigin);
  assertLanded(
    await commit(
      team,
      "two",
      team.leaderOrigin,
      "alice-token",
      1,
      0,
      lease.leaseId,
    ),
    "alice's commit through the leader",
  );
  const landed = await landedSeq(team, "two", 1);
  assertEquals(landed.principal, "user:alice");
  assertEquals(leaseOps(landed), [
    { kind: "lease", holder: lease.leaseId, fence: lease.fence },
  ]);
}

async function anotherMemberRefusedAtFollower(team: Team): Promise<void> {
  const lease = await acquire(team, "three", "alice", team.leaderOrigin);
  for (const origin of [team.followerOrigin, team.leaderOrigin]) {
    // only naming alice's lease reaches the same-principal check
    for (const named of [undefined, lease.leaseId]) {
      assertLeaseLost(
        await commit(team, "three", origin, "bob-token", 1, 0, named),
        `bob's commit through ${
          origin === team.followerOrigin ? "the follower" : "the leader"
        } naming ${named === undefined ? "no lease" : "alice's lease"}`,
      );
    }
  }
  const bob = clientAt(team.followerOrigin, "bob-token");
  assertEquals(
    await bob.renewLock(lease.leaseId, HOLD_MS, signal(), {
      holdMs: HOLD_MS,
    }),
    undefined,
    "bob renews alice's lease through the follower",
  );
  assertEquals(
    await bob.releaseLock(lease.leaseId, signal()),
    false,
    "bob releases alice's lease through the follower",
  );
  assertEquals(await landedAt(team, "three"), []);
  assertLanded(
    await commit(
      team,
      "three",
      team.followerOrigin,
      "alice-token",
      1,
      0,
      lease.leaseId,
    ),
    "alice's commit after bob's refusals",
  );
  assertEquals(
    (await landedSeq(team, "three", 1)).principal,
    "user:alice",
  );
}

async function renewAndReleaseAcrossNodes(team: Team): Promise<void> {
  const ways = [
    { takeAt: team.leaderOrigin, otherAt: team.followerOrigin },
    { takeAt: team.followerOrigin, otherAt: team.leaderOrigin },
  ];
  let seq = 0;
  for (const { takeAt, otherAt } of ways) {
    const lease = await acquire(team, "four", "alice", takeAt);
    const alice = clientAt(otherAt, "alice-token");
    // a longer hold, so the new expiry is unmistakably later
    const renewed = await alice.renewLock(
      lease.leaseId,
      HOLD_MS * 2,
      signal(),
      { holdMs: HOLD_MS * 2 },
    );
    assert(renewed !== undefined, "alice's renewal through the other node");
    assertEquals(renewed.leaseId, lease.leaseId);
    assert(
      Date.parse(renewed.expiresAt) > Date.parse(lease.expiresAt),
      `the renewal moved the expiry: ${lease.expiresAt} → ${renewed.expiresAt}`,
    );
    assertLeaseLost(
      await commit(
        team,
        "four",
        team.followerOrigin,
        "bob-token",
        seq + 1,
        seq,
      ),
      "bob's commit while alice holds the renewed lease",
    );
    // serve's own reply: the checkout's record cannot show the release
    assertEquals(
      await alice.releaseLock(lease.leaseId, signal()),
      true,
      "alice's release through the other node",
    );
    seq++;
    assertLanded(
      await commit(
        team,
        "four",
        team.followerOrigin,
        "bob-token",
        seq,
        seq - 1,
      ),
      "bob's commit after alice released",
    );
    const landed = await landedSeq(team, "four", seq);
    assertEquals(landed.principal, "user:bob");
    assertEquals(leaseOps(landed), []);
  }
}

async function acrossNodes(replicates: boolean): Promise<void> {
  await withTeam(replicates, async (team) => {
    await leaseAtLeaderCommitAtFollower(team);
    await leaseAtFollowerCommitAtLeader(team);
    await anotherMemberRefusedAtFollower(team);
    await renewAndReleaseAcrossNodes(team);
  });
}

Deno.test({
  name:
    "serve team on a filesystem v3 datastore: an explicit lease taken through one node covers its holder's commit through the other, refuses another member through the follower, and renews and releases through either node (swamp-club#4278)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => acrossNodes(false),
});

Deno.test({
  name:
    "serve team on a replicating v3 datastore: an explicit lease taken through one node covers its holder's commit through the other, refuses another member through the follower, and renews and releases through either node (swamp-club#4278)",
  ignore: SIDECAR_TESTS_IGNORED,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => acrossNodes(true),
});
