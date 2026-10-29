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
 * Serve's team mode on a v3 datastore (swamp-club#4096), with Workers as
 * machines: two serve nodes share a filesystem datastore, each with its own
 * checkout. One leads; the other follows, refuses writes naming the leader,
 * and takes over once the leader's lease expires, while the old leader,
 * resumed, lands nothing and follows.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { SERVE_NOT_LEADER_CODE } from "../src/domain/datastore_v3/serve_leader.ts";
import { WRITER_FENCED_CODE } from "../src/domain/datastore_v3/writer_lease.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import type {
  TeamNodeRequest,
  TeamNodeResponse,
  TeamNodeState,
} from "./serve_v3_team_machine_worker.ts";

/** The address every node behind serve's one address is started with. */
const OWNER = "http://serve.example:9090";

/** Expiry of a 1.5 s lease, with the 10 s clock skew. */
const STALL_MS = 14_000;

interface Node {
  send(request: TeamNodeRequest): Promise<unknown>;
  state(): Promise<TeamNodeState>;
}

async function withTeam(
  fn: (team: {
    node(
      name: string,
      options?: { readonly address?: string },
    ): Promise<Node>;
  }) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-team-" }),
  );
  const datastorePath = join(root, "ds");
  await initializeV3Datastore(datastorePath, "test");
  const workers: Worker[] = [];
  const nodes: Node[] = [];
  try {
    await fn({
      async node(name, options = {}) {
        const worker = new Worker(
          new URL("./serve_v3_team_machine_worker.ts", import.meta.url),
          { type: "module" },
        );
        workers.push(worker);
        let queue: Promise<unknown> = Promise.resolve();
        const call = (request: TeamNodeRequest) =>
          new Promise<unknown>((done, fail) => {
            worker.onmessage = (event: MessageEvent<TeamNodeResponse>) => {
              const response = event.data;
              if (response.ok) done(response.value);
              else fail(new Error(`${response.code}: ${response.error}`));
            };
            worker.onerror = (event) => {
              event.preventDefault();
              fail(new Error(event.message));
            };
            worker.postMessage(request);
          });
        const send = (request: TeamNodeRequest) => {
          const next = queue.then(() => call(request));
          queue = next.catch(() => {});
          return next;
        };
        await send({
          kind: "init",
          hostname: `node-${name}`,
          datastorePath,
          repoDir: join(root, name),
          instanceId: `instance-${name}`,
          ownerAddress: options.address ?? OWNER,
        });
        const node = {
          send,
          state: () => send({ kind: "state" }) as Promise<TeamNodeState>,
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
    if (Deno.build.os === "windows") {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(root, { recursive: true });
    }
  }
}

Deno.test("serve team mode: one node leads, the other follows and refuses writes naming the leader", async () => {
  await withTeam(async (team) => {
    const a = await team.node("a");
    assertEquals(await a.send({ kind: "start", tickMs: 3_600_000 }), "writer");
    const b = await team.node("b");
    assertEquals(
      await b.send({ kind: "start", tickMs: 3_600_000 }),
      "follower",
    );
    assertEquals((await a.state()).role, "leader");
    const follower = await b.state();
    assertEquals(follower.role, "follower");
    assertEquals(follower.leader, "instance-a");
    assertEquals(await a.send({ kind: "commit" }), undefined);
    assertEquals(await b.send({ kind: "commit" }), SERVE_NOT_LEADER_CODE);
    // A tick leaves the follower following while the leader holds on.
    await b.send({ kind: "tick" });
    assertEquals((await b.state()).role, "follower");
  });
});

Deno.test("serve team mode: the follower takes over once the leader's lease expires, and the resumed leader lands nothing and stops", async () => {
  await withTeam(async (team) => {
    const a = await team.node("a");
    await a.send({ kind: "start", ttlMs: 1_500, tickMs: 3_600_000 });
    const b = await team.node("b");
    await b.send({ kind: "start", tickMs: 3_600_000 });
    const before = (await a.state()).fence!;
    // A stalls past its lease's expiry; B's ticks take the lease.
    const stalled = a.send({ kind: "pause", ms: STALL_MS });
    await waitFor(
      async () => {
        await b.send({ kind: "tick" });
        return (await b.state()).role === "leader";
      },
      "the follower to take the lead",
      { timeoutMs: 30_000 },
    );
    await stalled;
    const after = await b.state();
    assert(after.fence! > before, `fence ${after.fence} after ${before}`);
    assertEquals(after.events, ["lead"]);
    assertEquals(await b.send({ kind: "commit" }), undefined);
    // A, resumed, holds a fenced lease: it commits nothing, refused as
    // fenced (its request may have done work), and stops once it notices,
    // closing its gates, to start again as a follower.
    assertEquals(await a.send({ kind: "commit" }), WRITER_FENCED_CODE);
    await waitFor(
      async () => {
        await a.send({ kind: "tick" });
        return (await a.state()).events.includes("lost");
      },
      "the old leader to stop",
      { timeoutMs: 30_000 },
    );
    const stopped = await a.state();
    assertEquals(stopped.events, ["lead", "lost"]);
    assertEquals(stopped.role, "follower");
    assertEquals(await a.send({ kind: "commit" }), WRITER_FENCED_CODE);
  });
});

Deno.test("serve team mode: a claimed datastore keeps its owner across a takeover (swamp-club#4063)", async () => {
  await withTeam(async (team) => {
    const claimer = await team.node("claimer");
    await claimer.send({ kind: "claim", address: OWNER });
    await claimer.send({ kind: "close" });
    const a = await team.node("a");
    await a.send({ kind: "start", ttlMs: 1_500, tickMs: 3_600_000 });
    const b = await team.node("b");
    assertEquals(
      await b.send({ kind: "start", tickMs: 3_600_000 }),
      "follower",
    );
    const stalled = a.send({ kind: "pause", ms: STALL_MS });
    await waitFor(
      async () => {
        await b.send({ kind: "tick" });
        return (await b.state()).role === "leader";
      },
      "the follower to take the lead",
      { timeoutMs: 30_000 },
    );
    await stalled;
    // The new leader writes as the owner: a takeover is no change of owner.
    assertEquals(await b.send({ kind: "commit" }), undefined);
    assertEquals(await b.send({ kind: "owner" }), OWNER);
  });
});

Deno.test("serve team mode: a node started with another --address is refused, even as a follower (swamp-club#4063)", async () => {
  await withTeam(async (team) => {
    const claimer = await team.node("claimer");
    await claimer.send({ kind: "claim", address: OWNER });
    await claimer.send({ kind: "close" });
    const a = await team.node("a");
    assertEquals(await a.send({ kind: "start", tickMs: 3_600_000 }), "writer");
    const laptop = await team.node("laptop", {
      address: "http://laptop.example:9090",
    });
    let refusal = "";
    try {
      await laptop.send({ kind: "start", tickMs: 3_600_000 });
    } catch (error) {
      refusal = (error as Error).message;
    }
    assert(
      refusal.startsWith("datastore_claimed:"),
      `the other address's start: ${refusal}`,
    );
  });
});

Deno.test("serve team mode: a node that follows commits nothing even before its leadership starts", async () => {
  await withTeam(async (team) => {
    const a = await team.node("a");
    await a.send({ kind: "start", tickMs: 3_600_000 });
    const b = await team.node("b");
    assertEquals(await b.send({ kind: "hold" }), "follower");
    assertEquals(await b.send({ kind: "commit" }), SERVE_NOT_LEADER_CODE);
  });
});
