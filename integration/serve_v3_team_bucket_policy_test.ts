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
 * A serve team's follower on a replicating v3 datastore answers reads under
 * the grants the leader's commits carry (swamp-club#4207). Every other
 * team-mode test runs on a filesystem v3 datastore whose nodes share one
 * `commits.db`; here each node has its own copy, replicated through a real
 * Litestream to a file replica as a bucket's is, so the follower takes the
 * leader's commits through `applyV3LeaderChanges` and its access policy is
 * reloaded by serve's own follower wiring (`wireFollowerPolicy`). Each node
 * is a Worker, with its own writer lease and handles. The follower restores
 * its copy before the leader materializes an admin grant, then takes the
 * grant from the leader's feed. Ignored without `SWAMP_LITESTREAM_PATH`,
 * and on Windows.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import type { LeaderChange } from "../src/infrastructure/datastore_v3/serve_feed.ts";
import { serveUpstreamLocalRoot } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import {
  SERVE_UPSTREAM_STATE_FILE,
  type ServeCopyAccess,
  ServeUpstreamState,
} from "../src/infrastructure/datastore_v3/serve_upstream_state.ts";
import { SERVE_DATASTORE_ACCESS_HEADER } from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import { SERVE_NOT_LEADER_CODE } from "../src/domain/datastore_v3/serve_leader.ts";
import {
  killSidecarAtTeardown,
  SIDECAR_TESTS_IGNORED,
} from "./datastore_v3_litestream_helpers.ts";
import type { Frame } from "./serve_request_harness.ts";
import {
  type Client,
  readCommand,
  serveEnv,
  withScratch,
} from "./serve_upstream_fixtures.ts";
import type {
  FeedState,
  NodeRequest,
  NodeResponse,
  Opened,
} from "./serve_v3_team_bucket_node_worker.ts";

await initializeLogging({});

const ignore = SIDECAR_TESTS_IGNORED;

/** Bearer tokens both nodes accept, and whom they name. */
const TOKENS: Record<string, string> = {
  "boss-token": "user:boss",
  "carol-token": "user:carol",
};

/**
 * How long a node may take to answer one request: a worker that never
 * answers fails the test, naming the request, instead of hanging the run.
 */
const REQUEST_TIMEOUT_MS = 120_000;

interface Node {
  send(request: NodeRequest): Promise<unknown>;
}

interface Team {
  readonly modelType: ModelType;
  node(name: string): Promise<Node>;
}

async function withTeam(fn: (team: Team) => Promise<void>): Promise<void> {
  // Under /tmp: macOS TMPDIR is too long for the sidecar's socket path.
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-4207-" }),
  );
  const datastorePath = join(root, "ds");
  const privateRoot = join(root, "priv");
  const replica = JSON.stringify({ type: "file", path: join(root, "replica") });
  await withMockedEnv(
    { [V3_REPLICA_ENV]: replica },
    () => initializeV3Datastore(datastorePath, "test"),
  );
  // The test's client resolves the behavior type in this thread too.
  const modelType = ModelType.create(
    `test/team-bucket-${crypto.randomUUID().slice(0, 8)}`,
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
  try {
    await fn({
      modelType,
      async node(name) {
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
          replica,
          privateRoot,
          datastorePath,
          repoDir: join(root, name),
          modelType: modelType.normalized,
          tokens: TOKENS,
        });
        const node = { send };
        nodes.push(node);
        return node;
      },
    });
  } finally {
    // The follower first: the leader's close releases the lease.
    for (const node of [...nodes].reverse()) {
      for (
        const pid of await node.send({ kind: "pids" }).catch(
          () => [],
        ) as number[]
      ) {
        pids.add(pid);
      }
      await node.send({ kind: "close" }).catch(() => {});
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

/** A team mid-scenario: see {@link startTeam}. */
interface Started {
  readonly leader: Node;
  readonly follower: Node;
  readonly leaderOrigin: string;
  readonly followerOrigin: string;
  /** Behavior `web`'s id, whose data `vpc` the leader saves. */
  readonly modelId: string;
  /** Behavior `api`'s id, which holds no data yet. */
  readonly apiId: string;
}

/**
 * The leader holds the lease, saves behaviors `web` and `api` and two
 * versions of web's data `vpc`, and has them replicated; the follower then
 * restores its own copy, which holds no grant. Behavior definitions are the
 * repository's, not the datastore's: each node's checkout holds them, as
 * each serve node's clone of the repository does.
 */
async function startTeam(team: Team): Promise<Started> {
  const leader = await team.node("leader");
  const lead = await leader.send({ kind: "open" }) as Opened;
  assertEquals(lead.role, "writer");
  const modelId = await leader.send({
    kind: "saveModel",
    name: "web",
  }) as string;
  const apiId = await leader.send({ kind: "saveModel", name: "api" }) as string;
  await leader.send({ kind: "saveData", modelId, dataName: "vpc", count: 2 });
  await leader.send({ kind: "confirm" });
  const follower = await team.node("follower");
  const follow = await follower.send({ kind: "open" }) as Opened;
  assertEquals(follow.role, "follower");
  await follower.send({ kind: "saveModel", name: "web", id: modelId });
  await follower.send({ kind: "saveModel", name: "api", id: apiId });
  const restoredAt = await follower.send({ kind: "head" }) as number;
  assertEquals(restoredAt, await leader.send({ kind: "head" }) as number);
  assertEquals(
    await follower.send({ kind: "grants", subject: "user:boss" }),
    0,
    "the follower restored before the grant",
  );
  return {
    leader,
    follower,
    leaderOrigin: lead.origin,
    followerOrigin: follow.origin,
    modelId,
    apiId,
  };
}

/**
 * The leader materializes `admins` as serve's `--admins` does, and saves
 * three more versions of `vpc` on `modelId` (web's by default) after it, as
 * the commits a team keeps making; then the follower's feed applies
 * everything the leader committed past its copy.
 */
async function grantAndFollow(
  started: Started,
  admins: readonly string[],
  modelId = started.modelId,
): Promise<void> {
  const { leader, follower } = started;
  await leader.send({ kind: "materialize", admins });
  await leader.send({ kind: "saveData", modelId, dataName: "vpc", count: 3 });
  const from = await follower.send({ kind: "head" }) as number;
  const changes = await leader.send({
    kind: "changesSince",
    cursor: from,
  }) as LeaderChange[];
  assert(changes.length > 0, "the leader committed past the follower");
  await follower.send({ kind: "apply", changes });
  assertEquals(
    await follower.send({ kind: "head" }),
    await leader.send({ kind: "head" }),
  );
}

interface ChangesPage {
  readonly status: number;
  readonly code?: string;
  readonly cursor?: number;
  readonly cursors: readonly number[];
  readonly access: string | null;
}

/** `GET changes` after `cursor`, every page, as `token`'s caller reads it. */
async function changes(
  origin: string,
  token: string,
  cursor = 0,
): Promise<ChangesPage> {
  const cursors: number[] = [];
  let next = cursor;
  let access: string | null = null;
  for (;;) {
    const response = await fetch(
      `${origin}/api/v1/datastore/_default/changes?cursor=${next}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const json = await response.json() as {
      code?: string;
      cursor?: number;
      more?: boolean;
      changes?: { cursor: number }[];
    };
    access = response.headers.get(SERVE_DATASTORE_ACCESS_HEADER);
    if (response.status !== 200) {
      return {
        status: response.status,
        ...(json.code !== undefined ? { code: json.code } : {}),
        cursors,
        access,
      };
    }
    for (const change of json.changes ?? []) cursors.push(change.cursor);
    if (json.more !== true || json.cursor === next) {
      return { status: 200, cursor: json.cursor, cursors, access };
    }
    next = json.cursor!;
  }
}

/** A `data.list` reply's items, by name and version, or its error code. */
function listed(frames: readonly Frame[]): unknown {
  const error = frames.find((frame) => frame.type === "error");
  if (error !== undefined) return { error: error.error?.code };
  const reply = frames.find((frame) => frame.type === "data.list");
  const data = reply?.payload?.data as { groups?: unknown } | undefined;
  const groups = (data?.groups ?? []) as {
    type: string;
    items: { name: string; version: number }[];
  }[];
  return groups.map((group) => ({
    type: group.type,
    items: group.items.map(({ name, version }) => ({ name, version })),
  }));
}

Deno.test({
  name:
    "serve team on a replicating v3 datastore: a follower that restored before an admin grant answers that admin's changes and data as the leader does once the grant arrives by its feed (swamp-club#4207)",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withTeam(async (team) => {
      const started = await startTeam(team);
      await grantAndFollow(started, ["user:boss"]);
      const { leader, follower, leaderOrigin, followerOrigin } = started;

      // (a) The admin reads the same commits through either node.
      const fromLeader = await changes(leaderOrigin, "boss-token");
      const fromFollower = await changes(followerOrigin, "boss-token");
      assertEquals(fromLeader.status, 200);
      assert(fromLeader.cursors.length > 0, "the admin reads commits");
      assertEquals(fromFollower, fromLeader);

      // The follower's policy holds the grant its feed brought in.
      assert(
        (await follower.send({
          kind: "grants",
          subject: "user:boss",
        }) as number) >= 1,
        "the follower's policy holds the admin grant",
      );

      // (b) Serve's data listing answers the admin alike on both nodes.
      const leaderList = listed(
        await leader.send({
          kind: "dataList",
          principal: "user:boss",
          modelName: "web",
        }) as Frame[],
      );
      assertEquals(leaderList, [{
        type: "resource",
        items: [{ name: "vpc", version: 5 }],
      }]);
      assertEquals(
        listed(
          await follower.send({
            kind: "dataList",
            principal: "user:boss",
            modelName: "web",
          }) as Frame[],
        ),
        leaderList,
      );
    });
  },
});

Deno.test({
  name:
    "serve team on a replicating v3 datastore: while a follower's policy is unknown its reads are refused as a stale follower's and no page moves a cursor, and once it reloads they match the leader's (swamp-club#4207)",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withTeam(async (team) => {
      const started = await startTeam(team);
      await grantAndFollow(started, ["user:boss"]);
      const { follower, leaderOrigin, followerOrigin } = started;
      const before = await follower.send({ kind: "feed" }) as FeedState;
      assertEquals(before.policyKnown, true);
      assertEquals(before.bound, before.head);

      // Carol's grant arrives while the follower cannot reload its policy.
      await follower.send({ kind: "failReloads", fail: true });
      await grantAndFollow(started, ["user:boss", "user:carol"]);
      // Every read is refused as a stale follower's: no page is answered,
      // so no caller's cursor moves past carol's grant.
      for (const token of ["carol-token", "boss-token"]) {
        const refused = await changes(followerOrigin, token);
        assertEquals(
          {
            status: refused.status,
            code: refused.code,
            cursor: refused.cursor,
            cursors: refused.cursors,
          },
          {
            status: 503,
            code: SERVE_NOT_LEADER_CODE,
            cursor: undefined,
            cursors: [],
          },
          token,
        );
      }
      const unknown = await follower.send({ kind: "feed" }) as FeedState;
      assertEquals(unknown.policyKnown, false);
      assert(unknown.head > before.head, "the copy holds the new commits");
      // The commits before the first one whose reload failed were applied;
      // serve pages to none from that one on.
      assert(
        unknown.bound >= before.bound && unknown.bound < unknown.head,
        `serve pages to ${unknown.bound} of ${unknown.head}`,
      );
      assertEquals(
        listed(
          await follower.send({
            kind: "dataList",
            principal: "user:carol",
            modelName: "web",
          }) as Frame[],
        ),
        { error: SERVE_NOT_LEADER_CODE },
      );

      // Reloaded, the follower answers carol as the leader does, from the
      // cursor no refused read moved.
      await follower.send({ kind: "failReloads", fail: false });
      await follower.send({ kind: "poke" });
      const known = await follower.send({ kind: "feed" }) as FeedState;
      assertEquals(known.policyKnown, true);
      assertEquals(known.bound, known.head);
      const fromLeader = await changes(leaderOrigin, "carol-token");
      assert(fromLeader.cursors.length > 0, "carol reads commits");
      assertEquals(await changes(followerOrigin, "carol-token"), fromLeader);
    });
  },
});

/** The access a serve-mode checkout's copy of `origin` was built and seen under. */
function copyState(
  client: Client,
  origin: string,
): { copyId: string; access: ServeCopyAccess } {
  const state = ServeUpstreamState.open(
    join(
      serveUpstreamLocalRoot(client.repoDir, origin, ""),
      SERVE_UPSTREAM_STATE_FILE,
    ),
  );
  try {
    return { copyId: state.copyId(), access: state.access() };
  } finally {
    state.close();
  }
}

Deno.test({
  name:
    "serve team on a replicating v3 datastore: a member's checkout copy built through the follower before its grant is rebuilt once the follower's policy holds it, and gets the commits it skipped (swamp-club#4089, swamp-club#4207)",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withTeam(async (team) => {
      const started = await startTeam(team);
      const { follower, followerOrigin, leaderOrigin } = started;
      const type = team.modelType;
      await withScratch(async (scratch) => {
        const member = await scratch.client("member");
        const env = serveEnv({ origin: followerOrigin }, "boss-token");
        // The versions of web's vpc the member's checkout holds.
        const read = () =>
          readCommand(
            scratch,
            member,
            env,
            async (repos) =>
              (await repos.unifiedDataRepo.listVersions(
                type,
                started.modelId,
                "vpc",
              )).sort((a, b) => a - b),
          );

        // Built through the follower while its policy gives boss nothing:
        // the copy's cursor moves past versions 1 and 2.
        assertEquals(await read(), []);
        const built = copyState(member, followerOrigin);
        const nothing = built.access.built;
        assert(nothing !== undefined, "the copy recorded its access");

        // Every commit from here on is to behavior api's partition: web's
        // gets none that would bring its history along.
        await grantAndFollow(started, ["user:boss"], started.apiId);
        const admin = (await changes(followerOrigin, "boss-token")).access;
        assert(admin !== null);
        assertNotEquals(
          admin,
          nothing,
          "the follower names boss's new read access once its policy holds the grant",
        );
        assertEquals(
          admin,
          (await changes(leaderOrigin, "boss-token")).access,
          "the follower names the access the leader names",
        );

        // The command that sees the change records it and reads on as the
        // copy is: web's two versions stay skipped.
        assertEquals(await read(), []);
        const seen = copyState(member, followerOrigin);
        assertEquals(seen.access.seen, admin);
        assertEquals(seen.access.built, nothing);
        assertEquals(seen.copyId, built.copyId);
        // The next rebuilds the copy under the new access and reads them.
        assertEquals(await read(), [1, 2]);
        const rebuilt = copyState(member, followerOrigin);
        assertNotEquals(rebuilt.copyId, built.copyId, "the copy was rebuilt");
        assertEquals(rebuilt.access.built, admin);
        assertEquals(rebuilt.access.seen, admin);
        assertEquals(
          await follower.send({ kind: "grants", subject: "user:boss" }),
          1,
        );
      });
    });
  },
});
