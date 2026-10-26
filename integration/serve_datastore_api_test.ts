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
 * Serve's datastore API (swamp-club#3915) end to end: an in-process client
 * against a port-0 server over a real v3 repository, as serve wires it.
 */

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { handleDatastoreRequest } from "../src/serve/datastore_api.ts";
import { matchDatastoreRoute } from "../src/serve/datastore_routes.ts";
import { resetRateLimitState } from "../src/serve/rate_limiter.ts";
import { UploadLedger } from "../src/infrastructure/datastore_v3/upload_ledger.ts";
import type {
  V3Datastore,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  v3DatastoreConfigOf,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { createServeCtx, grant } from "./serve_request_harness.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";

/** Bearer tokens the test server accepts, and whom they authenticate. */
const TOKENS: Record<string, string> = {
  "alice-token": "user:caller",
  "bob-token": "user:bob",
};

interface Server {
  readonly url: string;
  readonly v3: V3Datastore;
  readonly ctx: ConnectionContext;
  readonly modelType: ModelType;
  readonly model: Definition;
  /** Answers a request in-process, as the server does. */
  readonly handle: (req: Request) => Promise<Response>;
  policyLoads: number;
  close(): Promise<void>;
}

/**
 * Starts a port-0 server over a fresh v3 repository that holds one
 * behavior, `web`, and enforces `grants`.
 */
async function withServer(
  grants: Grant[],
  fn: (server: Server) => Promise<void>,
  ledger = new UploadLedger(),
): Promise<void> {
  resetRateLimitState();
  await withV3RowRepos({}, async (repos) => {
    const repo = repos.serveRepo;
    const model = Definition.create({ name: "web", globalArguments: {} });
    await runInRootUnitOfWork(
      repo.repoContext,
      { flush: undefined },
      () => repo.repoContext.definitionRepo.save(repo.modelType, model),
    );
    const location = await v3DatastoreConfigOf(
      repo.repoDir,
      repo.datastoreConfig,
    );
    assert(location !== undefined, "the fixture repository is v3");
    const v3 = v3DatastoreFor(repo.repoDir, location);
    const base = createServeCtx(repo, grants);
    const server: Server = {
      url: "",
      v3,
      ctx: base,
      modelType: repo.modelType,
      model,
      handle: () => Promise.reject(new Error("not started")),
      policyLoads: 0,
      close: () => Promise.resolve(),
    };
    const ctx = {
      ...base,
      policySnapshotLoader: Object.assign(
        Object.create(base.policySnapshotLoader ?? null),
        {
          decisionService: base.policySnapshotLoader?.decisionService,
          load: () => {
            server.policyLoads++;
            return Promise.resolve();
          },
        },
      ),
    } as ConnectionContext;
    const handle = async (req: Request): Promise<Response> => {
      const route = matchDatastoreRoute(new URL(req.url).pathname);
      if (route === undefined) return new Response("no", { status: 404 });
      return await handleDatastoreRequest(req, route, "127.0.0.1", {
        ctx,
        v3,
        ledger,
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
    };
    const http = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      handle,
    );
    try {
      Object.assign(server, {
        url: `http://127.0.0.1:${http.addr.port}/api/v1/datastore/_default`,
        ctx,
        handle,
      });
      await fn(server);
    } finally {
      await http.shutdown();
    }
  });
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
    .then((digest) =>
      Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
}

/** The framed body of a commit request. */
function commitBody(
  envelope: Record<string, unknown>,
  chunks: readonly Uint8Array[] = [],
): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(envelope));
  const total = 4 + json.length +
    chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const body = new Uint8Array(total);
  new DataView(body.buffer).setUint32(0, json.length);
  body.set(json, 4);
  let offset = 4 + json.length;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

function partitionPath(server: Server, id = server.model.id): string {
  const partition = partitionOf({
    kind: "model",
    type: server.modelType,
    id,
  });
  return `${server.url}/partitions/${
    encodeURIComponent(partition.toString())
  }/commits`;
}

/** The ops of a data save of `bytes`, stored as a chunk. */
async function blobSaveOps(
  server: Server,
  name: string,
  version: number,
  bytes: Uint8Array,
  modelId = server.model.id,
): Promise<unknown[]> {
  const type = server.modelType.normalized;
  const base = `data/${type}/${modelId}/${name}/${version}`;
  const intent = {
    kind: "data.save",
    model: { type, id: modelId },
    name,
    version,
  };
  return [
    {
      kind: "put",
      intent,
      key: `${base}/raw`,
      blob: { sha256: await sha256Hex(bytes), size: bytes.length },
    },
    {
      kind: "put",
      intent,
      key: `${base}/metadata.yaml`,
      inline: btoa("meta"),
    },
    {
      kind: "data-version",
      key: `${base}/metadata.yaml`,
      metadata: {
        name,
        id: crypto.randomUUID(),
        version,
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource" },
        ownerDefinition: { ownerType: "manual", ownerRef: "test" },
        createdAt: "2026-10-25T00:00:00.000Z",
      },
    },
  ];
}

async function post(
  url: string,
  token: string,
  body: Uint8Array,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/vnd.swamp.commit+v1",
    },
    body: body as Uint8Array<ArrayBuffer>,
  });
  return { status: response.status, json: await response.json() };
}

async function getJson(
  url: string,
  token: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, json: await response.json() };
}

/** A team member's grants: run, write and read, but not admin. */
const member = (): Grant[] => [
  grant({
    actions: ["read", "write", "run"],
    resource: { kind: "model", pattern: "*" },
  }),
  grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
];

/**
 * An admin's grants. Every forwarded write needs admin until
 * swamp-club#3922, so commits that should land are sent as one.
 */
const writer = (): Grant[] => [
  ...member(),
  grant({ actions: ["admin"], resource: { kind: "access", pattern: "*" } }),
];

Deno.test({
  name:
    "datastore API: a commit with its chunk lands, stamped with the caller, and is read back through has, Range, catch-up and changes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const content = new TextEncoder().encode("0123456789abcdef");
      const sha = await sha256Hex(content);
      const txnId = crypto.randomUUID();
      const committed = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId,
          ops: await blobSaveOps(server, "vpc", 1, content),
          chunks: [{ sha256: sha, size: content.length }],
        }, [content]),
      );
      assertEquals(committed.status, 200, JSON.stringify(committed.json));
      assertEquals(committed.json.seq, 1);

      // Stamped by serve: the caller, and serve's own writer.
      const [{ commit }] = await server.v3.commitStore.readPartition(
        server.v3.namespace,
        partitionOf({
          kind: "model",
          type: server.modelType,
          id: server.model.id,
        }),
        1,
        1,
      );
      assertEquals((commit as Commit).principal, "user:caller");
      assertEquals(commit.writer, server.v3.writer);

      // Serve's own checkout holds the file.
      assertEquals(
        await Deno.readFile(
          join(
            swampPath(server.ctx.repoDir),
            "data",
            server.modelType.normalized,
            server.model.id,
            "vpc",
            "1",
            "raw",
          ),
        ),
        content,
      );

      const has = await fetch(`${server.url}/chunks/has`, {
        method: "POST",
        headers: { authorization: "Bearer alice-token" },
        body: JSON.stringify({ hashes: [sha, "f".repeat(64)] }),
      });
      assertEquals((await has.json()).held, [sha]);

      const ranged = await fetch(`${server.url}/chunks/${sha}`, {
        headers: { authorization: "Bearer alice-token", range: "bytes=2-5" },
      });
      assertEquals(ranged.status, 206);
      assertEquals(await ranged.text(), "2345");

      const catchUp = await getJson(
        `${partitionPath(server)}?after=0`,
        "alice-token",
      );
      assertEquals(catchUp.status, 200);
      assertEquals((catchUp.json.commits as unknown[]).length, 1);
      assertEquals(catchUp.json.head, 1);

      const changes = await getJson(
        `${server.url}/changes?cursor=0`,
        "alice-token",
      );
      assertEquals(changes.status, 200);
      assertEquals((changes.json.changes as unknown[]).length, 1);
    });
  },
});

Deno.test({
  name:
    "datastore API: a client-sent principal or writer is refused, never taken",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      for (const field of ["principal", "writer", "namespace", "seq"]) {
        const refused = await post(
          partitionPath(server),
          "alice-token",
          commitBody({
            expectedSeq: 0,
            txnId: crypto.randomUUID(),
            ops: await blobSaveOps(server, "vpc", 1, new Uint8Array(0)),
            chunks: [],
            [field]: "forged",
          }),
        );
        assertEquals(refused.status, 400, field);
      }
    });
  },
});

Deno.test({
  name:
    "datastore API: a caller without write is refused per op, and nothing lands",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([], async (server) => {
      const content = new TextEncoder().encode("x");
      const refused = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: await blobSaveOps(server, "vpc", 1, content),
          chunks: [{ sha256: await sha256Hex(content), size: 1 }],
        }, [content]),
      );
      assertEquals(refused.status, 403);
      assertEquals(refused.json.code, "forbidden");
      assertEquals(refused.json.opIndex, 0);
    });
  },
});

Deno.test({
  name:
    "datastore API: a chunk whose bytes do not match its hash commits nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const content = new TextEncoder().encode("real");
      const refused = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: await blobSaveOps(server, "vpc", 1, content),
          chunks: [{ sha256: await sha256Hex(content), size: 4 }],
        }, [new TextEncoder().encode("fake")]),
      );
      assertEquals(refused.status, 400);
      assertEquals(refused.json.code, "chunk_hash_mismatch");
      const head = await server.v3.commitStore.head(
        server.v3.namespace,
        partitionOf({
          kind: "model",
          type: server.modelType,
          id: server.model.id,
        }),
      );
      assertEquals(head.seq, 0);
    });
  },
});

Deno.test({
  name:
    "datastore API: a chunk named only by its hash is refused, and its bytes stay unreadable to another caller",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Bob may write a behavior of his own but read nothing of Alice's.
    const grants = [
      ...writer(),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["run"],
        resource: { kind: "model", pattern: "bobs" },
      }),
    ];
    await withServer(grants, async (server) => {
      const secret = new TextEncoder().encode("alice's secret");
      const sha = await sha256Hex(secret);
      const landed = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: await blobSaveOps(server, "vpc", 1, secret),
          chunks: [{ sha256: sha, size: secret.length }],
        }, [secret]),
      );
      assertEquals(landed.status, 200);

      const bobs = Definition.create({ name: "bobs", globalArguments: {} });
      await runInRootUnitOfWork(
        server.ctx.repoContext,
        { flush: undefined },
        () =>
          server.ctx.repoContext.definitionRepo.save(server.modelType, bobs),
      );
      const stolen = await post(
        partitionPath(server, bobs.id),
        "bob-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: await blobSaveOps(server, "loot", 1, secret, bobs.id),
          chunks: [],
        }),
      );
      // Refused: Bob is no admin, and a commit naming a chunk it neither
      // carries nor may read is refused in any case.
      assertEquals(stolen.status, 403);

      const read = await fetch(`${server.url}/chunks/${sha}`, {
        headers: { authorization: "Bearer bob-token" },
      });
      assertEquals(read.status, 404);
      await read.body?.cancel();
      const has = await fetch(`${server.url}/chunks/has`, {
        method: "POST",
        headers: { authorization: "Bearer bob-token" },
        body: JSON.stringify({ hashes: [sha] }),
      });
      assertEquals((await has.json()).held, []);

      // Bob's changes feed holds none of Alice's commits, and still moves on.
      const changes = await getJson(
        `${server.url}/changes?cursor=0`,
        "bob-token",
      );
      assertEquals(changes.json.changes, []);
      assert((changes.json.cursor as number) > 0);
    });
  },
});

Deno.test({
  name:
    "datastore API: a stale expected seq and a failed precondition answer with actionable conflicts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const empty = new Uint8Array(0);
      const emptySha = await sha256Hex(empty);
      const first = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: await blobSaveOps(server, "vpc", 1, empty),
          chunks: [{ sha256: emptySha, size: 0 }],
        }, [empty]),
      );
      assertEquals(first.status, 200, JSON.stringify(first.json));

      const stale = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: await blobSaveOps(server, "vpc", 2, empty),
          chunks: [],
        }),
      );
      assertEquals(stale.status, 409);
      assertEquals(stale.json.code, "stale_seq");
      assertEquals(stale.json.seq, 1);

      const type = server.modelType.normalized;
      const key = `data/${type}/${server.model.id}/vpc/1/metadata.yaml`;
      const conflict = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 1,
          txnId: crypto.randomUUID(),
          ops: [{
            kind: "put",
            intent: {
              kind: "data.append",
              model: { type, id: server.model.id },
              name: "vpc",
              version: 1,
            },
            key,
            inline: btoa("new"),
            expect: { sha256: "0".repeat(64) },
          }],
          chunks: [],
        }),
      );
      assertEquals(conflict.status, 409);
      assertEquals(conflict.json.code, "precondition_failed");
      assertEquals(conflict.json.key, key);
      assertEquals(conflict.json.changedBy, "user:caller");
      assertEquals(conflict.json.seq, 1);
      assert(String(conflict.json.message).startsWith("Updates were rejected"));
    });
  },
});

Deno.test({
  name:
    "datastore API: a grant record written as plain data needs admin, and a control-plane commit reloads the policy",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = grant({
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    });
    for (
      const [grants, allowed] of [[member(), false], [[admin], true]] as const
    ) {
      await withServer([...grants], async (server) => {
        const grantType = ModelType.create("@swamp/grant");
        const id = crypto.randomUUID();
        const base = `data/@swamp/grant/${id}/grant-main/1`;
        const intent = {
          kind: "data.save",
          model: { type: "@swamp/grant", id },
          name: "grant-main",
          version: 1,
        };
        const partition = partitionOf({ kind: "model", type: grantType, id });
        const result = await post(
          `${server.url}/partitions/${
            encodeURIComponent(partition.toString())
          }/commits`,
          "alice-token",
          commitBody({
            expectedSeq: 0,
            txnId: crypto.randomUUID(),
            ops: [{
              kind: "put",
              intent,
              key: `${base}/raw`,
              inline: btoa("{}"),
            }],
            chunks: [],
          }),
        );
        assertEquals(result.status, allowed ? 200 : 403);
        assertEquals(server.policyLoads, allowed ? 1 : 0);
      });
    }
  },
});

Deno.test({
  name: "datastore API: a server whose datastore is not v3 says so",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const route = matchDatastoreRoute(
        "/api/v1/datastore/_default/changes",
      );
      assert(route !== undefined);
      const response = await handleDatastoreRequest(
        new Request("http://serve.test/api/v1/datastore/_default/changes", {
          headers: { authorization: "Bearer alice-token" },
        }),
        route,
        "127.0.0.1",
        {
          ctx: server.ctx,
          v3: undefined,
          ledger: new UploadLedger(),
          authenticate: () =>
            Promise.resolve({
              ok: true,
              principalId: "user:caller",
              collectives: [],
              groups: [],
              tokenName: "t",
              tokenCreatedAt: "2026-01-01T00:00:00Z",
            }),
        },
      );
      assertEquals(response.status, 409);
      assertEquals((await response.json()).code, "datastore_not_v3");
    });
  },
});

Deno.test({
  name:
    "datastore API: two commits racing for one key from different partitions land one, and refuse the other as owned elsewhere",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = grant({
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    });
    await withServer([admin], async (server) => {
      const type = server.modelType.normalized;
      // A definition file named by a uuid binds to any definition of its
      // kind: only key ownership tells two partitions apart.
      const key = `config/models/${type}/${crypto.randomUUID()}.yaml`;
      const definitionCommit = (name: string) =>
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: [{
            kind: "put",
            intent: {
              kind: "definition.create",
              definition: { kind: "model", name },
            },
            key,
            inline: btoa(`name: ${name}`),
          }],
          chunks: [],
        });
      const configPath = (name: string) =>
        `${server.url}/partitions/${
          encodeURIComponent(
            partitionOf({ kind: "config", definitionKind: "model", name })
              .toString(),
          )
        }/commits`;
      const results = await Promise.all([
        post(configPath("one"), "alice-token", definitionCommit("one")),
        post(configPath("two"), "alice-token", definitionCommit("two")),
      ]);
      const statuses = results.map((r) => r.status).sort();
      assertEquals(statuses, [200, 403], JSON.stringify(results));
      const refused = results.find((r) => r.status === 403)!;
      assertEquals(refused.json.reason, "key-owned-elsewhere");
    });
  },
});

Deno.test({
  name:
    "datastore API: an output named for another behavior of the same type is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const type = server.modelType.normalized;
      const victim = crypto.randomUUID();
      const forged = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: [{
            kind: "put",
            intent: {
              kind: "output.save",
              model: { type, id: server.model.id },
              outputId: "o",
            },
            key: `outputs/${type}/run/${victim}-2099-01-01T00-00-00-000Z.yaml`,
            inline: btoa(`definitionId: ${victim}`),
          }],
          chunks: [],
        }),
      );
      assertEquals(forged.status, 403);
      assertEquals(forged.json.reason, "key-outside-aggregate");
    });
  },
});

Deno.test({
  name:
    "datastore API: chunks a commit carries count toward the caller's upload quota",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ledger = new UploadLedger({ maxUnreferencedBytesPerPrincipal: 8 });
    await withServer(writer(), async (server) => {
      const content = new TextEncoder().encode("sixteen bytes!!!");
      const refused = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: await blobSaveOps(server, "vpc", 1, content),
          chunks: [{ sha256: await sha256Hex(content), size: content.length }],
        }, [content]),
      );
      assertEquals(refused.status, 429);
      assertEquals(refused.json.code, "upload_quota_exceeded");
    }, ledger);
  },
});

Deno.test({
  name:
    "datastore API: a chunk upload without a length is 411, and a commit declaring a malformed chunk size is 400",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const sha = "a".repeat(64);
      // A streamed body carries no Content-Length.
      const upload = await fetch(`${server.url}/chunks/${sha}`, {
        method: "PUT",
        headers: { authorization: "Bearer alice-token" },
        body: ReadableStream.from([new TextEncoder().encode("x")]),
      });
      assertEquals(upload.status, 411);
      assertEquals((await upload.json()).code, "length_required");

      for (const size of [-1, 1.5, "8"]) {
        const refused = await post(
          partitionPath(server),
          "alice-token",
          commitBody({
            expectedSeq: 0,
            txnId: crypto.randomUUID(),
            ops: await blobSaveOps(server, "vpc", 1, new Uint8Array(0)),
            chunks: [{ sha256: sha, size }],
          }),
        );
        assertEquals(refused.status, 400, String(size));
      }
    });
  },
});

Deno.test({
  name:
    "datastore API: a tag-conditioned deny hides a behavior definition's config partition from catch-up",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const configPath = (server: Server) =>
      `${server.url}/partitions/${
        encodeURIComponent(
          partitionOf({ kind: "config", definitionKind: "model", name: "db" })
            .toString(),
        )
      }/commits?after=0`;
    // The partition names no behavior type or tags, so a deny on tags
    // must fail closed rather than read as matching nothing.
    const deny = grant({
      effect: "deny",
      actions: ["read"],
      resource: { kind: "model", pattern: "*" },
      condition: 'tags.env == "prod"',
    });
    await withServer([...writer(), deny], async (server) => {
      const read = await getJson(configPath(server), "alice-token");
      assertEquals(read.status, 404);
    });
    await withServer(writer(), async (server) => {
      const read = await getJson(configPath(server), "alice-token");
      assertEquals(read.status, 200);
    });
  },
});

Deno.test({
  name:
    "datastore API: a deny on a behavior's data refuses a forwarded data delete that write on the behavior would allow",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Team members may edit and run behaviors; nobody may destroy web's data.
    const deny = grant({
      effect: "deny",
      actions: ["write"],
      resource: { kind: "data", pattern: "web" },
    });
    const writeData = grant({
      actions: ["write"],
      resource: { kind: "data", pattern: "*" },
    });
    for (
      const [grants, status] of [
        [[...writer(), writeData, deny], 403],
        [[...writer(), writeData], 200],
      ] as const
    ) {
      await withServer([...grants], async (server) => {
        const type = server.modelType.normalized;
        const result = await post(
          partitionPath(server),
          "alice-token",
          commitBody({
            expectedSeq: 0,
            txnId: crypto.randomUUID(),
            ops: [{
              kind: "tombstone",
              intent: {
                kind: "data.delete",
                model: { type, id: server.model.id },
                name: "vpc",
                version: 1,
              },
              key: `data/${type}/${server.model.id}/vpc/1/raw`,
            }],
            chunks: [],
          }),
        );
        assertEquals(result.status, status, JSON.stringify(result.json));
      });
    }
  },
});

Deno.test({
  name:
    "datastore API: a team member who is not an admin cannot forward a write until swamp-club#3922",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(member(), async (server) => {
      const content = new TextEncoder().encode("x");
      const refused = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: await blobSaveOps(server, "vpc", 1, content),
          chunks: [{ sha256: await sha256Hex(content), size: 1 }],
        }, [content]),
      );
      assertEquals(refused.status, 403);
      assertEquals(refused.json.code, "forbidden");
    });
  },
});

/** Whether serve's storage holds a chunk. */
async function stored(server: Server, sha: string): Promise<boolean> {
  const held = await server.v3.storage.has(
    "_default",
    [sha],
    new AbortController().signal,
  );
  return held.has(sha);
}

Deno.test({
  name:
    "datastore API: a chunk upload by a caller who is not an admin is refused before anything is stored or recorded",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ledger = new UploadLedger();
    await withServer(member(), async (server) => {
      const content = new TextEncoder().encode("member bytes");
      const sha = await sha256Hex(content);
      const refused = await fetch(`${server.url}/chunks/${sha}`, {
        method: "PUT",
        headers: { authorization: "Bearer alice-token" },
        body: content,
      });
      assertEquals(refused.status, 403);
      assertEquals((await refused.json()).code, "forbidden");
      assertEquals(ledger.size, 0);
      assertEquals(await stored(server, sha), false);
    }, ledger);
    await withServer(writer(), async (server) => {
      const content = new TextEncoder().encode("admin bytes");
      const sha = await sha256Hex(content);
      const uploaded = await fetch(`${server.url}/chunks/${sha}`, {
        method: "PUT",
        headers: { authorization: "Bearer alice-token" },
        body: content,
      });
      assertEquals(uploaded.status, 201);
      await uploaded.body?.cancel();
      assertEquals(await stored(server, sha), true);
    });
  },
});

Deno.test({
  name:
    "datastore API: chunk uploads in flight together cannot pass the caller's byte quota",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ledger = new UploadLedger({ maxUnreferencedBytesPerPrincipal: 10 });
    await withServer(writer(), async (server) => {
      const first = new TextEncoder().encode("first!");
      const second = new TextEncoder().encode("second");
      // The first upload's body is held open until the second is answered.
      let reading!: () => void;
      const started = new Promise<void>((resolve) => reading = resolve);
      let release!: () => void;
      const held = new Promise<void>((resolve) => release = resolve);
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          reading();
          await held;
          controller.enqueue(first);
          controller.close();
        },
      });
      const put = (sha: string, size: number, body: BodyInit) =>
        server.handle(
          new Request(`${server.url}/chunks/${sha}`, {
            method: "PUT",
            headers: {
              authorization: "Bearer alice-token",
              "content-length": String(size),
            },
            body,
          }),
        );
      const pending = put(await sha256Hex(first), first.length, body);
      await started;
      const refused = await put(
        await sha256Hex(second),
        second.length,
        second,
      );
      assertEquals(refused.status, 429);
      assertEquals((await refused.json()).code, "upload_quota_exceeded");
      release();
      assertEquals((await pending).status, 201);
      assertEquals(ledger.unreferencedBytes("user:caller", Date.now()), 6);
      assertEquals(ledger.reserved, 0);
    }, ledger);
  },
});

Deno.test({
  name:
    "datastore API: an upload whose body fails gives its reserved quota back",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ledger = new UploadLedger();
    await withServer(writer(), async (server) => {
      const content = new TextEncoder().encode("whole");
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(content.subarray(0, 2));
          controller.error(new Error("connection lost"));
        },
      });
      const failed = await server.handle(
        new Request(`${server.url}/chunks/${await sha256Hex(content)}`, {
          method: "PUT",
          headers: {
            authorization: "Bearer alice-token",
            "content-length": String(content.length),
          },
          body,
        }),
      );
      assert(failed.status >= 400, String(failed.status));
      await failed.body?.cancel();
      assertEquals(ledger.reserved, 0);
      assertEquals(ledger.size, 0);
      assertEquals(ledger.unreferencedBytes("user:caller", Date.now()), 0);
    }, ledger);
  },
});

Deno.test({
  name:
    "datastore API: chunks a commit carries count toward the caller's entry cap, and the chunk past it is not read",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ledger = new UploadLedger({ maxEntriesPerPrincipal: 1 });
    await withServer(writer(), async (server) => {
      const one = new TextEncoder().encode("one");
      const two = new TextEncoder().encode("two");
      const ops = [
        ...(await blobSaveOps(server, "a", 1, one)),
        ...(await blobSaveOps(server, "b", 1, two)),
      ];
      const refused = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops,
          chunks: [
            { sha256: await sha256Hex(one), size: one.length },
            { sha256: await sha256Hex(two), size: two.length },
          ],
        }, [one, two]),
      );
      assertEquals(refused.status, 429, JSON.stringify(refused.json));
      assertEquals(refused.json.code, "upload_quota_exceeded");
      assertEquals(await stored(server, await sha256Hex(two)), false);
      assertEquals(ledger.size, 0);
      assertEquals(ledger.reserved, 0);
    }, ledger);
  },
});

Deno.test({
  name:
    "datastore API: a commit naming too many chunks it does not carry is refused before its carried chunks are read",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ledger = new UploadLedger();
    await withServer(writer(), async (server) => {
      const carried = new TextEncoder().encode("c");
      const carriedSha = await sha256Hex(carried);
      // One blob of 1,026 one-byte parts: one carried, 1,025 not.
      const parts = [{ sha256: carriedSha, size: 1 }];
      for (let i = 0; i < 1025; i++) {
        parts.push({ sha256: i.toString(16).padStart(64, "0"), size: 1 });
      }
      const [raw, ...rest] = await blobSaveOps(server, "big", 1, carried);
      const ops = [{
        ...(raw as Record<string, unknown>),
        blob: { sha256: "e".repeat(64), size: parts.length, parts },
      }, ...rest];
      const refused = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops,
          chunks: [{ sha256: carriedSha, size: 1 }],
        }, [carried]),
      );
      assertEquals(refused.status, 413, JSON.stringify(refused.json));
      assertEquals(refused.json.code, "too_many_chunks");
      assertEquals(await stored(server, carriedSha), false);
      assertEquals(ledger.size, 0);
    }, ledger);
  },
});

/** A behavior definition named `name` of `type`, stored as one chunk. */
async function definitionCommit(
  name: string,
  type: string,
  content: Uint8Array,
): Promise<Uint8Array> {
  const sha = await sha256Hex(content);
  return commitBody({
    expectedSeq: 0,
    txnId: crypto.randomUUID(),
    ops: [{
      kind: "put",
      intent: {
        kind: "definition.create",
        definition: { kind: "model", name },
      },
      key: `config/models/${type}/${name}.yaml`,
      blob: { sha256: sha, size: content.length },
    }],
    chunks: [{ sha256: sha, size: content.length }],
  }, [content]);
}

Deno.test({
  name:
    "datastore API: a control-plane definition's commits and chunks stay hidden from a reader of its name, as the changes feed hides them",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Bob reads every behavior and its data, but is no admin.
    const grants = [
      ...writer(),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["read"],
        resource: { kind: "model", pattern: "*" },
      }),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["read"],
        resource: { kind: "data", pattern: "*" },
      }),
    ];
    for (
      const [type, readable] of [
        ["@swamp/grant", false],
        ["ordinary", true],
      ] as const
    ) {
      await withServer(grants, async (server) => {
        const typeName = type === "ordinary"
          ? server.modelType.normalized
          : type;
        const content = new TextEncoder().encode(
          `name: shared\n# ${type}\n`,
        );
        const sha = await sha256Hex(content);
        const configPath = `${server.url}/partitions/${
          encodeURIComponent(
            partitionOf({
              kind: "config",
              definitionKind: "model",
              name: "shared",
            })
              .toString(),
          )
        }/commits`;
        const landed = await post(
          configPath,
          "alice-token",
          await definitionCommit("shared", typeName, content),
        );
        assertEquals(landed.status, 200, JSON.stringify(landed.json));

        const catchUp = await getJson(`${configPath}?after=0`, "bob-token");
        assertEquals(catchUp.status, 200, type);
        assertEquals(catchUp.json.head, 1, type);
        assertEquals(
          (catchUp.json.commits as unknown[]).length,
          readable ? 1 : 0,
          type,
        );
        const changes = await getJson(
          `${server.url}/changes?cursor=0`,
          "bob-token",
        );
        assertEquals(
          (changes.json.changes as unknown[]).length,
          readable ? 1 : 0,
          type,
        );

        const read = await fetch(`${server.url}/chunks/${sha}`, {
          headers: { authorization: "Bearer bob-token" },
        });
        assertEquals(read.status, readable ? 200 : 404, type);
        await read.body?.cancel();
        const has = await fetch(`${server.url}/chunks/has`, {
          method: "POST",
          headers: { authorization: "Bearer bob-token" },
          body: JSON.stringify({ hashes: [sha] }),
        });
        assertEquals((await has.json()).held, readable ? [sha] : [], type);
      });
    }
  },
});

Deno.test({
  name:
    "datastore API: a commit naming a chunk only a behavior definition holds is vouched for under the commit lock",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // A 1 ms grace window: by the second commit the upload no longer holds,
    // so only the definition's partition can vouch, read under the
    // forwarded-commit lock.
    const ledger = new UploadLedger({ graceMs: 1 });
    await withServer(writer(), async (server) => {
      const content = new TextEncoder().encode("name: shared\n");
      const sha = await sha256Hex(content);
      const configPath = `${server.url}/partitions/${
        encodeURIComponent(
          partitionOf({
            kind: "config",
            definitionKind: "model",
            name: "shared",
          })
            .toString(),
        )
      }/commits`;
      const defined = await post(
        configPath,
        "alice-token",
        await definitionCommit("shared", server.modelType.normalized, content),
      );
      assertEquals(defined.status, 200, JSON.stringify(defined.json));
      await waitFor(
        () => !ledger.holds("user:caller", "_default", sha, Date.now()),
        "the upload's grace window to end",
      );
      const named = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: await blobSaveOps(server, "copy", 1, content),
          chunks: [],
        }),
      );
      assertEquals(named.status, 200, JSON.stringify(named.json));
    }, ledger);
  },
});
