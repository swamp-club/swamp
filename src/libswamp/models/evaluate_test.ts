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

import { assertEquals, assertRejects } from "@std/assert";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createModelEvaluateDeps,
  isModelEvaluateAllData,
  modelEvaluate,
  type ModelEvaluateAllData,
  type ModelEvaluateDeps,
  type ModelEvaluateEvent,
  type ModelEvaluateItemData,
} from "./evaluate.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { catalogDbPath } from "../../infrastructure/persistence/repository_factory.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native sqlite handles
      // yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function catalogDbExists(repoDir: string): Promise<boolean> {
  try {
    await Deno.lstat(catalogDbPath(repoDir));
    return true;
  } catch {
    return false;
  }
}

Deno.test(
  "createModelEvaluateDeps: reuses an injected store and opens no new catalog db",
  async () => {
    await withTempDir(async (dir) => {
      const injected = new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        new CatalogStore(":memory:"),
      );
      createModelEvaluateDeps(
        dir,
        undefined,
        injected,
        new CatalogStore(":memory:"),
      );
      assertEquals(await catalogDbExists(dir), false);
    });
  },
);

Deno.test(
  "createModelEvaluateDeps: opens a file-based catalog db when no store is injected",
  async () => {
    await withTempDir(async (dir) => {
      createModelEvaluateDeps(dir);
      assertEquals(await catalogDbExists(dir), true);
    });
  },
);

function makeDeps(
  overrides?: Partial<ModelEvaluateDeps>,
): ModelEvaluateDeps {
  const definition = Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
  const modelType = ModelType.create("aws/ec2");

  return {
    lookupDefinition: () => Promise.resolve({ definition, type: modelType }),
    evaluateDefinition: () =>
      Promise.resolve({
        definition,
        type: modelType,
        hadExpressions: true,
        authoredExpressions: new Set<string>(),
      }),
    evaluateAllDefinitions: () =>
      Promise.resolve([{
        definition,
        type: modelType,
        hadExpressions: true,
        authoredExpressions: new Set<string>(),
      }]),
    saveEvaluatedDefinition: () => Promise.resolve(),
    getEvaluatedPath: (type, id) =>
      `/tmp/.swamp/definitions-evaluated/${type.normalized}/${id}.yaml`,
    ...overrides,
  };
}

Deno.test("modelEvaluate single model yields evaluating then completed", async () => {
  const deps = makeDeps();
  const events = await collect<ModelEvaluateEvent>(
    modelEvaluate(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "evaluating" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelEvaluateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as ModelEvaluateItemData;
  assertEquals(data.hadExpressions, true);
  assertEquals(data.name, "my-model");
  assertEquals(data.type, "aws/ec2");
  assertEquals(typeof data.outputPath, "string");
});

Deno.test("modelEvaluate single model not found yields error", async () => {
  const deps = makeDeps({
    lookupDefinition: () => Promise.resolve(null),
  });
  const events = await collect<ModelEvaluateEvent>(
    modelEvaluate(createLibSwampContext(), deps, {
      modelIdOrName: "missing",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<ModelEvaluateEvent, { kind: "error" }>;
  assertEquals(error.error.code, "not_found");
});

Deno.test("modelEvaluate all models yields completed with AllData", async () => {
  const deps = makeDeps();
  const events = await collect<ModelEvaluateEvent>(
    modelEvaluate(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "evaluating" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelEvaluateEvent,
    { kind: "completed" }
  >;
  assertEquals(isModelEvaluateAllData(completed.data), true);
  const data = completed.data as ModelEvaluateAllData;
  assertEquals(data.total, 1);
  assertEquals(data.evaluated, 1);
  assertEquals(data.items.length, 1);
});

Deno.test("isModelEvaluateAllData: returns true for AllData, false for ItemData", () => {
  const allData: ModelEvaluateAllData = {
    items: [],
    total: 0,
    evaluated: 0,
  };
  assertEquals(isModelEvaluateAllData(allData), true);

  const itemData: ModelEvaluateItemData = {
    id: "test",
    name: "test",
    type: "test",
    hadExpressions: false,
  };
  assertEquals(isModelEvaluateAllData(itemData), false);
});

Deno.test("modelEvaluate: byId resolves through lookupDefinitionById, never the name-first lookup", async () => {
  const id = crypto.randomUUID();
  const calls: string[] = [];
  const byIdDefinition = Definition.create({
    id,
    name: "by-id-model",
    version: 1,
  });
  const modelType = ModelType.create("aws/ec2");
  const deps = makeDeps({
    lookupDefinition: (idOrName) => {
      calls.push(`name:${idOrName}`);
      return Promise.reject(new Error("name-first lookup must not be used"));
    },
    lookupDefinitionById: (lookupId) => {
      calls.push(`id:${lookupId}`);
      return Promise.resolve({ definition: byIdDefinition, type: modelType });
    },
    evaluateDefinition: (definition, type) =>
      Promise.resolve({
        definition,
        type,
        hadExpressions: false,
        authoredExpressions: new Set<string>(),
      }),
  });

  const events = await collect<ModelEvaluateEvent>(
    modelEvaluate(createLibSwampContext(), deps, {
      modelIdOrName: id,
      byId: true,
    }),
  );

  const completed = events[1] as Extract<
    ModelEvaluateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  const data = completed.data as ModelEvaluateItemData;
  assertEquals(data.id, id);
  assertEquals(data.name, "by-id-model");
  assertEquals(calls, [`id:${id}`]);
});

Deno.test("modelEvaluate: byId without lookupDefinitionById fails instead of falling back to name lookup", async () => {
  let nameLookups = 0;
  const fallback = makeDeps();
  const deps = makeDeps({
    lookupDefinition: (idOrName) => {
      nameLookups++;
      return fallback.lookupDefinition(idOrName);
    },
  });

  await assertRejects(
    () =>
      collect<ModelEvaluateEvent>(
        modelEvaluate(createLibSwampContext(), deps, {
          modelIdOrName: crypto.randomUUID(),
          byId: true,
        }),
      ),
    Error,
    "none is wired",
  );
  assertEquals(nameLookups, 0);
});

Deno.test("modelEvaluate: shows sensitive values masked and caches them as vault references (swamp-club#2171)", async () => {
  const modelType = ModelType.create("aws/ec2");
  const evaluated = Definition.create({
    id: "00000000-0000-4000-8000-000000000002",
    name: "reads-secret",
    version: 1,
    globalArguments: { token: "Bearer Pl41n-s3cret", region: "eu" },
  });
  const saved: Definition[] = [];
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: evaluated, type: modelType }),
    // Evaluation read the secret through data.latest, which records it.
    evaluateDefinition: (_definition, type, sensitiveValues) => {
      sensitiveValues.addSecret("Pl41n-s3cret", {
        vaultName: "prod",
        key: "api-token",
      });
      return Promise.resolve({
        definition: evaluated,
        type,
        hadExpressions: true,
        authoredExpressions: new Set<string>(),
      });
    },
    saveEvaluatedDefinition: (_type, definition) => {
      saved.push(definition);
      return Promise.resolve();
    },
  });
  const events = await collect<ModelEvaluateEvent>(
    modelEvaluate(createLibSwampContext(), deps, {
      modelIdOrName: "reads-secret",
    }),
  );
  const completed = events.at(-1) as Extract<
    ModelEvaluateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as ModelEvaluateItemData;
  assertEquals(data.globalArguments, { token: "Bearer ***", region: "eu" });
  assertEquals(
    saved[0].globalArguments.token,
    "Bearer ${{ vault.get('prod', 'api-token') }}",
  );
});

Deno.test("modelEvaluate: --all writes sensitive values outside arguments as references (swamp-club#2171)", async () => {
  const modelType = ModelType.create("aws/ec2");
  const expression = "${{ data.latest('db', 'creds').attributes.password }}";
  const source = Definition.create({
    id: "00000000-0000-4000-8000-000000000003",
    name: "default-from-secret",
    version: 1,
    inputs: {
      type: "object",
      properties: { password: { type: "string", default: expression } },
    },
  });
  const evaluated = Definition.fromData({
    ...source.toData(),
    inputs: {
      type: "object",
      properties: { password: { type: "string", default: "Pl41n-s3cret" } },
    },
  });
  const saved: Definition[] = [];
  const deps = makeDeps({
    evaluateAllDefinitions: (sensitiveValues) => {
      sensitiveValues.addSecret("Pl41n-s3cret", {
        vaultName: "prod",
        key: "db-password",
      });
      return Promise.resolve([{
        definition: evaluated,
        sourceDefinition: source,
        type: modelType,
        hadExpressions: true,
        authoredExpressions: new Set([expression]),
      }]);
    },
    saveEvaluatedDefinition: (_type, definition) => {
      saved.push(definition);
      return Promise.resolve();
    },
  });
  await collect<ModelEvaluateEvent>(
    modelEvaluate(createLibSwampContext(), deps, {}),
  );
  assertEquals(
    JSON.stringify(saved[0].toData()).includes("Pl41n-s3cret"),
    false,
  );
  assertEquals(
    JSON.stringify(saved[0].toData()).includes(
      "${{ vault.get('prod', 'db-password') }}",
    ),
    true,
  );

Deno.test("modelEvaluate all with include saves and reports only accepted models", async () => {
  const modelType = ModelType.create("aws/ec2");
  const entry = (name: string) => ({
    definition: Definition.create({ name, version: 1 }),
    type: modelType,
    hadExpressions: true,
    authoredExpressions: new Set<string>(),
  });
  const saved: string[] = [];
  const deps = makeDeps({
    evaluateAllDefinitions: () =>
      Promise.resolve([entry("keep"), entry("skip")]),
    saveEvaluatedDefinition: (_type, definition) => {
      saved.push(definition.name);
      return Promise.resolve();
    },
  });

  const events = await collect<ModelEvaluateEvent>(
    modelEvaluate(createLibSwampContext(), deps, {
      include: ({ definition }) => definition.name === "keep",
    }),
  );

  const completed = events.find((e) => e.kind === "completed");
  if (
    completed?.kind !== "completed" || !isModelEvaluateAllData(completed.data)
  ) {
    throw new Error("expected all data");
  }
  assertEquals(completed.data.items.map((i) => i.name), ["keep"]);
  assertEquals(completed.data.total, 1);
  assertEquals(saved, ["keep"]);
});
