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
  assertStringIncludes,
} from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { stringify as stringifyYaml } from "@std/yaml";
import { join } from "@std/path";
import {
  handleModelCreate,
  handleModelDelete,
  handleModelEdit,
  handleModelMethodHistoryGet,
  handleModelMethodHistoryLogs,
  handleModelMethodHistorySearch,
  handleModelOutputGet,
  handleModelOutputSearch,
  redactWorkflowLinks,
} from "./model_handlers.ts";
import {
  findSpan,
  withCapturedSpans,
  withObservedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import type { ConnectionContext } from "./shared.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  createDefinitionId,
  Definition,
} from "../../domain/definitions/definition.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { DefinitionIdIndex } from "../../infrastructure/persistence/definition_id_index.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../../domain/datastore/datastore_sync_service.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import {
  GrantBasedAccessDecisionService,
  type GrantBasedAccessDecisionServiceOptions,
} from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import { createConditionEvaluator } from "../../domain/access/policy_snapshot_loader.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../../domain/access/principal.ts";

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
      tagRequiresExplicitGrant: false,
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
  options: GrantBasedAccessDecisionServiceOptions = {},
): ConnectionContext {
  const ctx = createEditCtx(repoDir, definitionRepo);
  return {
    ...ctx,
    authConfig: { ...ctx.authConfig, mode: "token" },
    policySnapshotLoader: {
      decisionService: new GrantBasedAccessDecisionService(
        new PolicySnapshot(grants, [], createConditionEvaluator()),
        options,
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
        allowRename: true,
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
        allowRename: true,
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

// --- handleModelEdit retag needs tag (swamp-club#3085) ---

/** Write on every model; tag only on team-a models; write does not imply tag. */
function createTeamTagCtx(
  dir: string,
  repo: YamlDefinitionRepository,
  extra: Grant[] = [],
): ConnectionContext {
  return createPolicyEditCtx(dir, repo, [
    grant({}),
    grant({ actions: ["tag"], condition: 'tags.team == "team-a"' }),
    ...extra,
  ], { writeImpliesTag: false });
}

async function editModel(
  ctx: ConnectionContext,
  definition: Definition,
  overrides: Record<string, unknown>,
) {
  const socket = createMockSocket();
  await handleModelEdit(
    socket,
    ctx,
    "req-retag",
    {
      modelIdOrName: definition.name,
      content: editYaml(definition, overrides),
      allowRename: true,
    },
    new AbortController(),
    EDITOR,
  );
  return frames(socket);
}

Deno.test("handleModelEdit: a retag into another team's tag is refused without a tag grant for its current tags", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "other-model", {
      team: "team-b",
    });

    const sent = await editModel(createTeamTagCtx(dir, repo), definition, {
      tags: { team: "team-a" },
    });

    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    assertEquals(sent[0].error.code, "unauthorized");
    const reread = await repo.findByNameGlobal("other-model");
    assertEquals(reread?.definition.tags, { team: "team-b" });
  });
});

Deno.test("handleModelEdit: a retag out of a granted team's tag is refused", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "own-model", {
      team: "team-a",
    });

    const sent = await editModel(createTeamTagCtx(dir, repo), definition, {
      tags: { team: "team-b" },
    });

    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    const reread = await repo.findByNameGlobal("own-model");
    assertEquals(reread?.definition.tags, { team: "team-a" });
  });
});

Deno.test("handleModelEdit: a retag within a granted team's tag is saved", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "own-model", {
      team: "team-a",
    });

    const sent = await editModel(createTeamTagCtx(dir, repo), definition, {
      tags: { team: "team-a", env: "prod" },
    });

    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "model.edit");
    const reread = await repo.findByNameGlobal("own-model");
    assertEquals(reread?.definition.tags, { team: "team-a", env: "prod" });
  });
});

Deno.test("handleModelEdit: an edit that keeps the tags and name needs no tag grant", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "other-model", {
      team: "team-b",
    });
    const ctx = createPolicyEditCtx(dir, repo, [grant({})], {
      writeImpliesTag: false,
    });

    const sent = await editModel(ctx, definition, { tags: { team: "team-b" } });

    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "model.edit");
  });
});

Deno.test("handleModelEdit: a rename into a name-scoped tag grant is refused, so it cannot be followed by a retag", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "other-model", {
      team: "team-b",
    });
    const ctx = createPolicyEditCtx(dir, repo, [
      grant({}),
      grant({
        actions: ["tag"],
        resource: { kind: "model", pattern: "team-a-*" },
      }),
    ], { writeImpliesTag: false });

    const sent = await editModel(ctx, definition, { name: "team-a-loot" });

    assertEquals(sent.length, 1);
    assertEquals(sent[0].error?.code, "unauthorized");
    assertEquals(await repo.findByNameGlobal("team-a-loot"), null);
    assertEquals(
      (await repo.findByNameGlobal("other-model"))?.definition.tags,
      { team: "team-b" },
    );
  });
});

Deno.test("handleModelEdit: an edit carrying the tags it loaded cannot undo a retag stored before it saves", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "own-model", {
      team: "team-a",
    });
    // The handler resolves the model, the edit loads it, and the save re-reads
    // it; another writer moves it to team-b right after the edit loads it.
    let lookups = 0;
    const racing = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop !== "findByNameGlobal") {
          return Reflect.get(target, prop, receiver);
        }
        return async (name: string) => {
          const found = await target.findByNameGlobal(name);
          if (++lookups === 2) {
            await target.save(
              EDIT_TEST_TYPE,
              Definition.fromData({
                ...definition.toData(),
                tags: { team: "team-b" },
              }),
            );
          }
          return found;
        };
      },
    });

    const sent = await editModel(
      createTeamTagCtx(dir, racing),
      definition,
      { tags: { team: "team-a" } },
    );

    assertEquals(lookups, 3);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].error?.code, "unauthorized");
    assertEquals(
      (await repo.findByNameGlobal("own-model"))?.definition.tags,
      { team: "team-b" },
    );
  });
});

Deno.test("handleModelEdit: a write grant still permits a retag when write implies tag", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "other-model", {
      team: "team-b",
    });

    const sent = await editModel(
      createPolicyEditCtx(dir, repo, [grant({})]),
      definition,
      { tags: { team: "team-a" } },
    );

    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "model.edit");
  });
});

Deno.test("handleModelEdit: a restricted model's retag stays an admin decision", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "restricted-model", {
      team: "team-b",
    });
    const base = createPolicyEditCtx(dir, repo, [
      grant({ actions: ["admin"], resource: { kind: "access", pattern: "*" } }),
    ], { writeImpliesTag: false });
    const ctx: ConnectionContext = {
      ...base,
      authConfig: {
        ...base.authConfig,
        restrictedModelTypes: [EDIT_TEST_TYPE.normalized],
      },
    };

    const sent = await editModel(ctx, definition, { tags: { team: "team-a" } });

    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "model.edit");
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
        `Behavior not found: ${modelIdOrName}`,
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

    // History retains its original response even for workflow-owned outputs.
    const historySocket = createMockSocket();
    // The legacy global scan enumerates registered types.
    modelRegistry.register({
      type: EDIT_TEST_TYPE,
      version: "2026.01.01.1",
      methods: {},
    });
    try {
      await handleModelMethodHistorySearch(
        historySocket,
        ctx,
        "req-history",
        new AbortController(),
        EDITOR,
        {},
      );
    } finally {
      modelRegistry.invalidateType(EDIT_TEST_TYPE);
    }
    const [history] = frames(historySocket);
    assertEquals(history.type, "model.method.history.search");
    assertEquals(history.payload.data.results.length, 3);
    for (const item of history.payload.data.results) {
      assertEquals(Object.keys(item).sort(), [
        "definitionId",
        "id",
        "methodName",
        "modelName",
        "startedAt",
        "status",
        "type",
      ]);
    }
  });
});

// --- output and method history search name resolution (swamp-club#3959) ---

Deno.test("handleModelOutputSearch and handleModelMethodHistorySearch: name history holding many deleted definitions from bounded definition scans", async () => {
  await withTempDir(async (dir) => {
    const definitionRepo = new YamlDefinitionRepository(dir);
    const outputRepo = new YamlOutputRepository(dir);
    const workflowRepo = new YamlWorkflowRepository(dir);
    const kept = await saveEditModel(definitionRepo, "kept");
    await saveEditModel(definitionRepo, "unused");

    const save = (definitionId: string, startedAt: Date) =>
      outputRepo.save(
        EDIT_TEST_TYPE,
        "execute",
        ModelOutput.create({
          definitionId: createDefinitionId(definitionId),
          methodName: "execute",
          status: "succeeded",
          startedAt,
          provenance: {
            definitionHash: "h",
            modelVersion: "1",
            triggeredBy: "manual",
          } as ModelOutput["provenance"],
        }),
      );
    // The kept model's runs are older than every deleted definition's.
    await save(kept.id, new Date("2026-01-01T00:00:00Z"));
    await save(kept.id, new Date("2026-01-01T00:00:01Z"));
    const deleted = 30;
    for (let i = 0; i < deleted; i++) {
      await save(crypto.randomUUID(), new Date(Date.UTC(2026, 0, 2, 0, 0, i)));
    }

    let findByIdCalls = 0;
    let scans = 0;
    const findById = definitionRepo.findById.bind(definitionRepo);
    definitionRepo.findById = (type, id) => {
      findByIdCalls++;
      return findById(type, id);
    };
    const scanAll = definitionRepo.findAllIncludingAutoGlobal.bind(
      definitionRepo,
    );
    definitionRepo.findAllIncludingAutoGlobal = () => {
      scans++;
      return scanAll();
    };

    // Only the kept model is readable, so the limit must apply after
    // authorization to return its two runs past the newer deleted ones.
    const base = createPolicyEditCtx(dir, definitionRepo, [
      grant({
        actions: ["read"],
        resource: { kind: "model", pattern: "kept" },
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
    // The global output scans walk registered types.
    modelRegistry.register({
      type: EDIT_TEST_TYPE,
      version: "2026.01.01.1",
      methods: {},
    });
    try {
      const socket = createMockSocket();
      await handleModelOutputSearch(
        socket,
        ctx,
        "req-1",
        new AbortController(),
        EDITOR,
        { limit: 2 },
      );
      const [response] = frames(socket);
      assertEquals(response.type, "model.output.search");
      assertEquals(
        response.payload.data.results.map((r: { modelName?: string }) =>
          r.modelName
        ),
        ["kept", "kept"],
      );
      assertEquals(findByIdCalls, 0);
      // Without a definition index, one scan names the outputs and
      // authorizes them (swamp-club#4141).
      assertEquals(scans, 1);

      scans = 0;
      const historySocket = createMockSocket();
      await handleModelMethodHistorySearch(
        historySocket,
        ctx,
        "req-history",
        new AbortController(),
        EDITOR,
        {},
      );
      const [history] = frames(historySocket);
      assertEquals(history.type, "model.method.history.search");
      assertEquals(
        history.payload.data.results.map((r: { modelName?: string }) =>
          r.modelName
        ),
        ["kept", "kept"],
      );
      assertEquals(findByIdCalls, 0);
      assertEquals(scans, 1);
    } finally {
      modelRegistry.invalidateType(EDIT_TEST_TYPE);
    }
  });
});

Deno.test("handleModelOutputSearch and handleModelMethodHistorySearch: with a definition index, read each definition owning an output once and no other (swamp-club#4141)", async () => {
  await withTempDir(async (dir) => {
    const definitionRepo = new YamlDefinitionRepository(dir);
    const outputRepo = new YamlOutputRepository(dir);
    const kept = await saveEditModel(definitionRepo, "kept");
    const hidden = await saveEditModel(definitionRepo, "hidden");
    const unused = [
      await saveEditModel(definitionRepo, "unused-1"),
      await saveEditModel(definitionRepo, "unused-2"),
    ];
    const save = (definition: Definition, startedAt: string) =>
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
            triggeredBy: "manual",
          },
        }),
      );
    await save(kept, "2026-01-01T00:00:00Z");
    await save(kept, "2026-01-02T00:00:00Z");
    await save(hidden, "2026-01-03T00:00:00Z");

    const reads = new Map<string, number>();
    const readFile = definitionRepo.readDefinitionFile.bind(definitionRepo);
    definitionRepo.readDefinitionFile = (path, segments, isSymlink) => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return readFile(path, segments, isSymlink);
    };
    let scans = 0;
    const scanAll = definitionRepo.findAllIncludingAutoGlobal.bind(
      definitionRepo,
    );
    definitionRepo.findAllIncludingAutoGlobal = () => {
      scans++;
      return scanAll();
    };
    // Settled at once, so a request's check of the index relists nothing.
    const definitionIndex = new DefinitionIdIndex(definitionRepo, {
      racyWindowMs: 0,
    });
    await definitionIndex.begin();

    const base = createPolicyEditCtx(dir, definitionRepo, [
      grant({
        actions: ["read"],
        resource: { kind: "model", pattern: "kept" },
      }),
    ]);
    const ctx: ConnectionContext = {
      ...base,
      definitionIndex,
      repoContext: {
        definitionRepo,
        outputRepo,
        workflowRepo: new YamlWorkflowRepository(dir),
      } as unknown as ConnectionContext["repoContext"],
    };
    modelRegistry.register({
      type: EDIT_TEST_TYPE,
      version: "2026.01.01.1",
      methods: {},
    });
    try {
      const requests = [
        (socket: WebSocket) =>
          handleModelOutputSearch(
            socket,
            ctx,
            "req-search",
            new AbortController(),
            EDITOR,
            {},
          ),
        (socket: WebSocket) =>
          handleModelMethodHistorySearch(
            socket,
            ctx,
            "req-history",
            new AbortController(),
            EDITOR,
            {},
          ),
      ];
      for (const request of requests) {
        reads.clear();
        await withObservedSpans(async (spans) => {
          const socket = createMockSocket();
          await request(socket);
          const [response] = frames(socket);
          assertEquals(
            response.payload.data.results.map((r: { modelName?: string }) =>
              r.modelName
            ),
            ["kept", "kept"],
          );

          // Each definition owning an output is read once; one owning none
          // is never read.
          assertEquals(
            Object.fromEntries(reads),
            {
              [definitionRepo.getPath(EDIT_TEST_TYPE, kept.id)]: 1,
              [definitionRepo.getPath(EDIT_TEST_TYPE, hidden.id)]: 1,
            },
          );
          for (const definition of unused) {
            assertEquals(
              reads.has(definitionRepo.getPath(EDIT_TEST_TYPE, definition.id)),
              false,
            );
          }

          // The names phase reads them, and authorization reuses its lookups.
          const phase = (name: string) =>
            findSpan(spans, `swamp.diagnostic.${name}`).attributes;
          assertEquals(
            phase("definition_names")["swamp.diagnostic.files_read"],
            2,
          );
          assertEquals(
            phase("authorization")["swamp.diagnostic.files_read"],
            undefined,
          );
          assertEquals(
            phase("authorization")["swamp.diagnostic.owner_lookups"],
            3,
          );
          assertEquals(
            phase("authorization")["swamp.diagnostic.owner_lookups_reused"],
            3,
          );
        });
      }
      assertEquals(scans, 0);
    } finally {
      modelRegistry.invalidateType(EDIT_TEST_TYPE);
    }
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

Deno.test("handleModelEdit: a rename without allowRename is refused and writes nothing", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "keep-me");
    const ctx = createPolicyEditCtx(dir, repo, [grant({})]);
    const socket = createMockSocket();

    await handleModelEdit(
      socket,
      ctx,
      "req-rename-unasked",
      {
        modelIdOrName: "keep-me",
        content: editYaml(definition, { name: "keep-me-template" }),
      },
      new AbortController(),
      EDITOR,
    );

    const sent = frames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    assertStringIncludes(sent[0].error.message, "--allow-rename");
    assertEquals(
      (await repo.findByNameGlobal("keep-me"))?.definition.id,
      definition.id,
    );
    assertEquals(await repo.findByNameGlobal("keep-me-template"), null);
  });
});

Deno.test("handleModelEdit: an allowed rename onto another model's name leaves both intact", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const mover = await saveEditModel(repo, "mover");
    const holder = await saveEditModel(repo, "holder");
    const ctx = createPolicyEditCtx(dir, repo, [grant({})]);
    const socket = createMockSocket();

    await handleModelEdit(
      socket,
      ctx,
      "req-rename-taken",
      {
        modelIdOrName: "mover",
        content: editYaml(mover, { name: "holder" }),
        allowRename: true,
      },
      new AbortController(),
      EDITOR,
    );

    const sent = frames(socket);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].type, "error");
    assertStringIncludes(sent[0].error.message, "already has that name");
    assertEquals(
      (await repo.findByNameGlobal("mover"))?.definition.id,
      mover.id,
    );
    assertEquals(
      (await repo.findByNameGlobal("holder"))?.definition.id,
      holder.id,
    );
  });
});

// --- principal on the libswamp spans (swamp-club#3593) ---

Deno.test("handleModelEdit: records the edited model and the requesting principal on the span", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "traced-model");
    await withCapturedSpans(async (spans) => {
      await handleModelEdit(
        createMockSocket(),
        createPolicyEditCtx(dir, repo, [grant({})]),
        "req-edit-traced",
        { modelIdOrName: definition.id, content: editYaml(definition) },
        new AbortController(),
        EDITOR,
      );
      const span = findSpan(spans, "swamp.model.edit");
      assertEquals(span.attributes["model.name"], "traced-model");
      assertEquals(span.attributes["model.id"], definition.id);
      assertEquals(span.attributes["auth.principal.id"], "user:editor");
    });
  });
});

Deno.test("handleModelEdit: records no principal on the span for an unauthenticated request", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "anonymous-model");
    await withCapturedSpans(async (spans) => {
      await handleModelEdit(
        createMockSocket(),
        createEditCtx(dir, repo),
        "req-edit-anonymous",
        { modelIdOrName: definition.id, content: editYaml(definition) },
        new AbortController(),
        null,
      );
      const span = findSpan(spans, "swamp.model.edit");
      assertEquals(span.attributes["model.name"], "anonymous-model");
      assertEquals(span.attributes["auth.principal.id"], undefined);
    });
  });
});

Deno.test("handleModelCreate: records the requesting principal on the span", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    await withCapturedSpans(async (spans) => {
      await handleModelCreate(
        createMockSocket(),
        createEditCtx(dir, repo),
        "req-create-traced",
        { typeArg: "command/shell", name: "created-model" },
        new AbortController(),
        EDITOR,
      );
      const span = findSpan(spans, "swamp.model.create");
      assertEquals(span.attributes["model.name"], "created-model");
      assertEquals(span.attributes["auth.principal.id"], "user:editor");
    });
  });
});

Deno.test("handleModelDelete: records the deleted model and the requesting principal on the span", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);
    const definition = await saveEditModel(repo, "doomed-model");
    const base = createDeleteCtx(dir);
    const ctx = {
      ...base,
      repoContext: {
        ...base.repoContext,
        // The model has no data, so only the lookup is ever called.
        unifiedDataRepo: { findAllForModel: () => Promise.resolve([]) },
      },
    } as unknown as ConnectionContext;
    await withCapturedSpans(async (spans) => {
      await handleModelDelete(
        createMockSocket(),
        ctx,
        "req-delete-traced",
        { modelIdOrName: definition.id },
        new AbortController(),
        EDITOR,
      );
      const span = findSpan(spans, "swamp.model.delete");
      assertEquals(span.attributes["model.name"], "doomed-model");
      assertEquals(span.attributes["model.id"], definition.id);
      assertEquals(span.attributes["auth.principal.id"], "user:editor");
    });
  });
});

// --- output and run-history reads under a relocated datastore (swamp-club#3729) ---

/**
 * A repo whose outputs resolve through `datastore`, with one run of model
 * `watched` saved the way a real run splits it: the record in the datastore
 * tier and its log under the repo's own outputs directory.
 */
async function saveRunUnder(
  repoDir: string,
  datastore: { path: string; namespace?: string } | undefined,
  logFile?: string,
): Promise<{ ctx: ConnectionContext; output: ModelOutput }> {
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const definition = await saveEditModel(definitionRepo, "watched");
  const resolver = new DefaultDatastorePathResolver(repoDir, {
    type: "filesystem",
    path: datastore?.path ?? join(repoDir, ".swamp"),
    ...(datastore?.namespace ? { namespace: datastore.namespace } : {}),
  });
  const outputRepo = new YamlOutputRepository(
    repoDir,
    resolver.resolvePath("outputs"),
  );
  const ownLog = join(
    repoDir,
    ".swamp",
    "outputs",
    "command",
    "shell",
    "execute",
    `${definition.id}.log`,
  );
  await Deno.mkdir(join(ownLog, ".."), { recursive: true });
  await Deno.writeTextFile(ownLog, "hello from the run\n");
  const output = ModelOutput.create({
    definitionId: definition.id,
    methodName: "execute",
    status: "succeeded",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    provenance: {
      definitionHash: "h",
      modelVersion: "1",
      triggeredBy: "manual",
    } as ModelOutput["provenance"],
    logFile: logFile ?? ownLog,
  });
  await outputRepo.save(EDIT_TEST_TYPE, "execute", output);
  const ctx = {
    ...createEditCtx(repoDir, definitionRepo),
    datastoreResolver: resolver,
  } as ConnectionContext;
  return { ctx, output };
}

/** The output lookups enumerate registered types to find a run's model. */
async function withEditTestTypeRegistered(fn: () => Promise<void>) {
  modelRegistry.register({
    type: EDIT_TEST_TYPE,
    version: "2026.01.01.1",
    methods: {},
  });
  try {
    await fn();
  } finally {
    modelRegistry.invalidateType(EDIT_TEST_TYPE);
  }
}

for (
  const [label, layout] of [
    ["a filesystem datastore outside the repo", { namespace: undefined }],
    ["a namespaced datastore", { namespace: "team-a" }],
  ] as const
) {
  Deno.test(`handleModelMethodHistoryGet, handleModelOutputGet and handleModelMethodHistoryLogs: find a run whose record is in ${label}`, async () => {
    await withEditTestTypeRegistered(() =>
      withTempDir(async (dir) => {
        const repoDir = join(dir, "repo");
        const { ctx, output } = await saveRunUnder(repoDir, {
          path: join(dir, "datastore"),
          namespace: layout.namespace,
        });
        for (const ref of [output.id, output.id.slice(0, 8), "watched"]) {
          const historySocket = createMockSocket();
          await handleModelMethodHistoryGet(
            historySocket,
            ctx,
            "req-history-get",
            { outputIdOrModelName: ref },
            new AbortController(),
            null,
          );
          const [history] = frames(historySocket);
          assertEquals(
            history.type,
            "model.method.history.get",
            JSON.stringify(history),
          );
          assertEquals(history.payload.data.id, output.id);

          const outputSocket = createMockSocket();
          await handleModelOutputGet(
            outputSocket,
            ctx,
            "req-output-get",
            { outputIdOrModelName: ref },
            new AbortController(),
            null,
          );
          const [got] = frames(outputSocket);
          assertEquals(got.type, "model.output.get", JSON.stringify(got));
          assertEquals(got.payload.data.id, output.id);

          const logsSocket = createMockSocket();
          await handleModelMethodHistoryLogs(
            logsSocket,
            ctx,
            "req-history-logs",
            { outputIdOrModelName: ref },
            new AbortController(),
            null,
          );
          const [logs] = frames(logsSocket);
          assertEquals(
            logs.type,
            "model.method.history.logs",
            JSON.stringify(logs),
          );
          assertEquals(logs.payload.data.type, "log");
          assertEquals(logs.payload.data.log.lines, ["hello from the run"]);
        }
      })
    );
  });
}

Deno.test("handleModelMethodHistoryLogs: never reads a log file outside the repo's outputs directory", async () => {
  await withEditTestTypeRegistered(() =>
    withTempDir(async (dir) => {
      const secret = join(dir, "secret.txt");
      await Deno.writeTextFile(secret, "server secret\n");
      const repoDir = join(dir, "repo");
      const escapeLink = join(repoDir, ".swamp", "outputs", "escape.log");

      for (const logFile of [secret, escapeLink]) {
        await Deno.remove(repoDir, { recursive: true }).catch(() => {});
        await Deno.mkdir(join(repoDir, ".swamp", "outputs"), {
          recursive: true,
        });
        await Deno.symlink(secret, escapeLink, { type: "file" });
        const { ctx, output } = await saveRunUnder(repoDir, undefined, logFile);

        const socket = createMockSocket();
        await handleModelMethodHistoryLogs(
          socket,
          ctx,
          "req-history-logs",
          { outputIdOrModelName: output.id },
          new AbortController(),
          null,
        );
        const [logs] = frames(socket);
        assertEquals(
          logs.type,
          "model.method.history.logs",
          JSON.stringify(logs),
        );
        assertEquals(logs.payload.data.type, "empty_log", logFile);
        assertEquals(JSON.stringify(logs).includes("server secret"), false);
      }
    })
  );
});

Deno.test("handleModelMethodHistoryLogs: reads a workflow step's log from its workflow run", async () => {
  await withEditTestTypeRegistered(() =>
    withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      const workflowLog = join(
        repoDir,
        ".swamp",
        "workflow-runs",
        crypto.randomUUID(),
        "workflow-run-1.log",
      );
      await Deno.mkdir(join(workflowLog, ".."), { recursive: true });
      await Deno.writeTextFile(workflowLog, "hello from the workflow\n");
      const { ctx, output } = await saveRunUnder(
        repoDir,
        { path: join(dir, "datastore") },
        workflowLog,
      );

      const socket = createMockSocket();
      await handleModelMethodHistoryLogs(
        socket,
        ctx,
        "req-history-logs",
        { outputIdOrModelName: output.id },
        new AbortController(),
        null,
      );
      const [logs] = frames(socket);
      assertEquals(
        logs.type,
        "model.method.history.logs",
        JSON.stringify(logs),
      );
      assertEquals(logs.payload.data.type, "log");
      assertEquals(logs.payload.data.log.lines, ["hello from the workflow"]);
    })
  );
});

// --- bounded behavior history search (swamp-club#4056) ---

Deno.test("handleModelOutputSearch: limits only after authorization, and exports output_search phases", async () => {
  await withTempDir(async (dir) => {
    const definitionRepo = new YamlDefinitionRepository(dir);
    const outputRepo = new YamlOutputRepository(dir);
    const readable = await saveEditModel(definitionRepo, "readable");
    const hidden = await saveEditModel(definitionRepo, "hidden");
    const save = (definition: Definition, startedAt: string) =>
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
            triggeredBy: "manual",
          },
        }),
      );
    await save(readable, "2026-01-01T00:00:00Z");
    await save(readable, "2026-01-02T00:00:00Z");
    // The newest outputs belong to a model the principal may not read.
    await save(hidden, "2026-01-03T00:00:00Z");
    await save(hidden, "2026-01-04T00:00:00Z");
    await save(hidden, "2026-01-05T00:00:00Z");

    const base = createPolicyEditCtx(dir, definitionRepo, [
      grant({
        actions: ["read"],
        resource: { kind: "model", pattern: "readable" },
      }),
    ]);
    const ctx = {
      ...base,
      repoContext: {
        definitionRepo,
        outputRepo,
        workflowRepo: new YamlWorkflowRepository(dir),
      } as unknown as ConnectionContext["repoContext"],
    };
    // The global scan enumerates registered types.
    modelRegistry.register({
      type: EDIT_TEST_TYPE,
      version: "2026.01.01.1",
      methods: {},
    });
    try {
      await withObservedSpans(async (spans) => {
        const socket = createMockSocket();
        await handleModelOutputSearch(
          socket,
          ctx,
          "req-1",
          new AbortController(),
          EDITOR,
          { limit: 2 },
        );

        const [response] = frames(socket);
        assertEquals(response.type, "model.output.search");
        assertEquals(
          response.payload.data.results.map((r: { startedAt: string }) =>
            r.startedAt
          ),
          ["2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
        );
        const phase = (name: string) =>
          findSpan(spans, `swamp.diagnostic.${name}`).attributes;
        assertEquals(
          phase("candidate_scan")["swamp.diagnostic.area"],
          "output_search",
        );
        assertEquals(phase("candidate_scan")["swamp.diagnostic.candidates"], 5);
        assertEquals(phase("authorization")["swamp.diagnostic.items"], 5);
        assertEquals(phase("authorization")["swamp.diagnostic.readable"], 2);
        assertEquals(phase("response")["swamp.diagnostic.results"], 2);
      });
    } finally {
      modelRegistry.invalidateType(EDIT_TEST_TYPE);
    }
  });
});

Deno.test("handleModelOutputSearch: names workflows through the repository's per-request view", async () => {
  await withTempDir(async (dir) => {
    const definitionRepo = new YamlDefinitionRepository(dir);
    const outputRepo = new YamlOutputRepository(dir);
    const workflowRepo = new YamlWorkflowRepository(dir);
    const definition = await saveEditModel(definitionRepo, "watched");
    const workflow = linkedWorkflow("nightly");
    await workflowRepo.save(workflow);
    await outputRepo.save(
      EDIT_TEST_TYPE,
      "execute",
      ModelOutput.create({
        definitionId: definition.id,
        methodName: "execute",
        status: "succeeded",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        provenance: {
          definitionHash: "h",
          modelVersion: "1",
          triggeredBy: "workflow",
          workflowId: workflow.id,
          workflowRunId: "run-1",
          stepName: "gate",
        },
      }),
    );
    let views = 0;
    let rawListings = 0;
    const counted = Object.assign(
      Object.create(workflowRepo) as YamlWorkflowRepository,
      {
        memoizedView: () => {
          views++;
          return workflowRepo;
        },
        findAll: () => {
          rawListings++;
          return workflowRepo.findAll();
        },
      },
    );
    const ctx = {
      ...createEditCtx(dir, definitionRepo),
      repoContext: {
        definitionRepo,
        outputRepo,
        workflowRepo: counted,
      } as unknown as ConnectionContext["repoContext"],
    };

    const socket = createMockSocket();
    await handleModelOutputSearch(
      socket,
      ctx,
      "req-1",
      new AbortController(),
      null,
      { model: "watched" },
    );

    const [response] = frames(socket);
    assertEquals(response.payload.data.results[0].workflowName, "nightly");
    // Authorization takes a view of its own; neither lists the live repository.
    assertGreater(views, 0);
    assertEquals(rawListings, 0);
  });
});

Deno.test("handleModelOutputSearch: a model's search skips its outputs named outside since and until without reading them (swamp-club#4058)", async () => {
  await withTempDir(async (dir) => {
    const definitionRepo = new YamlDefinitionRepository(dir);
    const outputRepo = new YamlOutputRepository(dir);
    const watched = await saveEditModel(definitionRepo, "watched");
    const other = await saveEditModel(definitionRepo, "other");
    const save = (definition: Definition, startedAt: string) =>
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
            triggeredBy: "manual",
          },
        }),
      );
    await save(watched, "2026-01-01T00:00:00Z");
    await save(watched, "2026-01-02T00:00:00Z");
    await save(watched, "2026-01-03T00:00:00Z");
    await save(other, "2026-01-02T12:00:00Z");
    const ctx = {
      ...createEditCtx(dir, definitionRepo),
      repoContext: {
        definitionRepo,
        outputRepo,
        workflowRepo: new YamlWorkflowRepository(dir),
      } as unknown as ConnectionContext["repoContext"],
    };

    for (
      const [window, expected, read] of [
        [
          { since: "2026-01-02T00:00:00Z" },
          ["2026-01-03T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
          2,
        ],
        [
          { since: "2026-01-02T00:00:00Z", until: "2026-01-03T00:00:00Z" },
          ["2026-01-02T00:00:00.000Z"],
          1,
        ],
      ] as const
    ) {
      await withObservedSpans(async (spans) => {
        const socket = createMockSocket();
        await handleModelOutputSearch(
          socket,
          ctx,
          "req-1",
          new AbortController(),
          null,
          { model: "watched", ...window },
        );

        const [response] = frames(socket);
        assertEquals(response.type, "model.output.search");
        assertEquals(
          response.payload.data.results.map((r: { startedAt: string }) =>
            r.startedAt
          ),
          [...expected],
        );
        const scan = findSpan(spans, "swamp.diagnostic.candidate_scan")
          .attributes;
        // Asserts candidates rather than files_read, which also counts the
        // definition lookup's reads.
        assertEquals(scan["swamp.diagnostic.candidates"], read);
        assertEquals(scan["swamp.diagnostic.skipped_by_name"], 4 - read);
      });
    }
  });
});

Deno.test("handleModelMethodHistorySearch: a search cancelled before its scan replies cancelled (swamp-club#4070)", async () => {
  await withTempDir(async (dir) => {
    const definitionRepo = new YamlDefinitionRepository(dir);
    const outputRepo = new YamlOutputRepository(dir);
    const watched = await saveEditModel(definitionRepo, "watched");
    await outputRepo.save(
      EDIT_TEST_TYPE,
      "execute",
      ModelOutput.create({
        definitionId: watched.id,
        methodName: "execute",
        status: "succeeded",
        provenance: {
          definitionHash: "h",
          modelVersion: "1",
          triggeredBy: "manual",
        },
      }),
    );
    const ctx = {
      ...createEditCtx(dir, definitionRepo),
      repoContext: {
        definitionRepo,
        outputRepo,
        workflowRepo: new YamlWorkflowRepository(dir),
      } as unknown as ConnectionContext["repoContext"],
    };
    const socket = createMockSocket();
    const controller = new AbortController();
    controller.abort();

    await handleModelMethodHistorySearch(
      socket,
      ctx,
      "req-1",
      controller,
      null,
      {},
    );

    const [response] = frames(socket);
    assertEquals(response.type, "error");
    assertEquals(response.error.code, "cancelled");
  });
});

Deno.test("handleModelOutputSearch: a search cancelled during its scan stops reading and replies cancelled (swamp-club#4070)", async () => {
  await withTempDir(async (dir) => {
    const definitionRepo = new YamlDefinitionRepository(dir);
    const outputRepo = new YamlOutputRepository(dir);
    const watched = await saveEditModel(definitionRepo, "watched");
    for (let day = 1; day <= 20; day++) {
      await outputRepo.save(
        EDIT_TEST_TYPE,
        "execute",
        ModelOutput.create({
          definitionId: watched.id,
          methodName: "execute",
          status: "succeeded",
          startedAt: new Date(Date.UTC(2026, 0, day)),
          provenance: {
            definitionHash: "h",
            modelVersion: "1",
            triggeredBy: "manual",
          },
        }),
      );
    }
    const ctx = {
      ...createEditCtx(dir, definitionRepo),
      repoContext: {
        definitionRepo,
        outputRepo,
        workflowRepo: new YamlWorkflowRepository(dir),
      } as unknown as ConnectionContext["repoContext"],
    };

    // Output reads are held open until released, so the cancel lands while
    // the scan holds permits and has reads still to start.
    const outputsDir = join(dir, ".swamp", "outputs");
    const readTextFile = Deno.readTextFile;
    const gate = Promise.withResolvers<void>();
    let outputReads = 0;
    (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile = async (
      path,
      options,
    ) => {
      if (String(path).startsWith(outputsDir)) {
        outputReads++;
        await gate.promise;
      }
      return await readTextFile(path, options);
    };
    try {
      await withObservedSpans(async (spans) => {
        const socket = createMockSocket();
        const controller = new AbortController();
        const search = handleModelOutputSearch(
          socket,
          ctx,
          "req-1",
          controller,
          null,
          { model: "watched" },
        );
        let readsAtAbort = 0;
        try {
          await waitFor(() => outputReads > 0, "the scan's first read");
        } finally {
          readsAtAbort = outputReads;
          controller.abort();
          gate.resolve();
          await search;
        }

        const [response] = frames(socket);
        assertEquals(response.type, "error");
        assertEquals(response.error.code, "cancelled");
        // 20 records, at most 16 read at once: the rest were never started.
        assertEquals(outputReads, readsAtAbort);
        assert(outputReads < 20, `${outputReads} reads`);
        const scan = findSpan(spans, "swamp.diagnostic.candidate_scan")
          .attributes;
        assertEquals(scan["swamp.outcome"], "cancelled");
        assertEquals(scan["swamp.diagnostic.cancel_observed"], true);
      });
    } finally {
      (Deno as { readTextFile: typeof Deno.readTextFile }).readTextFile =
        readTextFile;
    }
  });
});
