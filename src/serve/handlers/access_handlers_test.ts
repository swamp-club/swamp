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

import { assertEquals, assertGreater } from "@std/assert";
import { handleAccessCheck, handleAccessReload } from "./access_handlers.ts";
import { type ConnectionContext, setConnectionCollectives } from "./shared.ts";
import type { AccessCheckPayload } from "../protocol.ts";
import type {
  AccessDecisionService,
  AccessPrincipal,
  AccessResource,
} from "../../domain/access/access_decision_service.ts";
import type { Action } from "../../domain/access/action.ts";
import type { Principal } from "../../domain/access/principal.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../../domain/datastore/datastore_sync_service.ts";

interface CapturedExplainCall {
  principal: AccessPrincipal;
  action: Action;
  resource: AccessResource;
}

function createMockDecisionService(): {
  service: AccessDecisionService;
  calls: CapturedExplainCall[];
} {
  const calls: CapturedExplainCall[] = [];
  const service: AccessDecisionService = {
    decide(_p, _a, _r) {
      return {
        effect: "allow",
        grantId: "mock-grant",
        subject: { kind: "user" as const, name: "admin" },
      };
    },
    explain(principal, action, resource) {
      calls.push({ principal, action, resource });
      return [];
    },
  };
  return { service, calls };
}

function createMockSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    sent,
    close() {},
  } as unknown as WebSocket & { sent: string[] };
}

function createCtx(
  service: AccessDecisionService,
  mode: "none" | "token" | "oauth" = "token",
): ConnectionContext {
  return {
    repoDir: "/tmp/test",
    repoContext: {} as ConnectionContext["repoContext"],
    datastoreConfig: {} as ConnectionContext["datastoreConfig"],
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
      groupsField: "collectives",
      restrictedModelTypes: [],
      restrictedCommands: [],
    },
  };
}

Deno.test("handleAccessCheck: foreign subject evaluates with empty groups", async () => {
  const { service, calls } = createMockDecisionService();
  const socket = createMockSocket();
  const callerPrincipal: Principal = { kind: "user", id: "admin" };
  const ctx = createCtx(service);

  setConnectionCollectives(socket, ["acme-collective"], ["platform-eng"]);

  const payload: AccessCheckPayload = {
    subject: "user:stranger",
    action: "run",
    resource: "workflow:@acme/deploy",
  };

  await handleAccessCheck(socket, ctx, "req-1", payload, callerPrincipal);

  assertEquals(calls.length, 1);
  assertEquals(calls[0].principal.principal, { kind: "user", id: "stranger" });
  assertEquals(calls[0].principal.collectives, []);
  assertEquals(calls[0].principal.groups, []);

  const response = JSON.parse(socket.sent[0]);
  assertEquals(response.payload.collectives, []);
  assertEquals(response.payload.groups, []);
});

Deno.test("handleAccessCheck: self-check evaluates with caller groups", async () => {
  const { service, calls } = createMockDecisionService();
  const socket = createMockSocket();
  const callerPrincipal: Principal = { kind: "user", id: "admin" };
  const ctx = createCtx(service);

  setConnectionCollectives(
    socket,
    ["acme-collective"],
    ["platform-eng", "ops"],
  );

  const payload: AccessCheckPayload = {
    subject: "user:admin",
    action: "run",
    resource: "workflow:@acme/deploy",
  };

  await handleAccessCheck(socket, ctx, "req-1", payload, callerPrincipal);

  assertEquals(calls.length, 1);
  assertEquals(calls[0].principal.principal, { kind: "user", id: "admin" });
  assertEquals([...calls[0].principal.collectives], ["acme-collective"]);
  assertEquals([...calls[0].principal.groups], ["platform-eng", "ops"]);

  const response = JSON.parse(socket.sent[0]);
  assertEquals(response.payload.collectives, ["acme-collective"]);
  assertEquals(response.payload.groups, ["platform-eng", "ops"]);
});

Deno.test("handleAccessCheck: null principal evaluates with empty groups", async () => {
  const { service, calls } = createMockDecisionService();
  const socket = createMockSocket();
  const ctx = createCtx(service, "none");

  setConnectionCollectives(socket, ["acme-collective"], ["platform-eng"]);

  const payload: AccessCheckPayload = {
    subject: "user:anyone",
    action: "run",
    resource: "workflow:@acme/deploy",
  };

  await handleAccessCheck(socket, ctx, "req-1", payload, null);

  assertEquals(calls.length, 1);
  assertEquals(calls[0].principal.principal, { kind: "user", id: "anyone" });
  assertEquals(calls[0].principal.collectives, []);
  assertEquals(calls[0].principal.groups, []);
});

function createMockSyncService(): {
  service: DatastoreSyncService;
  pullCalls: DatastoreSyncOptions[];
} {
  const pullCalls: DatastoreSyncOptions[] = [];
  const service: DatastoreSyncService = {
    async pullChanged(
      options?: DatastoreSyncOptions,
    ): Promise<number | void> {
      pullCalls.push(options ?? {});
      return 0;
    },
    pushChanged(): Promise<number | void> {
      return Promise.resolve(0);
    },
    async markDirty(): Promise<void> {},
  };
  return { service, pullCalls };
}

function createMockUnifiedDataRepo() {
  return {
    findAllForType() {
      return Promise.resolve([]);
    },
    getContent() {
      return Promise.resolve(null);
    },
  };
}

function createReloadCtx(
  syncService?: DatastoreSyncService,
): ConnectionContext {
  let loadCalled = false;
  return {
    repoDir: "/tmp/test-reload-nonexistent",
    repoContext: {
      catalogStore: { invalidate() {} },
      eventBus: { subscribe() {} },
      definitionRepo: { save() {} },
      unifiedDataRepo: createMockUnifiedDataRepo(),
    } as unknown as ConnectionContext["repoContext"],
    datastoreConfig: {} as ConnectionContext["datastoreConfig"],
    datastoreResolver: {} as ConnectionContext["datastoreResolver"],
    syncService,
    policySnapshotLoader: {
      async loadWithCounts() {
        loadCalled = true;
        return { grantCount: 0, groupCount: 0 };
      },
      get _loadCalled() {
        return loadCalled;
      },
    } as unknown as PolicySnapshotLoader,
    authConfig: {
      mode: "none" as const,
      admins: [],
      allowedCollectives: [],
      allowedUsers: [],
      oauthProvider: "",
      groupsField: "collectives",
      restrictedModelTypes: [],
      restrictedCommands: [],
    },
  };
}

Deno.test("handleAccessReload: pulls remote access data before loading snapshot when syncService present", async () => {
  const { service: syncService, pullCalls } = createMockSyncService();
  const ctx = createReloadCtx(syncService);
  const socket = createMockSocket();

  await handleAccessReload(socket, ctx, "req-reload", null);

  assertGreater(pullCalls.length, 0);
  assertEquals(pullCalls[0].subdirs, [
    "data/swamp/grant",
    "data/swamp/group",
    "data/@swamp/grant",
    "data/@swamp/group",
  ]);

  const response = JSON.parse(socket.sent[0]);
  assertEquals(response.payload.success, true);
});

Deno.test("handleAccessReload: works without syncService (local-only mode)", async () => {
  const ctx = createReloadCtx(undefined);
  const socket = createMockSocket();

  await handleAccessReload(socket, ctx, "req-reload", null);

  const response = JSON.parse(socket.sent[0]);
  assertEquals(response.payload.success, true);
});
