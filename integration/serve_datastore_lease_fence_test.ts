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
 * Fenced model leases at serve (swamp-club#4121) end to end: an in-process
 * client against a port-0 server over a real v3 repository. A fenced lease
 * carries a fence and a version floor; serve stamps the fence on each
 * commit that names the lease, and refuses a commit to a partition a live
 * fenced lease covers unless it names that lease.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Commit } from "../src/domain/datastore_v3/commit.ts";
import { dataVersionOp } from "../src/domain/datastore_v3/op.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import {
  SERVE_REPLY_MAX_BYTES,
  ServeDatastoreClient,
} from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { grant } from "./serve_request_harness.ts";
import { LeaseRecordNotRemovedError } from "../src/serve/datastore_locks.ts";
import { LEASE_RECORD_NOT_REMOVED_CODE } from "../src/domain/datastore_v3/persisted_lease.ts";
import { exitCodeForError } from "../src/presentation/output/error_output.ts";
import {
  call,
  commitBody,
  dataMetadata,
  fencedLease,
  member,
  modelKey,
  partitionPath,
  post,
  save,
  saveBody,
  type Server,
  withServer,
} from "./serve_datastore_api_harness.ts";

await initializeLogging({});

function partition(server: Server) {
  return partitionOf({
    kind: "model",
    type: server.modelType,
    id: server.model.id,
  });
}

async function landed(server: Server, seq: number): Promise<Commit> {
  const [{ commit }] = await server.v3.commitStore.readPartition(
    server.v3.namespace,
    partition(server),
    seq,
    1,
  );
  return commit as Commit;
}

async function leaseFence(server: Server): Promise<number | undefined> {
  return (await server.v3.commitStore.leaseMarks(
    server.v3.namespace,
    partition(server),
  )).leaseFence;
}

/** Members alice (`user:caller`) and bob, each with run on every behavior. */
const twoMembers = () => [
  ...member(),
  grant({
    subject: { kind: "user", name: "bob" },
    actions: ["read", "write", "run"],
    resource: { kind: "model", pattern: "*" },
  }),
];

Deno.test({
  name:
    "datastore lease fence: the holder's commit lands with serve's lease op, and anyone else's is refused while the lease lives",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(twoMembers(), async (server) => {
      const lease = await fencedLease(server, "alice-token");
      assertEquals(lease.fence, 1);
      assertEquals(lease.floor, []);

      const committed = await save(server, "alice-token", 1, 0, {
        lease: lease.leaseId,
      });
      assertEquals(committed.status, 200, JSON.stringify(committed.json));
      const commit = await landed(server, 1);
      const leaseOps = commit.ops.filter((op) => op.kind === "lease");
      assertEquals(leaseOps.map((op) => op.toJSON()), [
        { kind: "lease", holder: lease.leaseId, fence: 1 },
      ]);
      assertEquals(await leaseFence(server), 1);

      // Another caller, with no lease or naming the holder's.
      for (const named of [undefined, lease.leaseId]) {
        const refused = await save(server, "bob-token", 2, 1, {
          ...(named === undefined ? {} : { lease: named }),
        });
        assertEquals(
          [refused.status, refused.json.code],
          [409, "commit_lease-lost"],
        );
        // Never says whose lease holds it.
        assert(!JSON.stringify(refused.json).includes("user:caller"));
      }
      // The holder itself must name the lease, and a forged id is refused.
      for (const named of [undefined, crypto.randomUUID()]) {
        const refused = await save(server, "alice-token", 2, 1, {
          ...(named === undefined ? {} : { lease: named }),
        });
        assertEquals(
          [refused.status, refused.json.code],
          [409, "commit_lease-lost"],
        );
      }
      assertEquals(
        (await server.v3.commitStore.head("", partition(server))).seq,
        1,
      );
      assertEquals(await leaseFence(server), 1);
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: once the lease is released an unleased commit lands, a commit naming it is refused, and its landed commit still answers a retry",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(twoMembers(), async (server) => {
      const lease = await fencedLease(server, "alice-token");
      const body = await saveBody(server, 1, 0, { lease: lease.leaseId });
      const first = await post(partitionPath(server), "alice-token", body);
      assertEquals(first.status, 200, JSON.stringify(first.json));
      assertEquals(
        (await call(server, "DELETE", `locks/${lease.leaseId}`, "alice-token"))
          .status,
        200,
      );

      // A retry of the landed commit is that commit, whatever lease it names
      // now: serve's lease op is left out of the comparison.
      const retried = await post(partitionPath(server), "alice-token", body);
      assertEquals(
        [retried.status, retried.json.seq, retried.json.duplicate],
        [200, 1, true],
      );

      const late = await save(server, "alice-token", 2, 1, {
        lease: lease.leaseId,
      });
      assertEquals([late.status, late.json.code], [409, "commit_lease-lost"]);
      const unleased = await save(server, "bob-token", 2, 1);
      assertEquals(unleased.status, 200, JSON.stringify(unleased.json));
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: a second holder takes the lease at a higher fence, and the first holder's late commit is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(twoMembers(), async (server) => {
      const first = await fencedLease(server, "alice-token");
      assertEquals(
        (await save(server, "alice-token", 1, 0, { lease: first.leaseId }))
          .status,
        200,
      );
      await call(server, "DELETE", `locks/${first.leaseId}`, "alice-token");
      const second = await fencedLease(server, "bob-token");
      assert(second.fence > first.fence);
      assertEquals(second.floor, [{ name: "vpc", highWater: 1 }]);

      const late = await save(server, "alice-token", 2, 1, {
        lease: first.leaseId,
      });
      assertEquals([late.status, late.json.code], [409, "commit_lease-lost"]);
      const ok = await save(server, "bob-token", 2, 1, {
        lease: second.leaseId,
      });
      assertEquals(ok.status, 200, JSON.stringify(ok.json));
      assertEquals(await leaseFence(server), second.fence);
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: a lease on another behavior covers only its own partition",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(twoMembers(), async (server) => {
      const other = crypto.randomUUID();
      const elsewhere = await fencedLease(
        server,
        "alice-token",
        modelKey(server, other),
      );
      const refused = await save(server, "alice-token", 1, 0, {
        lease: elsewhere.leaseId,
      });
      assertEquals(
        [refused.status, refused.json.code],
        [409, "commit_lease-lost"],
      );
      // The partition no lease covers keeps today's rules.
      assertEquals((await save(server, "alice-token", 1, 0)).status, 200);
      assertEquals(await leaseFence(server), undefined);
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: a run-only caller's fenced lease returns the floor of versions it cannot read",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const runOnly = [
      ...member(),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["run"],
        resource: { kind: "model", pattern: "*" },
      }),
    ];
    await withServer(runOnly, async (server) => {
      for (let version = 1; version <= 3; version++) {
        assertEquals(
          (await save(server, "alice-token", version, version - 1)).status,
          200,
        );
      }
      const lease = await fencedLease(server, "bob-token");
      assertEquals(lease.floor, [{ name: "vpc", highWater: 3 }]);
      // Names and numbers only.
      assert(!JSON.stringify(lease.floor).includes("content of version"));
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: an unfenced lease (an older client) keeps today's rules",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(twoMembers(), async (server) => {
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey: modelKey(server),
      });
      assertEquals(taken.status, 201);
      assertEquals(taken.json.fence, undefined);
      assertEquals(taken.json.floor, undefined);
      // Nothing is covered: an unleased commit lands, as before leases.
      assertEquals((await save(server, "bob-token", 1, 0)).status, 200);
      assertEquals(await leaseFence(server), undefined);
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: GET locks lists serve's leases on locks the caller could take, holder kinds only",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const grants = [
      ...member(),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["read", "write", "run"],
        resource: { kind: "model", pattern: "*" },
      }),
    ];
    await withServer(grants, async (server) => {
      const lease = await fencedLease(server, "alice-token");
      const asAlice = await call(server, "GET", "locks", "alice-token");
      assertEquals(asAlice.status, 200, JSON.stringify(asAlice.json));
      assertEquals(asAlice.json.truncated, false);
      const [listed] = asAlice.json.leases as Record<string, unknown>[];
      assertEquals(listed.lockKey, modelKey(server));
      assertEquals(listed.heldBy, "caller");
      assertEquals(typeof listed.expiresAt, "string");
      // Nothing but the key, the holder kind and the expiry.
      assertEquals(Object.keys(listed).sort(), [
        "expiresAt",
        "heldBy",
        "lockKey",
      ]);
      assert(!JSON.stringify(asAlice.json).includes(lease.leaseId));

      const asBob = await call(server, "GET", "locks", "bob-token");
      assertEquals(
        (asBob.json.leases as Record<string, unknown>[]).map((l) => l.heldBy),
        ["other"],
      );
      assert(!JSON.stringify(asBob.json).includes("user:caller"));

      const prefixed = await call(
        server,
        "GET",
        "locks?prefix=workflow-run-claims/",
        "alice-token",
      );
      assertEquals(prefixed.json.leases, []);
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: GET locks leaves out leases on locks the caller could not take",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const grants = [
      ...member(),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["read"],
        resource: { kind: "model", pattern: "*" },
      }),
    ];
    await withServer(grants, async (server) => {
      await fencedLease(server, "alice-token");
      const asBob = await call(server, "GET", "locks", "bob-token");
      assertEquals(asBob.status, 200);
      assertEquals(asBob.json.leases, []);
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: an explicit lease is held for its hold, renewed by it, and must be fenced and within bounds",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(twoMembers(), async (server) => {
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey: modelKey(server),
        fenced: true,
        holdMs: 1_800_000,
      });
      assertEquals(taken.status, 201, JSON.stringify(taken.json));
      assertEquals([taken.json.ttlMs, taken.json.holdMs], [
        1_800_000,
        1_800_000,
      ]);
      const renewed = await call(
        server,
        "PUT",
        `locks/${taken.json.leaseId}`,
        "alice-token",
        {},
      );
      assertEquals([renewed.status, renewed.json.ttlMs], [200, 1_800_000]);

      // Up to a day, so a lease can be checked out to work offline
      // (swamp-club#4195).
      const day = await call(server, "POST", "locks", "bob-token", {
        lockKey: modelKey(server, crypto.randomUUID()),
        fenced: true,
        holdMs: 86_400_000,
      });
      assertEquals(day.status, 201, JSON.stringify(day.json));

      for (
        const body of [
          { holdMs: 1_800_000 },
          { fenced: true, holdMs: 86_400_001 },
          { fenced: true, holdMs: 10 },
        ]
      ) {
        const refused = await call(server, "POST", "locks", "bob-token", {
          lockKey: modelKey(server, crypto.randomUUID()),
          ...body,
        });
        assertEquals(refused.status, 400, JSON.stringify(body));
      }
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: an admin force-releases another caller's explicit lease, a member may not, and the holder's next commit naming it is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([
      ...twoMembers(),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["admin"],
        resource: { kind: "access", pattern: "*" },
      }),
    ], async (server) => {
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey: modelKey(server),
        fenced: true,
        holdMs: 86_400_000,
      });
      assertEquals(taken.status, 201, JSON.stringify(taken.json));

      const refused = await call(server, "DELETE", "locks", "alice-token", {
        lockKey: modelKey(server),
      });
      assertEquals([refused.status, refused.json.code], [403, "forbidden"]);

      const ended = await call(server, "DELETE", "locks", "bob-token", {
        lockKey: modelKey(server),
      });
      assertEquals(ended.status, 200, JSON.stringify(ended.json));
      assertEquals([ended.json.released, ended.json.heldBy], [
        true,
        "user:caller",
      ]);

      // Its holder's commit naming it is refused as lost, and its renewal
      // finds no lease; nothing raised the partition's fence.
      const late = await save(server, "alice-token", 1, 0, {
        lease: taken.json.leaseId as string,
      });
      assertEquals([late.status, late.json.code], [409, "commit_lease-lost"]);
      const renewed = await call(
        server,
        "PUT",
        `locks/${taken.json.leaseId}`,
        "alice-token",
        {},
      );
      assertEquals(renewed.status, 404);
      assertEquals(await leaseFence(server), undefined);

      // Nothing left to release.
      const again = await call(server, "DELETE", "locks", "bob-token", {
        lockKey: modelKey(server),
      });
      assertEquals([again.status, again.json.released], [200, false]);
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: a forced release is audited with who ended whose lease, and a refused one too",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([
      ...twoMembers(),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["admin"],
        resource: { kind: "access", pattern: "*" },
      }),
    ], async (server) => {
      const events: AuditEvent[] = [];
      (server.ctx as { auditEmitter?: unknown }).auditEmitter = {
        emit: (event: AuditEvent) => events.push(event),
        durableStalled: false,
      } as unknown as ConnectionContext["auditEmitter"];
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey: modelKey(server),
        fenced: true,
        holdMs: 86_400_000,
      });
      assertEquals(taken.status, 201, JSON.stringify(taken.json));
      await call(server, "DELETE", "locks", "alice-token", {
        lockKey: modelKey(server),
      });
      const ended = await call(server, "DELETE", "locks", "bob-token", {
        lockKey: modelKey(server),
      });
      assertEquals(ended.status, 200, JSON.stringify(ended.json));

      const released = events.filter((event) =>
        event.action === "datastore.lock.force-release"
      );
      assertEquals(released.map((event) => event.outcome), [
        "failure",
        "success",
      ]);
      assertEquals(released[1].principalId, "bob");
      assertEquals(released[1].resourceKind, "lock");
      assert(
        released[1].resourceName.includes(modelKey(server)),
        released[1].resourceName,
      );
      assert(
        released[1].resourceName.includes("user:caller"),
        released[1].resourceName,
      );
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: a forced release whose kept record cannot be removed is refused as temporary, audited, and the client exits 75 so the admin forces it again",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([
      ...twoMembers(),
      grant({
        subject: { kind: "user", name: "bob" },
        actions: ["admin"],
        resource: { kind: "access", pattern: "*" },
      }),
    ], async (server) => {
      const events: AuditEvent[] = [];
      (server.ctx as { auditEmitter?: unknown }).auditEmitter = {
        emit: (event: AuditEvent) => events.push(event),
        durableStalled: false,
      } as unknown as ConnectionContext["auditEmitter"];
      // The lease ends, but its record stays in the control plane.
      server.locks.forceRelease = () =>
        Promise.reject(
          new LeaseRecordNotRemovedError(
            modelKey(server),
            new Error("control plane unreachable"),
          ),
        );

      const answer = await call(server, "DELETE", "locks", "bob-token", {
        lockKey: modelKey(server),
      });
      assertEquals(
        [answer.status, answer.json.code],
        [503, LEASE_RECORD_NOT_REMOVED_CODE],
      );
      assert(
        String(answer.json.message).includes("Force the release again"),
        String(answer.json.message),
      );
      const audited = events.filter((event) =>
        event.action === "datastore.lock.force-release"
      );
      assertEquals(audited.map((event) => event.outcome), ["failure"]);

      const client = new ServeDatastoreClient({
        baseUrl: new URL(server.url).origin,
        token: "bob-token",
      });
      try {
        const error = await assertRejects(() =>
          client.forceReleaseLock(
            modelKey(server),
            new AbortController().signal,
          )
        );
        assertEquals(
          (error as { code?: string }).code,
          LEASE_RECORD_NOT_REMOVED_CODE,
        );
        assertEquals(exitCodeForError(error), 75);
      } finally {
        client.close();
      }
    });
  },
});

const RUN_WORKFLOW = "55555555-6666-4777-8888-999999999999";

/** Forwards run `runId`'s record with `status`, as a run's owner saves it. */
async function forwardRun(
  server: Server,
  runId: string,
  kind: "run.create" | "run.update",
  status: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const partition = partitionOf({
    kind: "run",
    workflowId: RUN_WORKFLOW,
    runId,
  });
  const head = await server.v3.commitStore.head(server.v3.namespace, partition);
  const record = new TextEncoder().encode(
    JSON.stringify({
      id: runId,
      workflowId: RUN_WORKFLOW,
      workflowName: "deploy",
      status,
      tags: {},
      jobs: [],
      startedAt: "2026-10-26T00:00:00.000Z",
    }),
  );
  return await post(
    `${server.url}/partitions/${
      encodeURIComponent(partition.toString())
    }/commits`,
    "alice-token",
    commitBody({
      expectedSeq: head.seq,
      txnId: crypto.randomUUID(),
      ops: [{
        kind: "put",
        intent: { kind, run: { workflowId: RUN_WORKFLOW, runId } },
        key: `workflow-runs/${RUN_WORKFLOW}/workflow-run-${runId}.yaml`,
        inline: btoa(String.fromCharCode(...record)),
      }],
      chunks: [],
    }),
  );
}

Deno.test({
  name:
    "datastore lease fence: a fenced run claim does not refuse the run owner's unleased checkpoints",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const grants = [
      ...twoMembers(),
      grant({
        actions: ["read", "run"],
        resource: { kind: "workflow", pattern: "*" },
      }),
    ];
    await withServer(grants, async (server) => {
      const runId = crypto.randomUUID();
      const created = await forwardRun(server, runId, "run.create", "running");
      assertEquals(created.status, 200, JSON.stringify(created.json));
      // Another command holds the run's claim for a moment (an approve).
      const claim = await fencedLease(
        server,
        "alice-token",
        `workflow-run-claims/${runId}/.lock`,
      );
      assert(claim.fence >= 1);
      const checkpoint = await forwardRun(
        server,
        runId,
        "run.update",
        "running",
      );
      assertEquals(checkpoint.status, 200, JSON.stringify(checkpoint.json));
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: a reader that does not name lease ops is sent commits without them, as a swamp before them reads them",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(twoMembers(), async (server) => {
      const lease = await fencedLease(server, "alice-token");
      assertEquals(
        (await save(server, "alice-token", 1, 0, { lease: lease.leaseId }))
          .status,
        200,
      );
      const read = async (headers: Record<string, string>) => {
        const response = await fetch(`${partitionPath(server)}?after=0`, {
          headers: { authorization: "Bearer alice-token", ...headers },
        });
        const json = await response.json() as {
          commits: { ops: { kind: string }[] }[];
        };
        return json.commits[0].ops.map((op) => op.kind);
      };
      const older = await read({});
      assertEquals(older.includes("lease"), false);
      assert(older.length > 0);
      const current = await read({
        "x-swamp-datastore-features": "lease-ops",
      });
      assertEquals(current.filter((kind) => kind === "lease").length, 1);
      assertEquals(current.length, older.length + 1);
    });
  },
});

Deno.test({
  name:
    "datastore lease fence: a behavior whose floor is past the small reply limit still takes its lease through the client (swamp-club#4166)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(twoMembers(), async (server) => {
      // Long names put the floor past 1 MiB with few catalog rows, which are
      // slow to write under the parallel suite (swamp-club#4182).
      const names = Array.from(
        { length: 400 },
        (_, i) => `instance-${String(i).padStart(6, "0")}-${"x".repeat(3_000)}`,
      );
      const type = server.modelType.normalized;
      const fence = server.v3.commitStore.writerFence();
      for (const [index, start] of [0, 200].entries()) {
        await server.v3.commitStore.append(Commit.create({
          seq: index + 1,
          partition: partition(server),
          namespace: server.v3.namespace,
          txnId: crypto.randomUUID(),
          writer: { host: "host-a", pid: 4242, instance: "cli-1" },
          at: "2026-10-30T00:00:00.000Z",
          ...(fence === undefined ? {} : { fence }),
          ops: names.slice(start, start + 200).map((name) =>
            dataVersionOp({
              key: RecordKey.create(
                `data/${type}/${server.model.id}/${name}/1/metadata.yaml`,
              ),
              metadata: dataMetadata(name, 1),
            })
          ),
        }));
      }
      const floorBytes = JSON.stringify(
        (await server.v3.commitStore.leaseMarks(
          server.v3.namespace,
          partition(server),
        )).names,
      ).length;
      assert(floorBytes > SERVE_REPLY_MAX_BYTES, `${floorBytes} bytes`);
      // These commits bypassed serve: projecting them here keeps that work
      // out of the first request's deadline.
      await server.v3.catchUp();
      const client = new ServeDatastoreClient({
        baseUrl: new URL(server.url).origin,
        token: "alice-token",
      });
      try {
        const reply = await client.acquireLock(
          modelKey(server),
          30_000,
          0,
          AbortSignal.timeout(30_000),
        );
        assert(reply.acquired, JSON.stringify(reply));
        assertEquals(reply.lease.floor?.map((marks) => marks.name), names);
        const listing = await client.listLocks("", AbortSignal.timeout(30_000));
        assertEquals(listing?.leases.length, 1);
        await client.releaseLock(
          reply.lease.leaseId,
          AbortSignal.timeout(30_000),
        );
      } finally {
        client.close?.();
      }
    });
  },
});
