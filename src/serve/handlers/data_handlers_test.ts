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
import { SEPARATOR } from "@std/path";
import {
  handleDataDelete,
  handleDataGc,
  handleDataPrune,
  handleDataRename,
  handleRunGc,
  resolveDataFields,
  resolveRunGcInput,
} from "./data_handlers.ts";
import type { ConnectionContext } from "./shared.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../../domain/datastore/datastore_sync_service.ts";
import { Data } from "../../domain/data/mod.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";

function makeDefinitionRepo(
  definitions: Map<
    string,
    { name: string; tags?: Record<string, string>; type?: string }
  >,
): DefinitionRepository {
  return {
    findByNameGlobal: (name: string) => {
      const def = definitions.get(name);
      if (!def) return Promise.resolve(null);
      return Promise.resolve({
        type: { normalized: def.type ?? "test/type" },
        definition: { name: def.name, tags: def.tags, id: "test-id" },
      });
    },
    findById: () => Promise.resolve(null),
    listTypes: () => Promise.resolve([]),
    listByType: () => Promise.resolve([]),
  } as unknown as DefinitionRepository;
}

Deno.test("resolveDataFields: returns tags when model has them", async () => {
  const repo = makeDefinitionRepo(
    new Map([["tagged-model", {
      name: "tagged-model",
      tags: { env: "prod" },
    }]]),
  );

  const fields = await resolveDataFields(repo, "tagged-model");

  assertEquals(fields.name, "tagged-model");
  assertEquals(fields.tags, { env: "prod" });
});

Deno.test("resolveDataFields: omits tags when model has none", async () => {
  const repo = makeDefinitionRepo(
    new Map([["plain-model", { name: "plain-model" }]]),
  );

  const fields = await resolveDataFields(repo, "plain-model");

  assertEquals(fields.name, "plain-model");
  assertEquals(fields.tags, undefined);
});

Deno.test("resolveDataFields: falls back to name-only when model not found", async () => {
  const repo = makeDefinitionRepo(new Map());

  const fields = await resolveDataFields(repo, "missing-model");

  assertEquals(fields.name, "missing-model");
  assertEquals(fields.tags, undefined);
});

Deno.test("resolveDataFields: returns ns from user namespace type", async () => {
  const repo = makeDefinitionRepo(
    new Map([["ns-model", {
      name: "ns-model",
      tags: { env: "prod" },
      type: "@myns/model-type",
    }]]),
  );

  const fields = await resolveDataFields(repo, "ns-model");

  assertEquals(fields.name, "ns-model");
  assertEquals(fields.ns, "myns");
  assertEquals(fields.tags, { env: "prod" });
});

Deno.test("resolveDataFields: omits ns for non-namespaced type", async () => {
  const repo = makeDefinitionRepo(
    new Map([["plain-type-model", {
      name: "plain-type-model",
      type: "command/shell",
    }]]),
  );

  const fields = await resolveDataFields(repo, "plain-type-model");

  assertEquals(fields.name, "plain-type-model");
  assertEquals(fields.ns, undefined);
});

Deno.test("resolveDataFields: falls back to name-only when repo throws", async () => {
  const repo = {
    findByNameGlobal: () => Promise.reject(new Error("PermissionDenied")),
    findById: () => Promise.reject(new Error("PermissionDenied")),
    listTypes: () => Promise.resolve([]),
    listByType: () => Promise.resolve([]),
  } as unknown as DefinitionRepository;

  const fields = await resolveDataFields(repo, "erroring-model");

  assertEquals(fields.name, "erroring-model");
  assertEquals(fields.tags, undefined);
});

Deno.test("resolveRunGcInput: uses repository retention when request omits it", () => {
  assertEquals(
    resolveRunGcInput(undefined, { workflowRuns: "2w", outputs: "1d" }),
    {
      dryRun: false,
      workflowRunRetentionDays: 14,
      outputRetentionDays: 1,
    },
  );
});

Deno.test("resolveRunGcInput: request retention overrides repository retention", () => {
  assertEquals(
    resolveRunGcInput(
      { dryRun: true, workflowRunRetentionDays: 3, outputRetentionDays: 2 },
      { workflowRuns: "2w", outputs: "1d" },
    ),
    {
      dryRun: true,
      workflowRunRetentionDays: 3,
      outputRetentionDays: 2,
    },
  );
});

Deno.test("resolveRunGcInput: output policy survives a workflow-only request override", () => {
  assertEquals(
    resolveRunGcInput(
      { workflowRunRetentionDays: 3 },
      { workflowRuns: "2w", outputs: "1d" },
    ),
    {
      dryRun: false,
      workflowRunRetentionDays: 3,
      outputRetentionDays: 1,
    },
  );
});

Deno.test("resolveRunGcInput: omitted output policy uses the output default", () => {
  assertEquals(
    resolveRunGcInput(undefined, { workflowRuns: "2w" }),
    {
      dryRun: false,
      workflowRunRetentionDays: 14,
      outputRetentionDays: 30,
    },
  );
});

// --- sync tests: data mutations must push to the remote datastore ---

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

function createMockSyncService(pushError?: Error): {
  service: DatastoreSyncService;
  pushCalls: DatastoreSyncOptions[];
  markDirtyCalls: DatastoreSyncOptions[];
} {
  const pushCalls: DatastoreSyncOptions[] = [];
  const markDirtyCalls: DatastoreSyncOptions[] = [];
  const service: DatastoreSyncService = {
    pullChanged(_options?: DatastoreSyncOptions): Promise<number | void> {
      return Promise.resolve(0);
    },
    pushChanged(options?: DatastoreSyncOptions): Promise<number | void> {
      pushCalls.push(options ?? {});
      return pushError ? Promise.reject(pushError) : Promise.resolve(0);
    },
    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      markDirtyCalls.push(options ?? {});
      return Promise.resolve();
    },
  };
  return { service, pushCalls, markDirtyCalls };
}

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

const SYNC_TEST_TYPE = ModelType.create("command/shell");

interface SyncFixture {
  ctx: ConnectionContext;
  dataRepo: FileSystemUnifiedDataRepository;
  pushCalls: DatastoreSyncOptions[];
  markDirtyCalls: DatastoreSyncOptions[];
}

/**
 * Builds a serve connection context over a temp repo holding one model
 * ("sync-model") with one data item ("result"). Dirty signals from the
 * repositories flow into the mock sync service, as in serve.
 */
async function createSyncFixture(
  dir: string,
  options: { syncService?: boolean; pushError?: Error } = {},
): Promise<SyncFixture> {
  const { service, pushCalls, markDirtyCalls } = createMockSyncService(
    options.pushError,
  );
  const withSync = options.syncService ?? true;
  const markDirty = withSync
    ? (relPath?: string) => service.markDirty(relPath ? { relPath } : undefined)
    : undefined;

  const definitionRepo = new YamlDefinitionRepository(dir);
  const definition = Definition.create({
    name: "sync-model",
    globalArguments: {},
  });
  await definitionRepo.save(SYNC_TEST_TYPE, definition);

  const dataRepo = new FileSystemUnifiedDataRepository(
    dir,
    undefined,
    new CatalogStore(":memory:"),
    markDirty,
  );
  await dataRepo.save(
    SYNC_TEST_TYPE,
    definition.id,
    Data.create({
      name: "result",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 100,
      tags: { type: "resource" },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: "command/shell:execute",
      },
    }),
    new TextEncoder().encode("hello"),
  );
  markDirtyCalls.length = 0;

  const ctx = {
    repoDir: dir,
    repoContext: {
      definitionRepo,
      unifiedDataRepo: dataRepo,
      markDirty,
    } as unknown as ConnectionContext["repoContext"],
    datastoreConfig: {
      type: "custom",
      provider: "test",
      namespace: "shared",
      config: {},
      datastorePath: "/tmp/test-datastore",
    } as unknown as ConnectionContext["datastoreConfig"],
    datastoreResolver: undefined,
    syncService: withSync ? service : undefined,
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
  } as unknown as ConnectionContext;

  return { ctx, dataRepo, pushCalls, markDirtyCalls };
}

Deno.test("handleDataDelete: pushes the deletion after per-path markDirty (no bare override)", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls, markDirtyCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();

    await handleDataDelete(
      socket,
      ctx,
      "req-delete",
      { modelIdOrName: "sync-model", dataName: "result" },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "data.delete");
    assertEquals(response.payload.data.versionsDeleted, 1);

    assertEquals(pushCalls.length, 1);
    assertEquals(pushCalls[0].namespace, "shared");
    const bareCalls = markDirtyCalls.filter((c) => !c.relPath);
    assertEquals(bareCalls.length, 0, "bare markDirty() must not be called");
    // Full delete emits per-version-directory signals + latest marker
    // (swamp-club#2277), not a single data-name directory signal. The
    // fixture hands the repository's absolute paths straight to the mock,
    // so they use the platform separator; forward-slash normalization
    // happens in the repo_context wiring and is pinned there.
    assertEquals(
      markDirtyCalls.some((c) => c.relPath?.includes(`result${SEPARATOR}`)),
      true,
      "repo must mark deleted version directories and latest marker dirty",
    );
  });
});

Deno.test("handleDataDelete: pushes the deletion when the request is cancelled", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();
    const controller = new AbortController();
    controller.abort();

    await handleDataDelete(
      socket,
      ctx,
      "req-delete-cancelled",
      { modelIdOrName: "sync-model", dataName: "result" },
      controller,
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).error.code, "cancelled");
    assertEquals(pushCalls.length, 1);
  });
});

Deno.test("handleDataDelete: a failed push is logged and the delete still succeeds", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir, {
      pushError: new Error("s3 unavailable"),
    });
    const socket = createMockSocket();

    await handleDataDelete(
      socket,
      ctx,
      "req-delete-push-fail",
      { modelIdOrName: "sync-model", dataName: "result" },
      new AbortController(),
      null,
    );

    assertEquals(socket.sent.length, 1);
    assertEquals(JSON.parse(socket.sent[0]).type, "data.delete");
    assertEquals(pushCalls.length, 1);
  });
});

Deno.test("handleDataDelete: works without syncService (local-only mode)", async () => {
  await withTempDir(async (dir) => {
    const { ctx, dataRepo } = await createSyncFixture(dir, {
      syncService: false,
    });
    const socket = createMockSocket();

    await handleDataDelete(
      socket,
      ctx,
      "req-delete-local",
      { modelIdOrName: "sync-model", dataName: "result" },
      new AbortController(),
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).type, "data.delete");
    const definition = await ctx.repoContext.definitionRepo.findByNameGlobal(
      "sync-model",
    );
    assertEquals(
      await dataRepo.listVersions(
        SYNC_TEST_TYPE,
        definition!.definition.id,
        "result",
      ),
      [],
    );
  });
});

Deno.test("handleDataRename: pushes after rename", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();

    await handleDataRename(
      socket,
      ctx,
      "req-rename",
      { modelIdOrName: "sync-model", oldName: "result", newName: "renamed" },
      new AbortController(),
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).type, "data.rename");
    assertEquals(pushCalls.length, 1);
    assertEquals(pushCalls[0].namespace, "shared");
  });
});

Deno.test("handleDataGc: pushes after gc", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();

    await handleDataGc(
      socket,
      ctx,
      "req-gc",
      { dryRun: false },
      new AbortController(),
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).type, "data.gc");
    assertEquals(pushCalls.length, 1);
    assertEquals(pushCalls[0].namespace, "shared");
  });
});

Deno.test("handleDataPrune: pushes after prune", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();

    await handleDataPrune(
      socket,
      ctx,
      "req-prune",
      { dryRun: false },
      new AbortController(),
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).type, "data.prune");
    assertEquals(pushCalls.length, 1);
    assertEquals(pushCalls[0].namespace, "shared");
  });
});

Deno.test("handleRunGc: pushes after run gc", async () => {
  await withTempDir(async (dir) => {
    const { ctx, pushCalls } = await createSyncFixture(dir);
    const socket = createMockSocket();

    await handleRunGc(
      socket,
      ctx,
      "req-run-gc",
      { dryRun: false },
      new AbortController(),
      null,
    );

    assertEquals(JSON.parse(socket.sent[0]).type, "run.gc");
    assertEquals(pushCalls.length, 1);
    assertEquals(pushCalls[0].namespace, "shared");
  });
});
