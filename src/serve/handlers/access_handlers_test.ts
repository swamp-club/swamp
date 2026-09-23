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

import { assert, assertEquals, assertGreater } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  handleAccessCanI,
  handleAccessCheck,
  handleAccessReload,
} from "./access_handlers.ts";
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
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../../domain/datastore/datastore_sync_service.ts";
import { ACCESS_DATA_SUBDIRS } from "../access_data_poller.ts";
import { buildMarkDirtyHook } from "../../cli/repo_context.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import { createRepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import type { CustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";

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
    hasAnyGrantForKind() {
      return true;
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
      groupsField: "collectives",
      restrictedModelTypes: [],
      restrictedCommands: [],
      approveRequiresExplicitGrant: false,
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
  pushCalls: DatastoreSyncOptions[];
  markDirtyCalls: DatastoreSyncOptions[];
} {
  const pullCalls: DatastoreSyncOptions[] = [];
  const pushCalls: DatastoreSyncOptions[] = [];
  const markDirtyCalls: DatastoreSyncOptions[] = [];
  const service: DatastoreSyncService = {
    pullChanged(
      options?: DatastoreSyncOptions,
    ): Promise<number | void> {
      pullCalls.push(options ?? {});
      return Promise.resolve(0);
    },
    pushChanged(options?: DatastoreSyncOptions): Promise<number | void> {
      pushCalls.push(options ?? {});
      return Promise.resolve(0);
    },
    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      markDirtyCalls.push(options ?? {});
      return Promise.resolve();
    },
  };
  return { service, pullCalls, pushCalls, markDirtyCalls };
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
    datastoreConfig: {
      type: "filesystem",
    } as ConnectionContext["datastoreConfig"],
    datastoreResolver: {} as ConnectionContext["datastoreResolver"],
    syncService,
    policySnapshotLoader: {
      loadWithCounts() {
        loadCalled = true;
        return Promise.resolve({ grantCount: 0, groupCount: 0 });
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
      approveRequiresExplicitGrant: false,
    },
  };
}

Deno.test("handleAccessReload: pulls remote access data before loading snapshot when syncService present", async () => {
  const { service: syncService, pullCalls } = createMockSyncService();
  const ctx = createReloadCtx(syncService);
  const socket = createMockSocket();

  await handleAccessReload(socket, ctx, "req-reload", null);

  assertGreater(pullCalls.length, 0);
  assertEquals(pullCalls[0].subdirs, [...ACCESS_DATA_SUBDIRS]);

  const response = JSON.parse(socket.sent[0]);
  assertEquals(response.payload.success, true);
});

Deno.test("handleAccessReload: pushes reconciled grants to remote datastore before pulling", async () => {
  const { service: syncService, pushCalls, pullCalls, markDirtyCalls } =
    createMockSyncService();
  const ctx = createReloadCtx(syncService);
  const socket = createMockSocket();

  await handleAccessReload(socket, ctx, "req-reload", null);

  // No grant changed, so nothing is marked. A bare markDirty() would set
  // bulkInvalidated and turn the push into a walk of the whole cache
  // (swamp-club#2415).
  assertEquals(markDirtyCalls, []);
  assertGreater(pushCalls.length, 0);
  assertGreater(pullCalls.length, 0);

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

// --- approval policy: run implying approve ---

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "resumer" },
    effect: "allow",
    actions: ["run", "read"],
    resource: { kind: "workflow", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function createPolicyCtx(
  grants: Grant[],
  runImpliesApprove: boolean,
): ConnectionContext {
  const snapshot = new PolicySnapshot(grants, []);
  const decisionService = new GrantBasedAccessDecisionService(snapshot, {
    runImpliesApprove,
  });
  const ctx = createCtx(decisionService);
  return {
    ...ctx,
    policySnapshotLoader: {
      snapshot,
      decisionService,
    } as unknown as PolicySnapshotLoader,
    authConfig: {
      ...ctx.authConfig!,
      approveRequiresExplicitGrant: !runImpliesApprove,
    },
  };
}

const RESUMER: Principal = { kind: "user", id: "resumer" };

Deno.test("handleAccessCanI: listing shows approve implied by a run grant", async () => {
  const socket = createMockSocket();
  const ctx = createPolicyCtx([makeGrant()], true);

  await handleAccessCanI(socket, ctx, "req-1", {}, RESUMER);

  const payload = JSON.parse(socket.sent[0]).payload;
  assertEquals(payload.approveRequiresExplicitGrant, false);
  assertEquals(
    payload.decisions.map((d: { action: string; impliedBy?: string }) => [
      d.action,
      d.impliedBy,
    ]),
    [["run", undefined], ["read", undefined], ["approve", "run"]],
  );
});

Deno.test("handleAccessCanI: listing omits implied approve when approve requires an explicit grant", async () => {
  const socket = createMockSocket();
  const ctx = createPolicyCtx([makeGrant()], false);

  await handleAccessCanI(socket, ctx, "req-1", {}, RESUMER);

  const payload = JSON.parse(socket.sent[0]).payload;
  assertEquals(payload.approveRequiresExplicitGrant, true);
  assertEquals(
    payload.decisions.map((d: { action: string }) => d.action),
    ["run", "read"],
  );
});

Deno.test("handleAccessCanI: listing keeps approve implied by a deny on run in both policies", async () => {
  for (const runImpliesApprove of [true, false]) {
    const socket = createMockSocket();
    const ctx = createPolicyCtx(
      [makeGrant({ effect: "deny", actions: ["run"] })],
      runImpliesApprove,
    );

    await handleAccessCanI(socket, ctx, "req-1", {}, RESUMER);

    const payload = JSON.parse(socket.sent[0]).payload;
    assertEquals(
      payload.decisions.map((
        d: { action: string; effect: string; impliedBy?: string },
      ) => [d.action, d.effect, d.impliedBy]),
      [["run", "deny", undefined], ["approve", "deny", "run"]],
    );
  }
});

Deno.test("handleAccessCanI: specific approve check carries impliedBy", async () => {
  const socket = createMockSocket();
  const ctx = createPolicyCtx([makeGrant()], true);

  await handleAccessCanI(
    socket,
    ctx,
    "req-1",
    { action: "approve", resource: "workflow:@acme/deploy" },
    RESUMER,
  );

  const payload = JSON.parse(socket.sent[0]).payload;
  assertEquals(payload.decisions.length, 1);
  assertEquals(payload.decisions[0].effect, "allow");
  assertEquals(payload.decisions[0].impliedBy, "run");
  assertEquals(payload.approveRequiresExplicitGrant, false);
});

Deno.test("handleAccessCheck: reports the approval policy and omits run-only grants when approve requires an explicit grant", async () => {
  const socket = createMockSocket();
  const policyCtx = createPolicyCtx([makeGrant()], false);
  // access.check requires admin; auth mode none lets the check itself run.
  const ctx = {
    ...policyCtx,
    authConfig: { ...policyCtx.authConfig!, mode: "none" as const },
  };

  await handleAccessCheck(
    socket,
    ctx,
    "req-1",
    {
      subject: "user:resumer",
      action: "approve",
      resource: "workflow:@acme/deploy",
    },
    null,
  );

  const payload = JSON.parse(socket.sent[0]).payload;
  assertEquals(payload.approveRequiresExplicitGrant, true);
  assertEquals(payload.decisions, []);
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

// Models an ungated push (post-run, post-resume) landing right after each
// mark: the repositories mark a path before writing it, so that push finds
// the path absent, takes it as a delete and clears the mark. Only marks made
// after the write are still set when the handler pushes.
function createRacingSyncService(cacheRoot: string): {
  service: DatastoreSyncService;
  marks: Array<string | undefined>;
  dirtyAtPush: string[][];
} {
  const dirty = new Set<string>();
  const marks: Array<string | undefined> = [];
  const dirtyAtPush: string[][] = [];
  const service: DatastoreSyncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => {
      dirtyAtPush.push([...dirty]);
      dirty.clear();
      return Promise.resolve(0);
    },
    async markDirty(options?: DatastoreSyncOptions): Promise<void> {
      marks.push(options?.relPath);
      if (!options?.relPath) return;
      try {
        await Deno.stat(join(cacheRoot, options.relPath));
        dirty.add(options.relPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        dirty.delete(options.relPath);
      }
    },
  };
  return { service, marks, dirtyAtPush };
}

Deno.test("handleAccessReload: re-marks the paths reconcile wrote, per path, before the push (swamp-club#2415)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const cacheRoot = join(dir, "cache");
    await ensureDir(join(repoDir, "grants"));
    await ensureDir(cacheRoot);
    await Deno.writeTextFile(
      join(repoDir, "grants", "team.yaml"),
      `grants:
  - subject: "idp-group:platform-eng"
    effect: allow
    actions: [run]
    resource: "workflow:@acme/*"
`,
    );

    const { service, marks, dirtyAtPush } = createRacingSyncService(
      cacheRoot,
    );
    const datastoreConfig: CustomDatastoreConfig = {
      type: "@test/remote",
      config: {},
      datastorePath: join(dir, "remote"),
      cachePath: cacheRoot,
    };
    const repoContext = createRepositoryContext({
      repoDir,
      datastoreResolver: new DefaultDatastorePathResolver(
        repoDir,
        datastoreConfig,
      ),
      markDirty: buildMarkDirtyHook(service, cacheRoot, repoDir),
    });
    try {
      const ctx: ConnectionContext = {
        ...createReloadCtx(service),
        repoDir,
        repoContext,
        datastoreConfig,
      };

      await handleAccessReload(createMockSocket(), ctx, "req-1", null);

      // A bare markDirty() sets bulkInvalidated and turns the push into a
      // walk of the whole cache.
      assertEquals(
        marks.filter((m) => m === undefined),
        [],
        "reload must not call bare markDirty()",
      );
      assertEquals(dirtyAtPush.length, 1);
      const pushed = dirtyAtPush[0];
      assert(
        pushed.some((p) =>
          p.startsWith("auto-definitions/") && p.endsWith(".yaml")
        ),
        `grant definition must still be marked at the push, got ${pushed}`,
      );
      assert(
        pushed.some((p) => p.endsWith("/grant-main")),
        `grant data must still be marked at the push, got ${pushed}`,
      );

      // Nothing changed on the second reload, so nothing is marked.
      marks.length = 0;
      await handleAccessReload(createMockSocket(), ctx, "req-2", null);
      assertEquals(marks, []);
      assertEquals(dirtyAtPush[1], []);
    } finally {
      repoContext.catalogStore.close();
    }
  });
});
