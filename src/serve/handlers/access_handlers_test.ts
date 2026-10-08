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

import {
  assert,
  assertEquals,
  assertGreater,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { SERVER_TOKEN_MODEL_TYPE } from "../../domain/models/access/server_token_model.ts";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { createServerTokenLock } from "../../infrastructure/persistence/server_token_lock.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { useUnscopedChangeReporterForTesting } from "../../infrastructure/persistence/unit_of_work_scope.ts";
import {
  handleAccessCanI,
  handleAccessCheck,
  handleAccessReload,
  handleAccessTokenRevoke,
  handleAccessTokenRotate,
  withServerTokenWriteLock,
} from "./access_handlers.ts";
import {
  type ConnectionContext,
  removeConnection,
  setConnectionCollectives,
  setConnectionToken,
  terminateTokenSessions,
} from "./shared.ts";
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
import { createFileGrantStore } from "../../domain/access/grant_file_reconciler.ts";

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
    decideAll() {
      return {
        effect: "allow",
        grantId: "mock-grant",
        subject: { kind: "user" as const, name: "admin" },
      };
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
      signalRequiresExplicitGrant: false,
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
      signalRequiresExplicitGrant: false,
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

  // The handler itself sends no bare markDirty(), which would set
  // bulkInvalidated and turn the push into a walk of the whole cache
  // (swamp-club#2415). Per-path marks come from the repositories, which this
  // mock context does not wire; the real-repo test below covers them.
  assertEquals(markDirtyCalls, []);
  assertGreater(pushCalls.length, 0);
  assertGreater(pullCalls.length, 0);

  const response = JSON.parse(socket.sent[0]);
  assertEquals(response.payload.success, true);
});

Deno.test("handleAccessReload: a failed push still pulls, loads the snapshot and replies success", async () => {
  const { service: syncService, pushCalls, pullCalls } =
    createMockSyncService();
  syncService.pushChanged = (options?: DatastoreSyncOptions) => {
    pushCalls.push(options ?? {});
    return Promise.reject(new Error("datastore unreachable"));
  };
  const ctx = createReloadCtx(syncService);
  const socket = createMockSocket();

  await handleAccessReload(socket, ctx, "req-reload", null);

  assertEquals(pushCalls.length, 1);
  assertEquals(pullCalls.length, 1);
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
  runImpliesSignal = true,
): ConnectionContext {
  const snapshot = new PolicySnapshot(grants, []);
  const decisionService = new GrantBasedAccessDecisionService(snapshot, {
    runImpliesApprove,
    runImpliesSignal,
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
      signalRequiresExplicitGrant: !runImpliesSignal,
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
    [
      ["run", undefined],
      ["read", undefined],
      ["approve", "run"],
      ["signal", "run"],
    ],
  );
  assertEquals(payload.signalRequiresExplicitGrant, false);
});

Deno.test("handleAccessCanI: listing omits implied signal when signal requires an explicit grant", async () => {
  const socket = createMockSocket();
  const ctx = createPolicyCtx([makeGrant()], true, false);

  await handleAccessCanI(socket, ctx, "req-1", {}, RESUMER);

  const payload = JSON.parse(socket.sent[0]).payload;
  assertEquals(payload.signalRequiresExplicitGrant, true);
  assertEquals(
    payload.decisions.map((d: { action: string }) => d.action),
    ["run", "read", "approve"],
  );
});

Deno.test("handleAccessCanI: specific signal check carries impliedBy", async () => {
  const socket = createMockSocket();
  const ctx = createPolicyCtx([makeGrant()], true);

  await handleAccessCanI(
    socket,
    ctx,
    "req-1",
    { action: "signal", resource: "workflow:@acme/deploy" },
    RESUMER,
  );

  const payload = JSON.parse(socket.sent[0]).payload;
  assertEquals(payload.decisions.length, 1);
  assertEquals(payload.decisions[0].effect, "allow");
  assertEquals(payload.decisions[0].impliedBy, "run");
});

Deno.test("handleAccessCanI: listing omits implied approve when approve requires an explicit grant", async () => {
  const socket = createMockSocket();
  const ctx = createPolicyCtx([makeGrant()], false);

  await handleAccessCanI(socket, ctx, "req-1", {}, RESUMER);

  const payload = JSON.parse(socket.sent[0]).payload;
  assertEquals(payload.approveRequiresExplicitGrant, true);
  assertEquals(
    payload.decisions.map((d: { action: string }) => d.action),
    ["run", "read", "signal"],
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
      [
        ["run", "deny", undefined],
        ["approve", "deny", "run"],
        ["signal", "deny", "run"],
      ],
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

// Models a concurrent push landing right after each mark: the repositories
// mark a path before writing it, so that push finds
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

/** The production callers of route-2 writes made while `fn` runs. */
async function unscopedWritesDuring(
  fn: () => Promise<unknown>,
): Promise<string[]> {
  const unscoped: string[] = [];
  const dispose = useUnscopedChangeReporterForTesting(({ caller }) => {
    if (
      caller?.file.startsWith("src/") && !caller.file.endsWith("_test.ts")
    ) {
      unscoped.push(`${caller.file}:${caller.line}`);
    }
  });
  try {
    await fn();
  } finally {
    dispose();
  }
  return unscoped;
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

      // The reconcile writes stage into a root unit, not through
      // signalChange's fallback (swamp-club#3056).
      const unscoped = await unscopedWritesDuring(() =>
        handleAccessReload(createMockSocket(), ctx, "req-1", null)
      );
      assertEquals(unscoped, []);

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

// ── token sessions end only when the revoke or rotate succeeds ──────────

function bindSession(name: string): { closes: number[] } {
  const closes: number[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send() {},
    close(code?: number) {
      closes.push(code ?? 0);
      removeConnection(socket);
    },
  } as unknown as WebSocket;
  setConnectionCollectives(socket, [], [], "user:alice");
  setConnectionToken(socket, {
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    principalId: "user:alice",
  });
  return { closes };
}

function cleanupSessions(name: string): void {
  terminateTokenSessions(name, {
    code: 1000,
    reason: "test cleanup",
    cause: "revoked",
    initiatedBy: "system",
  });
}

// No repository behind the context, so the token operation itself fails.
const failingCtx = () => createCtx(createMockDecisionService().service);

Deno.test("handleAccessTokenRevoke: a failed revoke closes no sessions", async () => {
  const name = `tok-${crypto.randomUUID()}`;
  const session = bindSession(name);
  const caller = createMockSocket();

  await handleAccessTokenRevoke(
    caller,
    failingCtx(),
    "req-1",
    { name },
    new AbortController(),
    { kind: "user", id: "admin" },
  );

  assertEquals(JSON.parse(caller.sent[0]).type, "error");
  assertEquals(session.closes, []);
  cleanupSessions(name);
});

Deno.test("handleAccessTokenRotate: a failed rotate closes no sessions", async () => {
  const name = `tok-${crypto.randomUUID()}`;
  const session = bindSession(name);
  const caller = createMockSocket();

  await handleAccessTokenRotate(
    caller,
    failingCtx(),
    "req-1",
    { name },
    new AbortController(),
    { kind: "user", id: "admin" },
  );

  assertEquals(JSON.parse(caller.sent[0]).type, "error");
  assertEquals(session.closes, []);
  cleanupSessions(name);
});

// ── external grant files keep one source across mount paths ─────────────

Deno.test("handleAccessReload: --grants-dir and --grants-file grants keep their source when mounted at another path (swamp-club#2848)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await ensureDir(join(repoDir, "grants"));
    const denyYaml = `grants:
  - subject: "user:mallory"
    effect: deny
    actions: [run]
    resource: "workflow:*"
`;
    const allowYaml = `grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;
    // The same files, mounted at two paths as two instances would see them.
    for (const mount of ["a", "b"]) {
      await ensureDir(join(dir, mount, "grants-dir"));
      await Deno.writeTextFile(
        join(dir, mount, "grants-dir", "deny.yaml"),
        denyYaml,
      );
      await Deno.writeTextFile(join(dir, mount, "external.yaml"), allowYaml);
    }

    const repoContext = createRepositoryContext({ repoDir });
    try {
      const reloadFrom = async (mount: string) => {
        const socket = createMockSocket();
        const ctx: ConnectionContext = {
          ...createReloadCtx(),
          repoDir,
          repoContext,
          grantsDir: join(dir, mount, "grants-dir"),
          grantsFile: join(dir, mount, "external.yaml"),
        };
        await handleAccessReload(socket, ctx, `req-${mount}`, null);
        return JSON.parse(socket.sent[0]).payload as {
          success: boolean;
          fileResults?: Array<
            { filename: string; created: number; revoked: number }
          >;
        };
      };

      const first = await reloadFrom("a");
      assertEquals(first.success, true);
      assertEquals(
        first.fileResults?.map((f) => [f.filename, f.created, f.revoked]),
        [["grants-file", 1, 0], ["grants-dir/deny.yaml", 1, 0]],
      );

      const second = await reloadFrom("b");
      assertEquals(second.success, true);
      assertEquals(
        second.fileResults?.map((f) => [f.filename, f.created, f.revoked]),
        [["grants-file", 0, 0], ["grants-dir/deny.yaml", 0, 0]],
      );

      const stored = await createFileGrantStore(
        repoContext.definitionRepo,
        repoContext.definitionRepo,
        repoContext.unifiedDataRepo,
      ).queryFileGrants();
      assertEquals(
        [...stored.values()]
          .map(({ grant }) => `${grant.source} ${grant.state}`)
          .sort(),
        ["file:grants-dir/deny.yaml active", "file:grants-file active"],
      );
    } finally {
      repoContext.catalogStore.close();
    }
  });
});

// ── the token name lock around mint, rotate and revoke ──────────────────

function lockCtx(
  dir: string,
  allow: boolean,
  definitions: Record<string, string> = {},
): ConnectionContext {
  const { service } = createMockDecisionService();
  const ctx = createCtx(
    allow ? service : { ...service, decide: () => null },
  );
  return {
    ...ctx,
    datastoreConfig: { type: "filesystem", path: dir },
    repoContext: { definitionRepo: definitionsNamed(definitions) },
  } as unknown as ConnectionContext;
}

/** A definition repo holding server-token definitions by id. */
function definitionsNamed(byId: Record<string, string>) {
  const entry = (id: string) => ({
    definition: { id, name: byId[id] },
    type: SERVER_TOKEN_MODEL_TYPE,
  });
  return {
    findByNameGlobal: (name: string) => {
      const id = Object.keys(byId).find((key) => byId[key] === name);
      return Promise.resolve(id ? entry(id) : null);
    },
    findByIdCached: (id: string) =>
      Promise.resolve(id in byId ? entry(id) : undefined),
  };
}

Deno.test("withServerTokenWriteLock: an admin's operation runs holding the token's name lock", async () => {
  await withTempDir(async (dir) => {
    const ctx = lockCtx(dir, true);
    const name = `tok-${crypto.randomUUID()}`;
    const observer = await createServerTokenLock(ctx.datastoreConfig, name);
    let heldDuring = false;

    await withServerTokenWriteLock(
      createMockSocket(),
      ctx,
      "req-1",
      { kind: "user", id: "admin" },
      name,
      async () => {
        heldDuring = (await observer.inspect()) !== null;
      },
    );

    assertEquals(heldDuring, true);
    assertEquals(await observer.inspect(), null);
  });
});

Deno.test("withServerTokenWriteLock: a caller the handler will refuse takes no lock", async () => {
  await withTempDir(async (dir) => {
    const ctx = lockCtx(dir, false);
    const name = `tok-${crypto.randomUUID()}`;
    const observer = await createServerTokenLock(ctx.datastoreConfig, name);
    const socket = createMockSocket();
    let ran = false;
    let heldDuring = true;

    await withServerTokenWriteLock(
      socket,
      ctx,
      "req-1",
      { kind: "user", id: "mallory" },
      name,
      async () => {
        ran = true;
        heldDuring = (await observer.inspect()) !== null;
      },
    );

    // The handler still runs, to reply and audit the refusal itself.
    assertEquals(ran, true);
    assertEquals(heldDuring, false);
    assertEquals(socket.sent, []);
  });
});

Deno.test("withServerTokenWriteLock: a lock held elsewhere is reported to the client, and the operation does not run", async () => {
  await withTempDir(async (dir) => {
    const ctx = lockCtx(dir, true);
    const name = `tok-${crypto.randomUUID()}`;
    const holder = await createServerTokenLock(ctx.datastoreConfig, name);
    const socket = createMockSocket();
    let ran = false;

    await holder.acquire();
    try {
      await withMockedEnv(
        { SWAMP_LOCK_TIMEOUT_MS: "200" },
        () =>
          withServerTokenWriteLock(
            socket,
            ctx,
            "req-1",
            { kind: "user", id: "admin" },
            name,
            () => {
              ran = true;
              return Promise.resolve();
            },
          ),
      );
    } finally {
      await holder.release();
    }

    assertEquals(ran, false);
    const reply = JSON.parse(socket.sent[0]);
    assertEquals(reply.type, "error");
    // The code and details of serve's other lock timeouts, so a client
    // retries this one the same way; the message names the token.
    assertEquals(reply.error.code, "lock_timeout");
    assertEquals(reply.error.details, {
      retryable: true,
      exceptionType: "LockTimeoutError",
    });
    assert(reply.error.message.includes(`Server token '${name}'`));
  });
});

Deno.test("withServerTokenWriteLock: a lock that cannot be created is reported to the client, and the operation does not run", async () => {
  await withTempDir(async (dir) => {
    // A file where the datastore directory should be: the lock file cannot
    // be created under it.
    const notADir = join(dir, "datastore");
    await Deno.writeTextFile(notADir, "");
    const ctx = lockCtx(notADir, true);
    const socket = createMockSocket();
    let ran = false;

    await withServerTokenWriteLock(
      socket,
      ctx,
      "req-1",
      { kind: "user", id: "admin" },
      "tok",
      () => {
        ran = true;
        return Promise.resolve();
      },
    );

    assertEquals(ran, false);
    assertEquals(socket.sent.length, 1);
    assertEquals(
      JSON.parse(socket.sent[0]).error.code,
      "access_token_lock_failed",
    );
  });
});

Deno.test("withServerTokenWriteLock: an error from the operation itself is not answered twice", async () => {
  await withTempDir(async (dir) => {
    const ctx = lockCtx(dir, true);
    const socket = createMockSocket();

    await assertRejects(
      () =>
        withServerTokenWriteLock(
          socket,
          ctx,
          "req-1",
          { kind: "user", id: "admin" },
          "tok",
          () => Promise.reject(new Error("handler bug")),
        ),
      Error,
      "handler bug",
    );

    assertEquals(socket.sent, []);
    const observer = await createServerTokenLock(ctx.datastoreConfig, "tok");
    assertEquals(await observer.inspect(), null);
  });
});

Deno.test("withServerTokenWriteLock: a token named by definition id takes the lock of its name", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    const name = `tok-${crypto.randomUUID()}`;
    const ctx = lockCtx(dir, true, { [id]: name });
    const byName = await createServerTokenLock(ctx.datastoreConfig, name);
    const byId = await createServerTokenLock(ctx.datastoreConfig, id);
    let nameHeld = false;
    let idHeld = true;

    await withServerTokenWriteLock(
      createMockSocket(),
      ctx,
      "req-1",
      { kind: "user", id: "admin" },
      id,
      async () => {
        nameHeld = (await byName.inspect()) !== null;
        idHeld = (await byId.inspect()) !== null;
      },
    );

    assertEquals(nameHeld, true);
    assertEquals(idHeld, false);
  });
});

// --- vault:<name> (swamp-club#2676) ---

const PROD_VAULT = {
  id: "vault-id-1",
  name: "prod-db",
  type: "local_encryption",
};

/** A ctx whose vault config repository holds only {@link PROD_VAULT}. */
function withVaultRepo(ctx: ConnectionContext): ConnectionContext {
  const byName = (name: string) =>
    Promise.resolve(name === PROD_VAULT.name ? PROD_VAULT : null);
  return {
    ...ctx,
    repoContext: {
      vaultConfigRepo: {
        findByName: byName,
        findById: (_type: string, id: string) =>
          Promise.resolve(id === PROD_VAULT.id ? PROD_VAULT : null),
        findAll: () => Promise.resolve([PROD_VAULT]),
      },
    } as unknown as ConnectionContext["repoContext"],
  };
}

Deno.test("handleAccessCanI: explains vault:<name> as the vault it resolves to, by name or id", async () => {
  for (const named of ["prod-db", PROD_VAULT.id]) {
    const { service, calls } = createMockDecisionService();
    const socket = createMockSocket();
    await handleAccessCanI(
      socket,
      withVaultRepo(createCtx(service)),
      "req-1",
      { action: "read", resource: `vault:${named}` },
      RESUMER,
    );
    assertEquals(calls.length, 1, named);
    assertEquals(calls[0].resource, {
      kind: "vault",
      name: "prod-db",
      fields: { name: "prod-db" },
    });
  }
});

Deno.test("handleAccessCanI: explains an unknown vault by its name and a wildcard as a check on the kind", async () => {
  const { service, calls } = createMockDecisionService();
  const ctx = withVaultRepo(createCtx(service));
  await handleAccessCanI(
    createMockSocket(),
    ctx,
    "req-1",
    { action: "read", resource: "vault:missing" },
    RESUMER,
  );
  await handleAccessCanI(
    createMockSocket(),
    ctx,
    "req-2",
    { action: "read", resource: "vault:prod-*" },
    RESUMER,
  );
  assertEquals(calls.map((c) => c.resource), [
    { kind: "vault", name: "missing", fields: { name: "missing" } },
    { kind: "vault", name: "prod-*", fields: { name: "*" }, scope: "kind" },
  ]);
});

Deno.test("handleAccessCheck: reports the vault grants that decide vault:<name>", async () => {
  const policyCtx = createPolicyCtx([
    makeGrant({
      subject: { kind: "user", name: "resumer" },
      actions: ["read"],
      resource: { kind: "vault", pattern: "prod-*" },
    }),
    makeGrant({
      subject: { kind: "user", name: "resumer" },
      effect: "deny",
      actions: ["read"],
      resource: { kind: "vault", pattern: "prod-db" },
    }),
  ], true);
  const ctx = withVaultRepo({
    ...policyCtx,
    authConfig: { ...policyCtx.authConfig!, mode: "none" },
  });
  const socket = createMockSocket();
  await handleAccessCheck(socket, ctx, "req-1", {
    subject: "user:resumer",
    action: "read",
    resource: `vault:${PROD_VAULT.id}`,
  }, RESUMER);
  const payload = JSON.parse(socket.sent[0]).payload;
  assertEquals(
    payload.decisions.map((d: { effect: string }) => d.effect),
    ["deny", "allow"],
  );
});

Deno.test("handleAccessCanI: a concrete vault also reports the run-time decision for the caller", async () => {
  const allow = makeGrant({
    subject: { kind: "user", name: "resumer" },
    actions: ["read"],
    resource: { kind: "vault", pattern: "prod-db" },
  });
  const policyCtx = createPolicyCtx([allow], true);
  const ctx = withVaultRepo({
    ...policyCtx,
    authConfig: { ...policyCtx.authConfig!, mode: "token" },
  });
  const allowed = createMockSocket();
  await handleAccessCanI(allowed, ctx, "req-1", {
    action: "read",
    resource: `vault:${PROD_VAULT.id}`,
  }, RESUMER);
  assertEquals(JSON.parse(allowed.sent[0]).payload.runVaultAccess, {
    vault: "prod-db",
    action: "read",
    allowed: true,
    restricted: true,
    rule: "vault-allow",
    reason: `allowed by grant ${allow.id}`,
    grantId: allow.id,
  });
  const refused = createMockSocket();
  await handleAccessCanI(refused, ctx, "req-2", {
    action: "read",
    resource: "vault:erp",
  }, RESUMER);
  const report = JSON.parse(refused.sent[0]).payload.runVaultAccess;
  assertEquals(report.allowed, false);
  assertEquals(report.restricted, true);
  assertEquals(report.rule, "vault-scoped");
  // A wildcard names no vault, so it has no run-time decision.
  const wildcard = createMockSocket();
  await handleAccessCanI(wildcard, ctx, "req-3", {
    action: "read",
    resource: "vault:prod-*",
  }, RESUMER);
  assertEquals(JSON.parse(wildcard.sent[0]).payload.runVaultAccess, undefined);
});

Deno.test("handleAccessCheck: a trigger principal's run-time decision says it covers every scheduled or webhook run", async () => {
  const policyCtx = createPolicyCtx([], true);
  const ctx = withVaultRepo({
    ...policyCtx,
    authConfig: { ...policyCtx.authConfig!, mode: "none" },
  });
  const socket = createMockSocket();
  await handleAccessCheck(socket, ctx, "req-1", {
    subject: "service:scheduler",
    action: "read",
    resource: "vault:prod-db",
  }, RESUMER);
  const report = JSON.parse(socket.sent[0]).payload.runVaultAccess;
  assertEquals(report.allowed, true);
  assertEquals(report.rule, "no-vault-grants");
  assertEquals(report.triggerScope, "every scheduled or webhook run");
});

Deno.test("handleAccessCheck: another subject's run-time vault decision uses the IdP groups the request simulates", async () => {
  const opsAllow = makeGrant({
    subject: { kind: "idp-group", name: "ops" },
    actions: ["read"],
    resource: { kind: "vault", pattern: "prod-db" },
  });
  const policyCtx = createPolicyCtx([opsAllow], true);
  const ctx = withVaultRepo({
    ...policyCtx,
    authConfig: { ...policyCtx.authConfig!, mode: "none" },
  });
  const socket = createMockSocket();
  await handleAccessCheck(socket, ctx, "req-1", {
    subject: "user:stranger",
    action: "read",
    resource: "vault:prod-db",
    groups: ["ops"],
    collectives: ["acme"],
  }, RESUMER);
  const payload = JSON.parse(socket.sent[0]).payload;
  assertEquals(payload.groups, ["ops"]);
  assertEquals(payload.collectives, ["acme"]);
  assertEquals(
    payload.decisions.map((d: { grantId: string }) => d.grantId),
    [opsAllow.id],
  );
  assertEquals(payload.runVaultAccess.rule, "vault-allow");
  assertEquals(payload.runVaultAccess.grantId, opsAllow.id);
  assertEquals(
    payload.runVaultAccess.reason,
    `allowed by grant ${opsAllow.id}`,
  );
});

Deno.test("handleAccessCheck: another subject's run-time vault decision without simulated groups says IdP groups are not included", async () => {
  const policyCtx = createPolicyCtx([
    makeGrant({
      subject: { kind: "idp-group", name: "ops" },
      actions: ["read"],
      resource: { kind: "vault", pattern: "prod-db" },
    }),
  ], true);
  const ctx = withVaultRepo({
    ...policyCtx,
    authConfig: { ...policyCtx.authConfig!, mode: "none" },
  });
  const other = createMockSocket();
  await handleAccessCheck(other, ctx, "req-1", {
    subject: "user:stranger",
    action: "read",
    resource: "vault:prod-db",
  }, RESUMER);
  const report = JSON.parse(other.sent[0]).payload.runVaultAccess;
  assertEquals(report.rule, "unscoped");
  assertStringIncludes(report.reason, "IdP-group memberships are not included");
  // The caller's own check uses its session's groups, so it has no note.
  const self = createMockSocket();
  await handleAccessCheck(self, ctx, "req-2", {
    subject: "user:resumer",
    action: "read",
    resource: "vault:prod-db",
  }, RESUMER);
  const selfReport = JSON.parse(self.sent[0]).payload.runVaultAccess;
  assertEquals(selfReport.reason.includes("not included"), false);
});
