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

import { assertEquals, assertNotEquals } from "@std/assert";
import { serveCallerFingerprint } from "./checkout_view.ts";
import {
  keepsProbedCopy,
  probeVouches,
  registerCheckoutLeases,
  serveUpstreamLocalRoot,
} from "./serve_upstream_binding.ts";
import type { ExplicitLease } from "./explicit_model_leases.ts";
import {
  heldServeLeaseOf,
  resetServeLeasesForTesting,
} from "./serve_lease_registry.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import { MODEL_TYPE } from "../../domain/datastore_v3/v3_test_helpers.ts";
import { leaseLockKeyOfPartition } from "./serve_lease_registry.ts";
import {
  ACCESS_RESET_COOLDOWN_MS,
  accessResetDue,
} from "./serve_upstream_state.ts";

Deno.test("serveUpstreamLocalRoot: one copy per serve and namespace, whatever the token", () => {
  const root = (url: string, ns: string) =>
    serveUpstreamLocalRoot("/repo", url, ns);
  const base = root("http://serve.example.com", "");
  assertEquals(base, root("http://serve.example.com", ""));
  assertNotEquals(base, root("http://serve.example.com", "team"));
  assertNotEquals(base, root("http://other.example.com", ""));
});

Deno.test("serveCallerFingerprint: tells tokens apart without holding them", () => {
  const alice = serveCallerFingerprint("alice.secret");
  assertEquals(alice, serveCallerFingerprint("alice.secret"));
  assertNotEquals(alice, serveCallerFingerprint("bob.secret"));
  assertNotEquals(alice, serveCallerFingerprint(undefined));
  assertEquals(serveCallerFingerprint(undefined), serveCallerFingerprint(""));
  assertEquals(alice.includes("alice"), false);
  assertEquals(alice.length, 64);
});

Deno.test("accessResetDue: resets when serve sent another access, except within the cooldown of the last access reset (swamp-club#4089)", () => {
  const now = 10 * ACCESS_RESET_COOLDOWN_MS;
  assertEquals(accessResetDue({}, now), "current");
  assertEquals(accessResetDue({ built: "a1" }, now), "current");
  assertEquals(accessResetDue({ built: "a1", seen: "a1" }, now), "current");
  assertEquals(accessResetDue({ built: "a1", seen: "b2" }, now), "reset");
  assertEquals(
    accessResetDue({ built: "a1", seen: "b2", resetAt: now - 1 }, now),
    "cooling",
  );
  assertEquals(
    accessResetDue(
      { built: "a1", seen: "b2", resetAt: now - ACCESS_RESET_COOLDOWN_MS },
      now,
    ),
    "reset",
  );
  assertEquals(
    accessResetDue({ built: "a1", seen: "b2", resetAt: now + 1 }, now),
    "reset",
  );
  assertEquals(
    accessResetDue({ built: "a1", seen: "a1", resetAt: now - 1 }, now),
    "current",
  );
});

Deno.test("registerCheckoutLeases: a renewed lease is confirmed, one not renewed is registered unconfirmed, an ended one never (swamp-club#4167)", () => {
  resetServeLeasesForTesting();
  const root = "/checkout/root";
  const partitions = [1, 2, 3].map((n) =>
    partitionOf({
      kind: "model",
      type: MODEL_TYPE,
      id: `00000000-0000-4000-8000-00000000000${n}`,
    })
  );
  const leases: ExplicitLease[] = partitions.map((partition, index) => ({
    leaseId: `lease-${index}`,
    lockKey: leaseLockKeyOfPartition(partition)!,
    fence: index + 1,
    holdMs: 60_000,
    expiresAt: "2026-10-30T00:00:00.000Z",
    floor: [{ name: "out", highWater: index }],
  }));
  const [renewed, failed, ended] = leases;
  try {
    registerCheckoutLeases(root, leases, {
      renewed: [renewed],
      ended: [ended],
    });
    assertEquals(heldServeLeaseOf(root, partitions[0]), {
      leaseId: "lease-0",
      fence: 1,
      floor: [{ name: "out", highWater: 0 }],
    });
    assertEquals(heldServeLeaseOf(root, partitions[1]), {
      leaseId: "lease-1",
      fence: 2,
      floor: [{ name: "out", highWater: 1 }],
      unconfirmed: true,
    });
    assertEquals(heldServeLeaseOf(root, partitions[2]), undefined);

    resetServeLeasesForTesting();
    registerCheckoutLeases(root, [failed, ended], undefined);
    assertEquals(heldServeLeaseOf(root, partitions[1])?.unconfirmed, true);
    assertEquals(heldServeLeaseOf(root, partitions[2])?.unconfirmed, true);
  } finally {
    resetServeLeasesForTesting();
  }
});

Deno.test("probeVouches: only serve naming the cached principal, with the access the copy was built under when both are known (swamp-club#4512)", () => {
  const checked = { kind: "checked", principal: "user:p" } as const;
  const cases: [Parameters<typeof probeVouches>[0], boolean][] = [
    [{ cached: "user:p", mode: checked, built: "a", access: "a" }, true],
    [{ cached: "user:p", mode: checked, built: undefined, access: "a" }, true],
    [{ cached: "user:p", mode: checked, built: "a", access: undefined }, true],
    [{ cached: "user:p", mode: checked, built: "a", access: "b" }, false],
    [{ cached: "user:q", mode: checked, built: "a", access: "a" }, false],
    [{
      cached: "user:p",
      mode: { kind: "not-checked" },
      built: "a",
      access: "a",
    }, false],
    [{ cached: "user:p", mode: undefined, built: "a", access: "a" }, false],
  ];
  for (const [seen, expected] of cases) {
    assertEquals(probeVouches(seen), expected, JSON.stringify(seen));
  }
});

Deno.test("keepsProbedCopy: never a copy another caller reset, or whose principal changed, while the lease was awaited (swamp-club#4512)", () => {
  const probe = { principal: "user:p", fingerprint: "fp-old" };
  const caller = { fingerprint: "fp-old", resetting: false };
  assertEquals(keepsProbedCopy(probe, caller, "user:p"), true);
  assertEquals(keepsProbedCopy(undefined, caller, "user:p"), false);
  assertEquals(
    keepsProbedCopy(probe, { fingerprint: "fp-q", resetting: false }, "user:q"),
    false,
    "reset for principal Q meanwhile",
  );
  assertEquals(
    keepsProbedCopy(probe, { fingerprint: "fp-q", resetting: false }, "user:p"),
    false,
    "another fingerprint, even of the same principal",
  );
  assertEquals(keepsProbedCopy(probe, caller, undefined), false);
  assertEquals(
    keepsProbedCopy(
      probe,
      { fingerprint: "fp-old", resetting: true },
      "user:p",
    ),
    false,
  );
  assertEquals(keepsProbedCopy(probe, undefined, "user:p"), false);
});
