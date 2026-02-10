/**
 * Integration tests for CEL expression data access.
 *
 * Tests the full flow:
 * 1. Reference other models by name
 * 2. Access data from other models (latest and specific versions)
 * 3. Access vault secrets via CEL
 * 4. Verify lazy evaluation
 */

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { Data } from "../src/domain/data/data.ts";
import { computeDefinitionHash } from "../src/domain/data/data_metadata.ts";
import type { OwnerDefinition } from "../src/domain/data/data_metadata.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import {
  type DataRecord,
  ModelResolver,
} from "../src/domain/expressions/model_resolver.ts";
import { ExpressionEvaluationService } from "../src/domain/expressions/expression_evaluation_service.ts";
import { CelEvaluator } from "../src/infrastructure/cel/cel_evaluator.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cel-data-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, ".swamp", "definitions"));
  await ensureDir(join(dir, ".swamp", "vault"));
}

async function createOwner(ref: string): Promise<OwnerDefinition> {
  const definitionHash = await computeDefinitionHash("model-method", ref);
  return {
    definitionHash,
    ownerType: "model-method",
    ownerRef: ref,
  };
}

// ============================================================================
// Reference Other Models by Name
// ============================================================================

Deno.test("CEL Data Access: reference model input attributes by name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create source model
    const sourceModel = Definition.create({
      name: "config_model",
      attributes: {
        database_host: "db.example.com",
        database_port: "5432",
        connection_pool_size: 10,
      },
    });
    await definitionRepo.save(type, sourceModel);

    // Create dependent model
    const dependentModel = Definition.create({
      name: "app_model",
      attributes: {
        db_url:
          '${{ "postgres://" + model.config_model.input.attributes.database_host + ":" + model.config_model.input.attributes.database_port }}',
        pool_size:
          "${{ model.config_model.input.attributes.connection_pool_size }}",
      },
    });
    await definitionRepo.save(type, dependentModel);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(
      dependentModel,
      type,
    );

    assertEquals(result.hadExpressions, true);
    assertEquals(
      result.definition.attributes.db_url,
      "postgres://db.example.com:5432",
    );
    assertEquals(result.definition.attributes.pool_size, 10);
  });
});

Deno.test("CEL Data Access: reference model by UUID", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create source model
    const sourceModel = Definition.create({
      name: "source_by_id",
      attributes: {
        value: "accessed-by-id",
      },
    });
    await definitionRepo.save(type, sourceModel);

    // Build context to verify UUID access works
    const modelResolver = new ModelResolver(definitionRepo, { repoDir });
    const context = await modelResolver.buildContext();

    // Model should be accessible by both name and UUID
    assertExists(context.model["source_by_id"]);
    assertExists(context.model[sourceModel.id]);

    // Both should have the same data
    assertEquals(
      context.model["source_by_id"].input.attributes.value,
      "accessed-by-id",
    );
    assertEquals(
      context.model[sourceModel.id].input.attributes.value,
      "accessed-by-id",
    );
  });
});

Deno.test("CEL Data Access: reference hyphenated model name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create model with hyphenated name
    const hyphenModel = Definition.create({
      name: "my-hyphenated-model",
      attributes: {
        vpc_id: "vpc-12345",
      },
    });
    await definitionRepo.save(type, hyphenModel);

    // Build context
    const modelResolver = new ModelResolver(definitionRepo, { repoDir });
    const context = await modelResolver.buildContext();

    // Should be accessible by name
    assertExists(context.model["my-hyphenated-model"]);
    assertEquals(
      context.model["my-hyphenated-model"].input.attributes.vpc_id,
      "vpc-12345",
    );

    // Test CEL evaluation with bracket notation
    const celEvaluator = new CelEvaluator();
    const result = celEvaluator.evaluate(
      'model["my-hyphenated-model"].input.attributes.vpc_id',
      context,
    );
    assertEquals(result, "vpc-12345");
  });
});

// ============================================================================
// Access Data from Other Models
// ============================================================================

Deno.test("CEL Data Access: access latest data via model.X.data.Y", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = await createOwner("test/model:create");

    // Create model
    const sourceModel = Definition.create({
      name: "data_source",
      attributes: {},
    });
    await definitionRepo.save(type, sourceModel);

    // Create data with multiple versions
    const data = Data.create({
      name: "resource_state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    // Write 3 versions
    for (let i = 1; i <= 3; i++) {
      await dataRepo.save(
        type,
        sourceModel.id,
        data,
        new TextEncoder().encode(JSON.stringify({ version: i, id: `id-${i}` })),
      );
    }

    // Build context
    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // Access latest data (single artifact unwrapped)
    const modelData = context.model["data_source"];
    assertExists(modelData);
    assertExists(modelData.data);
    const dataRecord = modelData.data as {
      version: number;
      attributes: Record<string, unknown>;
    };

    // Latest version should be 3
    assertEquals(dataRecord.version, 3);
    assertEquals(dataRecord.attributes.version, 3);
    assertEquals(dataRecord.attributes.id, "id-3");
  });
});

Deno.test("CEL Data Access: access specific version via data.version()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = await createOwner("test/model:version-access");

    // Create model
    const model = Definition.create({
      name: "versioned_model",
      attributes: {},
    });
    await definitionRepo.save(type, model);

    // Create versioned data
    const data = Data.create({
      name: "history",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 100,
      tags: { type: "audit" },
      ownerDefinition: owner,
    });

    // Write 5 versions with different values
    for (let i = 1; i <= 5; i++) {
      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(JSON.stringify({
          step: i,
          value: i * 100,
          timestamp: `2024-01-0${i}T00:00:00Z`,
        })),
      );
    }

    // Build context
    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    assertExists(context.data);

    // Access specific versions
    for (let v = 1; v <= 5; v++) {
      const vData: DataRecord | null = context.data.version(
        "versioned_model",
        "history",
        v,
      );
      assertExists(vData);
      assertEquals(vData.version, v);
      assertEquals(vData.attributes.step, v);
      assertEquals(vData.attributes.value, v * 100);
    }

    // Non-existent version returns null
    const nonexistent = context.data.version("versioned_model", "history", 99);
    assertEquals(nonexistent, null);
  });
});

Deno.test("CEL Data Access: access data via data.latest()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = await createOwner("test/model:latest");

    const model = Definition.create({
      name: "latest_test",
      attributes: {},
    });
    await definitionRepo.save(type, model);

    const data = Data.create({
      name: "current_state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "state" },
      ownerDefinition: owner,
    });

    // Write versions
    for (let i = 1; i <= 4; i++) {
      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(JSON.stringify({ iteration: i })),
      );
    }

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    assertExists(context.data);

    const latest = context.data.latest("latest_test", "current_state");
    assertExists(latest);
    assertEquals(latest.version, 4);
    assertEquals(latest.attributes.iteration, 4);
  });
});

Deno.test("CEL Data Access: list all versions via data.listVersions()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = await createOwner("test/model:list");

    const model = Definition.create({
      name: "list_versions_model",
      attributes: {},
    });
    await definitionRepo.save(type, model);

    const data = Data.create({
      name: "logs",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 100,
      tags: { type: "log" },
      ownerDefinition: owner,
    });

    // Write 7 versions
    for (let i = 1; i <= 7; i++) {
      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(`log entry ${i}`),
      );
    }

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    assertExists(context.data);

    const versions = context.data.listVersions("list_versions_model", "logs");
    assertEquals(versions, [1, 2, 3, 4, 5, 6, 7]);
  });
});

// ============================================================================
// Cross-Model Data References
// ============================================================================

Deno.test("CEL Data Access: reference data from dependent model", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = await createOwner("test/model:cross-ref");

    // Create VPC model with resource data
    const vpcModel = Definition.create({
      name: "my_vpc",
      attributes: { cidr: "10.0.0.0/16" },
    });
    await definitionRepo.save(type, vpcModel);

    // Create VPC resource data
    const vpcData = Data.create({
      name: "resource",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      type,
      vpcModel.id,
      vpcData,
      new TextEncoder().encode(JSON.stringify({
        vpcId: "vpc-12345",
        state: "available",
      })),
    );

    // Create subnet model that references VPC data
    const subnetModel = Definition.create({
      name: "my_subnet",
      attributes: {
        // Reference VPC resource data (single artifact: data is unwrapped)
        vpc_id_ref: "${{ model.my_vpc.data.attributes.vpcId }}",
        vpc_state_ref: "${{ model.my_vpc.data.attributes.state }}",
      },
    });
    await definitionRepo.save(type, subnetModel);

    // Evaluate subnet model
    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { dataRepo },
    );

    const result = await evalService.evaluateDefinition(subnetModel, type);

    assertEquals(result.hadExpressions, true);
    assertEquals(result.definition.attributes.vpc_id_ref, "vpc-12345");
    assertEquals(result.definition.attributes.vpc_state_ref, "available");
  });
});

Deno.test("CEL Data Access: chain data references across multiple models", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = await createOwner("test/model:chain");

    // Model A - base config
    const modelA = Definition.create({
      name: "model_a",
      attributes: { base_value: 100 },
    });
    await definitionRepo.save(type, modelA);

    const dataA = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "output" },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      type,
      modelA.id,
      dataA,
      new TextEncoder().encode(JSON.stringify({ computed: 100 })),
    );

    // Model B - uses A
    const modelB = Definition.create({
      name: "model_b",
      attributes: { multiplier: 2 },
    });
    await definitionRepo.save(type, modelB);

    const dataB = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "output" },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      type,
      modelB.id,
      dataB,
      new TextEncoder().encode(JSON.stringify({ computed: 200 })),
    );

    // Model C - references both A and B data
    const modelC = Definition.create({
      name: "model_c",
      attributes: {
        from_a: "${{ model.model_a.data.attributes.computed }}",
        from_b: "${{ model.model_b.data.attributes.computed }}",
        sum:
          "${{ model.model_a.data.attributes.computed + model.model_b.data.attributes.computed }}",
      },
    });
    await definitionRepo.save(type, modelC);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { dataRepo },
    );

    const result = await evalService.evaluateDefinition(modelC, type);

    assertEquals(result.definition.attributes.from_a, 100);
    assertEquals(result.definition.attributes.from_b, 200);
    assertEquals(result.definition.attributes.sum, 300);
  });
});

// ============================================================================
// Environment Variables in CEL
// ============================================================================

Deno.test("CEL Data Access: access environment variables", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Set test env vars
    Deno.env.set("CEL_TEST_VAR", "test-value");
    Deno.env.set("CEL_TEST_NUMBER", "42");

    try {
      const model = Definition.create({
        name: "env_model",
        attributes: {
          from_env: "${{ env.CEL_TEST_VAR }}",
          number_as_string: "${{ env.CEL_TEST_NUMBER }}",
        },
      });
      await definitionRepo.save(type, model);

      const evalService = new ExpressionEvaluationService(
        definitionRepo,
        repoDir,
      );

      const result = await evalService.evaluateDefinition(model, type);

      assertEquals(result.definition.attributes.from_env, "test-value");
      assertEquals(result.definition.attributes.number_as_string, "42");
    } finally {
      Deno.env.delete("CEL_TEST_VAR");
      Deno.env.delete("CEL_TEST_NUMBER");
    }
  });
});

// ============================================================================
// Complex CEL Expressions
// ============================================================================

Deno.test("CEL Data Access: conditional expressions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const configModel = Definition.create({
      name: "config",
      attributes: {
        environment: "production",
        debug: false,
      },
    });
    await definitionRepo.save(type, configModel);

    const appModel = Definition.create({
      name: "app",
      attributes: {
        log_level:
          '${{ model.config.input.attributes.environment == "production" ? "warn" : "debug" }}',
        verbose: "${{ model.config.input.attributes.debug ? true : false }}",
      },
    });
    await definitionRepo.save(type, appModel);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(appModel, type);

    assertEquals(result.definition.attributes.log_level, "warn");
    assertEquals(result.definition.attributes.verbose, false);
  });
});

Deno.test("CEL Data Access: string concatenation and formatting", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const baseModel = Definition.create({
      name: "base",
      attributes: {
        prefix: "app",
        version: "1.2.3",
        region: "us-east-1",
      },
    });
    await definitionRepo.save(type, baseModel);

    const derivedModel = Definition.create({
      name: "derived",
      attributes: {
        full_name:
          '${{ model.base.input.attributes.prefix + "-" + model.base.input.attributes.version }}',
        resource_arn:
          '${{ "arn:aws:" + model.base.input.attributes.region + ":resource:" + model.base.input.attributes.prefix }}',
      },
    });
    await definitionRepo.save(type, derivedModel);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(derivedModel, type);

    assertEquals(result.definition.attributes.full_name, "app-1.2.3");
    assertEquals(
      result.definition.attributes.resource_arn,
      "arn:aws:us-east-1:resource:app",
    );
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("CEL Data Access: handle missing model gracefully", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);

    // Build context with no models
    const modelResolver = new ModelResolver(definitionRepo, { repoDir });
    const context = await modelResolver.buildContext();

    // Context should have empty model map
    assertEquals(Object.keys(context.model).length, 0);

    // Data functions should handle missing models
    assertExists(context.data);
    const versions = context.data.listVersions("nonexistent", "data");
    assertEquals(versions, []);

    const latest = context.data.latest("nonexistent", "data");
    assertEquals(latest, null);
  });
});

Deno.test("CEL Data Access: handle missing data gracefully", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create model without any data
    const model = Definition.create({
      name: "no_data_model",
      attributes: { value: 1 },
    });
    await definitionRepo.save(type, model);

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // Model exists but has no data
    assertExists(context.model["no_data_model"]);

    // Data namespace functions handle gracefully
    assertExists(context.data);
    const versions = context.data.listVersions("no_data_model", "nonexistent");
    assertEquals(versions, []);

    const latest = context.data.latest("no_data_model", "nonexistent");
    assertEquals(latest, null);
  });
});

Deno.test("CEL Data Access: multiple data items from same model", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = await createOwner("test/model:multi-data");

    const model = Definition.create({
      name: "multi_data_model",
      attributes: {},
    });
    await definitionRepo.save(type, model);

    // Create multiple data items
    const dataItems = ["stdout", "stderr", "exitcode", "timing"];

    for (const name of dataItems) {
      const data = Data.create({
        name,
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: "output" },
        ownerDefinition: owner,
      });

      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(JSON.stringify({ name, value: name.length })),
      );
    }

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    // All data items accessible
    const modelData = context.model["multi_data_model"];
    assertExists(modelData);
    assertExists(modelData.data);

    const dataMap = modelData.data as Record<
      string,
      { attributes: Record<string, unknown> }
    >;
    for (const name of dataItems) {
      assertExists(dataMap[name]);
      assertEquals(dataMap[name].attributes.name, name);
    }
  });
});
