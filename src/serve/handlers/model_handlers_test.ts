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
import { z } from "zod";
import { stringify as stringifyYaml } from "@std/yaml";
import { handleModelEdit, isMethodMutating } from "./model_handlers.ts";
import type { ConnectionContext } from "./shared.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../../domain/datastore/datastore_sync_service.ts";

const TEST_TYPE = ModelType.create("test/lock-check");

function registerTestModel(methods: Record<string, { kind?: string }>) {
  const methodDefs: Record<
    string,
    {
      description: string;
      kind?: "read" | "list" | "create" | "update" | "delete" | "action";
      arguments: z.ZodTypeAny;
      execute: () => Promise<Record<string, unknown>>;
    }
  > = {};
  for (const [name, config] of Object.entries(methods)) {
    methodDefs[name] = {
      description: `test method ${name}`,
      ...(config.kind
        ? {
          kind: config.kind as
            | "read"
            | "list"
            | "create"
            | "update"
            | "delete"
            | "action",
        }
        : {}),
      arguments: z.object({}),
      execute: () => Promise.resolve({}),
    };
  }
  modelRegistry.register({
    type: TEST_TYPE,
    version: "2026.01.01.1",
    methods: methodDefs,
  });
}

function cleanup() {
  modelRegistry.invalidateType(TEST_TYPE);
}

Deno.test("isMethodMutating: returns false for method with kind 'read'", async () => {
  registerTestModel({ status: { kind: "read" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "status"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns false for method with kind 'list'", async () => {
  registerTestModel({ search: { kind: "list" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "search"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'create'", async () => {
  registerTestModel({ provision: { kind: "create" } });
  try {
    assertEquals(
      await isMethodMutating(TEST_TYPE.normalized, "provision"),
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'update'", async () => {
  registerTestModel({ patch: { kind: "update" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "patch"), true);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'action'", async () => {
  registerTestModel({ deploy: { kind: "action" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "deploy"), true);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with no kind and unrecognized name", async () => {
  registerTestModel({ custom_process: {} });
  try {
    assertEquals(
      await isMethodMutating(TEST_TYPE.normalized, "custom_process"),
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: infers 'read' from name 'get' without explicit kind", async () => {
  registerTestModel({ get: {} });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "get"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: infers 'list' from name 'list' without explicit kind", async () => {
  registerTestModel({ list: {} });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "list"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'delete'", async () => {
  registerTestModel({ purge: { kind: "delete" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "purge"), true);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for unknown model type", async () => {
  assertEquals(
    await isMethodMutating("nonexistent/model-type", "get"),
    true,
  );
});

Deno.test("isMethodMutating: returns true for unknown method on known model", async () => {
  registerTestModel({ run: { kind: "action" } });
  try {
    assertEquals(
      await isMethodMutating(TEST_TYPE.normalized, "nonexistent"),
      true,
    );
  } finally {
    cleanup();
  }
});

// --- handleModelEdit sync tests ---

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

function createMockSyncService(): {
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
      return Promise.resolve(0);
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

const EDIT_TEST_TYPE = ModelType.create("command/shell");

function createEditCtx(
  repoDir: string,
  definitionRepo: YamlDefinitionRepository,
  syncService?: DatastoreSyncService,
): ConnectionContext {
  return {
    repoDir,
    repoContext: {
      definitionRepo,
    } as unknown as ConnectionContext["repoContext"],
    datastoreConfig: {
      type: "custom",
      provider: "test",
      namespace: "shared",
      config: {},
      datastorePath: "/tmp/test-datastore",
    } as unknown as ConnectionContext["datastoreConfig"],
    datastoreResolver: {} as ConnectionContext["datastoreResolver"],
    syncService,
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
  } as ConnectionContext;
}

Deno.test("handleModelEdit: calls markDirty and pushChanged on syncService after successful edit", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = Definition.create({
      name: "sync-test-model",
      globalArguments: {},
    });
    await repo.save(EDIT_TEST_TYPE, definition);

    const { service, pushCalls, markDirtyCalls } = createMockSyncService();
    const ctx = createEditCtx(dir, repo, service);
    const socket = createMockSocket();

    const updatedYaml = stringifyYaml({
      id: definition.id,
      name: "sync-test-model",
      type: "command/shell",
      version: 1,
      tags: { edited: "true" },
      globalArguments: {},
      methods: {},
    });

    await handleModelEdit(
      socket,
      ctx,
      "req-edit",
      { modelIdOrName: "sync-test-model", content: updatedYaml },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "model.edit");
    assertEquals(response.payload.data.status, "updated");

    assertGreater(markDirtyCalls.length, 0);
    assertGreater(pushCalls.length, 0);
    assertEquals(pushCalls[0].namespace, "shared");
  });
});

Deno.test("handleModelEdit: works without syncService (local-only mode)", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = Definition.create({
      name: "local-test-model",
      globalArguments: {},
    });
    await repo.save(EDIT_TEST_TYPE, definition);

    const ctx = createEditCtx(dir, repo);
    const socket = createMockSocket();

    const updatedYaml = stringifyYaml({
      id: definition.id,
      name: "local-test-model",
      type: "command/shell",
      version: 1,
      tags: {},
      globalArguments: {},
      methods: {},
    });

    await handleModelEdit(
      socket,
      ctx,
      "req-edit-local",
      { modelIdOrName: "local-test-model", content: updatedYaml },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "model.edit");
    assertEquals(response.payload.data.status, "updated");
  });
});
