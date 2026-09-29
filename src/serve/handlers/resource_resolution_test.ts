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
import { join } from "@std/path";
import {
  resolveModelTarget,
  resolveModelTargetById,
  resolveWorkflowTarget,
  resolveWorkflowTargetById,
  targetArgument,
} from "./resource_resolution.ts";
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
      // Passed on as sent: no parsed workflow matches it, so the operation
      // reaches the same broken file and reports its load error.
      assertEquals(targetArgument(resolution, idOrName), {
        idOrName,
        byId: false,
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
