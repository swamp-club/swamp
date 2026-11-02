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

import { assertEquals } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "../src/domain/models/worker/enrollment_token_model.ts";
import { FanOutPolicySchema } from "../src/domain/remote/fan_out.ts";
import { planFanOut } from "../src/domain/remote/scheduler.ts";
import type { PoolWorker } from "../src/domain/remote/worker_pool.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import { createServeWorkerPoolReader } from "../src/serve/worker_pool_reader.ts";
import { Fleet } from "./fleet_harness.ts";

await initializeLogging({});

// The gateway's grace and dispatch timers outlive a test body by design.
const SANITIZE = { sanitizeOps: false, sanitizeResources: false };

function poolReader(fleet: Fleet, now?: () => number) {
  return createServeWorkerPoolReader({
    gateway: fleet.gateway,
    query: (predicate, options) =>
      fleet.repoContext.dataQueryService.query(predicate, options),
    namespace: fleet.repoContext.unifiedDataRepo.namespace,
    now,
  });
}

function summary(pool: PoolWorker[]): [string, string, boolean][] {
  return pool.map((
    w,
  ): [string, string, boolean] => [w.name, w.status, w.connected])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

// as serve revokes: the record first, so the left worker cannot pass on a stale token
async function revokeToken(fleet: Fleet, name: string): Promise<void> {
  const deps = await createWorkerModelRunDeps(fleet.repoDir, fleet.repoContext);
  for await (
    const event of modelMethodRun(createLibSwampContext({}), deps, {
      modelIdOrName: name,
      methodName: "revoke",
      inputs: {},
      lastEvaluated: false,
      typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
      definitionName: name,
    })
  ) {
    if (event.kind === "error") throw new Error(`revoke of ${name} failed`);
  }
  await fleet.gateway.revokeToken(name, "revoked");
}

Deno.test({
  name:
    "WorkerPoolReader: connected and grace-window workers are members with their live status",
  ...SANITIZE,
  fn: async () => {
    // long enough that the disconnected worker is still in its grace window when read
    await using fleet = await Fleet.start({ graceWindowMs: 10 * 60 * 1000 });
    await fleet.addWorker("w-up", { labels: { role: "web" } });
    await fleet.addWorker("w-grace", { labels: { role: "web" } });
    await fleet.addWorker("w-unverified", {
      labels: { role: "web" },
      unverified: true,
    });
    await fleet.worker("w-grace").disconnect();

    const pool = await poolReader(fleet).readPool();
    assertEquals(summary(pool), [
      ["w-grace", "idle", false],
      ["w-unverified", "unverified", true],
      ["w-up", "idle", true],
    ]);
    assertEquals(pool.find((w) => w.name === "w-up")?.labels, { role: "web" });

    const plan = planFanOut(
      { labels: { role: "web" } },
      FanOutPolicySchema.parse({}),
      pool,
    );
    assertEquals(
      plan.kind === "planned"
        ? plan.members.map((m) => [m.worker, m.disposition, m.reason])
        : plan,
      [
        ["w-grace", "waiting", "disconnected"],
        ["w-unverified", "excluded", "unverified"],
        ["w-up", "dispatch", undefined],
      ],
    );
  },
});

Deno.test({
  name:
    "WorkerPoolReader: a worker that left the pool is a member while its token holds, and not once revoked or expired",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-up");
    await fleet.addWorker("w-left");
    await fleet.addWorker("w-revoked");
    await fleet.worker("w-left").disconnect({ untilRemoved: true });
    await revokeToken(fleet, "w-revoked");
    assertEquals(fleet.gateway.worker("w-left"), null);
    assertEquals(fleet.gateway.worker("w-revoked"), null);

    assertEquals(summary(await poolReader(fleet).readPool()), [
      ["w-left", "disconnected", false],
      ["w-up", "idle", true],
    ]);

    // the live worker stays: removing it on expiry is the gateway timer's job, not the reader's
    const afterExpiry = () => Date.now() + 60 * 60 * 1000;
    assertEquals(summary(await poolReader(fleet, afterExpiry).readPool()), [
      ["w-up", "idle", true],
    ]);
  },
});
