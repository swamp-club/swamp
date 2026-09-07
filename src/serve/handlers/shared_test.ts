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
import type { Grant } from "../../domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../../domain/access/principal.ts";
import {
  authorizeAnyOrReject,
  type ConnectionContext,
  filterByAuthorization,
  setConnectionCollectives,
} from "./shared.ts";

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "model", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makePrincipal(id: string): Principal {
  return { kind: "user", id };
}

function makeCtx(
  grants: Grant[],
  mode: "none" | "token" | "oauth" = "token",
): ConnectionContext {
  const snapshot = new PolicySnapshot(grants, []);
  const service = new GrantBasedAccessDecisionService(snapshot);
  return {
    repoDir: "/tmp/test",
    repoContext: {} as ConnectionContext["repoContext"],
    datastoreConfig: {
      type: "filesystem",
    } as ConnectionContext["datastoreConfig"],
    datastoreResolver: {} as ConnectionContext["datastoreResolver"],
    policySnapshotLoader: {
      decisionService: service,
    } as unknown as PolicySnapshotLoader,
    authConfig: {
      mode,
      admins: [],
      allowedCollectives: [],
      allowedUsers: [],
      oauthProvider: "",
      groupsField: "groups",
      restrictedModelTypes: [],
      restrictedCommands: [],
    },
  };
}

function makeSocket(): WebSocket {
  return {
    readyState: 1,
    send: () => {},
    OPEN: 1,
  } as unknown as WebSocket;
}

type TestItem = { name: string; type: string };

const testItems: TestItem[] = [
  { name: "@acme/deploy", type: "@acme" },
  { name: "@acme/build", type: "@acme" },
  { name: "@other/run", type: "@other" },
];

Deno.test("filterByAuthorization: returns all items when auth mode is none", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([], "none");
  const result = filterByAuthorization(
    testItems,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 3);
});

Deno.test("filterByAuthorization: returns empty when no principal", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "*" } }),
  ]);
  const result = filterByAuthorization(
    testItems,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    null,
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 0);
});

Deno.test("filterByAuthorization: returns all items for admin user", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    }),
  ]);
  const result = filterByAuthorization(
    testItems,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 3);
});

Deno.test("filterByAuthorization: filters by scoped grant", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "@acme/*" } }),
  ]);
  const result = filterByAuthorization(
    testItems,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "@acme/deploy");
  assertEquals(result[1].name, "@acme/build");
});

Deno.test("filterByAuthorization: excludes items with undefined name", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "*" } }),
  ]);
  const items = [
    { modelName: "@acme/deploy" },
    { modelName: undefined },
  ];
  const result = filterByAuthorization(
    items,
    (item) => item.modelName,
    (item) => ({ name: item.modelName }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 1);
});

Deno.test("filterByAuthorization: deny grant excludes matching items", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "*" } }),
    makeGrant({
      effect: "deny",
      resource: { kind: "model", pattern: "@other/*" },
    }),
  ]);
  const result = filterByAuthorization(
    testItems,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "@acme/deploy");
  assertEquals(result[1].name, "@acme/build");
});

Deno.test("filterByAuthorization: admin with deny grant respects deny", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    }),
    makeGrant({
      effect: "deny",
      actions: ["read"],
      resource: { kind: "model", pattern: "@secret/*" },
    }),
  ]);
  const itemsWithSecret: TestItem[] = [
    ...testItems,
    { name: "@secret/keys", type: "@secret" },
  ];
  const result = filterByAuthorization(
    itemsWithSecret,
    (item) => item.name,
    (item) => ({ name: item.name }),
    socket,
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result.length, 3);
  assertEquals(result[0].name, "@acme/deploy");
  assertEquals(result[1].name, "@acme/build");
  assertEquals(result[2].name, "@other/run");
});

Deno.test("authorizeAnyOrReject: returns true when auth mode is none", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([], "none");
  const result = authorizeAnyOrReject(
    socket,
    "req-1",
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result, true);
});

Deno.test("authorizeAnyOrReject: returns false when no principal", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([]);
  const result = authorizeAnyOrReject(
    socket,
    "req-1",
    null,
    "read",
    "model",
    ctx,
  );
  assertEquals(result, false);
});

Deno.test("authorizeAnyOrReject: returns true when user has scoped grant", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({ resource: { kind: "model", pattern: "@acme/*" } }),
  ]);
  const result = authorizeAnyOrReject(
    socket,
    "req-1",
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result, true);
});

Deno.test("authorizeAnyOrReject: returns false when no grants exist", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([]);
  const result = authorizeAnyOrReject(
    socket,
    "req-1",
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result, false);
});

Deno.test("authorizeAnyOrReject: returns true for admin fallback", () => {
  const socket = makeSocket();
  setConnectionCollectives(socket, [], []);
  const ctx = makeCtx([
    makeGrant({
      actions: ["admin"],
      resource: { kind: "access", pattern: "*" },
    }),
  ]);
  const result = authorizeAnyOrReject(
    socket,
    "req-1",
    makePrincipal("adam"),
    "read",
    "model",
    ctx,
  );
  assertEquals(result, true);
});
