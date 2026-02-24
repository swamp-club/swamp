// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";

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

function createOwner(ref: string): OwnerDefinition {
  return {
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
      globalArguments: {
        database_host: "db.example.com",
        database_port: "5432",
        connection_pool_size: 10,
      },
    });
    await definitionRepo.save(type, sourceModel);

    // Create dependent model
    const dependentModel = Definition.create({
      name: "app_model",
      globalArguments: {
        db_url:
          '${{ "postgres://" + model.config_model.input.globalArguments.database_host + ":" + model.config_model.input.globalArguments.database_port }}',
        pool_size:
          "${{ model.config_model.input.globalArguments.connection_pool_size }}",
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
      result.definition.globalArguments.db_url,
      "postgres://db.example.com:5432",
    );
    assertEquals(result.definition.globalArguments.pool_size, 10);
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
      globalArguments: {
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
      context.model["source_by_id"].input.globalArguments.value,
      "accessed-by-id",
    );
    assertEquals(
      context.model[sourceModel.id].input.globalArguments.value,
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
      globalArguments: {
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
      context.model["my-hyphenated-model"].input.globalArguments.vpc_id,
      "vpc-12345",
    );

    // Test CEL evaluation with bracket notation
    const celEvaluator = new CelEvaluator();
    const result = celEvaluator.evaluate(
      'model["my-hyphenated-model"].input.globalArguments.vpc_id',
      context,
    );
    assertEquals(result, "vpc-12345");
  });
});

// ============================================================================
// Access Data from Other Models
// ============================================================================

Deno.test("CEL Data Access: access latest resource via model.X.resource.specName", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:create");

    // Create model
    const sourceModel = Definition.create({
      name: "data_source",
      globalArguments: {},
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

    // Access latest resource via model.X.resource.specName.instanceName
    const modelData = context.model["data_source"];
    assertExists(modelData);
    assertExists(modelData.resource);
    const resourceInstances = modelData.resource!["resource_state"];
    assertExists(resourceInstances);
    const resourceRecord = resourceInstances["resource_state"];
    assertExists(resourceRecord);

    // Latest version should be 3
    assertEquals(resourceRecord.version, 3);
    assertEquals(resourceRecord.attributes.version, 3);
    assertEquals(resourceRecord.attributes.id, "id-3");
  });
});

Deno.test("CEL Data Access: access specific version via data.version()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:version-access");

    // Create model
    const model = Definition.create({
      name: "versioned_model",
      globalArguments: {},
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
    const owner = createOwner("test/model:latest");

    const model = Definition.create({
      name: "latest_test",
      globalArguments: {},
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
    const owner = createOwner("test/model:list");

    const model = Definition.create({
      name: "list_versions_model",
      globalArguments: {},
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

Deno.test("CEL Data Access: reference resource from dependent model", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:cross-ref");

    // Create VPC model with resource data
    const vpcModel = Definition.create({
      name: "my_vpc",
      globalArguments: { cidr: "10.0.0.0/16" },
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

    // Create subnet model that references VPC resource data via new pattern
    const subnetModel = Definition.create({
      name: "my_subnet",
      globalArguments: {
        // New pattern: model.X.resource.specName.instanceName.attributes.field
        vpc_id_ref:
          "${{ model.my_vpc.resource.resource.resource.attributes.vpcId }}",
        vpc_state_ref:
          "${{ model.my_vpc.resource.resource.resource.attributes.state }}",
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
    assertEquals(result.definition.globalArguments.vpc_id_ref, "vpc-12345");
    assertEquals(result.definition.globalArguments.vpc_state_ref, "available");
  });
});

Deno.test("CEL Data Access: chain data references across multiple models", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:chain");

    // Model A - base config
    const modelA = Definition.create({
      name: "model_a",
      globalArguments: { base_value: 100 },
    });
    await definitionRepo.save(type, modelA);

    const dataA = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
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
      globalArguments: { multiplier: 2 },
    });
    await definitionRepo.save(type, modelB);

    const dataB = Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      type,
      modelB.id,
      dataB,
      new TextEncoder().encode(JSON.stringify({ computed: 200 })),
    );

    // Model C - references both A and B resource data via new pattern
    const modelC = Definition.create({
      name: "model_c",
      globalArguments: {
        from_a:
          "${{ model.model_a.resource.result.result.attributes.computed }}",
        from_b:
          "${{ model.model_b.resource.result.result.attributes.computed }}",
        sum:
          "${{ model.model_a.resource.result.result.attributes.computed + model.model_b.resource.result.result.attributes.computed }}",
      },
    });
    await definitionRepo.save(type, modelC);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { dataRepo },
    );

    const result = await evalService.evaluateDefinition(modelC, type);

    assertEquals(result.definition.globalArguments.from_a, 100);
    assertEquals(result.definition.globalArguments.from_b, 200);
    assertEquals(result.definition.globalArguments.sum, 300);
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
        globalArguments: {
          from_env: "${{ env.CEL_TEST_VAR }}",
          number_as_string: "${{ env.CEL_TEST_NUMBER }}",
        },
      });
      await definitionRepo.save(type, model);

      const evalService = new ExpressionEvaluationService(
        definitionRepo,
        repoDir,
      );

      // evaluateDefinition defers env expressions to runtime (leaves raw)
      const result = await evalService.evaluateDefinition(model, type);

      assertEquals(
        result.definition.globalArguments.from_env,
        "${{ env.CEL_TEST_VAR }}",
      );
      assertEquals(
        result.definition.globalArguments.number_as_string,
        "${{ env.CEL_TEST_NUMBER }}",
      );

      // Resolve runtime expressions (env + vault) — this is the runtime phase
      const resolved = await evalService.resolveRuntimeExpressionsInDefinition(
        result.definition,
      );

      assertEquals(resolved.globalArguments.from_env, "test-value");
      assertEquals(resolved.globalArguments.number_as_string, "42");
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
      globalArguments: {
        environment: "production",
        debug: false,
      },
    });
    await definitionRepo.save(type, configModel);

    const appModel = Definition.create({
      name: "app",
      globalArguments: {
        log_level:
          '${{ model.config.input.globalArguments.environment == "production" ? "warn" : "debug" }}',
        verbose:
          "${{ model.config.input.globalArguments.debug ? true : false }}",
      },
    });
    await definitionRepo.save(type, appModel);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(appModel, type);

    assertEquals(result.definition.globalArguments.log_level, "warn");
    assertEquals(result.definition.globalArguments.verbose, false);
  });
});

Deno.test("CEL Data Access: string concatenation and formatting", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const baseModel = Definition.create({
      name: "base",
      globalArguments: {
        prefix: "app",
        version: "1.2.3",
        region: "us-east-1",
      },
    });
    await definitionRepo.save(type, baseModel);

    const derivedModel = Definition.create({
      name: "derived",
      globalArguments: {
        full_name:
          '${{ model.base.input.globalArguments.prefix + "-" + model.base.input.globalArguments.version }}',
        resource_arn:
          '${{ "arn:aws:" + model.base.input.globalArguments.region + ":resource:" + model.base.input.globalArguments.prefix }}',
      },
    });
    await definitionRepo.save(type, derivedModel);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
    );

    const result = await evalService.evaluateDefinition(derivedModel, type);

    assertEquals(result.definition.globalArguments.full_name, "app-1.2.3");
    assertEquals(
      result.definition.globalArguments.resource_arn,
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
      globalArguments: { value: 1 },
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

Deno.test("CEL Data Access: multiple resource items from same model", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:multi-data");

    const model = Definition.create({
      name: "multi_data_model",
      globalArguments: {},
    });
    await definitionRepo.save(type, model);

    // Create multiple resource data items
    const dataItems = ["stdout", "stderr", "exitcode", "timing"];

    for (const name of dataItems) {
      const data = Data.create({
        name,
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: "resource" },
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

    // All resource items accessible via model.X.resource.specName.instanceName
    const modelData = context.model["multi_data_model"];
    assertExists(modelData);
    assertExists(modelData.resource);

    for (const name of dataItems) {
      assertExists(modelData.resource![name]);
      assertExists(modelData.resource![name][name]);
      assertEquals(modelData.resource![name][name].attributes.name, name);
    }
  });
});

// ============================================================================
// specName != dataName (writeResource pattern)
// ============================================================================

Deno.test(
  "CEL Data Access: cross-model resource with specName != dataName (writeResource pattern)",
  async () => {
    await withTempDir(async (repoDir) => {
      await setupRepoDir(repoDir);
      const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const type = ModelType.create("test/model");
      const owner = createOwner("test/model:spec-name-test");

      // Create "s3-infra" model
      const s3InfraModel = Definition.create({
        name: "s3-infra",
        globalArguments: {},
      });
      await definitionRepo.save(type, s3InfraModel);

      // Write resource data with specName="summary", dataName="latest"
      // This mirrors what writeResource("summary", "latest", data) produces:
      //   tags.type = "resource", tags.specName = "summary", data.name = "latest"
      const resourceData = Data.create({
        name: "latest",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: "resource", specName: "summary" },
        ownerDefinition: owner,
      });
      await dataRepo.save(
        type,
        s3InfraModel.id,
        resourceData,
        new TextEncoder().encode(JSON.stringify({ totalBuckets: 42 })),
      );

      // Create "s3-report" model referencing model.s3-infra.resource.summary.latest
      const s3ReportModel = Definition.create({
        name: "s3-report",
        globalArguments: {
          bucket_count:
            "${{ model['s3-infra'].resource.summary.latest.attributes.totalBuckets }}",
        },
      });
      await definitionRepo.save(type, s3ReportModel);

      const evalService = new ExpressionEvaluationService(
        definitionRepo,
        repoDir,
        { dataRepo },
      );

      const result = await evalService.evaluateDefinition(s3ReportModel, type);

      assertEquals(result.hadExpressions, true);
      assertEquals(result.definition.globalArguments.bucket_count, 42);
    });
  },
);

Deno.test(
  "CLI: model evaluate resolves cross-model resource expressions (standalone, specName != dataName)",
  async () => {
    await withTempDir(async (repoDir) => {
      await initializeTestRepo(repoDir);
      const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const type = ModelType.create("test/model");
      const owner = createOwner("test/model:cli-spec-name-test");

      // Create "infra" model with resource data: specName="report", dataName="current"
      const infraModel = Definition.create({
        name: "infra",
        globalArguments: {},
      });
      await definitionRepo.save(type, infraModel);

      const resourceData = Data.create({
        name: "current",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: "resource", specName: "report" },
        ownerDefinition: owner,
      });
      await dataRepo.save(
        type,
        infraModel.id,
        resourceData,
        new TextEncoder().encode(JSON.stringify({ instanceCount: 7 })),
      );

      // Create "app" model referencing the infra resource
      const appModel = Definition.create({
        name: "app",
        globalArguments: {
          count:
            "${{ model.infra.resource.report.current.attributes.instanceCount }}",
        },
      });
      await definitionRepo.save(type, appModel);

      // Run model evaluate via CLI
      const { stdout, stderr, code } = await runCliCommand(
        ["--json", "model", "evaluate", "app", "--repo-dir", repoDir],
        Deno.cwd(),
      );

      assertEquals(
        code,
        0,
        `CLI exited with code ${code}. stdout: ${stdout} stderr: ${stderr}`,
      );
      const parsed = JSON.parse(stdout);
      assertEquals(parsed.globalArguments.count, 7);
    });
  },
);

// ============================================================================
// Cross-Model Type Resource References (Issue #370)
// ============================================================================

Deno.test("CEL Data Access: cross-type resource with specName tag via ExpressionEvaluationService (#370)", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const owner = createOwner("user/s3-inventory:create");

    // Two distinct model types — mirrors the real-world scenario from issue #370
    // Uses @-prefixed types as in the actual user report
    const inventoryType = ModelType.create("@user/s3-inventory");
    const reportType = ModelType.create("@user/s3-report");

    // Source model under inventory type — uses hyphenated name like issue #370
    const sourceModel = Definition.create({
      name: "s3-infra",
      globalArguments: { region: "us-east-1" },
    });
    await definitionRepo.save(inventoryType, sourceModel);

    // Write resource data the way createResourceWriter does:
    //   name = "latest" (instance name), specName tag = "summary"
    const resourceData = Data.create({
      name: "latest",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource", specName: "summary" },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      inventoryType,
      sourceModel.id,
      resourceData,
      new TextEncoder().encode(JSON.stringify({ totalBuckets: 42 })),
    );

    // Dependent model under a *different* type referencing the source's resource
    // Uses bracket notation for hyphenated name, matching the error from issue #370:
    //   model["s3-infra"].resource.summary.latest.attributes.totalBuckets
    const reportModel = Definition.create({
      name: "s3-report",
      globalArguments: {
        bucket_count:
          '${{ model["s3-infra"].resource.summary.latest.attributes.totalBuckets }}',
      },
    });
    await definitionRepo.save(reportType, reportModel);

    // Evaluate via ExpressionEvaluationService — the code path used by
    // `swamp model method run` and `swamp model evaluate`
    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { dataRepo },
    );

    const result = await evalService.evaluateDefinition(
      reportModel,
      reportType,
    );

    assertEquals(result.hadExpressions, true);
    assertEquals(result.definition.globalArguments.bucket_count, 42);
  });
});

Deno.test("CEL Data Access: resource resolves after model delete and recreate with new UUID (#370)", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const inventoryType = ModelType.create("@user/s3-inventory");
    const reportType = ModelType.create("@user/s3-report");
    const owner = createOwner("user/s3-inventory:create");

    // Step 1: Create source model and save resource data under its UUID
    const originalModel = Definition.create({
      name: "s3-infra",
      globalArguments: { region: "us-east-1" },
    });
    await definitionRepo.save(inventoryType, originalModel);

    const resourceData = Data.create({
      name: "latest",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource", specName: "summary", modelName: "s3-infra" },
      ownerDefinition: owner,
    });

    await dataRepo.save(
      inventoryType,
      originalModel.id,
      resourceData,
      new TextEncoder().encode(JSON.stringify({ totalBuckets: 42 })),
    );

    // Step 2: Delete the definition and recreate with a NEW UUID
    // (simulates `swamp model delete` + `swamp model create`)
    await definitionRepo.delete(inventoryType, originalModel.id);
    const recreatedModel = Definition.create({
      name: "s3-infra",
      globalArguments: { region: "us-east-1" },
    });
    await definitionRepo.save(inventoryType, recreatedModel);

    // Sanity check: the UUIDs are different
    const uuidsDiffer = originalModel.id !== recreatedModel.id;
    assertEquals(uuidsDiffer, true);

    // Step 3: Create dependent model referencing the source's resource
    const reportModel = Definition.create({
      name: "s3-report",
      globalArguments: {
        bucket_count:
          '${{ model["s3-infra"].resource.summary.latest.attributes.totalBuckets }}',
      },
    });
    await definitionRepo.save(reportType, reportModel);

    // Step 4: Evaluate — this used to fail with "No such key: resource"
    // because data lived under the old UUID and the new UUID had no data.
    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { dataRepo },
    );

    const result = await evalService.evaluateDefinition(
      reportModel,
      reportType,
    );

    assertEquals(result.hadExpressions, true);
    assertEquals(result.definition.globalArguments.bucket_count, 42);
  });
});
