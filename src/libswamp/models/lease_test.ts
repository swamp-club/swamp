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
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  modelLeaseAcquire,
  type ModelLeaseDeps,
  modelLeaseRelease,
  modelLeaseStatus,
  type ModelLeaseView,
} from "./lease.ts";

const BEHAVIOR = { name: "web", type: "aws/ec2", id: crypto.randomUUID() };
const LEASE: ModelLeaseView = {
  lockKey: `data/aws/ec2/${BEHAVIOR.id}/.lock`,
  fence: 4,
  holdMs: 1_800_000,
  expiresAt: "2026-10-29T12:30:00.000Z",
};

function deps(overrides: Partial<ModelLeaseDeps> = {}): ModelLeaseDeps {
  return {
    teamMode: true,
    lookupBehavior: (idOrName) =>
      Promise.resolve(idOrName === "web" ? BEHAVIOR : undefined),
    lockKeyOf: (behavior) => `data/${behavior.type}/${behavior.id}/.lock`,
    acquire: () => Promise.resolve({ lease: LEASE, existing: false }),
    release: () => Promise.resolve(true),
    list: () => Promise.resolve([LEASE]),
    now: () => Date.parse("2026-10-29T12:00:00.000Z"),
    ...overrides,
  };
}

const ctx = createLibSwampContext();

Deno.test("modelLeaseAcquire: takes the lease on the behavior's lock key and reports it", async () => {
  const asked: [string, number][] = [];
  const events = await collect(
    modelLeaseAcquire(
      ctx,
      deps({
        acquire: (lockKey, holdMs) => {
          asked.push([lockKey, holdMs]);
          return Promise.resolve({ lease: LEASE, existing: false });
        },
      }),
      { behavior: "web", holdMs: 1_800_000 },
    ),
  );
  assertEquals(asked, [[LEASE.lockKey, 1_800_000]]);
  assertEquals(events, [{
    kind: "completed",
    data: { behavior: BEHAVIOR, existing: false, ...LEASE },
  }]);
});

Deno.test("modelLeaseAcquire: a checkout not written through serve has no leases to take", async () => {
  const events = await collect(
    modelLeaseAcquire(ctx, deps({ teamMode: false }), {
      behavior: "web",
      holdMs: 60_000,
    }),
  );
  assertEquals(events.map((e) => e.kind === "error" && e.error.code), [
    "lease_team_mode_only",
  ]);
});

Deno.test("modelLeaseAcquire: a hold outside 5s to 24h, or an unknown behavior, is refused", async () => {
  for (const holdMs of [1_000, 86_400_001]) {
    const events = await collect(
      modelLeaseAcquire(ctx, deps(), { behavior: "web", holdMs }),
    );
    assertEquals(events.map((e) => e.kind === "error" && e.error.code), [
      "validation_failed",
    ]);
  }
  const unknown = await collect(
    modelLeaseAcquire(ctx, deps(), { behavior: "nope", holdMs: 60_000 }),
  );
  assertEquals(unknown.length, 1);
  assertEquals(unknown[0].kind, "error");
});

Deno.test("modelLeaseAcquire: a hold of up to 24h is accepted, so a lease can be checked out to work offline", async () => {
  const events = await collect(
    modelLeaseAcquire(ctx, deps(), { behavior: "web", holdMs: 86_400_000 }),
  );
  assertEquals(events.map((e) => e.kind), ["completed"]);
});

Deno.test("modelLeaseRelease: reports whether the checkout held a lease on the behavior", async () => {
  const events = await collect(
    modelLeaseRelease(ctx, deps({ release: () => Promise.resolve(false) }), {
      behavior: "web",
    }),
  );
  assertEquals(events, [{
    kind: "completed",
    data: { behavior: BEHAVIOR, lockKey: LEASE.lockKey, released: false },
  }]);
});

Deno.test("modelLeaseStatus: a lease past its expiry reads as expired", async () => {
  const stale = { ...LEASE, expiresAt: "2026-10-29T11:00:00.000Z" };
  const events = await collect(
    modelLeaseStatus(
      ctx,
      deps({ list: () => Promise.resolve([LEASE, stale]) }),
    ),
  );
  assertEquals(events, [{
    kind: "completed",
    data: {
      leases: [{ ...LEASE, state: "held" }, { ...stale, state: "expired" }],
    },
  }]);
});
