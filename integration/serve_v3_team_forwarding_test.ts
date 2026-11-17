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
import type { ServeLeader } from "../src/domain/datastore_v3/serve_leader.ts";
import { handleDatastoreRequest } from "../src/serve/datastore_api.ts";
import { matchDatastoreRoute } from "../src/serve/datastore_routes.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  LeaderLink,
  type LeaderLinkOptions,
} from "../src/serve/leader_link.ts";
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
  fn: (url: string, link: LeaderLink) => Promise<void>,
  linkOptions: Partial<LeaderLinkOptions> = {},
): Promise<void> {
  const leaderLink = new LeaderLink({ ...linkOptions, leader });
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
      leaderLink,
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
    "team forwarding: a leader that left two forwards in a row unanswered is refused at once, never sent, until a new leader takes over",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      let accepted = 0;
      const held: Deno.Conn[] = [];
      const frozenNode = (async () => {
        for await (const conn of listener) {
          accepted++;
          held.push(conn);
        }
      })();
      let current: ServeLeader = {
        ...leaderAt(server),
        instanceId: "frozen-1",
        fence: 3,
        address: `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
      };
      try {
        await withFollower(server, () => current, async (followerUrl) => {
          const send = async () =>
            await post(
              followerPath(server, followerUrl),
              "alice-token",
              await saveBody(server),
            );
          for (let i = 0; i < 2; i++) {
            const lost = await send();
            assertEquals(lost.status, 503);
            assertEquals(lost.json.inFlight, true);
          }
          const refused = await send();
          assertEquals(refused.status, 503);
          assertEquals(refused.json.code, "serve_not_leader");
          assertEquals(refused.json.inFlight, undefined);
          assert(String(refused.json.message).includes("Nothing was changed"));
          // the accept loop counts on the event loop, which may lag the kernel
          await waitFor(() => accepted === 2, "both lost forwards accepted");

          current = leaderAt(server);
          const landed = await send();
          assertEquals(landed.status, 200, JSON.stringify(landed.json));
        }, { commitResponseBaseMs: 200 });
      } finally {
        listener.close();
        for (const conn of held) conn.close();
        await frozenNode.catch(() => {});
      }
    });
  },
});

Deno.test({
  name:
    "team forwarding: a forward in flight to a frozen leader is answered as in flight once this node takes the lead, not at its deadline",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      let accepted = 0;
      const held: Deno.Conn[] = [];
      const frozenNode = (async () => {
        for await (const conn of listener) {
          accepted++;
          held.push(conn);
        }
      })();
      const frozen: ServeLeader = {
        ...leaderAt(server),
        instanceId: "frozen-1",
        fence: 3,
        address: `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
      };
      try {
        await withFollower(server, () => frozen, async (followerUrl, link) => {
          const pending = post(
            followerPath(server, followerUrl),
            "alice-token",
            await saveBody(server),
          );
          await waitFor(
            () => accepted === 1,
            "the forward to reach the leader",
          );
          link.abortForwards();
          const lost = await pending;
          assertEquals(lost.status, 503);
          assertEquals(lost.json.code, "serve_not_leader");
          assertEquals(lost.json.inFlight, true);
        }, { commitResponseBaseMs: 600_000 });
      } finally {
        listener.close();
        for (const conn of held) conn.close();
        await frozenNode.catch(() => {});
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

async function chunkUpload(
  server: Server,
  baseUrl: string,
  content: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  const sha = await sha256Hex(content);
  const partition = partitionOf({
    kind: "model",
    type: server.modelType,
    id: server.model.id,
  }).toString();
  return await fetch(
    `${baseUrl}/chunks/${sha}?partition=${encodeURIComponent(partition)}`,
    {
      method: "PUT",
      headers: { authorization: "Bearer alice-token" },
      body: content,
    },
  );
}

async function storedAtLeader(server: Server, sha: string): Promise<boolean> {
  const held = await server.v3.storage.has(
    "_default",
    [sha],
    new AbortController().signal,
  );
  return held.has(sha);
}

Deno.test({
  name:
    "team forwarding: a chunk uploaded to the follower is stored by the leader, sent on with its length",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const leader = leaderAt(server);
      await withFollower(server, () => leader, async (followerUrl) => {
        const content = new TextEncoder().encode(
          `chunk ${crypto.randomUUID()}`,
        );
        const sha = await sha256Hex(content);
        // LeaderLink drops content-length, so the leader's 411 stays away only
        // while fetch carries the length of the body serve received
        const upload = await chunkUpload(server, followerUrl, content);
        const body = await upload.json();
        assertEquals(upload.status, 201, JSON.stringify(body));
        assertEquals(body, { sha256: sha, size: content.byteLength });
        assert(await storedAtLeader(server, sha));
      });
    });
  },
});
