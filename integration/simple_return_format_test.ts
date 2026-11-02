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
import { ensureDir } from "@std/fs";
import { Definition } from "../src/domain/definitions/definition.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-simple-return-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function createUserModel(
  repoDir: string,
  filename: string,
  content: string,
): Promise<string> {
  const modelsDir = join(repoDir, "extensions", "models");
  await ensureDir(modelsDir);
  const modelPath = join(modelsDir, filename);
  await Deno.writeTextFile(modelPath, content);
  return modelsDir;
}

const DATAWRITER_MODEL_CODE = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  resourceName: z.string(),
  region: z.string().default("us-west-2"),
});

const ResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  region: z.string(),
  status: z.string(),
  endpoint: z.string(),
  createdAt: z.string(),
});

export const model = {
  type: "@user/datawriter-model",
  version: "2026.02.09.1",
  resources: {
    "resource": {
      description: "Resource output",
      schema: ResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    provision: {
      description: "Provision a cloud resource and return its state",
      arguments: InputSchema,
      execute: async (args, context) => {
        const resourceId = "res-" + crypto.randomUUID().slice(0, 8);

        const content = {
          id: resourceId,
          name: args.resourceName,
          region: args.region,
          status: "active",
          endpoint: "https://api.example.com/" + resourceId,
          createdAt: new Date().toISOString(),
        };

        // Use the writeResource API
        if (context.writeResource) {
          const handle = await context.writeResource("resource", "resource", content);
          return { dataHandles: [handle] };
        }

        // Fallback for tests without writeResource
        return { dataHandles: [] };
      },
    },
  },
};
`;

Deno.test("Integration: user model with dataWriter API works", async () => {
  try {
    await withTempDir(async (repoDir) => {
      const modelsDir = await createUserModel(
        repoDir,
        "datawriter_model.ts",
        DATAWRITER_MODEL_CODE,
      );

      const loader = new ExtensionLoader(testDenoRuntime, modelKindAdapter);
      const loadResult = await loader.load(modelsDir);

      if (loadResult.failed.length > 0) {
        console.error("Model load failures:", loadResult.failed);
      }
      assertEquals(
        loadResult.loaded.length,
        1,
        `Should load one model. Failed: ${JSON.stringify(loadResult.failed)}`,
      );
      assertEquals(loadResult.failed.length, 0, "Should have no failures");

      const modelType = ModelType.create("@user/datawriter-model");
      const modelDef = modelRegistry.get(modelType);
      assertEquals(modelDef !== undefined, true, "Model should be registered");

      assertEquals(
        Object.keys(modelDef!.resources ?? {}).length,
        1,
        "Should have one resource spec",
      );
      assertEquals(
        modelDef!.resources!["resource"]?.description,
        "Resource output",
        "Should have resource spec description",
      );
    });
  } finally {
    modelRegistry.invalidateType("@user/datawriter-model");
  }
});

const EXPRESSION_MODEL_CODE = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  value: z.string(),
  count: z.number().default(1),
});

export const model = {
  type: "@user/expression-model",
  version: "2026.02.09.1",
  methods: {
    process: {
      description: "Process with expression support",
      arguments: InputSchema,
      execute: async (_args, _context) => {
        return { dataHandles: [] };
      },
    },
  },
};
`;

Deno.test("Integration: expression-aware validation allows expressions in required fields", async () => {
  try {
    await withTempDir(async (repoDir) => {
      const modelsDir = await createUserModel(
        repoDir,
        "expression_model.ts",
        EXPRESSION_MODEL_CODE,
      );

      const loader = new ExtensionLoader(testDenoRuntime, modelKindAdapter);
      const loadResult = await loader.load(modelsDir);

      if (loadResult.failed.length > 0) {
        console.error("Model load failures:", loadResult.failed);
      }

      const modelType = ModelType.create("@user/expression-model");
      const modelDef = modelRegistry.get(modelType);
      assertEquals(modelDef !== undefined, true, "Model should be registered");

      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const definition = Definition.create({
        name: "test-expression",
        methods: {
          process: {
            arguments: {
              value: "${{ inputs.someValue }}",
              count: "${{ inputs.count }}",
            },
          },
        },
      });

      await definitionRepo.save(modelType, definition);

      const loaded = await definitionRepo.findById(modelType, definition.id);
      assertEquals(loaded !== null, true, "Definition should be loaded");
      assertEquals(
        loaded!.getMethodArguments("process").value,
        "${{ inputs.someValue }}",
        "Expression should be preserved",
      );
    });
  } finally {
    modelRegistry.invalidateType("@user/expression-model");
  }
});
