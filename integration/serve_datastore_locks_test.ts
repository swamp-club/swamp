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

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createModelLock } from "../src/cli/repo_context.ts";
import type { FileLock } from "../src/infrastructure/persistence/file_lock.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { grant } from "./serve_request_harness.ts";
import {
  member,
  type Server,
  withServer,
} from "./serve_datastore_api_harness.ts";

await initializeLogging({});

const RUN_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a77";

function modelKey(server: Server): string {
  return `data/${server.modelType.normalized}/${server.model.id}/.lock`;
}

async function call(
  server: Server,
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${server.url}/${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() };
}

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
    "datastore locks: a member takes a behavior's lock, another caller is told who holds it, and only the holder renews or releases it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(twoMembers(), async (server) => {
      const key = modelKey(server);
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey: key,
        ttlMs: 30_000,
      });
      assertEquals(taken.status, 201, JSON.stringify(taken.json));
      assertEquals(taken.json.lockKey, key);
      const leaseId = taken.json.leaseId as string;

      const held = await call(server, "POST", "locks", "bob-token", {
        lockKey: key,
      });
      assertEquals([held.status, held.json.code, held.json.heldBy], [
        409,
        "lock_held",
        "other",
      ]);
      assertEquals(
        (held.json.holder as { principal?: string } | undefined)?.principal,
        "user:caller",
      );

      assertEquals(
        (await call(server, "PUT", `locks/${leaseId}`, "bob-token", {})).status,
        404,
      );
      assertEquals(
        (await call(server, "DELETE", `locks/${leaseId}`, "bob-token"))
          .status,
        404,
      );

      const renewed = await call(
        server,
        "PUT",
        `locks/${leaseId}`,
        "alice-token",
        { ttlMs: 60_000 },
      );
      assertEquals([renewed.status, renewed.json.ttlMs], [200, 60_000]);

      const released = await call(
        server,
        "DELETE",
        `locks/${leaseId}`,
        "alice-token",
      );
      assertEquals(released.status, 200);
      assertEquals(
        (await call(server, "PUT", `locks/${leaseId}`, "alice-token", {}))
          .status,
        404,
      );
      assertEquals(
        (await call(server, "DELETE", `locks/${leaseId}`, "alice-token"))
          .status,
        404,
      );
      const bobs = await call(server, "POST", "locks", "bob-token", {
        lockKey: key,
      });
      assertEquals(bobs.status, 201);
      assertEquals(server.locks.size, 1);
    });
  },
});

Deno.test({
  name:
    "datastore locks: a lease is serve's own model lock, so serve's runs and callers exclude each other",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(member(), async (server) => {
      const key = modelKey(server);
      const serveLock = await createModelLock(
        server.ctx.datastoreConfig,
        server.modelType.normalized,
        server.model.id,
      ) as FileLock;
      assert(await serveLock.tryAcquire());
      try {
        const held = await call(server, "POST", "locks", "alice-token", {
          lockKey: key,
        });
        assertEquals([held.status, held.json.heldBy], [409, "serve"]);
      } finally {
        await serveLock.release();
      }
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey:
          `data/${server.modelType.normalized.toUpperCase()}/${server.model.id.toUpperCase()}/.lock`,
      });
      assertEquals([taken.status, taken.json.lockKey], [201, key]);
      assertEquals(await serveLock.tryAcquire(), false);
      await call(
        server,
        "DELETE",
        `locks/${taken.json.leaseId}`,
        "alice-token",
      );
      assert(await serveLock.tryAcquire());
      await serveLock.release();
    });
  },
});

Deno.test({
  name:
    "datastore locks: a lock needs run on its behavior, keys and TTLs are checked, and an unauthenticated caller is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer([
      grant({
        actions: ["read"],
        resource: { kind: "model", pattern: "*" },
      }),
    ], async (server) => {
      const key = modelKey(server);
      const refused = await call(server, "POST", "locks", "alice-token", {
        lockKey: key,
      });
      assertEquals([refused.status, refused.json.code], [403, "forbidden"]);
      assertStringIncludes(refused.json.message as string, "run on model:web");

      for (
        const body of [
          {},
          { lockKey: "../../etc/.lock" },
          { lockKey: `ns/${key}` },
          { lockKey: ".datastore.lock" },
          { lockKey: key, ttlMs: 10 },
          { lockKey: key, ttlMs: 10 * 60_000 },
          { lockKey: key, ttlMs: "30000" },
          { lockKey: key, waitMs: -1 },
        ]
      ) {
        const bad = await call(server, "POST", "locks", "alice-token", body);
        assertEquals(bad.status, 400, JSON.stringify(body));
      }
      assertEquals(
        (await call(server, "POST", "locks", undefined, { lockKey: key }))
          .status,
        401,
      );
      assertEquals(
        (await call(server, "GET", "locks", "alice-token")).status,
        200,
      );
      assertEquals(
        (await call(server, "PUT", "locks", "alice-token", {})).status,
        405,
      );
      assertEquals(server.locks.size, 0);
    });
  },
});

Deno.test({
  name:
    "datastore locks: a run serve does not know is decided on its id, so only a wildcard workflow grant holds its claim",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const lockKey = `workflow-run-claims/${RUN_ID}/.lock`;
    await withServer([
      ...member(),
      grant({
        actions: ["run"],
        resource: { kind: "workflow", pattern: "deploy" },
      }),
    ], async (server) => {
      const refused = await call(server, "POST", "locks", "alice-token", {
        lockKey,
      });
      assertEquals(refused.status, 403);
    });
    await withServer([
      ...member(),
      grant({
        actions: ["run"],
        resource: { kind: "workflow", pattern: "*" },
      }),
    ], async (server) => {
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey,
      });
      assertEquals([taken.status, taken.json.lockKey], [201, lockKey]);
    });
  },
});

Deno.test({
  name:
    "serve datastore locks: a held lock's refusal and the lease listing name the holder, whether the lease is explicit, and when it ends; a bad budget is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(twoMembers(), async (server) => {
      const key = modelKey(server);
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey: key,
        fenced: true,
        holdMs: 600_000,
      });
      assertEquals(taken.status, 201, JSON.stringify(taken.json));

      const held = await call(server, "POST", "locks", "bob-token", {
        lockKey: key,
        waitMs: 600_000,
        budgetMs: 60_000,
      });
      assertEquals([held.status, held.json.heldBy], [409, "other"]);
      assertEquals(held.json.holder, {
        principal: "user:caller",
        explicit: true,
        expiresAt: taken.json.expiresAt,
      });

      const listed = await call(
        server,
        "GET",
        "locks?prefix=data/",
        "bob-token",
      );
      const leases = listed.json.leases as Record<string, unknown>[];
      assertEquals(leases[0].heldBy, "other");
      assertEquals(leases[0].holder, {
        principal: "user:caller",
        explicit: true,
        expiresAt: taken.json.expiresAt,
      });

      for (const budgetMs of [-1, 1.5, "60000"]) {
        const bad = await call(server, "POST", "locks", "bob-token", {
          lockKey: key,
          budgetMs,
        });
        assertEquals(bad.status, 400, String(budgetMs));
      }
    });
  },
});

Deno.test({
  name:
    "datastore locks: a workflow's report lock needs run on the workflow's data owner, not write on the workflow",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const lockKey = `data/workflow/${crypto.randomUUID()}/.lock`;
    await withServer([
      grant({
        actions: ["read", "run"],
        resource: { kind: "model", pattern: "*" },
      }),
      grant({
        actions: ["read", "run"],
        resource: { kind: "workflow", pattern: "*" },
      }),
    ], async (server) => {
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey,
      });
      assertEquals([taken.status, taken.json.lockKey], [201, lockKey]);
    });
    await withServer([
      grant({
        actions: ["read"],
        resource: { kind: "model", pattern: "*" },
      }),
      grant({
        actions: ["read", "write", "run"],
        resource: { kind: "workflow", pattern: "*" },
      }),
    ], async (server) => {
      const refused = await call(server, "POST", "locks", "alice-token", {
        lockKey,
      });
      assertEquals([refused.status, refused.json.code], [403, "forbidden"]);
    });
  },
});

Deno.test({
  name:
    "datastore locks: a member that gave up on a lock request cancels it by its id, which frees a lease granted for it and refuses one taken later",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(twoMembers(), async (server) => {
      const key = modelKey(server);
      const requestId = crypto.randomUUID();
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey: key,
        ttlMs: 30_000,
        requestId,
      });
      assertEquals(taken.status, 201, JSON.stringify(taken.json));
      const cancelled = await call(
        server,
        "DELETE",
        `locks/requests/${requestId}`,
        "alice-token",
      );
      assertEquals(cancelled.status, 200);
      assertEquals(cancelled.json.released, true);
      const next = await call(server, "POST", "locks", "bob-token", {
        lockKey: key,
        ttlMs: 30_000,
      });
      assertEquals(next.status, 201, JSON.stringify(next.json));
      const released = await call(
        server,
        "DELETE",
        `locks/${next.json.leaseId}`,
        "bob-token",
      );
      assertEquals(released.status, 200);

      const early = crypto.randomUUID();
      await call(server, "DELETE", `locks/requests/${early}`, "alice-token");
      const late = await call(server, "POST", "locks", "alice-token", {
        lockKey: key,
        ttlMs: 30_000,
        requestId: early,
      });
      assertEquals(late.status, 409, JSON.stringify(late.json));

      const bad = await call(server, "POST", "locks", "alice-token", {
        lockKey: key,
        ttlMs: 30_000,
        requestId: "not/an id",
      });
      assertEquals(bad.status, 400);
    });
  },
});
