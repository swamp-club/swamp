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

import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import type { Grant } from "../models/access/grant_model.ts";
import type { Group } from "../models/access/group_model.ts";
import type { AccessPrincipal } from "./access_decision_service.ts";
import { GrantBasedAccessDecisionService } from "./grant_based_access_decision_service.ts";
import { PolicySnapshot } from "./policy_snapshot.ts";
import { readAccessFingerprint } from "./read_access_fingerprint.ts";

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "data", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeGroup(name: string, memberIds: string[]): Group {
  return {
    name,
    members: memberIds.map((id) => ({ kind: "user" as const, id })),
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const ADAM: AccessPrincipal = {
  principal: { kind: "user", id: "adam" },
  collectives: ["acme"],
  groups: ["idp-ops"],
};

function fingerprintOf(
  grants: readonly Grant[],
  groups: readonly Group[] = [],
  principal: AccessPrincipal = ADAM,
): string {
  return new GrantBasedAccessDecisionService(
    new PolicySnapshot(grants, groups),
  ).readAccessFingerprint(principal, []);
}

const READ_DATA = makeGrant({ id: "g-read" });

Deno.test("readAccessFingerprint: is a hex SHA-256 digest", () => {
  assertMatch(fingerprintOf([READ_DATA]), /^[0-9a-f]{64}$/);
});

Deno.test("readAccessFingerprint: ignores grant order and metadata", () => {
  const other = makeGrant({
    id: "g-other",
    resource: { kind: "model", pattern: "*" },
  });
  assertEquals(
    fingerprintOf([READ_DATA, other]),
    fingerprintOf([
      other,
      { ...READ_DATA, createdAt: "2026-05-05T00:00:00Z", source: "file" },
    ]),
  );
});

Deno.test("readAccessFingerprint: a widened or narrowed read grant changes it", () => {
  const base = fingerprintOf([READ_DATA]);
  assertNotEquals(
    fingerprintOf([
      READ_DATA,
      makeGrant({ id: "g-more", resource: { kind: "model", pattern: "*" } }),
    ]),
    base,
  );
  assertNotEquals(fingerprintOf([]), base);
  assertNotEquals(
    fingerprintOf([{
      ...READ_DATA,
      resource: { kind: "data", pattern: "web/*" },
    }]),
    base,
  );
  assertNotEquals(fingerprintOf([{ ...READ_DATA, condition: "true" }]), base);
  assertNotEquals(fingerprintOf([{ ...READ_DATA, effect: "deny" }]), base);
  assertNotEquals(fingerprintOf([{ ...READ_DATA, methods: ["get"] }]), base);
});

Deno.test("readAccessFingerprint: an admin grant changes it", () => {
  assertNotEquals(
    fingerprintOf([
      READ_DATA,
      makeGrant({
        id: "g-admin",
        actions: ["admin"],
        resource: { kind: "access", pattern: "*" },
      }),
    ]),
    fingerprintOf([READ_DATA]),
  );
});

Deno.test("readAccessFingerprint: grants without read or admin leave it alone", () => {
  assertEquals(
    fingerprintOf([
      READ_DATA,
      makeGrant({ id: "g-write", actions: ["write", "run"] }),
    ]),
    fingerprintOf([READ_DATA]),
  );
});

Deno.test("readAccessFingerprint: other subjects' grants leave it alone", () => {
  assertEquals(
    fingerprintOf([
      READ_DATA,
      makeGrant({ id: "g-bob", subject: { kind: "user", name: "bob" } }),
      makeGrant({ id: "g-devs", subject: { kind: "group", name: "devs" } }),
    ], [makeGroup("devs", ["bob"])]),
    fingerprintOf([READ_DATA], [makeGroup("devs", ["bob"])]),
  );
});

Deno.test("readAccessFingerprint: grants through local and IdP groups count", () => {
  const viaGroup = makeGrant({
    id: "g-ops",
    subject: { kind: "group", name: "ops" },
  });
  const viaIdp = makeGrant({
    id: "g-idp",
    subject: { kind: "idp-group", name: "idp-ops" },
  });
  const base = fingerprintOf([READ_DATA], [makeGroup("ops", ["adam"])]);
  assertNotEquals(
    fingerprintOf([READ_DATA, viaGroup], [makeGroup("ops", ["adam"])]),
    base,
  );
  assertNotEquals(
    fingerprintOf([READ_DATA, viaIdp], [makeGroup("ops", ["adam"])]),
    base,
  );
});

Deno.test("readAccessFingerprint: group membership and collectives change it", () => {
  const base = fingerprintOf([READ_DATA]);
  assertNotEquals(
    fingerprintOf([READ_DATA], [makeGroup("ops", ["adam"])]),
    base,
  );
  assertNotEquals(
    fingerprintOf([READ_DATA], [], { ...ADAM, collectives: ["acme", "beta"] }),
    base,
  );
  assertNotEquals(
    fingerprintOf([READ_DATA], [], { ...ADAM, groups: [] }),
    base,
  );
  assertEquals(
    fingerprintOf([READ_DATA], [], { ...ADAM, collectives: ["acme"] }),
    base,
  );
});

Deno.test("readAccessFingerprint: differs between principals with the same grants", () => {
  const forAll = makeGrant({
    id: "g-all",
    subject: { kind: "group", name: "all" },
  });
  const groups = [makeGroup("all", ["adam", "bob"])];
  assertNotEquals(
    fingerprintOf([forAll], groups),
    fingerprintOf([forAll], groups, {
      ...ADAM,
      principal: { kind: "user", id: "bob" },
    }),
  );
});

Deno.test("GrantBasedAccessDecisionService.readAccessFingerprint: follows a snapshot swap", () => {
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot([READ_DATA], []),
  );
  const before = service.readAccessFingerprint(ADAM, []);
  assertEquals(service.readAccessFingerprint(ADAM, []), before);
  service.snapshot = new PolicySnapshot(
    [
      READ_DATA,
      makeGrant({ id: "g-bob", subject: { kind: "user", name: "bob" } }),
    ],
    [],
  );
  assertEquals(service.readAccessFingerprint(ADAM, []), before);
  service.snapshot = new PolicySnapshot([], []);
  assertNotEquals(service.readAccessFingerprint(ADAM, []), before);
});

Deno.test("readAccessFingerprint: the pure function matches the service", () => {
  assertEquals(
    readAccessFingerprint(ADAM, [], [READ_DATA], []),
    fingerprintOf([READ_DATA]),
  );
});

Deno.test("readAccessFingerprint: serve's restricted behavior types change it, in any order", () => {
  const service = new GrantBasedAccessDecisionService(
    new PolicySnapshot([READ_DATA], []),
  );
  const none = service.readAccessFingerprint(ADAM, []);
  const one = service.readAccessFingerprint(ADAM, ["@acme/secret"]);
  assertNotEquals(one, none);
  assertNotEquals(
    service.readAccessFingerprint(ADAM, ["@acme/secret", "@acme/vault"]),
    one,
  );
  assertEquals(
    service.readAccessFingerprint(ADAM, ["@acme/vault", "@acme/secret"]),
    service.readAccessFingerprint(ADAM, [
      "@acme/secret",
      "@acme/vault",
      "@acme/secret",
    ]),
  );
  assertEquals(service.readAccessFingerprint(ADAM, []), none);
});
