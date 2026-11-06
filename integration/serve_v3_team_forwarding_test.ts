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
import type { ServeLeader } from "../src/domain/datastore_v3/serve_leader.ts";
import { handleDatastoreRequest } from "../src/serve/datastore_api.ts";
import { matchDatastoreRoute } from "../src/serve/datastore_routes.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { LeaderLink } from "../src/serve/leader_link.ts";
import { stringify as stringifyYaml } from "@std/yaml";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { grant } from "./serve_request_harness.ts";
import { UploadLedger } from "../src/infrastructure/datastore_v3/upload_ledger.ts";
import {
  blobSaveOps,
  commitBody,
  getJson,
  partitionPath,
  post,
  type Server,
  sha256Hex,
  TOKENS,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

async function withFollower(
  server: Server,
  leader: () => ServeLeader | undefined,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const leaderLink = new LeaderLink({ leader });
  const ctx = {
    ...server.ctx,
    followerGate: {
      role: "follower" as const,
      leader,
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
    await fn(
      server.url.replace(/:\d+\//, `:${http.addr.port}/`),
    );
  } finally {
    leaderLink.close();
    await http.shutdown();
  }
}

/** Grants the caller every action on workflows, approve among them. */
function admins() {
  return [grant({
    actions: ["read", "write", "run", "approve", "signal"],
    resource: { kind: "workflow", pattern: "*" },
  })];
}

function leaderAt(server: Server): ServeLeader {
  return {
    instanceId: "leader-1",
    fence: 4,
    address: new URL(server.url).origin,
    since: "2026-10-29T12:00:00.000Z",
  };
}

async function saveBody(server: Server): Promise<Uint8Array> {
  const content = new TextEncoder().encode("0123456789abcdef");
  return commitBody({
    expectedSeq: 0,
    txnId: crypto.randomUUID(),
    ops: await blobSaveOps(server, "vpc", 1, content),
    chunks: [{ sha256: await sha256Hex(content), size: content.length }],
  }, [content]);
}

const followerPath = (server: Server, followerUrl: string) =>
  partitionPath(server).replace(server.url, followerUrl);

Deno.test({
  name:
    "team forwarding: a commit sent to the follower lands at the leader, stamped with the caller's principal",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const leader = leaderAt(server);
      await withFollower(server, () => leader, async (followerUrl) => {
        const landed = await post(
          followerPath(server, followerUrl),
          "alice-token",
          await saveBody(server),
        );
        assertEquals(landed.status, 200, JSON.stringify(landed.json));
        const changes = await getJson(
          `${server.url}/changes?cursor=0`,
          "alice-token",
        );
        const commits = changes.json.changes as {
          commit: { principal?: string };
        }[];
        assertEquals(commits.at(-1)?.commit.principal, "user:caller");
      });
    });
  },
});

Deno.test({
  name:
    "team forwarding: the leader decides; a caller it does not allow is refused, whatever the follower is sent",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const leader = leaderAt(server);
      await withFollower(server, () => leader, async (followerUrl) => {
        // bob has no grants. A header naming another principal is the
        // caller's own, and the leader reads identity only from the token.
        const response = await fetch(followerPath(server, followerUrl), {
          method: "POST",
          headers: {
            authorization: "Bearer bob-token",
            "content-type": "application/vnd.swamp.commit+v1",
            "x-swamp-principal": "user:caller",
            "x-forwarded-user": "user:caller",
          },
          body: (await saveBody(server)) as Uint8Array<ArrayBuffer>,
        });
        const json = await response.json();
        assertEquals(response.status, 403, JSON.stringify(json));
        const head = await getJson(
          `${partitionPath(server)}?after=0`,
          "alice-token",
        );
        assertEquals(head.json.head, 0);
      });
    });
  },
});

Deno.test({
  name:
    "team forwarding: a leader that cannot be reached is a plain retryable refusal, and nothing lands",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port = (closed.addr as Deno.NetAddr).port;
      closed.close();
      const gone = {
        ...leaderAt(server),
        address: `http://127.0.0.1:${port}`,
      };
      await withFollower(server, () => gone, async (followerUrl) => {
        const refused = await post(
          followerPath(server, followerUrl),
          "alice-token",
          await saveBody(server),
        );
        assertEquals(refused.status, 503);
        assertEquals(refused.json.code, "serve_not_leader");
        assertEquals(refused.json.inFlight, undefined);
        assert(String(refused.json.message).includes("Nothing was changed"));
      });
    });
  },
});

Deno.test({
  name:
    "team forwarding: a leader lost after the request reached it is refused as in flight, and not sent again",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      let accepted = 0;
      const dropping = (async () => {
        for await (const conn of listener) {
          accepted++;
          await conn.read(new Uint8Array(64 * 1024)).catch(() => null);
          conn.close();
        }
      })();
      const lost = {
        ...leaderAt(server),
        address: `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
      };
      try {
        await withFollower(server, () => lost, async (followerUrl) => {
          const refused = await post(
            followerPath(server, followerUrl),
            "alice-token",
            await saveBody(server),
          );
          assertEquals(refused.status, 503);
          assertEquals(refused.json.code, "serve_not_leader");
          assertEquals(refused.json.inFlight, true);
        });
        assertEquals(accepted, 1);
      } finally {
        listener.close();
        await dropping.catch(() => {});
      }
    });
  },
});

Deno.test({
  name:
    "team forwarding: a forged decision sent to the follower is refused at the leader, even from a caller holding approve (swamp-club#4245)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const workflowId = "44444444-5555-4666-8777-888888888888";
    await withServer(admins(), async (server) => {
      const leader = leaderAt(server);
      await withFollower(server, () => leader, async (followerUrl) => {
        const runId = crypto.randomUUID();
        const key = `workflow-runs/${workflowId}/workflow-run-${runId}.yaml`;
        const partition = partitionOf({ kind: "run", workflowId, runId });
        const record = (step: Record<string, unknown>) => ({
          id: runId,
          workflowId,
          workflowName: "deploy",
          initiatedBy: "user:caller",
          status: "suspended",
          tags: {},
          jobs: [{
            jobName: "main",
            status: "waiting_approval",
            steps: [{
              stepName: "gate",
              startedAt: "2026-10-26T00:00:00.000Z",
              ...step,
            }],
          }],
        });
        const send = async (kind: string, body: unknown) => {
          const head = await server.v3.commitStore.head(
            server.v3.namespace,
            partition,
          );
          const bytes = new TextEncoder().encode(
            stringifyYaml(JSON.parse(JSON.stringify(body))),
          );
          return await post(
            `${followerUrl}/partitions/${
              encodeURIComponent(partition.toString())
            }/commits`,
            "alice-token",
            commitBody({
              expectedSeq: head.seq,
              txnId: crypto.randomUUID(),
              ops: [{
                kind: "put",
                intent: { kind, run: { workflowId, runId } },
                key,
                inline: btoa(String.fromCharCode(...bytes)),
              }],
              chunks: [],
            }),
          );
        };
        const waits = await send(
          "run.create",
          record({ status: "waiting_approval" }),
        );
        assertEquals(waits.status, 200, JSON.stringify(waits.json));
        const forged = await send(
          "run.update",
          record({
            status: "succeeded",
            approvalDecision: {
              approved: true,
              decidedBy: "user:caller",
              decidedAt: "2026-10-26T00:00:00.000Z",
            },
          }),
        );
        assertEquals(forged.status, 403, JSON.stringify(forged.json));
        assertEquals(forged.json.reason, "content-refused");
      });
    });
  },
});
