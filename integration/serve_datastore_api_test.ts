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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import {
  handleDatastoreRequest,
  UNRESTRICTED_READ_ACCESS,
  VouchBudget,
} from "../src/serve/datastore_api.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { matchDatastoreRoute } from "../src/serve/datastore_routes.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  SERVE_DATASTORE_ACCESS_HEADER,
  SERVE_DATASTORE_LOG_HEADER,
} from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import { PolicySnapshot } from "../src/domain/access/policy_snapshot.ts";
import { UploadLedger } from "../src/infrastructure/datastore_v3/upload_ledger.ts";
import { ReadModelIncompleteError } from "../src/domain/datastore_v3/read_model.ts";
import { CommitsCompactedError } from "../src/domain/datastore_v3/commit_store.ts";
import { createDefinitionId } from "../src/domain/definitions/definition.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { grant } from "./serve_request_harness.ts";
import {
  findSpan,
  SpanKind,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  blobSaveOps,
  commitBody,
  dataMetadata,
  definitionYaml,
  getJson,
  member,
  partitionPath,
  post,
  type Server,
  sha256Hex,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

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
            inline: btoa(stringifyYaml(dataMetadata("vpc", 1))),
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

const MEMBER_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const MEMBER_SPAN = "00f067aa0ba902b7";

async function tracedChanges(
  server: Server,
  authenticated: boolean,
  flags: string,
): Promise<Response> {
  const route = matchDatastoreRoute("/api/v1/datastore/_default/changes");
  assert(route !== undefined);
  return await handleDatastoreRequest(
    new Request("http://serve.test/api/v1/datastore/_default/changes", {
      headers: {
        authorization: "Bearer member-token",
        traceparent: `00-${MEMBER_TRACE}-${MEMBER_SPAN}-${flags}`,
      },
    }),
    route,
    "127.0.0.1",
    {
      ctx: server.ctx,
      v3: undefined,
      ledger: new UploadLedger(),
      locks: server.locks,
      authenticate: () =>
        Promise.resolve(
          authenticated
            ? {
              ok: true,
              principalId: "user:caller",
              collectives: [],
              groups: [],
              tokenName: "t",
              tokenCreatedAt: "2026-01-01T00:00:00Z",
            }
            : {
              ok: false as const,
              error: "refused",
              reason: "revoked" as const,
            },
        ),
    },
  );
}

const CHANGES_SPAN = "GET /api/v1/datastore/{namespace}/changes";

Deno.test({
  name:
    "datastore API: an authenticated member's traceparent parents serve's span; a refused caller's is ignored (swamp-club#4457)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await withCapturedSpans(async (spans) => {
        const answered = await tracedChanges(server, true, "01");
        await answered.body?.cancel();
        const adopted = findSpan(spans, CHANGES_SPAN);
        assertEquals(adopted.kind, SpanKind.SERVER);
        assertEquals(adopted.spanContext().traceId, MEMBER_TRACE);
        assertEquals(adopted.parentSpanId, MEMBER_SPAN);
        assertEquals(adopted.attributes["http.response.status_code"], 409);
        const auth = findSpan(spans, "swamp.serve.datastore.authenticate");
        assertEquals(auth.parentSpanId, undefined);
        assert(auth.spanContext().traceId !== MEMBER_TRACE);
        assertEquals(
          adopted.links.map((link) => link.context.spanId),
          [auth.spanContext().spanId],
        );

        const before = spans.length;
        const refused = await tracedChanges(server, false, "01");
        await refused.body?.cancel();
        assertEquals(refused.status, 401);
        const root = findSpan(spans.slice(before), CHANGES_SPAN);
        assert(root.spanContext().traceId !== MEMBER_TRACE);
        assertEquals(root.parentSpanId, undefined);
        assertEquals(root.attributes["http.response.status_code"], 401);
      });
    });
  },
});

Deno.test({
  name:
    "datastore API: a member's sampled flag neither forces nor suppresses serve's own sampling (swamp-club#4457)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      await withCapturedSpans(async (spans) => {
        const unsampled = await tracedChanges(server, true, "00");
        await unsampled.body?.cancel();
        assertEquals(
          findSpan(spans, CHANGES_SPAN).spanContext().traceId,
          MEMBER_TRACE,
        );

        const before = spans.length;
        await withMockedEnv({ OTEL_TRACES_SAMPLER: "always_off" }, async () => {
          const sampled = await tracedChanges(server, true, "01");
          await sampled.body?.cancel();
        });
        assertEquals(
          spans.slice(before).filter((span) => span.name === CHANGES_SPAN)
            .length,
          0,
        );
      });
    });
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
          locks: server.locks,
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
            inline: btoa(
              new TextDecoder().decode(
                definitionYaml(name, type, key.split("/").pop()!.slice(0, -5)),
              ),
            ),
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
    "datastore API: a team member who is not an admin forwards a run's data save, and one without run on the behavior is refused (swamp-club#3922)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const content = new TextEncoder().encode("x");
    const body = async (server: Server) =>
      commitBody({
        expectedSeq: 0,
        txnId: crypto.randomUUID(),
        ops: await blobSaveOps(server, "vpc", 1, content),
        chunks: [{ sha256: await sha256Hex(content), size: 1 }],
      }, [content]);
    await withServer(member(), async (server) => {
      const landed = await post(
        partitionPath(server),
        "alice-token",
        await body(server),
      );
      assertEquals(landed.status, 200, JSON.stringify(landed.json));
    });
    const reader = [
      grant({ actions: ["read"], resource: { kind: "model", pattern: "*" } }),
      grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
    ];
    await withServer(reader, async (server) => {
      const refused = await post(
        partitionPath(server),
        "alice-token",
        await body(server),
      );
      assertEquals(refused.status, 403);
      assertEquals(refused.json.code, "forbidden");
      assertEquals(refused.json.reason, "forbidden");
    });
  },
});

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
    "datastore API: a chunk upload needs write access to the partition it names, or admin with none, decided before anything is stored or recorded",
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
      const modelPartition = partitionOf({
        kind: "model",
        type: server.modelType,
        id: server.model.id,
      }).toString();
      const autoPartition = partitionOf({
        kind: "definition",
        id: crypto.randomUUID(),
      }).toString();
      const forAuto = await fetch(
        `${server.url}/chunks/${sha}?partition=${
          encodeURIComponent(autoPartition)
        }`,
        {
          method: "PUT",
          headers: { authorization: "Bearer alice-token" },
          body: content,
        },
      );
      assertEquals(forAuto.status, 403);
      await forAuto.body?.cancel();
      assertEquals(ledger.size, 0);
      assertEquals(await stored(server, sha), false);
      const forModel = await fetch(
        `${server.url}/chunks/${sha}?partition=${
          encodeURIComponent(modelPartition)
        }`,
        {
          method: "PUT",
          headers: { authorization: "Bearer alice-token" },
          body: content,
        },
      );
      assertEquals(forModel.status, 201);
      await forModel.body?.cancel();
      assertEquals(await stored(server, sha), true);
    }, ledger);
    const reader = [
      grant({ actions: ["read"], resource: { kind: "model", pattern: "*" } }),
    ];
    await withServer(reader, async (server) => {
      const content = new TextEncoder().encode("reader bytes");
      const sha = await sha256Hex(content);
      const modelPartition = partitionOf({
        kind: "model",
        type: server.modelType,
        id: server.model.id,
      }).toString();
      const refused = await fetch(
        `${server.url}/chunks/${sha}?partition=${
          encodeURIComponent(modelPartition)
        }`,
        {
          method: "PUT",
          headers: { authorization: "Bearer alice-token" },
          body: content,
        },
      );
      assertEquals(refused.status, 403);
      await refused.body?.cancel();
      assertEquals(await stored(server, sha), false);
    });
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
        const content = definitionYaml("shared", typeName);
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
      const content = definitionYaml("shared", server.modelType.normalized);
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

Deno.test({
  name:
    "datastore API: every reply to an authenticated caller names the log's id, a refusal too; an unauthenticated one does not (swamp-club#4049)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const logId = server.v3.commitStore.logId();
      const get = async (url: string, token?: string) => {
        const response = await fetch(url, {
          headers: token === undefined
            ? {}
            : { authorization: `Bearer ${token}` },
        });
        await response.body?.cancel();
        return {
          status: response.status,
          log: response.headers.get(SERVE_DATASTORE_LOG_HEADER),
        };
      };

      assertEquals(await get(`${server.url}/changes?cursor=0`, "alice-token"), {
        status: 200,
        log: logId,
      });
      assertEquals(
        await get(`${partitionPath(server)}?after=0`, "alice-token"),
        { status: 200, log: logId },
      );
      assertEquals(
        await get(
          `${server.url.replace(/_default$/, "other")}/changes?cursor=0`,
          "alice-token",
        ),
        { status: 404, log: logId },
      );
      assertEquals(await get(`${server.url}/changes?cursor=0`), {
        status: 401,
        log: null,
      });
    });
  },
});

Deno.test({
  name:
    "datastore API: every reply to an authenticated caller names its read access, which a reload changes only when the caller's grants change (swamp-club#4089)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const grants = member();
    await withServer(grants, async (server) => {
      const get = async (url: string, token?: string) => {
        const response = await fetch(url, {
          headers: token === undefined
            ? {}
            : { authorization: `Bearer ${token}` },
        });
        await response.body?.cancel();
        return {
          status: response.status,
          access: response.headers.get(SERVE_DATASTORE_ACCESS_HEADER),
        };
      };
      const changes = `${server.url}/changes?cursor=0`;
      const first = await get(changes, "alice-token");
      assertEquals(first.status, 200);
      assert(first.access !== null && /^[0-9a-f]{64}$/.test(first.access));
      assertEquals(
        await get(
          `${server.url.replace(/_default$/, "other")}/changes?cursor=0`,
          "alice-token",
        ),
        { status: 404, access: first.access },
      );
      assertEquals(await get(changes), { status: 401, access: null });
      const bob = await get(changes, "bob-token");
      assert(bob.access !== null && bob.access !== first.access);

      const service = server.ctx.policySnapshotLoader!.decisionService;
      service.snapshot = new PolicySnapshot([
        ...grants,
        grant({
          subject: { kind: "user", name: "bob" },
          actions: ["read"],
          resource: { kind: "data", pattern: "*" },
        }),
      ], []);
      assertEquals(await get(changes, "alice-token"), first);
      assert((await get(changes, "bob-token")).access !== bob.access);
      service.snapshot = new PolicySnapshot([
        ...grants,
        grant({
          actions: ["admin"],
          resource: { kind: "access", pattern: "*" },
        }),
      ], []);
      const widened = await get(changes, "alice-token");
      assert(widened.access !== first.access);
      service.snapshot = new PolicySnapshot(grants, []);
      assertEquals(await get(changes, "alice-token"), first);
    });
  },
});

Deno.test({
  name:
    "datastore API: with authorization off every reply names the unrestricted read access (swamp-club#4089)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(member(), async (server) => {
      (server.ctx as { authConfig: ConnectionContext["authConfig"] })
        .authConfig = { ...server.ctx.authConfig, mode: "none" };
      const response = await fetch(`${server.url}/changes?cursor=0`);
      await response.body?.cancel();
      assertEquals(response.status, 200);
      assertEquals(
        response.headers.get(SERVE_DATASTORE_ACCESS_HEADER),
        UNRESTRICTED_READ_ACCESS,
      );
    });
  },
});

Deno.test({
  name:
    "datastore API: a reply names the read access serve held when it began answering, so a reload while it answers rebuilds the copy rather than hiding the change (swamp-club#4089)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const grants = member();
    await withServer(grants, async (server) => {
      const get = async () => {
        const response = await fetch(`${server.url}/changes?cursor=0`, {
          headers: { authorization: "Bearer alice-token" },
        });
        await response.body?.cancel();
        assertEquals(response.status, 200);
        return response.headers.get(SERVE_DATASTORE_ACCESS_HEADER);
      };
      const before = await get();
      const service = server.ctx.policySnapshotLoader!.decisionService;
      const narrowed = new PolicySnapshot(grants.slice(0, 1), []);
      const store = server.v3.commitStore;
      const changesSince = store.changesSince.bind(store);
      let swapped = false;
      (store as { changesSince: typeof store.changesSince }).changesSince = (
        ...args
      ) => {
        if (!swapped) {
          swapped = true;
          service.snapshot = narrowed;
        }
        return changesSince(...args);
      };
      try {
        const during = await get();
        assert(swapped, "the reload landed while serve answered");
        assertEquals(during, before, "the access it began answering under");
        assert(await get() !== before, "the next reply names the new access");
      } finally {
        delete (store as { changesSince?: unknown }).changesSince;
      }
    });
  },
});

/** Bob reads behaviors matching `pattern` and every behavior's data. */
function bobReads(pattern: string): Grant[] {
  return [
    ...writer(),
    grant({
      subject: { kind: "user", name: "bob" },
      actions: ["read"],
      resource: { kind: "model", pattern },
    }),
    grant({
      subject: { kind: "user", name: "bob" },
      actions: ["read"],
      resource: { kind: "data", pattern: "*" },
    }),
  ];
}

/** `GET chunks/{sha}` and `chunks/has` for `sha`, as `token`'s caller. */
async function chunkRead(
  server: Server,
  sha: string,
  token = "bob-token",
): Promise<
  { status: number; body: Record<string, unknown>; held: unknown[] }
> {
  const read = await fetch(`${server.url}/chunks/${sha}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = read.status === 200
    ? (await read.body?.cancel(), {})
    : await read.json();
  const has = await fetch(`${server.url}/chunks/has`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ hashes: [sha] }),
  });
  return { status: read.status, body, held: (await has.json()).held };
}

/**
 * Saves `bytes` as data of `others` behaviors that do not exist, whose ids
 * sort before any random one, then of `web`: `web`'s partition is the last
 * referencing the chunk in key order. Only the first commit carries it.
 */
async function sharedChunk(
  server: Server,
  others: number,
  bytes: Uint8Array,
): Promise<string> {
  const sha = await sha256Hex(bytes);
  const ids = Array.from(
    { length: others },
    (_, i) =>
      createDefinitionId(
        `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
      ),
  );
  assert(
    server.model.id > ids[ids.length - 1],
    "web's partition sorts last",
  );
  ids.push(server.model.id);
  let first = true;
  for (const id of ids) {
    const landed = await post(
      partitionPath(server, id),
      "alice-token",
      commitBody({
        expectedSeq: 0,
        txnId: crypto.randomUUID(),
        ops: await blobSaveOps(server, "out", 1, bytes, id),
        chunks: first ? [{ sha256: sha, size: bytes.length }] : [],
      }, first ? [bytes] : []),
    );
    assertEquals(landed.status, 200, JSON.stringify(landed.json));
    first = false;
  }
  return sha;
}

/** The commits path of the behavior definition `name`'s config partition. */
function configCommitsPath(server: Server, name: string): string {
  return `${server.url}/partitions/${
    encodeURIComponent(
      partitionOf({ kind: "config", definitionKind: "model", name })
        .toString(),
    )
  }/commits`;
}

/** Creates the definition `name` of `type` as `v1`, then edits it to `v2`. */
async function supersededDefinition(
  server: Server,
  name: string,
  type: string,
): Promise<{ v1: string; v2: string; v1Bytes: Uint8Array; id: string }> {
  const id = crypto.randomUUID();
  const v1 = definitionYaml(name, type, id);
  const v2 = new TextEncoder().encode(
    new TextDecoder().decode(definitionYaml(name, type, id)) + "# v2\n",
  );
  const versions = [
    [0, v1, "definition.create"],
    [1, v2, "definition.edit"],
  ] as const;
  for (const [expectedSeq, content, kind] of versions) {
    const sha = await sha256Hex(content);
    const landed = await post(
      configCommitsPath(server, name),
      "alice-token",
      commitBody({
        expectedSeq,
        txnId: crypto.randomUUID(),
        ops: [{
          kind: "put",
          intent: { kind, definition: { kind: "model", name } },
          key: `config/models/${type}/${name}.yaml`,
          blob: { sha256: sha, size: content.length },
        }],
        chunks: [{ sha256: sha, size: content.length }],
      }, [content]),
    );
    assertEquals(landed.status, 200, JSON.stringify(landed.json));
  }
  return {
    v1: await sha256Hex(v1),
    v2: await sha256Hex(v2),
    v1Bytes: v1,
    id,
  };
}

Deno.test({
  name:
    "datastore API: a chunk referenced by more than 64 partitions is served through the last one the caller may read, and refused as missing when it may read none (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(bobReads("web"), async (server) => {
      const sha = await sharedChunk(
        server,
        64,
        new TextEncoder().encode("common"),
      );
      const read = await chunkRead(server, sha);
      assertEquals(read.status, 200);
      assertEquals(read.held, [sha]);
    });
    await withServer(bobReads("nothing-here"), async (server) => {
      const sha = await sharedChunk(
        server,
        64,
        new TextEncoder().encode("common"),
      );
      const read = await chunkRead(server, sha);
      assertEquals(read.status, 404);
      assertEquals(read.body, { code: "not_found", message: "No such chunk" });
      assertEquals(read.held, []);
    });
  },
});

Deno.test({
  name:
    "datastore API: a superseded definition's chunk is served to a reader of its commit, and stays hidden for a control-plane definition (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    for (
      const [type, readable] of [
        ["ordinary", true],
        ["@swamp/grant", false],
      ] as const
    ) {
      await withServer(bobReads("*"), async (server) => {
        const typeName = type === "ordinary"
          ? server.modelType.normalized
          : type;
        const { v1, v2 } = await supersededDefinition(
          server,
          "shared",
          typeName,
        );
        for (const sha of [v1, v2]) {
          const read = await chunkRead(server, sha);
          assertEquals(read.status, readable ? 200 : 404, type);
          assertEquals(read.held, readable ? [sha] : [], type);
        }
      });
    }
  },
});

Deno.test({
  name:
    "datastore API: a superseded definition's chunk is vouched for through the compacted base and the commits after it (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(bobReads("*"), async (server) => {
      const type = server.modelType.normalized;
      const { v1, v2, id } = await supersededDefinition(
        server,
        "shared",
        type,
      );
      // Folds v1's commit into the base; v2 is superseded by v3, stored.
      const store = server.v3.commitStore;
      const point = (await store.changesSince(0, 1))[0].cursor;
      const fence = store.writerFence();
      await store.compactHistory(point, fence === undefined ? {} : { fence });
      const v3 = new TextEncoder().encode(
        new TextDecoder().decode(definitionYaml("shared", type, id)) +
          "# v3\n",
      );
      const v3Sha = await sha256Hex(v3);
      const landed = await post(
        configCommitsPath(server, "shared"),
        "alice-token",
        commitBody({
          expectedSeq: 2,
          txnId: crypto.randomUUID(),
          ops: [{
            kind: "put",
            intent: {
              kind: "definition.edit",
              definition: { kind: "model", name: "shared" },
            },
            key: `config/models/${type}/shared.yaml`,
            blob: { sha256: v3Sha, size: v3.length },
          }],
          chunks: [{ sha256: v3Sha, size: v3.length }],
        }, [v3]),
      );
      assertEquals(landed.status, 200, JSON.stringify(landed.json));
      for (const sha of [v1, v2, v3Sha]) {
        assertEquals((await chunkRead(server, sha)).status, 200, sha);
      }
    });
  },
});

Deno.test({
  name:
    "datastore API: a definition chunk is answered from history while serve's read model is incomplete, never waiting on it (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(bobReads("*"), async (server) => {
      const { v2 } = await supersededDefinition(
        server,
        "shared",
        server.modelType.normalized,
      );
      // As after a restart, a restore or a takeover: the index is not
      // complete, for every caller.
      const readModel = server.v3.readModel as {
        liveRecords: (...args: unknown[]) => Promise<unknown>;
      };
      const original = readModel.liveRecords;
      let asked = 0;
      readModel.liveRecords = () => {
        asked++;
        return Promise.reject(new ReadModelIncompleteError());
      };
      try {
        for (const token of ["bob-token", "alice-token"]) {
          const read = await chunkRead(server, v2, token);
          assertEquals(read.status, 200, token);
          assertEquals(read.held, [v2], token);
        }
        // Asked, refused as incomplete, and decided from history instead.
        assert(asked > 0, "the live records were asked first");
      } finally {
        readModel.liveRecords = original;
      }
    });
  },
});

Deno.test({
  name:
    "datastore API: a commit naming a superseded definition's chunk it may read is vouched for without carrying it (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ledger = new UploadLedger({ graceMs: 1 });
    await withServer(writer(), async (server) => {
      const { v1, v1Bytes } = await supersededDefinition(
        server,
        "shared",
        server.modelType.normalized,
      );
      await waitFor(
        () => !ledger.holds("user:caller", "_default", v1, Date.now()),
        "the upload's grace window to end",
      );
      const named = await post(
        partitionPath(server),
        "alice-token",
        commitBody({
          expectedSeq: 0,
          txnId: crypto.randomUUID(),
          ops: await blobSaveOps(server, "copy", 1, v1Bytes),
          chunks: [],
        }),
      );
      assertEquals(named.status, 200, JSON.stringify(named.json));
    }, ledger);
  },
});

/** A budget that counts what it allowed. */
class CountingBudget extends VouchBudget {
  partitionsSpent = 0;
  override spendPartition(): boolean {
    const spent = super.spendPartition();
    if (spent) this.partitionsSpent++;
    return spent;
  }
}

Deno.test({
  name:
    "datastore API: past the request's vouch budget a chunk read is undecided, a 503 that names no partition, and has leaves it out; the work stops at the budget (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const budgets: CountingBudget[] = [];
    let limit = 3;
    const vouchBudget = () => {
      const budget = new CountingBudget(limit, 100);
      budgets.push(budget);
      return budget;
    };
    await withServer(
      bobReads("web"),
      async (server) => {
        // Five partitions reference the chunk; bob may read only the last.
        const sha = await sharedChunk(
          server,
          4,
          new TextEncoder().encode("common"),
        );
        budgets.length = 0;
        const read = await fetch(`${server.url}/chunks/${sha}`, {
          headers: { authorization: "Bearer bob-token" },
        });
        assertEquals(read.status, 503);
        const body = await read.json();
        assertEquals(body.code, "chunk_access_undecided");
        assert(!JSON.stringify(body).includes("model"), JSON.stringify(body));
        // Two hashes in one has share one budget: the second gets none.
        const has = await fetch(`${server.url}/chunks/has`, {
          method: "POST",
          headers: { authorization: "Bearer bob-token" },
          body: JSON.stringify({ hashes: [sha, sha.replace(/^./, "0")] }),
        });
        assertEquals((await has.json()).held, []);
        assertEquals(budgets.map((budget) => budget.partitionsSpent), [3, 3]);
        // A budget that reaches the last partition serves it.
        limit = 5;
        const served = await chunkRead(server, sha);
        assertEquals(served.status, 200);
        assertEquals(served.held, [sha]);
      },
      new UploadLedger(),
      { vouchBudget },
    );
  },
});

Deno.test({
  name:
    "datastore API: a chunk has leaves out is carried by the commit naming it, which lands (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(
      writer(),
      async (server) => {
        const bytes = new TextEncoder().encode("carried");
        const sha = await sha256Hex(bytes);
        const has = await fetch(`${server.url}/chunks/has`, {
          method: "POST",
          headers: { authorization: "Bearer alice-token" },
          body: JSON.stringify({ hashes: [sha] }),
        });
        assertEquals((await has.json()).held, []);
        const landed = await post(
          partitionPath(server),
          "alice-token",
          commitBody({
            expectedSeq: 0,
            txnId: crypto.randomUUID(),
            ops: await blobSaveOps(server, "out", 1, bytes),
            chunks: [{ sha256: sha, size: bytes.length }],
          }, [bytes]),
        );
        assertEquals(landed.status, 200, JSON.stringify(landed.json));
      },
      new UploadLedger(),
      { vouchBudget: () => new VouchBudget(0, 0) },
    );
  },
});

Deno.test({
  name:
    "datastore API: a definition's history is read newest first, so a recent superseded version is vouched for within a budget an old one runs out, which is refused (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(
      bobReads("*"),
      async (server) => {
        // Four versions, the fourth live: two commit reads reach the third,
        // never the first.
        const [first, , third] = await editDefinition(
          server,
          "shared",
          server.modelType.normalized,
          0,
          4,
          "definition.create",
        );
        const recent = await chunkRead(server, third);
        assertEquals(recent.status, 200);
        assertEquals(recent.held, [third]);
        const old = await chunkRead(server, first);
        assertEquals(old.status, 404);
        assertEquals(old.held, []);
      },
      new UploadLedger(),
      { vouchLimits: { partitions: 1024, commits: 2 } },
    );
  },
});

Deno.test({
  name:
    "datastore API: a content-checked put naming a chunk the budget cannot decide is answered chunk_not_provided, not refused as content (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ledger = new UploadLedger({ graceMs: 1 });
    await withServer(
      writer(),
      async (server) => {
        const type = server.modelType.normalized;
        const { v1, v1Bytes } = await supersededDefinition(
          server,
          "shared",
          type,
        );
        await waitFor(
          () => !ledger.holds("user:caller", "_default", v1, Date.now()),
          "the upload's grace window to end",
        );
        // A revert of shared to v1, naming v1's chunk without carrying it.
        const named = await post(
          configCommitsPath(server, "shared"),
          "alice-token",
          commitBody({
            expectedSeq: 2,
            txnId: crypto.randomUUID(),
            ops: [{
              kind: "put",
              intent: {
                kind: "definition.edit",
                definition: { kind: "model", name: "shared" },
              },
              key: `config/models/${type}/shared.yaml`,
              blob: { sha256: v1, size: v1Bytes.length },
            }],
            chunks: [],
          }),
        );
        assertEquals(named.status, 403, JSON.stringify(named.json));
        assertEquals(named.json.code, "chunk_not_provided");
        // No partition checks at all: the chunk is undecided.
      },
      ledger,
      { vouchBudget: () => new VouchBudget(0, 10_000) },
    );
  },
});

Deno.test({
  name:
    "datastore API: a definition chunk whose decision a compaction moved twice is undecided, never answered as missing (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(bobReads("*"), async (server) => {
      // A control-plane definition: no commit bob may read names v1, so
      // the decision reaches the compaction-point check.
      const { v1 } = await supersededDefinition(
        server,
        "shared",
        "@swamp/grant",
      );
      // Each look at the compaction point finds it moved.
      const store = server.v3.commitStore as {
        compactionPoint: () => Promise<number>;
      };
      const original = store.compactionPoint;
      let point = 0;
      store.compactionPoint = () => Promise.resolve(++point);
      try {
        const read = await fetch(`${server.url}/chunks/${v1}`, {
          headers: { authorization: "Bearer bob-token" },
        });
        assertEquals(read.status, 503);
        assertEquals((await read.json()).code, "chunk_access_undecided");
      } finally {
        store.compactionPoint = original;
      }
      // With the point still, the same read is decided: refused.
      assertEquals((await chunkRead(server, v1)).status, 404);
    });
  },
});

Deno.test({
  name:
    "datastore API: a forwarded commit decides a chunk it may not name once, within one budget (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let budgets = 0;
    await withServer(
      writer(),
      async (server) => {
        const type = server.modelType.normalized;
        // Bytes serve never received, which no partition names.
        const content = definitionYaml("other", type);
        const sha = await sha256Hex(content);
        budgets = 0;
        const named = await post(
          configCommitsPath(server, "other"),
          "alice-token",
          commitBody({
            expectedSeq: 0,
            txnId: crypto.randomUUID(),
            ops: [{
              kind: "put",
              intent: {
                kind: "definition.create",
                definition: { kind: "model", name: "other" },
              },
              key: `config/models/${type}/other.yaml`,
              blob: { sha256: sha, size: content.length },
            }],
            chunks: [],
          }),
        );
        assertEquals(named.status, 403, JSON.stringify(named.json));
        assertEquals(budgets, 1);
      },
      new UploadLedger(),
      {
        vouchBudget: () => {
          budgets++;
          return new VouchBudget();
        },
      },
    );
  },
});

Deno.test({
  name:
    "datastore API: a definition chunk whose history is compacted again mid-read is undecided, and the reply names no partition (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(bobReads("*"), async (server) => {
      const { v1 } = await supersededDefinition(
        server,
        "shared",
        "@swamp/grant",
      );
      // Every partition read finds its first commit compacted, retried or
      // not, and the compaction point moves each time it is looked at.
      const store = server.v3.commitStore as {
        readPartition: (...args: unknown[]) => Promise<unknown>;
        compactionPoint: () => Promise<number>;
      };
      const read = store.readPartition;
      const compactionPoint = store.compactionPoint;
      let point = 0;
      // Each read is refused as compacted through the seq it starts at, so
      // the retry from just past it is refused again.
      store.readPartition = (...args: unknown[]) =>
        Promise.reject(
          new CommitsCompactedError(
            ++point,
            "compacted meanwhile",
            args[2] as number,
          ),
        );
      store.compactionPoint = () => Promise.resolve(++point);
      try {
        const reply = await fetch(`${server.url}/chunks/${v1}`, {
          headers: { authorization: "Bearer bob-token" },
        });
        assertEquals(reply.status, 503);
        const body = await reply.json();
        assertEquals(body.code, "chunk_access_undecided");
        assert(!JSON.stringify(body).includes("shared"), JSON.stringify(body));
      } finally {
        store.readPartition = read;
        store.compactionPoint = compactionPoint;
      }
    });
  },
});

Deno.test({
  name:
    "datastore API: a compacted base vouches for a definition chunk only through the record the caller may read, not a same-named definition of another type (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(bobReads("*"), async (server) => {
      // Two definitions named shared share one config partition: one of an
      // ordinary type bob may read, one of a control-plane type only an
      // admin may.
      const types = [server.modelType.normalized, "@swamp/grant"];
      const shas: string[] = [];
      for (const [expectedSeq, type] of types.entries()) {
        const content = definitionYaml("shared", type);
        const sha = await sha256Hex(content);
        shas.push(sha);
        const landed = await post(
          configCommitsPath(server, "shared"),
          "alice-token",
          commitBody({
            expectedSeq,
            txnId: crypto.randomUUID(),
            ops: [{
              kind: "put",
              intent: {
                kind: "definition.create",
                definition: { kind: "model", name: "shared" },
              },
              key: `config/models/${type}/shared.yaml`,
              blob: { sha256: sha, size: content.length },
            }],
            chunks: [{ sha256: sha, size: content.length }],
          }, [content]),
        );
        assertEquals(landed.status, 200, JSON.stringify(landed.json));
      }
      // Folds both commits: only the base names either chunk now.
      const store = server.v3.commitStore;
      const fence = store.writerFence();
      await store.compactHistory(
        Number.MAX_SAFE_INTEGER,
        fence === undefined ? {} : { fence },
      );
      const config = partitionOf({
        kind: "config",
        definitionKind: "model",
        name: "shared",
      });
      for (const sha of shas) {
        assertEquals(
          (await store.baseRecordKeysNaming(server.v3.namespace, config, sha))
            .length,
          1,
        );
      }
      const [ordinary, controlPlane] = shas;
      const readable = await chunkRead(server, ordinary);
      assertEquals(readable.status, 200);
      assertEquals(readable.held, [ordinary]);
      const hidden = await chunkRead(server, controlPlane);
      assertEquals(hidden.status, 404);
      assertEquals(hidden.body, {
        code: "not_found",
        message: "No such chunk",
      });
      assertEquals(hidden.held, []);
      for (const sha of shas) {
        const admin = await chunkRead(server, sha, "alice-token");
        assertEquals(admin.status, 200, sha);
        assertEquals(admin.held, [sha], sha);
      }
    });
  },
});

/** Edits the definition `name` of `type` from `fromSeq`, `count` times. */
async function editDefinition(
  server: Server,
  name: string,
  type: string,
  fromSeq: number,
  count: number,
  kind: "definition.create" | "definition.edit" = "definition.edit",
): Promise<string[]> {
  const id = crypto.randomUUID();
  const shas: string[] = [];
  for (let i = 0; i < count; i++) {
    const content = new TextEncoder().encode(
      new TextDecoder().decode(definitionYaml(name, type, id)) + `# ${i}\n`,
    );
    const sha = await sha256Hex(content);
    shas.push(sha);
    const landed = await post(
      configCommitsPath(server, name),
      "alice-token",
      commitBody({
        expectedSeq: fromSeq + i,
        txnId: crypto.randomUUID(),
        ops: [{
          kind: i === 0 ? kind : "put",
          intent: {
            kind: i === 0 ? kind : "definition.edit",
            definition: { kind: "model", name },
          },
          key: `config/models/${type}/${name}.yaml`,
          blob: { sha256: sha, size: content.length },
        }].map((op) => ({ ...op, kind: "put" })),
        chunks: [{ sha256: sha, size: content.length }],
      }, [content]),
    );
    assertEquals(landed.status, 200, JSON.stringify(landed.json));
  }
  return shas;
}

Deno.test({
  name:
    "datastore API: a commit budget run out over history the caller may read none of is refused, as for a chunk nothing names, never undecided (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(
      bobReads("*"),
      async (server) => {
        // A control-plane definition bob may not read, edited past the
        // budget: its first version's chunk sits behind the rest.
        const [first] = await editDefinition(
          server,
          "shared",
          "@swamp/grant",
          0,
          4,
          "definition.create",
        );
        const guessed = await chunkRead(server, first);
        const unnamed = await chunkRead(server, "e".repeat(64));
        assertEquals(guessed.status, 404);
        assertEquals(guessed.body, unnamed.body);
        assertEquals(guessed.held, []);
      },
      new UploadLedger(),
      { vouchLimits: { partitions: 1024, commits: 2 } },
    );
  },
});

Deno.test({
  name:
    "datastore API: a live definition record vouches for its chunk whatever the history of a same-named type in front of it (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(
      bobReads("*"),
      async (server) => {
        // bob's readable definition, then a control-plane one of the same name
        // edited past the budget, which a newest-first scan reads first.
        const [live] = await editDefinition(
          server,
          "shared",
          server.modelType.normalized,
          0,
          1,
          "definition.create",
        );
        await editDefinition(
          server,
          "shared",
          "@swamp/grant",
          1,
          4,
          "definition.create",
        );
        const read = await chunkRead(server, live);
        assertEquals(read.status, 200);
        assertEquals(read.held, [live]);
      },
      new UploadLedger(),
      { vouchLimits: { partitions: 1024, commits: 2 } },
    );
  },
});

Deno.test({
  name:
    "datastore API: a commit naming more held chunks than one request's budget covers lands, as it did before the budget (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Bob writes web; another behavior's partition, which he may not read,
    // names each chunk first, so vouching for each costs two checks.
    const grants = [
      ...writer(),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["read", "write", "run"],
        resource: { kind: "model", pattern: "web" },
      }),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["read"],
        resource: { kind: "data", pattern: "web" },
      }),
    ];
    await withServer(
      grants,
      async (server) => {
        const other = createDefinitionId(
          "00000000-0000-4000-8000-000000000000",
        );
        assert(server.model.id > other, "web's partition sorts last");
        const contents = ["one", "two"].map((text) =>
          new TextEncoder().encode(text)
        );
        for (const [i, bytes] of contents.entries()) {
          const sha = await sha256Hex(bytes);
          for (const id of [other, server.model.id]) {
            const landed = await post(
              partitionPath(server, id),
              "alice-token",
              commitBody({
                expectedSeq: i,
                txnId: crypto.randomUUID(),
                ops: await blobSaveOps(server, `held-${i}`, 1, bytes, id),
                chunks: [{ sha256: sha, size: bytes.length }],
              }, [bytes]),
            );
            assertEquals(landed.status, 200, JSON.stringify(landed.json));
          }
        }
        // Two chunks at two checks each, past a budget of two.
        const ops = [
          ...(await blobSaveOps(server, "copy-0", 1, contents[0])),
          ...(await blobSaveOps(server, "copy-1", 1, contents[1])),
        ];
        const named = await post(
          partitionPath(server),
          "bob-token",
          commitBody({
            expectedSeq: 2,
            txnId: crypto.randomUUID(),
            ops,
            chunks: [],
          }),
        );
        assertEquals(named.status, 200, JSON.stringify(named.json));
      },
      new UploadLedger(),
      { vouchLimits: { partitions: 2, commits: 10_000 } },
    );
  },
});

Deno.test({
  name:
    "datastore API: a commit budget run out over a same-named type's commits the caller may read leaves a control-plane chunk refused as missing, never undecided (swamp-club#4260)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(
      bobReads("*"),
      async (server) => {
        // A control-plane definition bob may not read, then a same-named one
        // of an ordinary type he may, edited past the budget in front of it.
        const [hidden] = await editDefinition(
          server,
          "shared",
          "@swamp/grant",
          0,
          1,
          "definition.create",
        );
        await editDefinition(
          server,
          "shared",
          server.modelType.normalized,
          1,
          4,
          "definition.create",
        );
        const guessed = await chunkRead(server, hidden);
        const unnamed = await chunkRead(server, "e".repeat(64));
        assertEquals(guessed.status, 404);
        assertEquals(guessed.body, unnamed.body);
        assertEquals(guessed.held, []);
      },
      new UploadLedger(),
      { vouchLimits: { partitions: 1024, commits: 2 } },
    );
  },
});

Deno.test({
  name:
    "datastore API: a commit that lands but cannot be confirmed as replicated is logged by serve, not only answered to the member (swamp-club#4522)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const captured: LogRecord[] = [];
    await configure({
      sinks: { capture: (record: LogRecord) => captured.push(record) },
      loggers: [
        {
          category: ["serve", "datastore-api"],
          lowestLevel: "warning",
          sinks: ["capture"],
        },
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
      ],
      reset: true,
    });
    try {
      await withServer(writer(), async (server) => {
        server.ctx.confirmReplicated = () =>
          Promise.reject(
            new Error(
              "the replicated state could not be published: GCS putObject failed HTTP 429 rateLimitExceeded",
            ),
          );
        const content = new TextEncoder().encode("0123456789abcdef");
        const sha = await sha256Hex(content);
        const committed = await post(
          partitionPath(server),
          "alice-token",
          commitBody({
            expectedSeq: 0,
            txnId: crypto.randomUUID(),
            ops: await blobSaveOps(server, "vpc", 1, content),
            chunks: [{ sha256: sha, size: content.length }],
          }, [content]),
        );
        assertEquals(committed.status, 503, JSON.stringify(committed.json));
        assertEquals(committed.json.seq, 1);
      });
      const warnings = captured.map((r) =>
        r.message.map((p) => String(p)).join("")
      );
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0], "Commit 1 to partition");
      assertStringIncludes(warnings[0], "could not be confirmed");
      assertStringIncludes(warnings[0], "HTTP 429 rateLimitExceeded");
    } finally {
      await reset();
      await initializeLogging({});
    }
  },
});
