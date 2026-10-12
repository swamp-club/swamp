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
import { join } from "@std/path";
import {
  handleModelDelete,
  handleModelEdit,
  handleModelOutputSearch,
  isMethodMutating,
  redactWorkflowLinks,
} from "./model_handlers.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import type { ConnectionContext } from "./shared.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../../domain/datastore/datastore_sync_service.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import { createConditionEvaluator } from "../../domain/access/policy_snapshot_loader.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../../domain/access/principal.ts";

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
      approveRequiresExplicitGrant: false,
      signalRequiresExplicitGrant: false,
    },
  } as ConnectionContext;
}

Deno.test("handleModelEdit: pushChanged called after edit, per-path markDirty from repo (no bare override)", async () => {
  await withTempDir(async (dir) => {
    const { service, pushCalls, markDirtyCalls } = createMockSyncService();
    const markDirtyHook = (relPath?: string) =>
      service.markDirty(relPath ? { relPath } : undefined);
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      false,
      markDirtyHook,
    );
    const definition = Definition.create({
      name: "sync-test-model",
      globalArguments: {},
    });
    await repo.save(EDIT_TEST_TYPE, definition);
    markDirtyCalls.length = 0;

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

    assertGreater(pushCalls.length, 0);
    assertEquals(pushCalls[0].namespace, "shared");
    const bareCalls = markDirtyCalls.filter((c) => !c.relPath);
    assertEquals(bareCalls.length, 0, "bare markDirty() must not be called");
    const perPathCalls = markDirtyCalls.filter((c) => !!c.relPath);
    assertGreater(perPathCalls.length, 0, "repo must send per-path markDirty");
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

// --- handleModelEdit authorization (swamp-club#2426) ---

const EDITOR: Principal = { kind: "user", id: "editor" };

function grant(overrides: Partial<Grant>): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "editor" },
    effect: "allow",
    actions: ["write"],
    resource: { kind: "model", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** An edit context that enforces `grants` for token principals. */
function createPolicyEditCtx(
  repoDir: string,
  definitionRepo: YamlDefinitionRepository,
  grants: Grant[],
): ConnectionContext {
  const ctx = createEditCtx(repoDir, definitionRepo);
  return {
    ...ctx,
    authConfig: { ...ctx.authConfig, mode: "token" },
    policySnapshotLoader: {
      decisionService: new GrantBasedAccessDecisionService(
        new PolicySnapshot(grants, [], createConditionEvaluator()),
      ),
    } as unknown as PolicySnapshotLoader,
  };
}

async function saveEditModel(
  repo: YamlDefinitionRepository,
  name: string,
  tags: Record<string, string> = {},
): Promise<Definition> {
  const definition = Definition.create({ name, globalArguments: {}, tags });
  await repo.save(EDIT_TEST_TYPE, definition);
  return definition;
}

function editYaml(
  definition: Definition,
  overrides: Record<string, unknown> = {},
): string {
  return stringifyYaml({
    id: definition.id,
    name: definition.name,
    type: "command/shell",
    version: 1,
    tags: definition.tags,
    globalArguments: {},
    methods: {},
    ...overrides,
  });
}

function frames(socket: { sent: string[] }) {
  return socket.sent.map((raw) => JSON.parse(raw));
}

Deno.test("handleModelEdit: rejects a request without content instead of opening an editor on the server", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    await saveEditModel(repo, "no-content-model");
    const socket = createMockSocket();

    await handleModelEdit(
      socket,
      createEditCtx(dir, repo),
      "req-no-content",
      { modelIdOrName: "no-content-model" },
      new AbortController(),
      null,
    );

    const sent = frames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    assertEquals(sent[0].error.code, "invalid_request");
  });
});

Deno.test("handleModelEdit: a request by id cannot sidestep a name-scoped deny", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "prod-db");
    const ctx = createPolicyEditCtx(dir, repo, [
      grant({}),
      grant({
        effect: "deny",
        resource: { kind: "model", pattern: "prod-*" },
      }),
    ]);
    const socket = createMockSocket();

    await handleModelEdit(
      socket,
      ctx,
      "req-by-id",
      {
        modelIdOrName: definition.id,
        content: editYaml(definition, { tags: { edited: "true" } }),
      },
      new AbortController(),
      EDITOR,
    );

    const sent = frames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    const reread = await repo.findByNameGlobal("prod-db");
    assertEquals(reread?.definition.tags, {});
  });
});

Deno.test("handleModelEdit: a tag-conditioned deny applies to the edited model", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "tagged-model", {
      env: "prod",
    });
    const ctx = createPolicyEditCtx(dir, repo, [
      grant({}),
      grant({ effect: "deny", condition: 'tags.env == "prod"' }),
    ]);
    const socket = createMockSocket();

    await handleModelEdit(
      socket,
      ctx,
      "req-tag-deny",
      { modelIdOrName: "tagged-model", content: editYaml(definition) },
      new AbortController(),
      EDITOR,
    );

    const sent = frames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
  });
});

Deno.test("handleModelEdit: a rename into a denied name sends one error and writes nothing", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "dev-x");
    const ctx = createPolicyEditCtx(dir, repo, [
      grant({}),
      grant({
        effect: "deny",
        resource: { kind: "model", pattern: "prod-*" },
      }),
    ]);
    const socket = createMockSocket();

    await handleModelEdit(
      socket,
      ctx,
      "req-rename-denied",
      {
        modelIdOrName: "dev-x",
        content: editYaml(definition, { name: "prod-x" }),
      },
      new AbortController(),
      EDITOR,
    );

    const sent = frames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    assertEquals(
      (await repo.findByNameGlobal("dev-x"))?.definition.id,
      definition.id,
    );
    assertEquals(await repo.findByNameGlobal("prod-x"), null);
  });
});

Deno.test("handleModelEdit: an allowed rename saves the edited model", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "dev-y");
    const ctx = createPolicyEditCtx(dir, repo, [grant({})]);
    const socket = createMockSocket();

    await handleModelEdit(
      socket,
      ctx,
      "req-rename-allowed",
      {
        modelIdOrName: definition.id,
        content: editYaml(definition, { name: "dev-z" }),
      },
      new AbortController(),
      EDITOR,
    );

    const sent = frames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "model.edit");
    assertEquals(sent[0].payload.data.name, "dev-z");
    assertEquals(
      (await repo.findByNameGlobal("dev-z"))?.definition.id,
      definition.id,
    );
  });
});

Deno.test("handleModelEdit: reports an unknown model as not found", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const socket = createMockSocket();

    await handleModelEdit(
      socket,
      createEditCtx(dir, repo),
      "req-missing",
      { modelIdOrName: "no-such-model", content: "name: no-such-model\n" },
      new AbortController(),
      null,
    );

    const sent = frames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].error.code, "not_found");
  });
});

// --- handleModelDelete not-found tests (swamp-club#2716) ---

function createDeleteCtx(repoDir: string): ConnectionContext {
  const definitionRepo = new YamlDefinitionRepository(
    repoDir,
    undefined,
    undefined,
    false,
  );
  const base = createEditCtx(repoDir, definitionRepo);
  return {
    ...base,
    repoContext: {
      definitionRepo,
      // The lookup misses before any data is read, so a stub avoids opening a
      // catalog store for the test.
      unifiedDataRepo: {},
    } as unknown as ConnectionContext["repoContext"],
    datastoreResolver: {
      resolvePath: (subdir: string) => join(repoDir, ".swamp", subdir),
    } as unknown as ConnectionContext["datastoreResolver"],
  };
}

for (
  const [label, modelIdOrName] of [
    ["name", "no-such-model"],
    ["id", "8a0f1b2c-3d4e-4f56-8789-0abcdef12345"],
  ]
) {
  Deno.test(`handleModelDelete: a missing model by ${label} replies with the not-found message, not [object Object]`, async () => {
    await withTempDir(async (dir) => {
      const socket = createMockSocket();
      await handleModelDelete(
        socket,
        createDeleteCtx(dir),
        "req-delete",
        { modelIdOrName },
        new AbortController(),
        null,
      );

      const sent = frames(socket);
      assertEquals(sent.length, 1);
      assertEquals(sent[0].type, "error");
      assertEquals(sent[0].error.code, "model_delete_failed");
      assertEquals(
        sent[0].error.message,
        `Model not found: ${modelIdOrName}`,
      );
      assertEquals(sent[0].error.details, {
        reason: "not_found",
        entityType: "Model",
      });
    });
  });
}

// --- handleModelOutputSearch workflow linkage (swamp-club#2736) ---

function linkedWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve"),
          }),
        ],
      }),
    ],
  });
}

Deno.test("handleModelOutputSearch: drops the workflow linkage of a run whose workflow the principal may not read", async () => {
  await withTempDir(async (dir) => {
    const definitionRepo = new YamlDefinitionRepository(dir);
    const outputRepo = new YamlOutputRepository(dir);
    const workflowRepo = new YamlWorkflowRepository(dir);
    const definition = await saveEditModel(definitionRepo, "watched");
    const readable = linkedWorkflow("readable-wf");
    const hidden = linkedWorkflow("hidden-wf");
    await workflowRepo.save(readable);
    await workflowRepo.save(hidden);

    const save = (
      startedAt: string,
      provenance: Record<string, unknown>,
    ) =>
      outputRepo.save(
        EDIT_TEST_TYPE,
        "execute",
        ModelOutput.create({
          definitionId: definition.id,
          methodName: "execute",
          status: "succeeded",
          startedAt: new Date(startedAt),
          provenance: {
            definitionHash: "h",
            modelVersion: "1",
            ...provenance,
          } as ModelOutput["provenance"],
        }),
      );
    await save("2026-01-01T00:00:00Z", { triggeredBy: "manual" });
    await save("2026-01-02T00:00:00Z", {
      triggeredBy: "workflow",
      workflowId: readable.id,
      workflowRunId: "run-readable",
      stepName: "step-a",
    });
    await save("2026-01-03T00:00:00Z", {
      triggeredBy: "workflow",
      workflowId: hidden.id,
      workflowRunId: "run-hidden",
      stepName: "step-b",
    });

    const base = createPolicyEditCtx(dir, definitionRepo, [
      grant({ actions: ["read"], resource: { kind: "model", pattern: "*" } }),
      grant({
        actions: ["read"],
        resource: { kind: "workflow", pattern: "readable-wf" },
      }),
    ]);
    const ctx = {
      ...base,
      repoContext: {
        definitionRepo,
        outputRepo,
        workflowRepo,
      } as unknown as ConnectionContext["repoContext"],
    };
    const socket = createMockSocket();
    await handleModelOutputSearch(
      socket,
      ctx,
      "req-1",
      new AbortController(),
      EDITOR,
      { model: "watched", limit: 2 },
    );

    const [response] = frames(socket);
    assertEquals(response.type, "model.output.search");
    const results = response.payload.data.results;
    assertEquals(results.length, 2);
    // Most recent first: the hidden workflow's run keeps only triggeredBy.
    assertEquals(results[0].triggeredBy, "workflow");
    assertEquals(results[0].workflowId, undefined);
    assertEquals(results[0].workflowName, undefined);
    assertEquals(results[0].workflowRunId, undefined);
    assertEquals(results[0].stepName, undefined);
    assertEquals(results[1].workflowId, readable.id);
    assertEquals(results[1].workflowName, "readable-wf");
    assertEquals(results[1].workflowRunId, "run-readable");
    assertEquals(results[1].stepName, "step-a");
  });
});

Deno.test("redactWorkflowLinks: keeps every linkage without authorization, drops an unresolved one with it", async () => {
  const items = () => [{
    id: "o1",
    definitionId: "d1",
    type: "command/shell",
    methodName: "execute",
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    triggeredBy: "workflow" as const,
    workflowId: "gone",
    workflowRunId: "r1",
    stepName: "s1",
  }];
  const denyAll = () => Promise.resolve(false);

  const open = items();
  await redactWorkflowLinks(open, true, denyAll);
  assertEquals(open[0].workflowRunId, "r1");

  const restricted = items();
  await redactWorkflowLinks(restricted, false, () => Promise.resolve(true));
  assertEquals(restricted[0].workflowId, undefined);
  assertEquals(restricted[0].workflowRunId, undefined);
  assertEquals(restricted[0].stepName, undefined);
});
