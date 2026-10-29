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
 * Serve's lock routes (swamp-club#3985) end to end: an in-process client
 * against a port-0 server over a real v3 repository, as serve wires them,
 * with serve's own file locks behind the leases.
 */

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
    "datastore locks: a member takes a behavior's lock, another caller is told only that another holds it, and only the holder renews or releases it",
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
      // Never the holder's identity.
      assert(!JSON.stringify(held.json).includes("user:caller"));

      // Bob cannot renew or release alice's lease.
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
      // Released: renewing it is refused, and bob may take the lock.
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
      // Serve's own run holds the behavior's lock.
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
      // Any spelling of the type and id is the same lock.
      const taken = await call(server, "POST", "locks", "alice-token", {
        lockKey:
          `data/${server.modelType.normalized.toUpperCase()}/${server.model.id.toUpperCase()}/.lock`,
      });
      assertEquals([taken.status, taken.json.lockKey], [201, key]);
      // Now serve's run waits on the caller's lease.
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
      // GET lists the leases serve holds (swamp-club#4121); other methods
      // are still refused.
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
