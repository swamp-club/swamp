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
import { dirname, join } from "@std/path";
import {
  authorizeReferenceAccess,
  resolveModelTarget,
  resolveModelTargetById,
  resolveOutputAccess,
  resolveRunAccess,
  resolveWorkflowTarget,
  resolveWorkflowTargetById,
  targetArgument,
} from "./resource_resolution.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { ConnectionContext } from "./shared.ts";
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
      fields: { name: "widget-a", ns: "acme" },
    });
  });
});

Deno.test("resolveModelTarget: an unknown name is missing, authorized as sent and acted on by id only", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const resolution = await resolveModelTarget(repo, "nope");

    assertEquals(resolution, {
      status: "missing",
      resource: { kind: "model", name: "nope", fields: { name: "nope" } },
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
        fields: { name: OUTPUT.definitionId, modelType: "@acme/db" },
      },
      {
        kind: "data",
        name: OUTPUT.definitionId,
        fields: { name: OUTPUT.definitionId, ns: "acme" },
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

Deno.test("resolveOutputAccess: an ambiguous or unmatched argument is authorized as sent", async () => {
  for (
    const reference of [
      { kind: "ambiguous" as const, ids: [OUTPUT.id] },
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
      { kind: "model", name: "abc", fields: { name: "abc" } },
    ]);
  }
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
    { kind: "workflow", name: "prod-flow", fields: { name: "prod-flow" } },
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
  assertEquals(proceed, false);
  assertEquals(
    (sent[0] as { error?: { code: string } }).error?.code,
    "model_output_get_failed",
  );
});
