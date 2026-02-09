/**
 * Integration tests for the simplified return formats (resource and data)
 * and expression-aware validation added in PR #153.
 *
 * Tests verify:
 * 1. User models with `resource` return format work end-to-end
 * 2. User models with `data` return format work end-to-end
 * 3. Expression-aware validation skips schema validation for expression fields
 * 4. Data outputs are correctly stored and retrievable
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { Definition } from "../src/domain/definitions/definition.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { UserModelLoader } from "../src/domain/models/user_model_loader.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { MethodContext } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { getLogger } from "@logtape/logtape";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-simple-return-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Creates a user model file in the extensions/models directory.
 */
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

/**
 * Creates a context for method execution.
 */
function createTestContext(
  repoDir: string,
  modelType: ModelType,
  modelId: string,
): MethodContext {
  return {
    repoDir,
    modelType,
    modelId,
    logger: getLogger(["test"]),
    dataRepository: new FileSystemUnifiedDataRepository(repoDir),
    definitionRepository: new YamlDefinitionRepository(repoDir),
  };
}

// ============================================================================
// Resource Return Format Tests
// ============================================================================

const RESOURCE_MODEL_CODE = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  resourceName: z.string(),
  region: z.string().default("us-west-2"),
});

export const model = {
  type: "test/resource-model",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    provision: {
      description: "Provision a cloud resource and return its state",
      execute: async (definition, _context) => {
        // Simulate provisioning a cloud resource
        const resourceId = "res-" + Date.now().toString(36);

        return {
          resource: {
            attributes: {
              id: resourceId,
              name: definition.attributes.resourceName,
              region: definition.attributes.region,
              status: "active",
              endpoint: "https://api.example.com/" + resourceId,
              createdAt: new Date().toISOString(),
            },
          },
        };
      },
    },
  },
};
`;

Deno.test("Integration: resource return format - full lifecycle", async () => {
  await withTempDir(async (repoDir) => {
    // 1. Create a user model with resource return format
    const modelsDir = await createUserModel(
      repoDir,
      "resource_model.ts",
      RESOURCE_MODEL_CODE,
    );

    // 2. Load the user model
    const loader = new UserModelLoader();
    const loadResult = await loader.loadModels(modelsDir);

    assertEquals(loadResult.loaded.length, 1, "Should load one model");
    assertEquals(loadResult.failed.length, 0, "Should have no failures");

    // 3. Verify model is registered
    const modelType = ModelType.create("test/resource-model");
    const modelDef = modelRegistry.get(modelType);
    assertEquals(modelDef !== undefined, true, "Model should be registered");

    // 4. Create a definition
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = Definition.create({
      name: "my-cloud-resource",
      attributes: {
        resourceName: "production-api",
        region: "eu-west-1",
      },
    });
    await definitionRepo.save(modelType, definition);

    // 5. Execute the provision method
    const context = createTestContext(repoDir, modelType, definition.id);
    const result = await modelDef!.methods.provision.execute(
      definition,
      context,
    );

    // 6. Verify the resource was converted to dataOutputs
    assertEquals(
      result.dataOutputs !== undefined,
      true,
      "Should have dataOutputs",
    );
    assertEquals(result.dataOutputs!.length, 1, "Should have one data output");

    const dataOutput = result.dataOutputs![0];
    assertEquals(dataOutput.name, "resource", "Name should be 'resource'");
    assertEquals(
      dataOutput.metadata.contentType,
      "application/json",
      "Should be JSON content type",
    );
    assertEquals(
      dataOutput.metadata.tags.type,
      "resource",
      "Should have type=resource tag",
    );

    // 7. Verify the content contains the resource attributes
    const content = JSON.parse(new TextDecoder().decode(dataOutput.content));
    assertEquals(content.name, "production-api");
    assertEquals(content.region, "eu-west-1");
    assertEquals(content.status, "active");
    assertStringIncludes(content.endpoint, "https://api.example.com/");
    assertEquals(typeof content.id, "string");
    assertEquals(typeof content.createdAt, "string");

    // Note: model remains in registry but uses unique type name
  });
});

// ============================================================================
// Data Return Format Tests
// ============================================================================

const DATA_MODEL_CODE = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  query: z.string(),
  limit: z.number().default(10),
});

export const model = {
  type: "test/data-model",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    fetch: {
      description: "Fetch data based on query",
      execute: async (definition, _context) => {
        // Simulate a data fetch operation
        const results = [
          { id: 1, value: "first" },
          { id: 2, value: "second" },
          { id: 3, value: "third" },
        ].slice(0, definition.attributes.limit);

        return {
          data: {
            attributes: {
              query: definition.attributes.query,
              results: results,
              totalCount: results.length,
              fetchedAt: new Date().toISOString(),
            },
            name: "query-result",
            tags: { source: "database", format: "json" },
          },
        };
      },
    },
  },
};
`;

Deno.test(
  "Integration: data return format - full lifecycle with custom name and tags",
  async () => {
    await withTempDir(async (repoDir) => {
      // 1. Create a user model with data return format
      const modelsDir = await createUserModel(
        repoDir,
        "data_model.ts",
        DATA_MODEL_CODE,
      );

      // 2. Load the user model
      const loader = new UserModelLoader();
      const loadResult = await loader.loadModels(modelsDir);

      assertEquals(loadResult.loaded.length, 1, "Should load one model");

      // 3. Verify model is registered
      const modelType = ModelType.create("test/data-model");
      const modelDef = modelRegistry.get(modelType);
      assertEquals(modelDef !== undefined, true, "Model should be registered");

      // 4. Create a definition
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const definition = Definition.create({
        name: "my-data-fetch",
        attributes: {
          query: "SELECT * FROM users",
          limit: 2,
        },
      });
      await definitionRepo.save(modelType, definition);

      // 5. Execute the fetch method
      const context = createTestContext(repoDir, modelType, definition.id);
      const result = await modelDef!.methods.fetch.execute(definition, context);

      // 6. Verify the data was converted to dataOutputs
      assertEquals(
        result.dataOutputs !== undefined,
        true,
        "Should have dataOutputs",
      );
      assertEquals(
        result.dataOutputs!.length,
        1,
        "Should have one data output",
      );

      const dataOutput = result.dataOutputs![0];
      assertEquals(
        dataOutput.name,
        "query-result",
        "Name should be custom 'query-result'",
      );
      assertEquals(
        dataOutput.metadata.contentType,
        "application/json",
        "Should be JSON content type",
      );
      assertEquals(
        dataOutput.metadata.tags.source,
        "database",
        "Should have custom source tag",
      );
      assertEquals(
        dataOutput.metadata.tags.format,
        "json",
        "Should have custom format tag",
      );

      // 7. Verify the content
      const content = JSON.parse(new TextDecoder().decode(dataOutput.content));
      assertEquals(content.query, "SELECT * FROM users");
      assertEquals(content.results.length, 2);
      assertEquals(content.totalCount, 2);
      assertEquals(typeof content.fetchedAt, "string");

      // Note: model remains in registry but uses unique type name
    });
  },
);

// ============================================================================
// Expression-Aware Validation Tests
// ============================================================================

const EXPRESSION_MODEL_CODE = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  vpcId: z.string(),
  subnetId: z.string(),
  instanceType: z.string().default("t3.micro"),
});

export const model = {
  type: "test/expression-model",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    deploy: {
      description: "Deploy to VPC and subnet",
      execute: async (definition, _context) => {
        return {
          resource: {
            attributes: {
              vpcId: definition.attributes.vpcId,
              subnetId: definition.attributes.subnetId,
              instanceType: definition.attributes.instanceType,
              deployed: true,
            },
          },
        };
      },
    },
  },
};
`;

Deno.test(
  "Integration: expression-aware validation allows expressions in required fields",
  async () => {
    await withTempDir(async (repoDir) => {
      // 1. Create a user model
      const modelsDir = await createUserModel(
        repoDir,
        "expression_model.ts",
        EXPRESSION_MODEL_CODE,
      );

      // 2. Load the user model
      const loader = new UserModelLoader();
      await loader.loadModels(modelsDir);

      const modelType = ModelType.create("test/expression-model");
      const modelDef = modelRegistry.get(modelType);
      assertEquals(modelDef !== undefined, true, "Model should be registered");

      // 3. Create a definition with expressions in required fields
      // This would have failed validation before PR #153
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const definition = Definition.create({
        name: "my-deployment",
        attributes: {
          // These are expressions that reference other models
          vpcId: "${{ model.my-vpc.resource.attributes.VpcId }}",
          subnetId: "${{ model.my-vpc.resource.attributes.SubnetId }}",
          // Static value for instanceType
          instanceType: "t3.large",
        },
      });

      // 4. Save the definition - this should NOT fail due to expression-aware validation
      await definitionRepo.save(modelType, definition);

      // 5. Verify it was saved
      const saved = await definitionRepo.findByName(modelType, "my-deployment");
      assertEquals(saved !== null, true, "Definition should be saved");
      assertEquals(
        saved!.attributes.vpcId,
        "${{ model.my-vpc.resource.attributes.VpcId }}",
      );

      // Note: model remains in registry but uses unique type name
    });
  },
);

// ============================================================================
// Default Values Test
// ============================================================================

Deno.test(
  "Integration: data format - defaults to 'data' name and type tag when not specified",
  async () => {
    await withTempDir(async (repoDir) => {
      const modelCode = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  input: z.string(),
});

export const model = {
  type: "test/simple-data",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    process: {
      description: "Process input and return data",
      execute: async (definition, _context) => {
        return {
          data: {
            attributes: {
              output: definition.attributes.input.toUpperCase(),
            },
            // No custom name or tags - should use defaults
          },
        };
      },
    },
  },
};
`;

      const modelsDir = await createUserModel(
        repoDir,
        "simple_data.ts",
        modelCode,
      );
      const loader = new UserModelLoader();
      await loader.loadModels(modelsDir);

      const modelType = ModelType.create("test/simple-data");
      const modelDef = modelRegistry.get(modelType);
      assertEquals(modelDef !== undefined, true);

      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const definition = Definition.create({
        name: "default-tags-test",
        attributes: { input: "hello" },
      });
      await definitionRepo.save(modelType, definition);

      const context = createTestContext(repoDir, modelType, definition.id);
      const result = await modelDef!.methods.process.execute(
        definition,
        context,
      );

      // Verify default name and tags
      const dataOutput = result.dataOutputs![0];
      assertEquals(dataOutput.name, "data", "Default name should be 'data'");
      assertEquals(
        dataOutput.metadata.tags.type,
        "data",
        "Default type tag should be 'data'",
      );

      // Verify content
      const content = JSON.parse(new TextDecoder().decode(dataOutput.content));
      assertEquals(content.output, "HELLO");
    });
  },
);

// ============================================================================
// Comparison Test: Old vs New Format
// ============================================================================

const LEGACY_FORMAT_MODEL_CODE = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  value: z.string(),
});

export const model = {
  type: "test/legacy-format",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    run: {
      description: "Run with legacy dataOutputs format",
      execute: async (definition, _context) => {
        // This is the OLD way - explicit dataOutputs
        return {
          dataOutputs: [
            {
              name: "result",
              content: JSON.stringify({
                processed: definition.attributes.value.toUpperCase(),
              }),
              metadata: {
                contentType: "application/json",
                lifetime: "infinite",
                tags: { type: "data" },
              },
            },
          ],
        };
      },
    },
  },
};
`;

const SIMPLE_FORMAT_MODEL_CODE = `
import { z } from "npm:zod@4";

const InputSchema = z.object({
  value: z.string(),
});

export const model = {
  type: "test/simple-format",
  version: 1,
  inputAttributesSchema: InputSchema,
  methods: {
    run: {
      description: "Run with simple data format",
      execute: async (definition, _context) => {
        // This is the NEW way - simple data format
        return {
          data: {
            attributes: {
              processed: definition.attributes.value.toUpperCase(),
            },
            name: "result",
          },
        };
      },
    },
  },
};
`;

Deno.test(
  "Integration: legacy dataOutputs and new data format produce equivalent results",
  async () => {
    await withTempDir(async (repoDir) => {
      // Create both models
      const modelsDir = join(repoDir, "extensions", "models");
      await ensureDir(modelsDir);
      await Deno.writeTextFile(
        join(modelsDir, "legacy.ts"),
        LEGACY_FORMAT_MODEL_CODE,
      );
      await Deno.writeTextFile(
        join(modelsDir, "simple.ts"),
        SIMPLE_FORMAT_MODEL_CODE,
      );

      // Load both models
      const loader = new UserModelLoader();
      const loadResult = await loader.loadModels(modelsDir);
      assertEquals(loadResult.loaded.length, 2, "Should load both models");

      const legacyType = ModelType.create("test/legacy-format");
      const simpleType = ModelType.create("test/simple-format");
      const legacyModel = modelRegistry.get(legacyType);
      const simpleModel = modelRegistry.get(simpleType);

      assertEquals(legacyModel !== undefined, true);
      assertEquals(simpleModel !== undefined, true);

      // Create definitions for both
      const definitionRepo = new YamlDefinitionRepository(repoDir);

      const legacyDef = Definition.create({
        name: "legacy-test",
        attributes: { value: "hello" },
      });
      const simpleDef = Definition.create({
        name: "simple-test",
        attributes: { value: "hello" },
      });

      await definitionRepo.save(legacyType, legacyDef);
      await definitionRepo.save(simpleType, simpleDef);

      // Execute both
      const legacyContext = createTestContext(
        repoDir,
        legacyType,
        legacyDef.id,
      );
      const simpleContext = createTestContext(
        repoDir,
        simpleType,
        simpleDef.id,
      );

      const legacyResult = await legacyModel!.methods.run.execute(
        legacyDef,
        legacyContext,
      );
      const simpleResult = await simpleModel!.methods.run.execute(
        simpleDef,
        simpleContext,
      );

      // Both should produce equivalent dataOutputs
      assertEquals(legacyResult.dataOutputs!.length, 1);
      assertEquals(simpleResult.dataOutputs!.length, 1);

      const legacyOutput = legacyResult.dataOutputs![0];
      const simpleOutput = simpleResult.dataOutputs![0];

      // Same name
      assertEquals(legacyOutput.name, "result");
      assertEquals(simpleOutput.name, "result");

      // Same content type
      assertEquals(legacyOutput.metadata.contentType, "application/json");
      assertEquals(simpleOutput.metadata.contentType, "application/json");

      // Same content
      const legacyContent = JSON.parse(
        new TextDecoder().decode(legacyOutput.content),
      );
      const simpleContent = JSON.parse(
        new TextDecoder().decode(simpleOutput.content),
      );

      assertEquals(legacyContent.processed, "HELLO");
      assertEquals(simpleContent.processed, "HELLO");

      // Note: models remain in registry but use unique type names
    });
  },
);
