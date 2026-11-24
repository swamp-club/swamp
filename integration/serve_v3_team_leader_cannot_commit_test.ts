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
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { WRITER_LEASE_CLOCK_SKEW_MS } from "../src/domain/datastore_v3/writer_lease.ts";
import type {
  TeamNodeRequest,
  TeamNodeResponse,
  TeamNodeState,
} from "./serve_v3_team_machine_worker.ts";
import { startLoadedWorker } from "./graph_worker.ts";

await initializeLogging({});

const TICK_MS = 300;
const LEASE_TTL_MS = 2_000;
const WINDOW_MS = 1_000;
/** twice the lease TTL plus the skew allowance, from the trip to a new leader */
const TAKEOVER_BOUND_MS = 2 * (LEASE_TTL_MS + WRITER_LEASE_CLOCK_SKEW_MS);
const REQUEST_TIMEOUT_MS = 60_000;

interface Node {
  readonly name: string;
  send(request: TeamNodeRequest): Promise<unknown>;
  state(): Promise<TeamNodeState>;
  commit(): Promise<string | undefined>;
  cursors(): Promise<number[]>;
}

interface Team {
  start(
    name: string,
    options: { release: boolean; windowMs?: number },
  ): Promise<Node>;
}

async function withTeam(fn: (team: Team) => Promise<void>): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-team-cannot-commit-" }),
  );
  const datastorePath = join(root, "ds");
  await initializeV3Datastore(datastorePath, "test");
  const workers: Worker[] = [];
  const nodes: Node[] = [];
  let started = 0;
  try {
    await fn({
      async start(name, options) {
        started++;
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
        const call = (request: TeamNodeRequest) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          return new Promise<unknown>((done, fail) => {
            timer = setTimeout(() => {
              worker.terminate();
              fail(new Error(`node-${name}: ${request.kind} timed out`));
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
        await send({
          kind: "init",
          hostname: `node-${name}`,
          datastorePath,
          repoDir: join(root, `${name}-${started}`),
          instanceId: `instance-${name}-${started}`,
        });
        await send({
          kind: "start",
          tickMs: TICK_MS,
          leaseTtlMs: LEASE_TTL_MS,
          commitHealth: {
            windowMs: options.windowMs ?? WINDOW_MS,
            release: options.release,
          },
        });
        const node: Node = {
          name,
          send,
          state: () => send({ kind: "state" }) as Promise<TeamNodeState>,
          commit: () => send({ kind: "commit" }) as Promise<string | undefined>,
          cursors: () => send({ kind: "cursors" }) as Promise<number[]>,
        };
        nodes.push(node);
        return node;
      },
    });
  } finally {
    for (const node of nodes) {
      await node.send({ kind: "close" }).catch(() => {});
    }
    for (const worker of workers) worker.terminate();
    await Deno.remove(root, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

/** commits on the leader until it trips; returns when it did */
async function fillTheDisk(leader: Node): Promise<number> {
  await leader.send({ kind: "disk-full", full: true });
  let trippedAt: number | undefined;
  await waitFor(
    async () => {
      const failed = await leader.commit();
      assert(failed !== undefined, "a commit landed on a full disk");
      if ((await leader.state()).cannotCommit === undefined) return false;
      trippedAt = Date.now();
      return true;
    },
    "the leader to find it cannot commit",
    { timeoutMs: 30_000 },
  );
  return trippedAt!;
}

function assertUnique(cursors: readonly number[]): void {
  assertEquals(new Set(cursors).size, cursors.length, `${cursors}`);
}

Deno.test({
  name:
    "leader that cannot commit: it steps down, the standby takes over within 2 x (TTL + skew), and every acknowledged write is there once",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async (team) => {
      const a = await team.start("a", { release: true });
      const b = await team.start("b", { release: true });
      assertEquals((await a.state()).role, "leader");
      assertEquals((await b.state()).role, "follower");
      for (let i = 0; i < 3; i++) assertEquals(await a.commit(), undefined);
      const acknowledged = await a.cursors();
      const oldFence = (await a.state()).fence!;

      await fillTheDisk(a);
      const reason = (await a.state()).cannotCommit!;
      assert(reason.includes("storage is full"), reason);
      assert(!reason.includes("database or disk"), "/ready names no raw error");

      await waitFor(
        async () => {
          const state = await b.state();
          return state.role === "leader" && (state.fence ?? 0) > oldFence;
        },
        "the standby to take the lead at a higher fence",
        { timeoutMs: TAKEOVER_BOUND_MS },
      );
      assertEquals(
        (await a.state()).events.filter((e) => e === "stepped-down").length,
        1,
      );

      assertEquals(await b.commit(), undefined);
      const after = await b.cursors();
      assertUnique(after);
      for (const cursor of acknowledged) assert(after.includes(cursor));
      assertEquals(after.length, acknowledged.length + 1);

      const restarted = await team.start("a", { release: true });
      assertEquals((await restarted.state()).role, "follower");
      assertEquals((await b.state()).role, "leader");
    });
  },
});

Deno.test({
  name:
    "leader that cannot commit: a burst of storage failures inside the window, then a commit, never moves the lease",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async (team) => {
      // a window no burst of five commits can cross, however slow the host
      const a = await team.start("a", { release: true, windowMs: 3_600_000 });
      const b = await team.start("b", { release: true });
      const fence = (await a.state()).fence;
      await a.send({ kind: "disk-full", full: true });
      for (let i = 0; i < 5; i++) assert(await a.commit() !== undefined);
      await a.send({ kind: "disk-full", full: false });
      assertEquals(await a.commit(), undefined);
      // the follower ticks against the lease a few times
      const until = Date.now() + 5 * TICK_MS;
      await waitFor(() => Date.now() >= until, "a few follower ticks");
      const state = await a.state();
      assertEquals(state.role, "leader");
      assertEquals(state.fence, fence);
      assertEquals(state.cannotCommit, undefined);
      assertEquals(state.events.includes("stepped-down"), false);
      assertEquals((await b.state()).role, "follower");
    });
  },
});

Deno.test({
  name:
    "leader that cannot commit: one still draining when its lease lapses has its next commit refused, and the commit never lands",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTeam(async (team) => {
      const a = await team.start("a", { release: false });
      const b = await team.start("b", { release: true });
      assertEquals(await a.commit(), undefined);
      const oldFence = (await a.state()).fence!;
      await fillTheDisk(a);
      await waitFor(
        async () => {
          const state = await b.state();
          return state.role === "leader" && (state.fence ?? 0) > oldFence;
        },
        "the standby to take the lapsed lease",
        { timeoutMs: TAKEOVER_BOUND_MS },
      );
      const before = await b.cursors();
      await a.send({ kind: "disk-full", full: false });
      const refused = await a.commit();
      assert(refused !== undefined, "the deposed leader's commit landed");
      assertEquals(await b.cursors(), before);
      assertEquals(await b.commit(), undefined);
      assertUnique(await b.cursors());
    });
  },
});
