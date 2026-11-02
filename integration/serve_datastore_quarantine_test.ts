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
import type {
  PersistedLease,
  PersistedLeaseStore,
} from "../src/domain/datastore_v3/persisted_lease.ts";
import {
  DatastoreLockLeases,
  lockKeyOf,
} from "../src/serve/datastore_locks.ts";
import { grant } from "./serve_request_harness.ts";
import { stringify as stringifyYaml } from "@std/yaml";
import { Commit } from "../src/domain/datastore_v3/commit.ts";
import { opFromJSON } from "../src/domain/datastore_v3/op.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import {
  chunksToWire,
  MAX_QUARANTINED_PER_PRINCIPAL,
} from "../src/domain/datastore_v3/quarantine.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  MAX_CONCURRENT_CHUNK_REQUESTS,
  MAX_QUARANTINE_REQUEST_BYTES,
} from "../src/serve/datastore_api.ts";
import {
  createDatastoreStatusDeps,
  datastoreStatus,
  type DatastoreStatusData,
  quarantineStatusOf,
} from "../src/libswamp/datastores/status.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { getSwampLogger } from "../src/infrastructure/logging/logger.ts";
import {
  blobSaveOps,
  call,
  commitBody,
  modelKey,
  partitionPath,
  post,
  save,
  saveBody,
  type Server,
  sha256Hex,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

function bobReads(
  subject: { kind: "user" | "idp-group"; name: string } = {
    kind: "user",
    name: "bob",
  },
) {
  return [
    grant({
      subject,
      actions: ["read"],
      resource: { kind: "model", pattern: "*" },
    }),
    // the harness behavior's own data, not data:*: a data grant also reads a
    // vault of that name, which the vault tests rely on bob lacking
    grant({
      subject,
      actions: ["read"],
      resource: { kind: "data", pattern: "web" },
    }),
  ];
}

async function bobsChange(
  server: Server,
  version: number,
  bytes = new TextEncoder().encode(`bob's version ${version}`),
  executedAt = new Date().toISOString(),
): Promise<{ commit: Commit; chunk: { sha256: string; bytes: Uint8Array } }> {
  const ops = await Promise.all(
    (await blobSaveOps(server, "vpc", version, bytes)).map((op) =>
      opFromJSON(op)
    ),
  );
  const commit = Commit.create({
    seq: 1,
    partition: partitionOf({
      kind: "model",
      type: server.modelType,
      id: server.model.id,
    }),
    namespace: server.v3.namespace,
    txnId: crypto.randomUUID(),
    writer: { host: "bobs-laptop", pid: 1, instance: crypto.randomUUID() },
    executedAt,
    at: new Date().toISOString(),
    ops,
  });
  return { commit, chunk: { sha256: await sha256Hex(bytes), bytes } };
}

async function deposit(
  server: Server,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return await call(server, "POST", "quarantine", token, body);
}

function depositBody(
  change: Awaited<ReturnType<typeof bobsChange>>,
  chunks = [change.chunk],
): unknown {
  return {
    commit: change.commit.toJSON(),
    base: { seq: 0 },
    chunks: chunksToWire(chunks),
  };
}

function captureAudit(server: Server): AuditEvent[] {
  const events: AuditEvent[] = [];
  (server.ctx as { auditEmitter?: unknown }).auditEmitter = {
    emit: (event: AuditEvent) => events.push(event),
    durableStalled: false,
  } as unknown as ConnectionContext["auditEmitter"];
  return events;
}

Deno.test({
  name:
    "datastore quarantine: only a change refused for a grant its author lacks is kept, whole and once",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const change = await bobsChange(server, 1);

      const allowed = await deposit(
        server,
        "alice-token",
        depositBody(change),
      );
      assertEquals(allowed.status, 409, JSON.stringify(allowed.json));
      assertEquals(allowed.json.code, "not_quarantinable");

      const missing = await deposit(
        server,
        "bob-token",
        depositBody(change, []),
      );
      assertEquals(missing.status, 400);
      const forged = await deposit(server, "bob-token", {
        ...(depositBody(change) as Record<string, unknown>),
        chunks: [{ sha256: change.chunk.sha256, data: btoa("other bytes") }],
      });
      assertEquals(forged.status, 400);
      assertEquals(forged.json.message, "Malformed quarantine deposit");

      const kept = await deposit(server, "bob-token", depositBody(change));
      assertEquals(kept.status, 201, JSON.stringify(kept.json));
      const again = await deposit(server, "bob-token", depositBody(change));
      assertEquals(again.json.duplicate, true);
      const record = await server.quarantine.find(change.commit.txnId);
      assertEquals(record?.principal, "user:bob");
      assertEquals(record?.state, "held");
      assert(record?.reason.includes("Not authorized"), record?.reason);
      const content = await server.quarantine.content(change.commit.txnId);
      assertEquals(content?.chunks.map((chunk) => chunk.sha256), [
        change.chunk.sha256,
      ]);

      const claimed = await deposit(server, "alice-token", depositBody(change));
      assertEquals(claimed.status, 409);

      // A txnId that already landed is not kept: accepting it would record
      // another commit's seq against it.
      const landedTxnId = crypto.randomUUID();
      const landed = await post(
        partitionPath(server),
        "alice-token",
        await saveBody(server, 2, 0, { txnId: landedTxnId }),
      );
      assertEquals(landed.status, 200, JSON.stringify(landed.json));
      const reused = {
        ...change,
        commit: await Commit.fromJSON({
          ...change.commit.toJSON(),
          txnId: landedTxnId,
        }),
      };
      const refusedLanded = await deposit(
        server,
        "bob-token",
        depositBody(reused),
      );
      assertEquals(
        refusedLanded.status,
        409,
        JSON.stringify(refusedLanded.json),
      );
      assertEquals(refusedLanded.json.code, "quarantine_landed");
      assertEquals(await server.quarantine.find(landedTxnId), undefined);
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: a deposit past the size serve keeps is refused before it is read",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const response = await fetch(`${server.url}/quarantine`, {
        method: "POST",
        headers: {
          authorization: "Bearer bob-token",
          "content-type": "application/json",
        },
        body: new Uint8Array(MAX_QUARANTINE_REQUEST_BYTES + 1),
      });
      assertEquals(response.status, 413);
      assertEquals((await response.json()).code, "quarantine_too_large");
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: a non-admin cannot accept; an admin lands the change rebased, as its author, recorded and audited",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const audit = captureAudit(server);
      const change = await bobsChange(server, 1);
      assertEquals(
        (await deposit(server, "bob-token", depositBody(change))).status,
        201,
      );
      assertEquals((await save(server, "alice-token", 1, 0)).status, 200);
      const path = `quarantine/${change.commit.txnId}/accept`;

      const refused = await call(server, "POST", path, "bob-token");
      assertEquals(refused.status, 403);
      assertEquals(
        (await server.quarantine.find(change.commit.txnId))?.state,
        "held",
      );
      const refusal = audit.find((event) =>
        event.action === "datastore.quarantine.accept" &&
        event.outcome === "failure"
      );
      assert(refusal !== undefined, "the non-admin accept is audited");

      const accepted = await call(server, "POST", path, "alice-token");
      assertEquals(accepted.status, 200, JSON.stringify(accepted.json));
      assertEquals(accepted.json.principal, "user:bob");
      assertEquals(accepted.json.acceptedBy, "user:caller");
      const renumbered = accepted.json.renumbered as {
        behavior: string;
        name: string;
        from: number;
        to: number;
      }[];
      assertEquals(
        renumbered.map(({ name, from, to }) => ({ name, from, to })),
        [{ name: "vpc", from: 1, to: 2 }],
      );
      const identity = change.commit.partition.identity;
      assertEquals(
        renumbered[0].behavior,
        identity.kind === "model"
          ? `${identity.type}/${identity.id}`
          : change.commit.partition.toString(),
      );

      const partition = change.commit.partition;
      const seq = await server.v3.commitStore.landedSeq(
        server.v3.namespace,
        partition,
        change.commit.txnId,
      );
      assertEquals(seq, 2);
      const [landed] = await server.v3.commitStore.readPartition(
        server.v3.namespace,
        partition,
        2,
        1,
      );
      assertEquals(landed.commit.principal, "user:bob");
      assert(
        landed.commit.ops.some((op) =>
          op.kind === "data-version" && op.metadata.version === 2
        ),
      );

      const record = await server.quarantine.find(change.commit.txnId);
      assertEquals(record?.state, "accepted");
      assertEquals(record?.acceptedBy, "user:caller");
      assertEquals(record?.seq, 2);
      assertEquals(
        await server.quarantine.content(change.commit.txnId),
        undefined,
      );

      const accept = audit.filter((event) =>
        event.action === "datastore.quarantine.accept" &&
        event.outcome === "success"
      );
      assertEquals(accept.length, 1);
      assertEquals(accept[0].principalId, "caller");
      assert(accept[0].resourceName.includes("user:bob"));

      const repeat = await call(server, "POST", path, "alice-token");
      assertEquals(repeat.json.duplicate, true);
      assertEquals(
        (await server.v3.commitStore.head(server.v3.namespace, partition))
          .seq,
        2,
      );
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: datastore status lists what serve keeps, held and accepted, with author and reason",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const held = await bobsChange(server, 1);
      const accepted = await bobsChange(server, 2);
      for (const change of [held, accepted]) {
        assertEquals(
          (await deposit(server, "bob-token", depositBody(change))).status,
          201,
        );
      }
      assertEquals(
        (await call(
          server,
          "POST",
          `quarantine/${accepted.commit.txnId}/accept`,
          "alice-token",
        )).status,
        200,
      );
      const deps = await createDatastoreStatusDeps(
        server.ctx.datastoreResolver,
        {
          listQuarantine: async () => {
            const { records, truncated } = await server.quarantine.list(50);
            return { entries: records.map(quarantineStatusOf), truncated };
          },
        },
      );
      let data: DatastoreStatusData | undefined;
      for await (
        const event of datastoreStatus(
          createLibSwampContext({ logger: getSwampLogger(["test"]) }),
          deps,
        )
      ) {
        if (event.kind === "completed") data = event.data;
      }
      assertEquals(
        data?.quarantine?.map((entry) => [entry.txnId, entry.state]),
        [[held.commit.txnId, "held"], [accepted.commit.txnId, "accepted"]],
      );
      assertEquals(data?.quarantine?.[0].author, "user:bob");
      assert(data?.quarantine?.[0].reason.includes("Not authorized"));
      assertEquals(data?.quarantine?.[1].acceptedBy, "user:caller");
    });
  },
});

async function bobsVaultChange(server: Server): Promise<{ commit: Commit }> {
  const type = server.modelType.normalized;
  const id = server.model.id;
  const base = `data/${type}/${id}/creds/1`;
  const intent = {
    kind: "data.save",
    model: { type, id },
    name: "creds",
    version: 1,
  };
  const metadata = {
    name: "creds",
    id: crypto.randomUUID(),
    version: 1,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: {
      type: "resource",
      "_swamp.sensitiveFields": JSON.stringify(["token"]),
      "_swamp.sensitiveFieldsVersion": "1",
    },
    ownerDefinition: { ownerType: "model-method", ownerRef: id },
    createdAt: new Date().toISOString(),
  };
  const inline = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const encoder = new TextEncoder();
  const raw = encoder.encode(
    JSON.stringify({ token: "${{ vault.get('prod', 'payments-api-key') }}" }),
  );
  const yamlBytes = encoder.encode(
    stringifyYaml(JSON.parse(JSON.stringify(metadata))),
  );
  const ops = [
    { kind: "put", intent, key: `${base}/raw`, inline: inline(raw) },
    {
      kind: "put",
      intent,
      key: `${base}/metadata.yaml`,
      inline: inline(yamlBytes),
    },
    { kind: "data-version", key: `${base}/metadata.yaml`, metadata },
  ];
  const parsed = await Promise.all(ops.map((op) => opFromJSON(op)));
  return {
    commit: Commit.create({
      seq: 1,
      partition: partitionOf({ kind: "model", type: server.modelType, id }),
      namespace: server.v3.namespace,
      txnId: crypto.randomUUID(),
      writer: { host: "bobs-laptop", pid: 1, instance: crypto.randomUUID() },
      executedAt: new Date().toISOString(),
      at: new Date().toISOString(),
      ops: parsed,
    }),
  };
}

Deno.test({
  name:
    "datastore quarantine: an accept judges the change's content with its author's access, so a secret only the admin may read is refused and the change stays held",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const audit = captureAudit(server);
      const change = await bobsVaultChange(server);
      assertEquals(
        (await deposit(server, "bob-token", {
          commit: change.commit.toJSON(),
          base: { seq: 0 },
          chunks: [],
        })).status,
        201,
      );
      const path = `quarantine/${change.commit.txnId}/accept`;
      const refused = await call(server, "POST", path, "alice-token");
      assertEquals(refused.status, 403, JSON.stringify(refused.json));
      assertEquals(refused.json.code, "quarantine_content_refused");
      assertEquals(
        (await server.quarantine.find(change.commit.txnId))?.state,
        "held",
      );
      assertEquals(
        await server.v3.commitStore.landedSeq(
          server.v3.namespace,
          change.commit.partition,
          change.commit.txnId,
        ),
        undefined,
      );
      assert(
        audit.some((event) =>
          JSON.stringify(event).includes("datastore.quarantine.accept") &&
          JSON.stringify(event).includes("content refused")
        ),
        "the refused accept is audited",
      );
      const discarded = await call(
        server,
        "POST",
        `quarantine/${change.commit.txnId}/discard`,
        "alice-token",
      );
      assertEquals(discarded.status, 200, JSON.stringify(discarded.json));
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: an accept judges content with the author's memberships as serve knows them now, not as the deposit carried them",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const opsMayReadProd = grant({
      subject: { kind: "idp-group", name: "ops" },
      actions: ["read"],
      resource: { kind: "vault", pattern: "prod" },
    });
    // bob's token named group ops at deposit but not at accept, so the read ops
    // was granted is not his to lend
    const tokenGroups = { "bob-token": ["ops"] };
    await withServer(
      [...writer(), ...bobReads(), opsMayReadProd],
      async (server) => {
        const change = await bobsVaultChange(server);
        assertEquals(
          (await deposit(server, "bob-token", {
            commit: change.commit.toJSON(),
            base: { seq: 0 },
            chunks: [],
          })).status,
          201,
        );
        tokenGroups["bob-token"] = [];
        const refused = await call(
          server,
          "POST",
          `quarantine/${change.commit.txnId}/accept`,
          "alice-token",
        );
        assertEquals(refused.status, 403, JSON.stringify(refused.json));
        assertEquals(refused.json.code, "quarantine_content_refused");
        assertEquals(
          (await server.quarantine.find(change.commit.txnId))?.state,
          "held",
        );
      },
      undefined,
      { tokenGroups },
    );
    const bobMayReadProd = grant({
      subject: { kind: "user", name: "bob" },
      actions: ["read"],
      resource: { kind: "vault", pattern: "prod" },
    });
    await withServer(
      [...writer(), ...bobReads(), bobMayReadProd],
      async (server) => {
        const change = await bobsVaultChange(server);
        assertEquals(
          (await deposit(server, "bob-token", {
            commit: change.commit.toJSON(),
            base: { seq: 0 },
            chunks: [],
          })).status,
          201,
        );
        const accepted = await call(
          server,
          "POST",
          `quarantine/${change.commit.txnId}/accept`,
          "alice-token",
        );
        assertEquals(accepted.status, 200, JSON.stringify(accepted.json));
      },
    );
  },
});

Deno.test({
  name:
    "datastore quarantine: an accept whose rebase would restate a latest its author may not read lands the change without the restatement, and says it became latest",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(
      [
        ...writer(),
        ...bobReads({
          kind: "idp-group",
          name: "readers",
        }),
      ],
      async (server) => {
        const change = await bobsChange(
          server,
          1,
          undefined,
          "2026-10-24T23:58:00.000Z",
        );
        assertEquals(
          (await deposit(server, "bob-token", depositBody(change))).status,
          201,
        );
        const big = new TextEncoder().encode("x".repeat(20 * 1024));
        const landed = await post(
          partitionPath(server),
          "alice-token",
          commitBody({
            expectedSeq: 0,
            txnId: crypto.randomUUID(),
            ops: await blobSaveOps(server, "vpc", 1, big),
            chunks: [{ sha256: await sha256Hex(big), size: big.length }],
          }, [big]),
        );
        assertEquals(landed.status, 200, JSON.stringify(landed.json));

        const accepted = await call(
          server,
          "POST",
          `quarantine/${change.commit.txnId}/accept`,
          "alice-token",
        );
        assertEquals(accepted.status, 200, JSON.stringify(accepted.json));
        const latest = accepted.json.latest as {
          name: string;
          kind: string;
          version: number;
          restateSkipped?: string;
        }[];
        assertEquals(latest.length, 1);
        assertEquals(latest[0].kind, "rebased");
        assertEquals(latest[0].version, 2);
        assertEquals(latest[0].restateSkipped, "content-not-provided");
      },
      undefined,
      { tokenGroups: { "bob-token": ["readers"] } },
    );
  },
});

async function bobsTwoChunkChange(
  server: Server,
  version: number,
  shared: Uint8Array,
): Promise<{
  commit: Commit;
  own: { sha256: string; bytes: Uint8Array };
  shared: { sha256: string; bytes: Uint8Array };
}> {
  const ownBytes = new TextEncoder().encode(`bob's version ${version}`);
  const ops = await Promise.all(
    [
      ...(await blobSaveOps(server, "vpc", version, ownBytes)),
      ...(await blobSaveOps(server, "subnet", 1, shared)),
    ].map((op) => opFromJSON(op)),
  );
  const commit = Commit.create({
    seq: 1,
    partition: partitionOf({
      kind: "model",
      type: server.modelType,
      id: server.model.id,
    }),
    namespace: server.v3.namespace,
    txnId: crypto.randomUUID(),
    writer: { host: "bobs-laptop", pid: 1, instance: crypto.randomUUID() },
    executedAt: new Date().toISOString(),
    at: new Date().toISOString(),
    ops,
  });
  return {
    commit,
    own: { sha256: await sha256Hex(ownBytes), bytes: ownBytes },
    shared: { sha256: await sha256Hex(shared), bytes: shared },
  };
}

Deno.test({
  name:
    "datastore quarantine: a deposit that repeats a chunk in place of one its commit names is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const change = await bobsTwoChunkChange(
        server,
        1,
        new TextEncoder().encode("content of version 1"),
      );
      const repeated = await deposit(server, "bob-token", {
        commit: change.commit.toJSON(),
        base: { seq: 0 },
        chunks: chunksToWire([change.own, change.own]),
      });
      assertEquals(repeated.status, 400, JSON.stringify(repeated.json));
      assertEquals(
        await server.quarantine.find(change.commit.txnId),
        undefined,
      );
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: accept refuses kept content missing a chunk its commit names, so an admin's access never vouches for it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      assertEquals((await save(server, "alice-token", 1, 0)).status, 200);
      const change = await bobsTwoChunkChange(
        server,
        2,
        new TextEncoder().encode("content of version 1"),
      );
      assertEquals(
        (await deposit(server, "bob-token", {
          commit: change.commit.toJSON(),
          base: { seq: 1 },
          chunks: chunksToWire([change.own, change.shared]),
        })).status,
        201,
      );
      const record = await server.quarantine.find(change.commit.txnId);
      assert(record !== undefined);
      await server.quarantine.deposit(record, {
        commit: change.commit.toJSON(),
        base: { seq: 1 },
        chunks: [change.own],
      });
      const accepted = await call(
        server,
        "POST",
        `quarantine/${change.commit.txnId}/accept`,
        "alice-token",
      );
      assertEquals(accepted.status, 409, JSON.stringify(accepted.json));
      assertEquals(accepted.json.code, "quarantine_corrupt");
      assertEquals(
        await server.v3.commitStore.landedSeq(
          server.v3.namespace,
          change.commit.partition,
          change.commit.txnId,
        ),
        undefined,
      );
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: deposits sent together never pass an author's cap",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const changes = await Promise.all(
        Array.from(
          { length: MAX_QUARANTINED_PER_PRINCIPAL + 6 },
          (_, index) => bobsChange(server, index + 1),
        ),
      );
      // sent as many at a time as serve takes one caller's uploads, so every
      // one reaches the cap check
      const codes: string[] = [];
      for (
        let at = 0;
        at < changes.length;
        at += MAX_CONCURRENT_CHUNK_REQUESTS
      ) {
        codes.push(
          ...await Promise.all(
            changes.slice(at, at + MAX_CONCURRENT_CHUNK_REQUESTS).map(
              async (change) => {
                const { status, json } = await deposit(
                  server,
                  "bob-token",
                  depositBody(change),
                );
                return status === 201 ? "kept" : String(json.code);
              },
            ),
          ),
        );
      }
      assertEquals(
        codes.filter((code) => code === "kept").length,
        MAX_QUARANTINED_PER_PRINCIPAL,
      );
      assertEquals(
        codes.filter((code) => code === "quarantine_full").length,
        6,
      );
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: an admin discards a kept change so it never lands; a non-admin is refused and audited, a second discard is a duplicate, and accept is refused after",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const audit = captureAudit(server);
      const change = await bobsChange(server, 1);
      assertEquals(
        (await deposit(server, "bob-token", depositBody(change))).status,
        201,
      );
      const txnId = change.commit.txnId;
      const path = `quarantine/${txnId}/discard`;

      const asBob = await call(
        server,
        "GET",
        `quarantine/${txnId}`,
        "bob-token",
      );
      assertEquals(asBob.status, 200, JSON.stringify(asBob.json));
      assertEquals(asBob.json.state, "held");
      const asCarol = await call(
        server,
        "GET",
        `quarantine/${txnId}`,
        "carol-token",
      );
      assertEquals(asCarol.status, 404, JSON.stringify(asCarol.json));
      assertEquals(asCarol.json.state, undefined);

      const refused = await call(server, "POST", path, "bob-token");
      assertEquals(refused.status, 403);
      assertEquals(refused.json.code, "forbidden");
      assertEquals((await server.quarantine.find(txnId))?.state, "held");
      const refusal = audit.find((event) =>
        event.action === "datastore.quarantine.discard"
      );
      assertEquals(refusal?.outcome, "failure");

      const discarded = await call(server, "POST", path, "alice-token");
      assertEquals(discarded.status, 200, JSON.stringify(discarded.json));
      assertEquals(discarded.json.discarded, true);
      assertEquals(discarded.json.duplicate, false);
      assertEquals(discarded.json.state, "discarded");
      assertEquals(discarded.json.principal, "user:bob");
      assert(typeof discarded.json.discardedBy === "string");
      assert(typeof discarded.json.discardedAt === "string");
      const record = await server.quarantine.find(txnId);
      assertEquals(record?.state, "discarded");
      assertEquals(await server.quarantine.content(txnId), undefined);
      assertEquals(
        audit.filter((event) =>
          event.action === "datastore.quarantine.discard" &&
          event.outcome === "success"
        ).length,
        1,
      );
      const told = await call(
        server,
        "GET",
        `quarantine/${txnId}`,
        "bob-token",
      );
      assertEquals(told.json.state, "discarded");

      const again = await call(server, "POST", path, "alice-token");
      assertEquals(again.status, 200);
      assertEquals(again.json.duplicate, true);

      const accept = await call(
        server,
        "POST",
        `quarantine/${txnId}/accept`,
        "alice-token",
      );
      assertEquals(accept.status, 409, JSON.stringify(accept.json));
      assertEquals(accept.json.code, "quarantine_discarded");
      assertEquals(
        await server.v3.commitStore.landedSeq(
          server.v3.namespace,
          change.commit.partition,
          txnId,
        ),
        undefined,
      );
    });
  },
});

Deno.test({
  name: "datastore quarantine: an accepted change cannot be discarded",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const change = await bobsChange(server, 1);
      assertEquals(
        (await deposit(server, "bob-token", depositBody(change))).status,
        201,
      );
      const txnId = change.commit.txnId;
      const accepted = await call(
        server,
        "POST",
        `quarantine/${txnId}/accept`,
        "alice-token",
      );
      assertEquals(accepted.status, 200, JSON.stringify(accepted.json));
      const discard = await call(
        server,
        "POST",
        `quarantine/${txnId}/discard`,
        "alice-token",
      );
      assertEquals(discard.status, 409);
      assertEquals(discard.json.code, "quarantine_accepted");
      assertEquals((await server.quarantine.find(txnId))?.state, "accepted");
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: a discarded change no longer counts against its author's cap",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const changes = [];
      for (let index = 0; index < MAX_QUARANTINED_PER_PRINCIPAL; index++) {
        const change = await bobsChange(server, index + 1);
        assertEquals(
          (await deposit(server, "bob-token", depositBody(change))).status,
          201,
        );
        changes.push(change);
      }
      const extra = await bobsChange(server, MAX_QUARANTINED_PER_PRINCIPAL + 1);
      assertEquals(
        (await deposit(server, "bob-token", depositBody(extra))).status,
        429,
      );
      const discarded = await call(
        server,
        "POST",
        `quarantine/${changes[0].commit.txnId}/discard`,
        "alice-token",
      );
      assertEquals(discarded.status, 200, JSON.stringify(discarded.json));
      assertEquals(
        (await deposit(server, "bob-token", depositBody(extra))).status,
        201,
      );
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: a caller who may not read the partition keeps nothing there, so it cannot fill the shared caps",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(writer(), async (server) => {
      const change = await bobsChange(server, 1);
      const refused = await deposit(server, "bob-token", depositBody(change));
      assertEquals(refused.status, 403, JSON.stringify(refused.json));
      assertEquals(refused.json.code, "quarantine_not_readable");
      assertEquals(
        await server.quarantine.find(change.commit.txnId),
        undefined,
      );
      assertEquals(await server.quarantine.heldKeys(), []);
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: an accept whose replication is not confirmed keeps the change held with its content, and a retry marks it accepted without landing it again",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const change = await bobsChange(server, 1);
      assertEquals(
        (await deposit(server, "bob-token", depositBody(change))).status,
        201,
      );
      const txnId = change.commit.txnId;
      const path = `quarantine/${txnId}/accept`;
      let replicates = false;
      server.ctx.confirmReplicated = () =>
        replicates
          ? Promise.resolve()
          : Promise.reject(new Error("replica unreachable"));

      const unconfirmed = await call(server, "POST", path, "alice-token");
      assertEquals(unconfirmed.status, 503, JSON.stringify(unconfirmed.json));
      // held with its content: a leader that loses the lead leaves the change
      // for the next one to land
      assertEquals((await server.quarantine.find(txnId))?.state, "held");
      assert(await server.quarantine.content(txnId) !== undefined);
      const partition = change.commit.partition;
      const seq = await server.v3.commitStore.landedSeq(
        server.v3.namespace,
        partition,
        txnId,
      );
      assertEquals(seq, 1);

      replicates = true;
      const accepted = await call(server, "POST", path, "alice-token");
      assertEquals(accepted.status, 200, JSON.stringify(accepted.json));
      assertEquals(accepted.json.seq, seq);
      assertEquals((await server.quarantine.find(txnId))?.state, "accepted");
      assertEquals(await server.quarantine.content(txnId), undefined);
      assertEquals(
        (await server.v3.commitStore.head(server.v3.namespace, partition)).seq,
        1,
      );
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: an accept that landed the change but stopped before marking it is marked accepted by the next accept, never landed twice",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const change = await bobsChange(server, 1);
      assertEquals(
        (await deposit(server, "bob-token", depositBody(change))).status,
        201,
      );
      const txnId = change.commit.txnId;
      const path = `quarantine/${txnId}/accept`;
      const markAccepted = server.quarantine.markAccepted.bind(
        server.quarantine,
      );
      let stops = true;
      server.quarantine.markAccepted = (record) => {
        if (stops) {
          stops = false;
          return Promise.reject(new Error("serve stopped"));
        }
        return markAccepted(record);
      };

      const stopped = await call(server, "POST", path, "alice-token");
      assertEquals(stopped.status, 500, JSON.stringify(stopped.json));
      assertEquals((await server.quarantine.find(txnId))?.state, "held");

      const accepted = await call(server, "POST", path, "alice-token");
      assertEquals(accepted.status, 200, JSON.stringify(accepted.json));
      assertEquals(accepted.json.seq, 1);
      assertEquals((await server.quarantine.find(txnId))?.state, "accepted");
      assertEquals(
        (await server.v3.commitStore.head(
          server.v3.namespace,
          change.commit.partition,
        )).seq,
        1,
      );
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: a caller's deposits share its upload slots, so one past them is refused before its body is read",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
      const pending: Promise<Response>[] = [];
      for (let slot = 0; slot < MAX_CONCURRENT_CHUNK_REQUESTS; slot++) {
        pending.push(server.handle(
          new Request(`${server.url}/quarantine`, {
            method: "POST",
            headers: {
              authorization: "Bearer bob-token",
              "content-type": "application/json",
            },
            body: new ReadableStream<Uint8Array>(
              {
                pull: (controller) => {
                  if (!bodies.includes(controller)) bodies.push(controller);
                  return new Promise(() => {});
                },
              },
              { highWaterMark: 0 },
            ),
            duplex: "half",
          } as RequestInit),
        ));
        await waitFor(
          () => bodies.length === slot + 1,
          "the slow deposit holds a slot",
        );
      }
      const change = await bobsChange(server, 1);
      const refused = await deposit(server, "bob-token", depositBody(change));
      assertEquals(refused.status, 429, JSON.stringify(refused.json));

      for (const body of bodies) {
        body.enqueue(new TextEncoder().encode("{}"));
        body.close();
      }
      for (const response of await Promise.all(pending)) {
        assertEquals(response.status, 400);
        await response.body?.cancel();
      }
      assertEquals(
        (await deposit(server, "bob-token", depositBody(change))).status,
        201,
      );
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: a deposit serve would not keep is refused before its chunks are decoded",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const change = await bobsChange(server, 1);
      const refused = await deposit(server, "alice-token", {
        commit: change.commit.toJSON(),
        base: { seq: 0 },
        chunks: [{ sha256: change.chunk.sha256, data: "%%% not base64 %%%" }],
      });
      assertEquals(refused.status, 409, JSON.stringify(refused.json));
      assertEquals(refused.json.code, "not_quarantinable");
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: a re-cased copy of a landed txnId is answered as landed, never kept",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const txnId = crypto.randomUUID();
      const landed = await post(
        partitionPath(server),
        "alice-token",
        await saveBody(server, 1, 0, { txnId }),
      );
      assertEquals(landed.status, 200, JSON.stringify(landed.json));

      const change = await bobsChange(server, 1);
      const recased = await Commit.fromJSON({
        ...change.commit.toJSON(),
        txnId: txnId.toUpperCase(),
      });
      const refused = await deposit(server, "bob-token", {
        ...depositBody(change) as Record<string, unknown>,
        commit: recased.toJSON(),
      });
      assertEquals(refused.status, 409, JSON.stringify(refused.json));
      assertEquals(refused.json.code, "quarantine_landed");
      assertEquals(await server.quarantine.find(txnId), undefined);
    });
  },
});

Deno.test({
  name:
    "datastore quarantine: an accept waits while the kept lease on its behavior is not adopted yet, and the change stays held",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const records = new Map<string, PersistedLease>();
    const blocked = new Set<string>();
    const store: PersistedLeaseStore = {
      save: (_fence, lease) => {
        records.set(lease.lockKey, lease);
        return Promise.resolve();
      },
      remove: (_fence, lockKey) => {
        records.delete(lockKey);
        return Promise.resolve();
      },
      adopt: () => Promise.resolve([...records.values()]),
    };
    await withServer(
      [...writer(), ...bobReads()],
      async (server) => {
        const change = await bobsChange(server, 1);
        assertEquals(
          (await deposit(server, "bob-token", depositBody(change))).status,
          201,
        );
        const key = modelKey(server);
        records.set(key, {
          leaseId: crypto.randomUUID(),
          lockKey: key,
          principal: "user:caller",
          fence: 1,
          holdMs: 3_600_000,
          remainingMs: 3_600_000,
          recordedAt: new Date().toISOString(),
          leaderFence: 1,
        });
        blocked.add(key);
        await server.locks.adopt();
        assert(server.locks.adopting);

        const txnId = change.commit.txnId;
        const waiting = await call(
          server,
          "POST",
          `quarantine/${txnId}/accept`,
          "alice-token",
        );
        assertEquals(waiting.status, 503, JSON.stringify(waiting.json));
        assertEquals(waiting.json.code, "serve_not_leader");
        assertEquals((await server.quarantine.find(txnId))?.state, "held");
      },
      undefined,
      {
        locks: (createLock) =>
          new DatastoreLockLeases({
            createLock: async (target) => {
              const lock = await createLock(target);
              return {
                tryAcquire: () =>
                  blocked.has(lockKeyOf(target))
                    ? Promise.resolve(false)
                    : lock.tryAcquire(),
                release: () => lock.release(),
              };
            },
            persistence: { store, leaderFence: () => 2 },
            maxWaitMs: 20,
            retryIntervalMs: 5,
            adoptRetryMs: 60_000,
          }),
      },
    );
  },
});

Deno.test({
  name:
    "datastore quarantine: an accept refuses a change whose txnId another author's commit took, and keeps it held",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([...writer(), ...bobReads()], async (server) => {
      const change = await bobsChange(server, 1);
      assertEquals(
        (await deposit(server, "bob-token", depositBody(change))).status,
        201,
      );
      const txnId = change.commit.txnId;
      const taken = await post(
        partitionPath(server),
        "alice-token",
        await saveBody(server, 1, 0, { txnId }),
      );
      assertEquals(taken.status, 200, JSON.stringify(taken.json));

      const refused = await call(
        server,
        "POST",
        `quarantine/${txnId}/accept`,
        "alice-token",
      );
      assertEquals(refused.status, 409, JSON.stringify(refused.json));
      assertEquals(refused.json.code, "quarantine_refused");
      assertEquals((await server.quarantine.find(txnId))?.state, "held");
    });
  },
});
