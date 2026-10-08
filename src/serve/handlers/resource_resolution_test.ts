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

import { assertEquals, assertStrictEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  authorizeReferenceAccess,
  CanonicalResources,
  recordedRunModel,
  type ReferenceAccess,
  resolveModelTarget,
  resolveModelTargetById,
  resolveOutputAccess,
  resolveRunAccess,
  resolveWorkflowTarget,
  resolveWorkflowTargetById,
  restrictedModelAuthorization,
  targetArgument,
} from "./resource_resolution.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { type ConnectionContext, setConnectionCollectives } from "./shared.ts";
import type { AccessResource } from "../../domain/access/access_decision_service.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import "../../domain/models/models.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-resolution-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const SHELL = ModelType.create("command/shell");

function workflowRepo(workflows: Workflow[]): WorkflowRepository {
  return {
    findByName: (name: string) =>
      Promise.resolve(workflows.find((w) => w.name === name) ?? null),
    findById: (id: string) =>
      Promise.resolve(workflows.find((w) => w.id === id) ?? null),
  } as unknown as WorkflowRepository;
}

Deno.test("resolveModelTarget: authorizes a model by id on its canonical name and full fields", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = Definition.create({
      name: "prod-db",
      globalArguments: {},
      tags: { env: "prod" },
    });
    await repo.save(SHELL, definition);

    const resolution = await resolveModelTarget(repo, definition.id);

    assertEquals(resolution.status, "found");
    if (resolution.status !== "found") return;
    assertEquals(resolution.resource, {
      kind: "model",
      name: "prod-db",
      fields: {
        name: "prod-db",
        modelType: "command/shell",
        tags: { env: "prod" },
      },
    });
    assertEquals(resolution.id, definition.id);
    assertEquals(targetArgument(resolution, definition.id), {
      idOrName: definition.id,
      byId: true,
      expectedName: "prod-db",
    });
  });
});

Deno.test("resolveModelTarget: as data, carries the namespace instead of the model type", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const type = ModelType.create("@acme/widget");
    const definition = Definition.create({
      name: "widget-a",
      globalArguments: {},
    });
    await repo.save(type, definition);

    const resolution = await resolveModelTarget(repo, "widget-a", "data");

    assertEquals(resolution.status === "found" && resolution.resource, {
      kind: "data",
      name: "widget-a",
      fields: { name: "widget-a", ns: "acme", tags: {} },
    });
  });
});

Deno.test("resolveModelTarget: an unknown name is missing, authorized as sent and acted on by id only", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const resolution = await resolveModelTarget(repo, "nope");

    assertEquals(resolution, {
      status: "missing",
      resource: {
        kind: "model",
        name: "nope",
        fields: { name: "nope", tags: {} },
      },
    });
    if (resolution.status !== "missing") return;
    assertEquals(targetArgument(resolution, "nope"), {
      idOrName: "nope",
      byId: true,
    });
  });
});

Deno.test("resolveModelTarget: a failing lookup is reported, never treated as missing", async () => {
  const error = new Error("disk on fire");
  const repo = {
    findByNameGlobal: () => Promise.reject(error),
  } as unknown as DefinitionRepository;

  assertEquals(await resolveModelTarget(repo, "x"), {
    status: "failed",
    error,
  });
});

Deno.test("restrictedModelAuthorization: a restricted model needs admin on access:*, acted on by the same id", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const definition = Definition.create({
      name: "deploy",
      globalArguments: {},
      tags: { env: "prod" },
    });
    await repo.save(SHELL, definition);
    const resolution = await resolveModelTarget(repo, "deploy", "data");

    for (
      const listed of ["command/shell", "@command/shell", "Command::Shell"]
    ) {
      const { action, resolution: judged } = restrictedModelAuthorization(
        resolution,
        "write",
        [listed],
      );
      assertEquals(action, "admin", listed);
      assertEquals(judged.status, "found");
      if (judged.status !== "found") return;
      assertEquals(judged.resource, {
        kind: "access",
        name: "*",
        fields: { name: "deploy", ns: "", tags: { env: "prod" } },
      });
      assertEquals(
        targetArgument(judged, "deploy"),
        targetArgument(resolution as typeof judged, "deploy"),
      );
    }

    const open = restrictedModelAuthorization(resolution, "write", [
      "@other/type",
    ]);
    assertEquals(open.action, "write");
    assertStrictEquals(open.resolution, resolution);
  });
});

Deno.test("restrictedModelAuthorization: a missing model and a control-plane model keep their resource", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const missing = await resolveModelTarget(repo, "nothing");
    const judged = restrictedModelAuthorization(missing, "write", [
      "command/shell",
    ]);
    assertEquals(judged.action, "write");
    assertStrictEquals(judged.resolution, missing);

    const grantType = ModelType.create("swamp/grant");
    const grantDef = Definition.create({ name: "g", globalArguments: {} });
    await repo.save(grantType, grantDef);
    const controlPlane = await resolveModelTarget(repo, "g");
    const kept = restrictedModelAuthorization(controlPlane, "write", [
      "swamp/grant",
    ]);
    assertEquals(kept.action, "write");
    assertStrictEquals(kept.resolution, controlPlane);
  });
});

Deno.test("resolveModelTargetById: ignores a model named with the id", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const target = Definition.create({ name: "target", globalArguments: {} });
    const impostor = Definition.create({
      name: target.id,
      globalArguments: {},
    });
    await repo.save(SHELL, target);
    await repo.save(SHELL, impostor);

    const byName = await resolveModelTarget(repo, target.id);
    const byId = await resolveModelTargetById(repo, target.id);

    assertEquals(byName.status === "found" && byName.id, impostor.id);
    assertEquals(byId.status === "found" && byId.id, target.id);
  });
});

Deno.test("resolveWorkflowTarget: names win over ids", async () => {
  const target = Workflow.create({ name: "prod-flow", tags: { env: "prod" } });
  const impostor = Workflow.create({ name: target.id });
  const repo = workflowRepo([target, impostor]);

  const byName = await resolveWorkflowTarget(repo, target.id);
  const byId = await resolveWorkflowTargetById(repo, target.id);

  assertEquals(byName.status === "found" && byName.id, impostor.id);
  assertEquals(byId.status === "found" && byId.resource, {
    kind: "workflow",
    name: "prod-flow",
    fields: { name: "prod-flow", tags: { env: "prod" } },
  });
});

Deno.test("resolveWorkflowTarget: a broken workflow file is authorized on the name it declares", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    await Deno.writeTextFile(
      join(dir, "workflow-prod-broken.yaml"),
      `id: ${id}\nname: prod-broken\njobs: not-a-list\n`,
    );
    const repo = workflowRepo([]);

    for (const idOrName of [id, "prod-broken"]) {
      const resolution = await resolveWorkflowTarget(repo, idOrName, dir);
      assertEquals(resolution.status, "broken", idOrName);
      if (resolution.status !== "broken") continue;
      assertEquals(resolution.resource.name, "prod-broken");
      // Passed by the id and name it declares, so the operation reaches this
      // file and no other.
      assertEquals(targetArgument(resolution, idOrName), {
        idOrName: id,
        byId: true,
        expectedName: "prod-broken",
      });
    }
  });
});

Deno.test("resolveWorkflowTargetById: matches a broken workflow file by its id only", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    await Deno.writeTextFile(
      join(dir, "workflow-named-like-an-id.yaml"),
      `name: ${id}\njobs: not-a-list\n`,
    );
    const resolution = await resolveWorkflowTargetById(
      workflowRepo([]),
      id,
      dir,
    );
    assertEquals(resolution.status, "missing");
  });
});

Deno.test("resolveWorkflowTarget: a broken workflow file without an id is passed on as sent", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "workflow-no-id.yaml"),
      "name: no-id\njobs: not-a-list\n",
    );
    const resolution = await resolveWorkflowTarget(
      workflowRepo([]),
      "no-id",
      dir,
    );
    assertEquals(resolution.status, "broken");
    if (resolution.status !== "broken") return;
    assertEquals(targetArgument(resolution, "no-id"), {
      idOrName: "no-id",
      byId: false,
    });
  });
});

// Output and run reads (swamp-club#2673).

/** Copies `source`'s file under another name; the copy keeps its id. */
async function copyDefinitionFile(
  repo: YamlDefinitionRepository,
  source: Definition,
  name: string,
): Promise<void> {
  const path = repo.getPath(SHELL, source.id);
  await Deno.writeTextFile(
    join(dirname(path), `${name}.yaml`),
    (await Deno.readTextFile(path)).replace(
      `name: ${source.name}`,
      `name: ${name}`,
    ),
  );
}

const OUTPUT = {
  id: "abc00000-0000-4000-8000-000000000001",
  definitionId: "00000000-0000-4000-8000-0000000000aa",
};

Deno.test("resolveOutputAccess: an output is authorized on every definition declaring its model id", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const prod = Definition.create({
      id: OUTPUT.definitionId,
      name: "prod-db",
      globalArguments: {},
      tags: { env: "prod" },
    });
    await repo.save(SHELL, prod);
    // A copied file keeps the id, so the copy shares the output.
    await copyDefinitionFile(repo, prod, "safe-model");

    const access = await resolveOutputAccess(
      repo,
      () =>
        Promise.resolve({
          reference: {
            kind: "output" as const,
            match: { output: OUTPUT, type: SHELL },
          },
        }),
      "abc",
      ["model", "data"],
    );

    assertEquals(access.status, "resolved");
    if (access.status !== "resolved") return;
    assertEquals(
      access.resources.map((r) => `${r.kind}:${r.name}`).sort(),
      ["data:prod-db", "data:safe-model", "model:prod-db", "model:safe-model"],
    );
    const prodModel = access.resources.find((r) =>
      r.kind === "model" && r.name === "prod-db"
    );
    assertEquals(prodModel?.fields, {
      name: "prod-db",
      modelType: "command/shell",
      tags: { env: "prod" },
    });
  });
});

Deno.test("resolveOutputAccess: an output of a deleted model is authorized on its model id", async () => {
  await withTempDir(async (dir) => {
    const access = await resolveOutputAccess(
      new YamlDefinitionRepository(dir),
      () =>
        Promise.resolve({
          reference: {
            kind: "output" as const,
            match: { output: OUTPUT, type: ModelType.create("@acme/db") },
          },
        }),
      "abc",
      ["model", "data"],
    );
    assertEquals(access.status === "resolved" && access.resources, [
      {
        kind: "model",
        name: OUTPUT.definitionId,
        fields: {
          name: OUTPUT.definitionId,
          modelType: "@acme/db",
          tags: {},
        },
      },
      {
        kind: "data",
        name: OUTPUT.definitionId,
        fields: { name: OUTPUT.definitionId, ns: "acme", tags: {} },
      },
    ]);
  });
});

Deno.test("resolveOutputAccess: a model read authorizes the model and the owners of its latest output", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const safe = Definition.create({
      id: OUTPUT.definitionId,
      name: "safe-model",
      globalArguments: {},
    });
    await repo.save(SHELL, safe);
    await copyDefinitionFile(repo, safe, "prod-db");
    const access = await resolveOutputAccess(
      repo,
      () =>
        Promise.resolve({
          reference: {
            kind: "model" as const,
            definition: safe,
            type: SHELL,
            latest: OUTPUT,
          },
        }),
      "safe-model",
      ["model"],
    );
    assertEquals(
      access.status === "resolved" && access.resources.map((r) => r.name),
      ["safe-model", "prod-db"],
    );
  });
});

Deno.test("resolveOutputAccess: an unmatched argument is authorized as sent", async () => {
  for (
    const reference of [
      { kind: "not_found" as const },
      { kind: "invalid" as const },
    ]
  ) {
    const access = await resolveOutputAccess(
      {} as DefinitionRepository,
      () => Promise.resolve({ reference }),
      "abc",
      ["model"],
    );
    assertEquals(access.status === "resolved" && access.resources, [
      { kind: "model", name: "abc", fields: { name: "abc", tags: {} } },
    ]);
  }
});

/** Counts the by-id lookups `repo` answers. */
function countingDefinitionRepo(
  repo: YamlDefinitionRepository,
): { repo: DefinitionRepository; lookups: () => number } {
  let lookups = 0;
  return {
    lookups: () => lookups,
    repo: {
      findAllByIdGlobal: (
        id: Parameters<
          NonNullable<DefinitionRepository["findAllByIdGlobal"]>
        >[0],
      ) => {
        lookups++;
        return repo.findAllByIdGlobal(id);
      },
    } as unknown as DefinitionRepository,
  };
}

const PROD_ID = "00000000-0000-4000-8000-0000000000aa";
const DEV_ID = "00000000-0000-4000-8000-0000000000bb";

/** An ambiguous reference to two prod outputs and one dev output. */
function ambiguousOutputs() {
  const matches = [
    { output: { definitionId: PROD_ID }, type: SHELL },
    { output: { definitionId: DEV_ID }, type: SHELL },
    { output: { definitionId: PROD_ID }, type: SHELL },
  ];
  return {
    kind: "ambiguous" as const,
    ids: ["abc1", "abc2", "abc3"],
    matches,
  };
}

async function saveProdAndDev(repo: YamlDefinitionRepository): Promise<void> {
  await repo.save(
    SHELL,
    Definition.create({ id: PROD_ID, name: "prod-db", globalArguments: {} }),
  );
  await repo.save(
    SHELL,
    Definition.create({ id: DEV_ID, name: "dev-db", globalArguments: {} }),
  );
}

Deno.test("resolveOutputAccess: an ambiguous prefix is authorized on each match's owners, looked up once per model (swamp-club#2743)", async () => {
  await withTempDir(async (dir) => {
    const yaml = new YamlDefinitionRepository(dir);
    await saveProdAndDev(yaml);
    const { repo, lookups } = countingDefinitionRepo(yaml);

    const access = await resolveOutputAccess(
      repo,
      () => Promise.resolve({ reference: ambiguousOutputs() }),
      "abc",
      ["model", "data"],
    );

    assertEquals(access.status, "ambiguous");
    if (access.status !== "ambiguous") return;
    assertEquals(
      access.candidates.map((c) => c.map((r) => `${r.kind}:${r.name}`)),
      [
        ["model:prod-db", "data:prod-db"],
        ["model:dev-db", "data:dev-db"],
        ["model:prod-db", "data:prod-db"],
      ],
    );
    assertEquals(lookups(), 2);
    // Matches with the same owners share one array, decided once.
    assertStrictEquals(access.candidates[0], access.candidates[2]);
  });
});

Deno.test("resolveOutputAccess: narrowing an ambiguous prefix keeps ids and matches aligned", async () => {
  await withTempDir(async (dir) => {
    const yaml = new YamlDefinitionRepository(dir);
    await saveProdAndDev(yaml);
    const reference = ambiguousOutputs();
    const access = await resolveOutputAccess(
      yaml,
      () => Promise.resolve({ reference }),
      "abc",
      ["model"],
    );
    if (access.status !== "ambiguous") throw new Error(access.status);
    assertEquals(access.narrow([0, 2]).reference, {
      kind: "ambiguous",
      ids: ["abc1", "abc3"],
      matches: [reference.matches[0], reference.matches[2]],
    });
  });
});

Deno.test("resolveOutputAccess: a failing lookup is reported, never treated as not found", async () => {
  const access = await resolveOutputAccess(
    {} as DefinitionRepository,
    () => Promise.reject(new Error("disk on fire")),
    "abc",
    ["model"],
  );
  assertEquals(access.status, "failed");
});

function runOf(workflow: Workflow): WorkflowRun {
  return WorkflowRun.create(workflow);
}

Deno.test("resolveRunAccess: a run is authorized on its recorded workflow", async () => {
  const prod = Workflow.create({ name: "prod-flow", tags: { env: "prod" } });
  const access = await resolveRunAccess(
    workflowRepo([prod]),
    () => Promise.resolve({ reference: { kind: "run", run: runOf(prod) } }),
    "abd",
  );
  assertEquals(access.status === "resolved" && access.resources, [
    {
      kind: "workflow",
      name: "prod-flow",
      fields: { name: "prod-flow", tags: { env: "prod" } },
    },
  ]);
});

Deno.test("resolveRunAccess: a run of a deleted workflow is authorized on its recorded name", async () => {
  const prod = Workflow.create({ name: "prod-flow" });
  const access = await resolveRunAccess(
    workflowRepo([]),
    () => Promise.resolve({ reference: { kind: "run", run: runOf(prod) } }),
    "abd",
  );
  assertEquals(access.status === "resolved" && access.resources, [
    {
      kind: "workflow",
      name: "prod-flow",
      fields: { name: "prod-flow", tags: {} },
    },
  ]);
});

Deno.test("resolveRunAccess: a run of a renamed workflow is authorized on both names", async () => {
  const prod = Workflow.create({ name: "prod-flow" });
  const renamed = Workflow.create({ id: prod.id, name: "renamed-flow" });
  const access = await resolveRunAccess(
    workflowRepo([renamed]),
    () => Promise.resolve({ reference: { kind: "run", run: runOf(prod) } }),
    "abd",
  );
  assertEquals(
    access.status === "resolved" && access.resources.map((r) => r.name),
    ["prod-flow", "renamed-flow"],
  );
});

/** Counts every lookup `workflows` answers. */
function countingWorkflowRepo(
  workflows: Workflow[],
): { repo: WorkflowRepository; lookups: () => number } {
  let lookups = 0;
  const inner = workflowRepo(workflows);
  return {
    lookups: () => lookups,
    repo: {
      findByName: (name: string) => {
        lookups++;
        return inner.findByName(name);
      },
      findById: (id: Parameters<WorkflowRepository["findById"]>[0]) => {
        lookups++;
        return inner.findById(id);
      },
    } as unknown as WorkflowRepository,
  };
}

Deno.test("resolveRunAccess: an ambiguous prefix is authorized on each run's workflows, looked up once per workflow (swamp-club#2743)", async () => {
  const prod = Workflow.create({ name: "prod-flow" });
  const dev = Workflow.create({ name: "dev-flow" });

  const single = countingWorkflowRepo([prod, dev]);
  await resolveRunAccess(
    single.repo,
    () => Promise.resolve({ reference: { kind: "run", run: runOf(prod) } }),
    "abd",
  );

  const { repo, lookups } = countingWorkflowRepo([prod, dev]);
  const runs = [runOf(prod), runOf(dev), runOf(prod)];
  const access = await resolveRunAccess(
    repo,
    () =>
      Promise.resolve({
        reference: {
          kind: "ambiguous",
          ids: runs.map((run) => run.id),
          runs,
        },
      }),
    "abd",
  );

  assertEquals(access.status, "ambiguous");
  if (access.status !== "ambiguous") return;
  assertEquals(
    access.candidates.map((c) => c.map((r) => r.name)),
    [["prod-flow"], ["dev-flow"], ["prod-flow"]],
  );
  assertEquals(lookups(), 2 * single.lookups());
  assertStrictEquals(access.candidates[0], access.candidates[2]);
  assertEquals(access.narrow([1]).reference, {
    kind: "ambiguous",
    ids: [runs[1].id],
    runs: [runs[1]],
  });
});

Deno.test("resolveRunAccess: an unmatched argument is authorized as sent", async () => {
  const access = await resolveRunAccess(
    workflowRepo([]),
    () => Promise.resolve({ reference: { kind: "not_found" } }),
    "abd",
  );
  assertEquals(access.status === "resolved" && access.resources, [
    { kind: "workflow", name: "abd", fields: { name: "abd", tags: {} } },
  ]);
});

Deno.test("resolveRunAccess: a workflow read authorizes the workflow and its latest run's workflow", async () => {
  const prod = Workflow.create({ name: "prod-flow" });
  const copy = Workflow.create({ id: prod.id, name: "safe-flow" });
  const access = await resolveRunAccess(
    workflowRepo([prod, copy]),
    () =>
      Promise.resolve({
        reference: {
          kind: "workflow",
          workflow: copy,
          latest: runOf(prod),
        },
      }),
    "safe-flow",
  );
  assertEquals(
    access.status === "resolved" && access.resources.map((r) => r.name),
    ["safe-flow", "prod-flow"],
  );
});

/** A socket that records what serve sends. */
function recordingSocket(): { socket: WebSocket; sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    socket: {
      readyState: WebSocket.OPEN,
      send: (data: string) => sent.push(JSON.parse(data)),
    } as unknown as WebSocket,
  };
}

Deno.test("authorizeReferenceAccess: a failed lookup replies with the failed code and never proceeds", () => {
  const { socket, sent } = recordingSocket();
  const ctx = { authConfig: { mode: "none" } } as unknown as ConnectionContext;
  const proceed = authorizeReferenceAccess(
    socket,
    "req-1",
    null,
    "read",
    { status: "failed", error: new Error("disk on fire") },
    "abc",
    ["model"],
    ctx,
    "model_output_get_failed",
  );
  assertEquals(proceed, null);
  assertEquals(
    (sent[0] as { error?: { code: string } }).error?.code,
    "model_output_get_failed",
  );
});

// Ambiguous prefixes (swamp-club#2743).

const PRINCIPAL = { kind: "user" as const, id: "adam" };

function modelResource(name: string): AccessResource {
  return { kind: "model", name, fields: { name } };
}

/** A policy context allowing model:* and denying model:prod-*. */
function policyCtx(
  mode: "none" | "token" = "token",
): { ctx: ConnectionContext; audit: AuditEvent[] } {
  const grant = (overrides: Partial<Grant>): Grant => ({
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
  });
  const snapshot = new PolicySnapshot([
    grant({}),
    grant({ effect: "deny", resource: { kind: "model", pattern: "prod-*" } }),
  ], []);
  const audit: AuditEvent[] = [];
  const ctx = {
    policySnapshotLoader: {
      decisionService: new GrantBasedAccessDecisionService(snapshot),
    } as unknown as PolicySnapshotLoader,
    authConfig: { mode, admins: [] },
    auditEmitter: { emit: (event: AuditEvent) => audit.push(event) },
    instanceId: "test-instance",
  } as unknown as ConnectionContext;
  return { ctx, audit };
}

/** An ambiguous access over `names`, narrowing to the readable names. */
function ambiguousAccess(names: string[]): ReferenceAccess<string[]> {
  return {
    status: "ambiguous",
    resolved: names,
    candidates: names.map((name) => [modelResource(name)]),
    narrow: (readable) => readable.map((i) => names[i]),
  };
}

function authorizeAmbiguousNames(
  names: string[],
  ctx: ConnectionContext,
  principal: typeof PRINCIPAL | null = PRINCIPAL,
): { result: string[] | null; sent: unknown[] } {
  const { socket, sent } = recordingSocket();
  setConnectionCollectives(socket, [], []);
  const result = authorizeReferenceAccess(
    socket,
    "req-1",
    principal,
    "read",
    ambiguousAccess(names),
    "abc",
    ["model"],
    ctx,
    "model_output_get_failed",
  );
  return { result, sent };
}

Deno.test("authorizeReferenceAccess: an ambiguous prefix keeps only the readable matches, in order, and audits the rest", () => {
  const { ctx, audit } = policyCtx();
  const { result, sent } = authorizeAmbiguousNames(
    ["prod-db", "dev-db", "prod-cache", "dev-cache"],
    ctx,
  );
  assertEquals(result, ["dev-db", "dev-cache"]);
  assertEquals(sent, []);
  assertEquals(
    audit.map((e) => [e.outcome, e.resourceName]),
    [["denied", "prod-cache"], ["denied", "prod-db"]],
  );
});

Deno.test("authorizeReferenceAccess: an ambiguous prefix decides and audits each distinct owner once, however many matches share it", () => {
  const { ctx, audit } = policyCtx();
  const prod = [modelResource("prod-db")];
  const dev = [modelResource("dev-db")];
  const candidates = Array.from(
    { length: 1000 },
    (_, i) => i % 2 === 0 ? prod : dev,
  );
  const { socket, sent } = recordingSocket();
  setConnectionCollectives(socket, [], []);
  const result = authorizeReferenceAccess(
    socket,
    "req-1",
    PRINCIPAL,
    "read",
    {
      status: "ambiguous",
      resolved: [],
      candidates,
      narrow: (readable: number[]) => readable,
    },
    "abc",
    ["model"],
    ctx,
    "model_output_get_failed",
  );
  assertEquals(result?.length, 500);
  assertEquals(result?.every((i) => i % 2 === 1), true);
  assertEquals(sent, []);
  assertEquals(
    audit.map((e) => [e.outcome, e.resourceName]),
    [["denied", "prod-db"]],
  );
});

Deno.test("authorizeReferenceAccess: an ambiguous prefix whose matches all share a denied owner is refused and audited once", () => {
  const { ctx, audit } = policyCtx();
  const prod = [modelResource("prod-db")];
  const { socket, sent } = recordingSocket();
  setConnectionCollectives(socket, [], []);
  const result = authorizeReferenceAccess(
    socket,
    "req-1",
    PRINCIPAL,
    "read",
    {
      status: "ambiguous",
      resolved: [],
      candidates: Array.from({ length: 1000 }, () => prod),
      narrow: (readable: number[]) => readable,
    },
    "abc",
    ["model"],
    ctx,
    "model_output_get_failed",
  );
  assertEquals(result, null);
  assertEquals(sent.length, 1);
  assertEquals(
    audit.map((e) => [e.outcome, e.resourceName]),
    [["denied", "prod-db"]],
  );
});

Deno.test("authorizeReferenceAccess: matches sharing an allowed first owner are all listed", () => {
  const { ctx, audit } = policyCtx();
  const dev = [modelResource("dev-db")];
  const prod = [modelResource("prod-db")];
  const { socket, sent } = recordingSocket();
  setConnectionCollectives(socket, [], []);
  const result = authorizeReferenceAccess(
    socket,
    "req-1",
    PRINCIPAL,
    "read",
    {
      status: "ambiguous",
      resolved: [],
      candidates: [dev, prod, dev, prod],
      narrow: (readable: number[]) => readable,
    },
    "abc",
    ["model"],
    ctx,
    "model_output_get_failed",
  );
  assertEquals(result, [0, 2]);
  assertEquals(sent, []);
  assertEquals(
    audit.map((e) => [e.outcome, e.resourceName]),
    [["denied", "prod-db"]],
  );
});

Deno.test("authorizeReferenceAccess: an ambiguous prefix with no readable match is refused as its first match would be", () => {
  const { ctx, audit } = policyCtx();
  const { result, sent } = authorizeAmbiguousNames(
    ["prod-db", "prod-cache"],
    ctx,
  );
  assertEquals(result, null);
  assertEquals(sent.length, 1);
  const error = (sent[0] as { error: { code: string; message: string } })
    .error;
  assertEquals(error.code, "unauthorized");
  assertEquals(error.message.includes("model:prod-db"), true);
  assertEquals(error.message.includes("prod-cache"), false);
  assertEquals(
    audit.map((e) => [e.outcome, e.resourceName]),
    [["denied", "prod-cache"], ["denied", "prod-db"]],
  );
});

Deno.test("authorizeReferenceAccess: an ambiguous prefix without a principal or policy is refused with the usual code", () => {
  const { ctx } = policyCtx();
  const noPrincipal = authorizeAmbiguousNames(
    ["dev-db", "dev-cache"],
    ctx,
    null,
  );
  assertEquals(noPrincipal.result, null);
  assertEquals(
    (noPrincipal.sent[0] as { error: { code: string } }).error.code,
    "unauthorized",
  );

  ctx.policySnapshotLoader = undefined;
  const noPolicy = authorizeAmbiguousNames(["dev-db", "dev-cache"], ctx);
  assertEquals(noPolicy.result, null);
  assertEquals(
    (noPolicy.sent[0] as { error: { code: string } }).error.code,
    "access_not_configured",
  );
});

Deno.test("authorizeReferenceAccess: an ambiguous prefix lists every match when auth is off", () => {
  const { ctx, audit } = policyCtx("none");
  const { result, sent } = authorizeAmbiguousNames(
    ["prod-db", "dev-db"],
    ctx,
    null,
  );
  assertEquals(result, ["prod-db", "dev-db"]);
  assertEquals(sent, []);
  assertEquals(audit, []);
});

// --- CanonicalResources (swamp-club#2675) ---

Deno.test("CanonicalResources.modelOwners: every definition sharing the id, with full fields", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const prod = Definition.create({
      name: "prod-db",
      globalArguments: {},
      tags: { env: "prod" },
    });
    await repo.save(SHELL, prod);
    await copyDefinitionFile(repo, prod, "safe-model");

    const canonical = new CanonicalResources(repo, workflowRepo([]));
    const owners = await canonical.modelOwners(
      prod.id,
      "command/shell",
      "recorded-name",
      "data",
    );

    assertEquals(
      owners.map((o) => o.name).sort(),
      ["prod-db", "safe-model"],
    );
    for (const owner of owners) {
      assertEquals(owner.kind, "data");
      assertEquals(owner.fields.ns, "");
      assertEquals(owner.fields.tags, { env: "prod" });
    }
  });
});

Deno.test("CanonicalResources.modelOwners: a deleted model is judged on its recorded name with empty tags", async () => {
  await withTempDir(async (dir) => {
    const canonical = new CanonicalResources(
      new YamlDefinitionRepository(dir),
      workflowRepo([]),
    );
    assertEquals(
      await canonical.modelOwners(
        crypto.randomUUID(),
        "@acme/db",
        "gone-db",
        "data",
      ),
      [{
        kind: "data",
        name: "gone-db",
        fields: { name: "gone-db", ns: "acme", tags: {} },
      }],
    );
  });
});

Deno.test("CanonicalResources.model: a listed definition is judged as itself, not its copy", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const prod = Definition.create({
      name: "prod-db",
      globalArguments: {},
      tags: { env: "prod" },
    });
    await repo.save(SHELL, prod);
    await copyDefinitionFile(repo, prod, "safe-model");

    const canonical = new CanonicalResources(repo, workflowRepo([]));
    const resources = await canonical.model(
      prod.id,
      "safe-model",
      "command/shell",
    );

    assertEquals(resources.map((r) => r.name), ["safe-model"]);
    assertEquals(resources[0].fields.modelType, "command/shell");
  });
});

Deno.test("CanonicalResources.workflowOwners: a renamed workflow counts under both names", async () => {
  const wf = Workflow.create({ name: "prod-flow", tags: { env: "prod" } });
  const canonical = new CanonicalResources(
    {} as DefinitionRepository,
    workflowRepo([wf]),
  );

  const owners = await canonical.workflowOwners(wf.id, "old-flow");

  assertEquals(owners, [
    {
      kind: "workflow",
      name: "old-flow",
      fields: { name: "old-flow", tags: {} },
    },
    {
      kind: "workflow",
      name: "prod-flow",
      fields: { name: "prod-flow", tags: { env: "prod" } },
    },
  ]);
});

Deno.test("CanonicalResources.dataOwners: workflow-scope data is named by its workflow with its tags", async () => {
  const wf = Workflow.create({ name: "nightly", tags: { env: "prod" } });
  const canonical = new CanonicalResources(
    {} as DefinitionRepository,
    workflowRepo([wf]),
  );

  const owners = await canonical.dataOwners({
    modelType: "workflow",
    modelId: wf.id,
    modelName: "nightly",
  });

  assertEquals(owners, [{
    kind: "data",
    name: "nightly",
    fields: { name: "nightly", ns: "", tags: { env: "prod" } },
  }]);
});

Deno.test("CanonicalResources: looks each id up once per request", async () => {
  let lookups = 0;
  const wf = Workflow.create({ name: "w" });
  const repo = {
    findById: (id: string) => {
      lookups++;
      return Promise.resolve(id === wf.id ? wf : null);
    },
    findByName: () => Promise.resolve(null),
  } as unknown as WorkflowRepository;
  const canonical = new CanonicalResources({} as DefinitionRepository, repo);

  await canonical.workflowOwners(wf.id, "w");
  const before = lookups;
  await canonical.workflowOwners(wf.id, "w");

  assertEquals(lookups, before);
});

Deno.test("CanonicalResources: one definition scan serves every id in a request", async () => {
  let scans = 0;
  let perIdScans = 0;
  const definitions = Array.from({ length: 50 }, (_, i) => ({
    definition: Definition.create({ name: `m-${i}`, globalArguments: {} }),
    type: SHELL,
  }));
  const repo = {
    findAllIncludingAutoGlobal: () => {
      scans++;
      return Promise.resolve(definitions);
    },
    findAllByIdGlobal: () => {
      perIdScans++;
      return Promise.resolve([]);
    },
  } as unknown as DefinitionRepository;
  const canonical = new CanonicalResources(repo, workflowRepo([]));

  for (const { definition } of definitions) {
    const owners = await canonical.modelOwners(
      definition.id,
      "command/shell",
      definition.name,
      "data",
    );
    assertEquals(owners.map((o) => o.name), [definition.name]);
  }

  assertEquals(scans, 1);
  assertEquals(perIdScans, 0);
});

// ── Control-plane records are owned by the access kind (swamp-club#2756) ──

const GRANT_TYPE = ModelType.create("swamp/grant");
const GRANT_RECORD: AccessResource = {
  kind: "access",
  name: "swamp/grant",
  fields: { name: "grant-abc", modelType: "swamp/grant", tags: {} },
};

async function saveAutoDefinition(
  dir: string,
  type: ModelType,
  definition: Definition,
): Promise<void> {
  // Serve writes control-plane definitions to .swamp/auto-definitions.
  const autoRepo = new YamlDefinitionRepository(
    dir,
    undefined,
    join(dir, ".swamp", "auto-definitions"),
    false,
  );
  await autoRepo.save(type, definition);
}

Deno.test("resolveModelTarget: a control-plane definition resolves to its access record resource, as data or model", async () => {
  await withTempDir(async (dir) => {
    const grant = Definition.create({ name: "grant-abc", globalArguments: {} });
    await saveAutoDefinition(dir, GRANT_TYPE, grant);
    const repo = new YamlDefinitionRepository(dir);

    for (const kind of ["data", "model"] as const) {
      for (const ref of ["grant-abc", grant.id]) {
        const resolution = await resolveModelTarget(repo, ref, kind);
        assertEquals(resolution.status, "found");
        if (resolution.status !== "found") return;
        assertEquals(resolution.resource, GRANT_RECORD, `${kind} ${ref}`);
        assertEquals(resolution.name, "grant-abc");
      }
    }
  });
});

Deno.test("CanonicalResources.dataOwners: control-plane data is owned by its access record resource", async () => {
  await withTempDir(async (dir) => {
    const grant = Definition.create({ name: "grant-abc", globalArguments: {} });
    await saveAutoDefinition(dir, GRANT_TYPE, grant);
    const user = Definition.create({ name: "mine", globalArguments: {} });
    const repo = new YamlDefinitionRepository(dir);
    await repo.save(SHELL, user);
    const canonical = new CanonicalResources(repo, workflowRepo([]));

    assertEquals(
      await canonical.dataOwners({
        modelType: "swamp/grant",
        modelId: grant.id,
        modelName: "grant-abc",
      }),
      [GRANT_RECORD],
    );
    assertEquals(
      (await canonical.dataOwners({
        modelType: "command/shell",
        modelId: user.id,
        modelName: "mine",
      }))[0].kind,
      "data",
    );
  });
});

Deno.test("CanonicalResources: an orphaned control-plane record is judged on its recorded type", async () => {
  await withTempDir(async (dir) => {
    const canonical = new CanonicalResources(
      new YamlDefinitionRepository(dir),
      workflowRepo([]),
    );
    const orphan = {
      modelType: "swamp/server-token",
      modelId: crypto.randomUUID(),
      modelName: "tok",
    };
    const expected: AccessResource = {
      kind: "access",
      name: "swamp/server-token",
      fields: { name: "tok", modelType: "swamp/server-token", tags: {} },
    };
    assertEquals(await canonical.dataOwners(orphan), [expected]);
    assertEquals(
      await canonical.model(orphan.modelId, "tok", "swamp/server-token"),
      [expected],
    );
  });
});

Deno.test("resolveOutputAccess: an output of a deleted control-plane model stays admin-only", async () => {
  await withTempDir(async (dir) => {
    const access = await resolveOutputAccess(
      new YamlDefinitionRepository(dir),
      () =>
        Promise.resolve({
          reference: {
            kind: "output" as const,
            match: {
              output: OUTPUT,
              type: ModelType.create("swamp/enrollment-token"),
            },
          },
        }),
      "abc",
      ["model", "data"],
    );
    assertEquals(access.status === "resolved" && access.resources, [{
      kind: "access",
      name: "swamp/enrollment-token",
      fields: {
        name: OUTPUT.definitionId,
        modelType: "swamp/enrollment-token",
        tags: {},
      },
    }]);
  });
});

Deno.test("CanonicalResources: a user definition reusing a control-plane record's id does not own it alone", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    // A user model that happens to declare the id a deleted grant had.
    const user = Definition.create({ name: "mine", globalArguments: {} });
    await repo.save(SHELL, user);
    const canonical = new CanonicalResources(repo, workflowRepo([]));

    const owners = await canonical.dataOwners({
      modelType: "swamp/grant",
      modelId: user.id,
      modelName: "grant-gone",
    });
    assertEquals(owners.map((o) => `${o.kind}:${o.name}`), [
      "data:mine",
      "access:swamp/grant",
    ]);
    assertEquals(owners[1].fields, {
      name: "grant-gone",
      modelType: "swamp/grant",
      tags: {},
    });
    // A live control-plane owner is not doubled.
    const grant = Definition.create({ name: "grant-abc", globalArguments: {} });
    await saveAutoDefinition(dir, GRANT_TYPE, grant);
    assertEquals(
      await new CanonicalResources(
        new YamlDefinitionRepository(dir),
        workflowRepo([]),
      ).dataOwners({
        modelType: "swamp/grant",
        modelId: grant.id,
        modelName: "grant-abc",
      }),
      [GRANT_RECORD],
    );
  });
});

Deno.test("resolveOutputAccess: an output recorded under a control-plane type needs admin even when a user definition shares its id", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const user = Definition.create({ name: "mine", globalArguments: {} });
    await repo.save(SHELL, user);
    const access = await resolveOutputAccess(
      repo,
      () =>
        Promise.resolve({
          reference: {
            kind: "output" as const,
            match: {
              output: { ...OUTPUT, definitionId: user.id },
              type: ModelType.create("swamp/fleet-probe"),
            },
          },
        }),
      "abc",
      ["model"],
    );
    assertEquals(
      access.status === "resolved" &&
        access.resources.map((r) => `${r.kind}:${r.name}`),
      ["model:mine", "access:swamp/fleet-probe"],
    );
  });
});

Deno.test("recordedRunModel: records the definition's name and a control-plane type from either source", () => {
  const user = {
    definition: Definition.create({ name: "user-db", globalArguments: {} }),
    type: SHELL,
  };
  const grant = {
    definition: Definition.create({ name: "grant-abc", globalArguments: {} }),
    type: GRANT_TYPE,
  };
  // A direct-type run of a control-plane type against a user model's name.
  assertEquals(recordedRunModel(user, "raw", "swamp.Server-Token"), {
    name: "user-db",
    type: "swamp/server-token",
  });
  // A user typeArg against a control-plane model.
  assertEquals(recordedRunModel(grant, "raw", "command/shell"), {
    name: "grant-abc",
    type: "swamp/grant",
  });
  assertEquals(recordedRunModel(user, "raw", undefined), {
    name: "user-db",
    type: "command/shell",
  });
  // No definition yet: the requested name and the executed type.
  assertEquals(recordedRunModel(null, "new-grant", "@swamp/grant"), {
    name: "new-grant",
    type: "swamp/grant",
  });
  assertEquals(recordedRunModel(null, "x", undefined), {
    name: "x",
    type: undefined,
  });
});
