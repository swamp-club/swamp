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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createModelValidateDeps,
  isModelValidateAllData,
  modelValidate,
  type ModelValidateData,
  type ModelValidateDeps,
  type ModelValidateEvent,
} from "./validate.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { catalogDbPath } from "../../infrastructure/persistence/repository_factory.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { join } from "@std/path";

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
  "createModelValidateDeps: reuses an injected store and opens no new catalog db",
  async () => {
    await withTempDir(async (dir) => {
      const injected = new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        new CatalogStore(":memory:"),
      );
      createModelValidateDeps(
        dir,
        undefined,
        undefined,
        injected,
        new CatalogStore(":memory:"),
      );
      assertEquals(await catalogDbExists(dir), false);
    });
  },
);

Deno.test(
  "createModelValidateDeps: opens a file-based catalog db when no store is injected",
  async () => {
    await withTempDir(async (dir) => {
      createModelValidateDeps(dir);
      assertEquals(await catalogDbExists(dir), true);
    });
  },
);

Deno.test(
  "createModelValidateDeps: isAutoDefinition compares IDs, not only names",
  async () => {
    await withTempDir(async (dir) => {
      const type = ModelType.create("aws/ec2");
      const authored = Definition.create({ name: "shared", version: 1 });
      const auto = Definition.create({ name: "shared", version: 1 });
      const autoOnly = Definition.create({ name: "auto-only", version: 1 });
      await new YamlDefinitionRepository(dir).save(type, authored);
      const autoRepo = new YamlDefinitionRepository(
        dir,
        undefined,
        join(dir, ".swamp", "auto-definitions"),
        false,
      );
      await autoRepo.save(type, auto);
      await autoRepo.save(type, autoOnly);

      const store = new CatalogStore(":memory:");
      try {
        const deps = createModelValidateDeps(
          dir,
          undefined,
          undefined,
          new FileSystemUnifiedDataRepository(dir, undefined, store),
          store,
        );
        assertEquals(await deps.isAutoDefinition(authored, type), false);
        // Reached by UUID while models/ holds another "shared".
        assertEquals(await deps.isAutoDefinition(auto, type), true);
        assertEquals(await deps.isAutoDefinition(autoOnly, type), true);
      } finally {
        store.close();
      }
    });
  },
);

function makeDeps(
  overrides?: Partial<ModelValidateDeps>,
): ModelValidateDeps {
  const definition = Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
  const modelType = ModelType.create("aws/ec2");
  return {
    lookupDefinition: () => Promise.resolve({ definition, type: modelType }),
    findAllDefinitions: () =>
      Promise.resolve([{ definition, type: modelType }]),
    isAutoDefinition: () => Promise.resolve(false),
    resolveModelType: () => Promise.resolve({}),
    validateModel: () =>
      Promise.resolve({
        results: [
          { name: "schema", passed: true },
          { name: "refs", passed: true },
        ],
        warnings: [],
      }),
    ...overrides,
  };
}

Deno.test("modelValidate single model yields completed with passed=true", async () => {
  const deps = makeDeps();
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as ModelValidateData;
  assertEquals(data.passed, true);
  assertEquals(data.validations.length, 2);
});

Deno.test("modelValidate single model yields completed with passed=false", async () => {
  const deps = makeDeps({
    validateModel: () =>
      Promise.resolve({
        results: [
          { name: "schema", passed: false, error: "invalid field" },
        ],
        warnings: [],
      }),
  });
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
    }),
  );

  const completed = events[1] as Extract<
    ModelValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as ModelValidateData;
  assertEquals(data.passed, false);
});

Deno.test("modelValidate all models yields aggregate results", async () => {
  const deps = makeDeps();
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {}),
  );

  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelValidateEvent,
    { kind: "completed" }
  >;
  assertEquals(isModelValidateAllData(completed.data), true);
});

Deno.test("modelValidate yields error when model not found", async () => {
  const deps = makeDeps({
    lookupDefinition: () => Promise.resolve(null),
  });
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {
      modelIdOrName: "missing",
    }),
  );

  assertEquals(events[1].kind, "error");
});

Deno.test("modelValidate all yields error when no models exist", async () => {
  const deps = makeDeps({
    findAllDefinitions: () => Promise.resolve([]),
  });
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {}),
  );

  assertEquals(events[1].kind, "error");
});

Deno.test("modelValidate single model resolves all model types for cross-type references", async () => {
  const targetType = ModelType.create("@keeb/mms/dedup");
  const otherType = ModelType.create("@keeb/mms/organizer");
  const targetDef = Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "dedup",
    version: 1,
  });
  const otherDef = Definition.create({
    id: "00000000-0000-4000-8000-000000000002",
    name: "organizer",
    version: 1,
  });

  const resolvedTypes: string[] = [];
  const deps = makeDeps({
    lookupDefinition: () =>
      Promise.resolve({ definition: targetDef, type: targetType }),
    findAllDefinitions: () =>
      Promise.resolve([
        { definition: targetDef, type: targetType },
        { definition: otherDef, type: otherType },
      ]),
    resolveModelType: (type) => {
      resolvedTypes.push(type.normalized);
      return Promise.resolve({});
    },
  });

  await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {
      modelIdOrName: "dedup",
    }),
  );

  // The target type is resolved once for the target model, then all types
  // (including the target again) are resolved to populate the registry
  assertEquals(resolvedTypes.includes(targetType.normalized), true);
  assertEquals(resolvedTypes.includes(otherType.normalized), true);
});

Deno.test("modelValidate single model propagates warnings", async () => {
  const deps = makeDeps({
    validateModel: () =>
      Promise.resolve({
        results: [{ name: "schema", passed: true }],
        warnings: [
          {
            name: "Environment variables detected",
            message: "Data stored under this model will vary",
            envVars: [
              { path: "globalArguments.baseUrl", envVar: "BASE_URL" },
            ],
          },
        ],
      }),
  });
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
    }),
  );

  const completed = events[1] as Extract<
    ModelValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as ModelValidateData;
  assertEquals(data.passed, true);
  assertEquals(data.warnings.length, 1);
  assertEquals(data.warnings[0].name, "Environment variables detected");
  assertEquals(data.warnings[0].envVars?.length, 1);
  assertEquals(data.warnings[0].envVars?.[0].envVar, "BASE_URL");
});

async function validateSingleData(
  overrides: Partial<ModelValidateDeps>,
): Promise<ModelValidateData> {
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), makeDeps(overrides), {
      modelIdOrName: "my-model",
    }),
  );
  const completed = events.at(-1) as Extract<
    ModelValidateEvent,
    { kind: "completed" }
  >;
  return completed.data as ModelValidateData;
}

Deno.test("modelValidate single auto-definition with a failed check adds the Auto-definition note", async () => {
  const data = await validateSingleData({
    isAutoDefinition: () => Promise.resolve(true),
    validateModel: () =>
      Promise.resolve({
        results: [{ name: "Expression paths", passed: false, error: "x" }],
        warnings: [],
      }),
  });
  assertEquals(data.passed, false);
  assertEquals(data.warnings.map((w) => w.name), ["Auto-definition"]);
  assertStringIncludes(data.warnings[0].message, "evaluation produced");
});

Deno.test("modelValidate single auto-definition with a warning adds the Auto-definition note", async () => {
  const data = await validateSingleData({
    isAutoDefinition: () => Promise.resolve(true),
    validateModel: () =>
      Promise.resolve({
        results: [{ name: "Expression paths", passed: true }],
        warnings: [{ name: "Template syntax passed through", message: "m" }],
      }),
  });
  assertEquals(data.warnings.map((w) => w.name), [
    "Template syntax passed through",
    "Auto-definition",
  ]);
});

Deno.test("modelValidate clean auto-definition gets no Auto-definition note", async () => {
  const data = await validateSingleData({
    isAutoDefinition: () => Promise.resolve(true),
  });
  assertEquals(data.passed, true);
  assertEquals(data.warnings, []);
});

Deno.test("modelValidate single models/ definition gets no Auto-definition note", async () => {
  const data = await validateSingleData({
    validateModel: () =>
      Promise.resolve({
        results: [{ name: "Expression paths", passed: false, error: "x" }],
        warnings: [],
      }),
  });
  assertEquals(data.warnings, []);
});

Deno.test("modelValidate all models never adds the Auto-definition note", async () => {
  const deps = makeDeps({
    isAutoDefinition: () => Promise.resolve(true),
    validateModel: () =>
      Promise.resolve({
        results: [{ name: "Expression paths", passed: false, error: "x" }],
        warnings: [],
      }),
  });
  const events = await collect<ModelValidateEvent>(
    modelValidate(createLibSwampContext(), deps, {}),
  );
  const completed = events.at(-1) as Extract<
    ModelValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data;
  if (!isModelValidateAllData(data)) {
    throw new Error("expected all-models data");
  }
  assertEquals(data.models[0].warnings, []);
});
