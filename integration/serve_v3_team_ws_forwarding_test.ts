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
 * A serve follower relaying WebSocket requests to its team's leader
 * (swamp-club#4120), over real sockets on port 0. The follower is serve's
 * own connection handling; the leader is scripted, so each case controls
 * exactly what the leader does: a run's stream comes back whole, a cancel
 * reaches the leader, a leader that drops mid-request gives the in-flight
 * refusal, a session the leader revoked closes the client, and a worker's
 * connection is relayed whole.
 */

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type { ServeLeader } from "../src/domain/datastore_v3/serve_leader.ts";
import { handleConnection } from "../src/serve/connection.ts";
import {
  forwardCredentialOf,
  rememberForwardCredential,
} from "../src/serve/follower_forwarder.ts";
import { LeaderLink } from "../src/serve/leader_link.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import {
  CALLER,
  createServeCtx,
  grant,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

interface LeaderSocket {
  readonly auth: string | null;
  readonly received: string[];
  readonly socket: WebSocket;
}

/** A scripted leader: records each socket's credential and frames. */
async function withLeader(
  script: (leader: LeaderSocket, frame: Record<string, unknown>) => void,
  fn: (address: string, sockets: LeaderSocket[]) => Promise<void>,
): Promise<void> {
  const sockets: LeaderSocket[] = [];
  const http = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const auth = req.headers.get("authorization");
      const { socket, response } = Deno.upgradeWebSocket(req);
      const leader: LeaderSocket = {
        auth,
        received: [],
        socket,
      };
      sockets.push(leader);
      socket.onmessage = (event) => {
        leader.received.push(String(event.data));
        script(leader, JSON.parse(String(event.data)));
      };
      return response;
    },
  );
  try {
    await fn(`http://127.0.0.1:${http.addr.port}`, sockets);
  } finally {
    for (const { socket } of sockets) {
      if (socket.readyState <= WebSocket.OPEN) socket.close();
    }
    await http.shutdown();
  }
}

/** Runs `fn` with a follower relaying to the leader at `address`. */
async function withFollower(
  address: string,
  fn: (connect: () => Promise<WebSocket & { frames: unknown[] }>) => Promise<
    void
  >,
): Promise<void> {
  await withServeRepo(async (repo) => {
    const leader: ServeLeader = {
      instanceId: "leader-1",
      fence: 2,
      address,
      since: "2026-10-29T12:00:00.000Z",
    };
    const leaderLink = new LeaderLink({ leader: () => leader });
    const ctx = createServeCtx(repo, [
      grant({ actions: ["read"], resource: { kind: "model", pattern: "*" } }),
    ]);
    ctx.followerGate = {
      role: "follower",
      leader: () => leader,
      isStale: () => false,
    };
    ctx.leaderLink = leaderLink;
    const http = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        const credential = forwardCredentialOf(
          req,
          { kind: "bearer", token: "alice.secret" },
          "127.0.0.1",
        );
        const { socket, response } = Deno.upgradeWebSocket(req);
        rememberForwardCredential(socket, credential);
        handleConnection(socket, ctx, CALLER);
        return response;
      },
    );
    const clients: WebSocket[] = [];
    try {
      await fn(async () => {
        const client = Object.assign(
          new WebSocket(`ws://127.0.0.1:${http.addr.port}/`),
          { frames: [] as unknown[] },
        );
        clients.push(client);
        client.onmessage = (event) =>
          client.frames.push(JSON.parse(String(event.data)));
        await new Promise((resolve) => (client.onopen = resolve));
        return client;
      });
    } finally {
      for (const client of clients) {
        if (client.readyState <= WebSocket.OPEN) client.close();
      }
      leaderLink.close();
      await http.shutdown();
    }
  });
}

const RUN = {
  type: "workflow.run",
  id: "run-1",
  payload: { workflowIdOrName: "deploy" },
};

Deno.test({
  name:
    "team ws forwarding: a run sent to the follower reaches the leader with the caller's credential, and its stream comes back whole",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLeader((leader, frame) => {
      if (frame.type !== "workflow.run") return;
      leader.socket.send(JSON.stringify({
        type: "event",
        id: frame.id,
        event: { kind: "started" },
      }));
      leader.socket.send(JSON.stringify({ type: "done", id: frame.id }));
    }, async (address, sockets) => {
      await withFollower(address, async (connect) => {
        const client = await connect();
        client.send(JSON.stringify(RUN));
        await waitFor(() => client.frames.length === 2, "the run's stream");
        assertEquals(
          client.frames.map((f) => (f as { type: string }).type),
          ["event", "done"],
        );
        assertEquals(sockets.length, 1);
        assertEquals(sockets[0].auth, "Bearer alice.secret");
        assertEquals(JSON.parse(sockets[0].received[0]), RUN);
      });
    });
  },
});

Deno.test({
  name:
    "team ws forwarding: a cancel for a forwarded run, and for a run id the follower does not have, reaches the leader",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLeader(() => {}, async (address, sockets) => {
      await withFollower(address, async (connect) => {
        const client = await connect();
        client.send(JSON.stringify(RUN));
        await waitFor(() => sockets[0]?.received.length === 1, "the run");
        client.send(JSON.stringify({ type: "cancel", id: "run-1" }));
        client.send(JSON.stringify({ type: "cancel", id: "some-run-id" }));
        await waitFor(
          () => sockets[0].received.length === 3,
          "both cancels at the leader",
        );
        assertEquals(
          sockets[0].received.slice(1).map((raw) => JSON.parse(raw)),
          [{ type: "cancel", id: "run-1" }, {
            type: "cancel",
            id: "some-run-id",
          }],
        );
      });
    });
  },
});

Deno.test({
  name:
    "team ws forwarding: a cancel on a connection that forwarded nothing yet still reaches the leader",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLeader(() => {}, async (address, sockets) => {
      await withFollower(address, async (connect) => {
        const client = await connect();
        client.send(JSON.stringify({ type: "cancel", id: "run-elsewhere" }));
        await waitFor(
          () => sockets[0]?.received.length === 1,
          "the cancel at the leader",
        );
        assertEquals(JSON.parse(sockets[0].received[0]), {
          type: "cancel",
          id: "run-elsewhere",
        });
      });
    });
  },
});

Deno.test({
  name:
    "team ws forwarding: a leader that drops with a request in flight gives the in-flight refusal, and nothing is sent again",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLeader((leader, frame) => {
      if (frame.type === "workflow.run") leader.socket.close(1011, "gone");
    }, async (address, sockets) => {
      await withFollower(address, async (connect) => {
        const client = await connect();
        client.send(JSON.stringify(RUN));
        await waitFor(() => client.frames.length === 1, "the refusal");
        const frame = client.frames[0] as {
          type: string;
          id: string;
          error: {
            code: string;
            message: string;
            details?: { inFlight?: boolean };
          };
        };
        assertEquals(frame.type, "error");
        assertEquals(frame.id, "run-1");
        assertEquals(frame.error.code, "serve_not_leader");
        assertEquals(frame.error.details?.inFlight, true);
        assertEquals(sockets.length, 1);
        assertEquals(sockets[0].received.length, 1);
        // The client's connection is still the follower's.
        assertEquals(client.readyState, WebSocket.OPEN);
      });
    });
  },
});

Deno.test({
  name:
    "team ws forwarding: a session the leader revoked closes the client's with the same code",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLeader((leader) => {
      leader.socket.close(4003, "Session revoked");
    }, async (address) => {
      await withFollower(address, async (connect) => {
        const client = await connect();
        const closed = new Promise<number>((resolve) =>
          client.addEventListener("close", (e) => resolve(e.code))
        );
        client.send(JSON.stringify(RUN));
        assertEquals(await closed, 4003);
      });
    });
  },
});

Deno.test({
  name:
    "team ws forwarding: a worker's connection to a follower is relayed whole to the leader from its first RPC frame",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLeader((leader, frame) => {
      if (frame.type === "rpc.request") {
        leader.socket.send(JSON.stringify({
          type: "rpc.response",
          id: frame.id,
          result: { enrolled: true },
        }));
      }
    }, async (address, sockets) => {
      await withFollower(address, async (connect) => {
        const client = await connect();
        const enroll = {
          type: "rpc.request",
          id: "e1",
          method: "enroll",
          params: { token: "pool.secret" },
        };
        client.send(JSON.stringify(enroll));
        await waitFor(() => client.frames.length === 1, "the leader's reply");
        assertEquals(
          (client.frames[0] as { type: string }).type,
          "rpc.response",
        );
        client.send(JSON.stringify({ type: "rpc.cancel", id: "e1" }));
        await waitFor(
          () => sockets[0]?.received.length === 2,
          "the next frame relayed",
        );
        assert(sockets[0].received[0].includes('"enroll"'));
      });
    });
  },
});
