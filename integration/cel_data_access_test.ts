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

import { RunSensitiveValues } from "../src/domain/secrets/mod.ts";
import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
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
import {
  collectAuthoredExpressions,
  ExpressionEvaluationService,
} from "../src/domain/expressions/expression_evaluation_service.ts";
import { CelEvaluator } from "../src/infrastructure/cel/cel_evaluator.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { SENSITIVE_FIELDS_TAG } from "../src/domain/models/data_writer.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import {
  createEphemeralStore,
  wrapWithEphemeral,
} from "../src/infrastructure/persistence/ephemeral_store.ts";
import {
  assertPathEquals,
  withMockedEnv,
} from "../src/infrastructure/persistence/path_test_helpers.ts";
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cel-data-" });
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

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, "models"));
  await ensureDir(join(dir, "vaults"));
}

function createOwner(ref: string): OwnerDefinition {
  return {
    ownerType: "model-method",
    ownerRef: ref,
  };
}

Deno.test("CEL Data Access: reference model input attributes by name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const sourceModel = Definition.create({
      name: "config_model",
      globalArguments: {
        database_host: "db.example.com",
        database_port: "5432",
        connection_pool_size: 10,
      },
    });
    await definitionRepo.save(type, sourceModel);

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
      new RunSensitiveValues(),
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

    const sourceModel = Definition.create({
      name: "source_by_id",
      globalArguments: {
        value: "accessed-by-id",
      },
    });
    await definitionRepo.save(type, sourceModel);

    const modelResolver = new ModelResolver(definitionRepo, { repoDir });
    const context = await modelResolver.buildContext(new RunSensitiveValues());

    assertExists(context.model["source_by_id"]);
    assertExists(context.model[sourceModel.id]);

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

    const hyphenModel = Definition.create({
      name: "my-hyphenated-model",
      globalArguments: {
        vpc_id: "vpc-12345",
      },
    });
    await definitionRepo.save(type, hyphenModel);

    const modelResolver = new ModelResolver(definitionRepo, { repoDir });
    const context = await modelResolver.buildContext(new RunSensitiveValues());

    assertExists(context.model["my-hyphenated-model"]);
    assertEquals(
      context.model["my-hyphenated-model"].input.globalArguments.vpc_id,
      "vpc-12345",
    );

    const celEvaluator = new CelEvaluator();
    const result = celEvaluator.evaluate(
      'model["my-hyphenated-model"].input.globalArguments.vpc_id',
      context,
    );
    assertEquals(result, "vpc-12345");
  });
});

Deno.test("CEL Data Access: access latest resource via model.X.resource.specName", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:create");

    const sourceModel = Definition.create({
      name: "data_source",
      globalArguments: {},
    });
    await definitionRepo.save(type, sourceModel);

    const data = Data.create({
      name: "resource_state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 3; i++) {
      await dataRepo.save(
        type,
        sourceModel.id,
        data,
        new TextEncoder().encode(JSON.stringify({ version: i, id: `id-${i}` })),
      );
    }

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext(new RunSensitiveValues());

    const modelData = context.model["data_source"];
    assertExists(modelData);
    assertExists(modelData.resource);
    const resourceInstances = modelData.resource!["resource_state"];
    assertExists(resourceInstances);
    const resourceRecord = resourceInstances["resource_state"];
    assertExists(resourceRecord);

    assertEquals(resourceRecord.version, 3);
    assertEquals(resourceRecord.attributes.version, 3);
    assertEquals(resourceRecord.attributes.id, "id-3");
  });
});

Deno.test("CEL Data Access: access specific version via data.version()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:version-access");

    const model = Definition.create({
      name: "versioned_model",
      globalArguments: {},
    });
    await definitionRepo.save(type, model);

    const data = Data.create({
      name: "history",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 100,
      tags: { type: "audit", modelName: "versioned_model" },
      ownerDefinition: owner,
    });

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

    const dqs = new DataQueryService(catalog, dataRepo);
    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const context = await modelResolver.buildContext(new RunSensitiveValues());

    assertExists(context.data);

    for (let v = 1; v <= 5; v++) {
      const vData: DataRecord | null = await context.data.version(
        "versioned_model",
        "history",
        v,
      );
      assertExists(vData);
      assertEquals(vData.version, v);
      assertEquals(vData.attributes.step, v);
      assertEquals(vData.attributes.value, v * 100);
    }

    const nonexistent = await context.data.version(
      "versioned_model",
      "history",
      99,
    );
    assertEquals(nonexistent, null);
  });
});

Deno.test("CEL Data Access: access data via data.latest()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
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
      tags: { type: "state", modelName: "latest_test" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 4; i++) {
      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(JSON.stringify({ iteration: i })),
      );
    }

    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    try {
      const modelResolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      const context = await modelResolver.buildContext(
        new RunSensitiveValues(),
      );

      assertExists(context.data);

      const latest = await context.data.latest("latest_test", "current_state");
      assertExists(latest);
      assertEquals(latest.version, 4);
      assertEquals(latest.attributes.iteration, 4);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("CEL Data Access: list all versions via data.listVersions()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
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
      tags: { type: "log", modelName: "list_versions_model" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 7; i++) {
      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(`log entry ${i}`),
      );
    }

    const dqs = new DataQueryService(catalog, dataRepo);
    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
    });
    const context = await modelResolver.buildContext(new RunSensitiveValues());

    assertExists(context.data);

    const versions = context.data.listVersions("list_versions_model", "logs");
    assertEquals(versions, [1, 2, 3, 4, 5, 6, 7]);
  });
});

Deno.test("CEL Data Access: reference resource from dependent model", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:cross-ref");

    const vpcModel = Definition.create({
      name: "my_vpc",
      globalArguments: { cidr: "10.0.0.0/16" },
    });
    await definitionRepo.save(type, vpcModel);

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

    const subnetModel = Definition.create({
      name: "my_subnet",
      globalArguments: {
        vpc_id_ref:
          "${{ model.my_vpc.resource.resource.resource.attributes.vpcId }}",
        vpc_state_ref:
          "${{ model.my_vpc.resource.resource.resource.attributes.state }}",
      },
    });
    await definitionRepo.save(type, subnetModel);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { dataRepo },
    );

    const result = await evalService.evaluateDefinition(
      subnetModel,
      type,
      new RunSensitiveValues(),
    );

    assertEquals(result.hadExpressions, true);
    assertEquals(result.definition.globalArguments.vpc_id_ref, "vpc-12345");
    assertEquals(result.definition.globalArguments.vpc_state_ref, "available");
  });
});

Deno.test("CEL Data Access: chain data references across multiple models", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:chain");

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

    const result = await evalService.evaluateDefinition(
      modelC,
      type,
      new RunSensitiveValues(),
    );

    assertEquals(result.definition.globalArguments.from_a, 100);
    assertEquals(result.definition.globalArguments.from_b, 200);
    assertEquals(result.definition.globalArguments.sum, 300);
  });
});

Deno.test("CEL Data Access: access environment variables", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    await withMockedEnv(
      { CEL_TEST_VAR: "test-value", CEL_TEST_NUMBER: "42" },
      async () => {
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
        const result = await evalService.evaluateDefinition(
          model,
          type,
          new RunSensitiveValues(),
        );

        assertEquals(
          result.definition.globalArguments.from_env,
          "${{ env.CEL_TEST_VAR }}",
        );
        assertEquals(
          result.definition.globalArguments.number_as_string,
          "${{ env.CEL_TEST_NUMBER }}",
        );

        const runtimeResult = await evalService
          .resolveRuntimeExpressionsInDefinition(
            result.definition,
            undefined,
            undefined,
            collectAuthoredExpressions(model.toData()),
          );

        assertEquals(
          runtimeResult.definition.globalArguments.from_env,
          "test-value",
        );
        assertEquals(
          runtimeResult.definition.globalArguments.number_as_string,
          "42",
        );
      },
    );
  });
});

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

    const result = await evalService.evaluateDefinition(
      appModel,
      type,
      new RunSensitiveValues(),
    );

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

    const result = await evalService.evaluateDefinition(
      derivedModel,
      type,
      new RunSensitiveValues(),
    );

    assertEquals(result.definition.globalArguments.full_name, "app-1.2.3");
    assertEquals(
      result.definition.globalArguments.resource_arn,
      "arn:aws:us-east-1:resource:app",
    );
  });
});

Deno.test("CEL Data Access: handle missing model gracefully", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);

    const modelResolver = new ModelResolver(definitionRepo, { repoDir });
    const context = await modelResolver.buildContext(new RunSensitiveValues());

    assertEquals(Object.keys(context.model).length, 0);

    assertExists(context.data);
    const versions = context.data.listVersions("nonexistent", "data");
    assertEquals(versions, []);

    const latest = await context.data.latest("nonexistent", "data");
    assertEquals(latest, null);
  });
});

Deno.test("CEL Data Access: handle missing data gracefully", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const model = Definition.create({
      name: "no_data_model",
      globalArguments: { value: 1 },
    });
    await definitionRepo.save(type, model);

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext(new RunSensitiveValues());

    assertExists(context.model["no_data_model"]);

    assertExists(context.data);
    const versions = context.data.listVersions("no_data_model", "nonexistent");
    assertEquals(versions, []);

    const latest = await context.data.latest("no_data_model", "nonexistent");
    assertEquals(latest, null);
  });
});

Deno.test("CEL Data Access: multiple resource items from same model", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:multi-data");

    const model = Definition.create({
      name: "multi_data_model",
      globalArguments: {},
    });
    await definitionRepo.save(type, model);

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
    const context = await modelResolver.buildContext(new RunSensitiveValues());

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

Deno.test(
  "CEL Data Access: cross-model resource with specName != dataName (writeResource pattern)",
  async () => {
    await withTempDir(async (repoDir) => {
      await setupRepoDir(repoDir);
      const dataRepo = new FileSystemUnifiedDataRepository(
        repoDir,
        undefined,
        new CatalogStore(join(repoDir, "_catalog.db")),
      );
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const type = ModelType.create("test/model");
      const owner = createOwner("test/model:spec-name-test");

      const s3InfraModel = Definition.create({
        name: "s3-infra",
        globalArguments: {},
      });
      await definitionRepo.save(type, s3InfraModel);

      const resourceData = Data.create({
        name: "current",
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

      const s3ReportModel = Definition.create({
        name: "s3-report",
        globalArguments: {
          bucket_count:
            "${{ model['s3-infra'].resource.summary.current.attributes.totalBuckets }}",
        },
      });
      await definitionRepo.save(type, s3ReportModel);

      const evalService = new ExpressionEvaluationService(
        definitionRepo,
        repoDir,
        { dataRepo },
      );

      const result = await evalService.evaluateDefinition(
        s3ReportModel,
        type,
        new RunSensitiveValues(),
      );

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
      const dataRepo = new FileSystemUnifiedDataRepository(
        repoDir,
        undefined,
        new CatalogStore(join(repoDir, "_catalog.db")),
      );
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const type = ModelType.create("test/model");
      const owner = createOwner("test/model:cli-spec-name-test");

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

      const appModel = Definition.create({
        name: "app",
        globalArguments: {
          count:
            "${{ model.infra.resource.report.current.attributes.instanceCount }}",
        },
      });
      await definitionRepo.save(type, appModel);

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

Deno.test("CEL Data Access: cross-type resource with specName tag via ExpressionEvaluationService (#370)", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const owner = createOwner("user/s3-inventory:create");

    const inventoryType = ModelType.create("@user/s3-inventory");
    const reportType = ModelType.create("@user/s3-report");

    const sourceModel = Definition.create({
      name: "s3-infra",
      globalArguments: { region: "us-east-1" },
    });
    await definitionRepo.save(inventoryType, sourceModel);

    const resourceData = Data.create({
      name: "current",
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

    const reportModel = Definition.create({
      name: "s3-report",
      globalArguments: {
        bucket_count:
          '${{ model["s3-infra"].resource.summary.current.attributes.totalBuckets }}',
      },
    });
    await definitionRepo.save(reportType, reportModel);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { dataRepo },
    );

    const result = await evalService.evaluateDefinition(
      reportModel,
      reportType,
      new RunSensitiveValues(),
    );

    assertEquals(result.hadExpressions, true);
    assertEquals(result.definition.globalArguments.bucket_count, 42);
  });
});

Deno.test("CEL Data Access: resource resolves after model delete and recreate with new UUID (#370)", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const inventoryType = ModelType.create("@user/s3-inventory");
    const reportType = ModelType.create("@user/s3-report");
    const owner = createOwner("user/s3-inventory:create");

    const originalModel = Definition.create({
      name: "s3-infra",
      globalArguments: { region: "us-east-1" },
    });
    await definitionRepo.save(inventoryType, originalModel);

    const resourceData = Data.create({
      name: "current",
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

    await definitionRepo.delete(inventoryType, originalModel.id);
    const recreatedModel = Definition.create({
      name: "s3-infra",
      globalArguments: { region: "us-east-1" },
    });
    await definitionRepo.save(inventoryType, recreatedModel);

    const uuidsDiffer = originalModel.id !== recreatedModel.id;
    assertEquals(uuidsDiffer, true);

    const reportModel = Definition.create({
      name: "s3-report",
      globalArguments: {
        bucket_count:
          '${{ model["s3-infra"].resource.summary.current.attributes.totalBuckets }}',
      },
    });
    await definitionRepo.save(reportType, reportModel);

    const evalService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { dataRepo },
    );

    const result = await evalService.evaluateDefinition(
      reportModel,
      reportType,
      new RunSensitiveValues(),
    );

    assertEquals(result.hadExpressions, true);
    assertEquals(result.definition.globalArguments.bucket_count, 42);
  });
});

Deno.test("CEL Data Access: data.latest() sees data written after buildContext()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:fresh-data");

    const model = Definition.create({
      name: "fresh_data_model",
      globalArguments: {},
    });
    await definitionRepo.save(type, model);

    const data = Data.create({
      name: "live_state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: "fresh_data_model" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ step: 1 })),
    );

    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    try {
      const modelResolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      const context = await modelResolver.buildContext(
        new RunSensitiveValues(),
      );

      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(JSON.stringify({ step: 2, fresh: true })),
      );

      catalog.invalidate();

      assertExists(context.data);
      const latest = await context.data.latest(
        "fresh_data_model",
        "live_state",
      );
      assertExists(latest);
      assertEquals(latest.version, 2);
      assertEquals(latest.attributes.step, 2);
      assertEquals(latest.attributes.fresh, true);
    } finally {
      catalog.close();
    }
  });
});

/**
 * a plain string field holding ${{ env.X }} text, read via data.latest() and
 * spliced in by the CEL pass, must be left alone by the runtime pass; env has
 * no redaction, so a gate failure shows plaintext
 */
Deno.test("CEL Data Access: env expression injected through data.latest() is not resolved", async () => {
  await withMockedEnv(
    { SWAMP_TEST_2172_SECRET: "leaked-plaintext" },
    async () => {
      await withTempDir(async (repoDir) => {
        await setupRepoDir(repoDir);

        const dataRepo = new FileSystemUnifiedDataRepository(
          repoDir,
          undefined,
          new CatalogStore(join(repoDir, "_catalog.db")),
        );
        const definitionRepo = new YamlDefinitionRepository(repoDir);
        const type = ModelType.create("test/model");
        const owner = createOwner("test/model:injector");

        const producer = Definition.create({
          name: "injector",
          globalArguments: {},
        });
        await definitionRepo.save(type, producer);

        const data = Data.create({
          name: "notes",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "state", modelName: "injector" },
          ownerDefinition: owner,
        });

        // attacker-controlled text in a field with no sensitive marking, so the
        // read-side gate passes it through as literal text
        await dataRepo.save(
          type,
          producer.id,
          data,
          new TextEncoder().encode(
            JSON.stringify({ body: "${{ env.SWAMP_TEST_2172_SECRET }}" }),
          ),
        );

        const consumer = Definition.create({
          name: "consumer",
          globalArguments: {
            run: '${{ data.latest("injector", "notes").attributes.body }}',
          },
        });
        await definitionRepo.save(type, consumer);

        const catalog = new CatalogStore(
          join(repoDir, ".swamp", "data", "_catalog.db"),
        );
        const dqs = new DataQueryService(catalog, dataRepo);
        await dqs.query('name == ""');
        try {
          const evalService = new ExpressionEvaluationService(
            definitionRepo,
            repoDir,
            { dataRepo, dataQueryService: dqs },
          );

          // Provenance is taken from the source definition, before CEL runs:
          // the author's data.latest() reference is in it, the env text is not.
          const authored = collectAuthoredExpressions(consumer.toData());
          assertEquals(authored.size, 1);
          assertEquals(
            authored.has("${{ env.SWAMP_TEST_2172_SECRET }}"),
            false,
          );

          const evaluated = await evalService.evaluateDefinition(
            consumer,
            type,
            new RunSensitiveValues(),
          );

          // The CEL pass really did splice the attacker's text into the tree —
          // without this the test would pass for the wrong reason.
          assertEquals(
            evaluated.definition.globalArguments.run,
            "${{ env.SWAMP_TEST_2172_SECRET }}",
          );

          const runtimeResult = await evalService
            .resolveRuntimeExpressionsInDefinition(
              evaluated.definition,
              undefined,
              undefined,
              authored,
            );

          assertEquals(
            runtimeResult.definition.globalArguments.run,
            "${{ env.SWAMP_TEST_2172_SECRET }}",
          );
          assertEquals(
            JSON.stringify(runtimeResult.definition.globalArguments).includes(
              "leaked-plaintext",
            ),
            false,
          );
        } finally {
          catalog.close();
        }
      });
    },
  );
});

/**
 * the positive half: an author-written runtime expression still resolves after
 * a CEL pass substitutes data around it, so the gate cannot pass by resolving
 * nothing
 */
Deno.test("CEL Data Access: authored env expression still resolves alongside substituted data", async () => {
  await withMockedEnv(
    { SWAMP_TEST_2172_AUTHORED: "authored-value" },
    async () => {
      await withTempDir(async (repoDir) => {
        await setupRepoDir(repoDir);

        const dataRepo = new FileSystemUnifiedDataRepository(
          repoDir,
          undefined,
          new CatalogStore(join(repoDir, "_catalog.db")),
        );
        const definitionRepo = new YamlDefinitionRepository(repoDir);
        const type = ModelType.create("test/model");
        const owner = createOwner("test/model:producer");

        const producer = Definition.create({
          name: "producer",
          globalArguments: {},
        });
        await definitionRepo.save(type, producer);

        const data = Data.create({
          name: "notes",
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "state", modelName: "producer" },
          ownerDefinition: owner,
        });
        await dataRepo.save(
          type,
          producer.id,
          data,
          new TextEncoder().encode(JSON.stringify({ body: "plain text" })),
        );

        const consumer = Definition.create({
          name: "authored_consumer",
          globalArguments: {
            fromData: '${{ data.latest("producer", "notes").attributes.body }}',
            fromEnv: "${{ env.SWAMP_TEST_2172_AUTHORED }}",
          },
        });
        await definitionRepo.save(type, consumer);

        const catalog = new CatalogStore(
          join(repoDir, ".swamp", "data", "_catalog.db"),
        );
        const dqs = new DataQueryService(catalog, dataRepo);
        await dqs.query('name == ""');
        try {
          const evalService = new ExpressionEvaluationService(
            definitionRepo,
            repoDir,
            { dataRepo, dataQueryService: dqs },
          );

          const authored = collectAuthoredExpressions(consumer.toData());
          const evaluated = await evalService.evaluateDefinition(
            consumer,
            type,
            new RunSensitiveValues(),
          );
          const runtimeResult = await evalService
            .resolveRuntimeExpressionsInDefinition(
              evaluated.definition,
              undefined,
              undefined,
              authored,
            );

          assertEquals(
            runtimeResult.definition.globalArguments.fromData,
            "plain text",
          );
          assertEquals(
            runtimeResult.definition.globalArguments.fromEnv,
            "authored-value",
          );
        } finally {
          catalog.close();
        }
      });
    },
  );
});

/**
 * the injected text is a data.latest() call naming a sensitive field, which the
 * read path resolves via the vault; only the step-input gate stops it, asserted
 * on vault call count, with an unrestricted control
 */
Deno.test("CEL Data Access: data.latest() on a sensitive field injected through a plain field never reads the vault", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const vaultService = new VaultService();
    vaultService.registerVault({ name: "v", type: "mock", config: {} });
    let vaultReads = 0;
    const originalGet = vaultService.get.bind(vaultService);
    vaultService.get = (vaultName, secretKey, callerContext) => {
      vaultReads++;
      return originalGet(vaultName, secretKey, callerContext);
    };

    // a sensitive-tagged field holding a vault reference, which the read path
    // resolves on access
    const victim = Definition.create({ name: "victim", globalArguments: {} });
    await definitionRepo.save(type, victim);
    await dataRepo.save(
      type,
      victim.id,
      Data.create({
        name: "creds",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: {
          type: "state",
          modelName: "victim",
          [SENSITIVE_FIELDS_TAG]: JSON.stringify(["token"]),
        },
        ownerDefinition: createOwner("test/model:victim"),
      }),
      new TextEncoder().encode(
        JSON.stringify({ token: "${{ vault.get('v', 'demo-api-key') }}" }),
      ),
    );

    const injected = "${{ data.latest('victim', 'creds').attributes.token }}";
    const injector = Definition.create({
      name: "injector",
      globalArguments: {},
    });
    await definitionRepo.save(type, injector);
    await dataRepo.save(
      type,
      injector.id,
      Data.create({
        name: "notes",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "state", modelName: "injector" },
        ownerDefinition: createOwner("test/model:injector"),
      }),
      new TextEncoder().encode(JSON.stringify({ body: injected })),
    );

    const consumer = Definition.create({
      name: "consumer",
      globalArguments: {
        run: '${{ data.latest("injector", "notes").attributes.body }}',
      },
    });
    await definitionRepo.save(type, consumer);

    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    try {
      const repos = { dataRepo, dataQueryService: dqs, vaultService };
      const evalService = new ExpressionEvaluationService(
        definitionRepo,
        repoDir,
        repos,
      );
      const authored = collectAuthoredExpressions(consumer.toData());

      // Pass 1 splices the attacker's text in, touching no vault.
      const evaluated = await evalService.evaluateDefinition(
        consumer,
        type,
        new RunSensitiveValues(),
      );
      assertEquals(evaluated.definition.globalArguments.run, injected);
      assertEquals(vaultReads, 0);

      // Pass 2, gated: the spliced text is left alone and the vault stays cold.
      const controlValues = new RunSensitiveValues();
      const ctx = await new ModelResolver(definitionRepo, { repoDir, ...repos })
        .buildContext(controlValues);
      const gated = await evalService.evaluateData(
        evaluated.definition.globalArguments,
        ctx,
        authored,
      ) as { run: string };
      assertEquals(gated.run, injected);
      assertEquals(vaultReads, 0);

      // Control: the authored read produces a reference that loads at delivery.
      const open = await evalService.evaluateData(
        evaluated.definition.globalArguments,
        ctx,
        "unrestricted",
      ) as { run: string };
      assertEquals(open.run.startsWith("__SWAMP_VSEC_"), true);
      assertEquals(vaultReads, 0);
      const loaded = await evalService.secretLoader(undefined).load(
        new VaultSecretBag(controlValues.sentinels),
        open,
      );
      assertEquals(loaded.resolveRaw(open.run), "super-secret-api-key-12345");
      assertEquals(vaultReads, 1);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("CEL Data Access: data.latest().path matches the deprecated model.*.file path", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:path");

    const model = Definition.create({ name: "r-lab", globalArguments: {} });
    await definitionRepo.save(type, model);

    const csv = "a,b\n1,2\n";
    await dataRepo.save(
      type,
      model.id,
      Data.create({
        name: "table",
        contentType: "text/csv",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "file", specName: "table", modelName: "r-lab" },
        ownerDefinition: owner,
      }),
      new TextEncoder().encode(csv),
    );
    await dataRepo.save(
      type,
      model.id,
      Data.create({
        name: "summary",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource", specName: "summary", modelName: "r-lab" },
        ownerDefinition: owner,
      }),
      new TextEncoder().encode(JSON.stringify({ rows: 1 })),
    );

    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    try {
      const resolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      const context = await resolver.buildContext(new RunSensitiveValues());
      assertExists(context.data);

      const deprecated = (context.model["r-lab"].file as Record<
        string,
        Record<string, { path: string }>
      >)["table"]["table"].path;

      const latest = await context.data.latest("r-lab", "table");
      assertExists(latest);
      assertPathEquals(latest.path, deprecated);
      assertEquals(await Deno.readTextFile(latest.path), csv);

      const pinned = await context.data.version("r-lab", "table", 1);
      assertPathEquals(pinned!.path, deprecated);

      const projected = await context.data.query(
        'modelName == "r-lab" && name == "table"',
        "path",
      );
      assertEquals(projected.length, 1);
      assertPathEquals(projected[0] as string, deprecated);

      const summary = await context.data.latest("r-lab", "summary");
      assertEquals(
        JSON.parse(await Deno.readTextFile(summary!.path)),
        { rows: 1 },
      );

      // Callers that do not opt in — swamp data query, the serve API and
      // remote workers — never see the host path, even under select.
      const plain = await dqs.query('modelName == "r-lab"') as DataRecord[];
      assertEquals(plain.map((r) => r.path), ["", ""]);
      const plainProjection = await dqs.query(
        'modelName == "r-lab"',
        { select: "path" },
      );
      assertEquals(plainProjection, ["", ""]);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("CEL Data Access: data.latest().path is empty for ephemeral data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const persistentRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const ephemeral = createEphemeralStore();
    try {
      const { dataRepo, dataQueryService } = wrapWithEphemeral(
        persistentRepo,
        catalog,
        ephemeral,
      );
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const type = ModelType.create("test/model");
      const model = Definition.create({ name: "scratch" });
      await definitionRepo.save(type, model);
      await dataRepo.save(
        type,
        model.id,
        Data.create({
          name: "notes",
          contentType: "text/plain",
          lifetime: "ephemeral",
          garbageCollection: 10,
          tags: { type: "file", specName: "notes", modelName: "scratch" },
          ownerDefinition: createOwner("test/model:ephemeral"),
        }),
        new TextEncoder().encode("in memory only"),
      );

      const resolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService,
      });
      for (
        const context of [
          await resolver.buildContext(new RunSensitiveValues()),
          resolver.buildLightContext(new RunSensitiveValues()),
        ]
      ) {
        const record = await context.data!.latest("scratch", "notes");
        assertExists(record);
        assertEquals(record.content, "in memory only");
        assertEquals(record.path, "");
      }
    } finally {
      ephemeral.dispose();
    }
  });
});

Deno.test("CEL Data Access: data.latest() with a spec name explains the data names written under it", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("@acme/mirror");
    const model = Definition.create({ name: "mirror", globalArguments: {} });
    await definitionRepo.save(type, model);

    await dataRepo.save(
      type,
      model.id,
      Data.create({
        name: "sync-2026-01-01T00-00-00Z",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: {
          type: "resource",
          specName: "syncRunSummary",
          modelName: "mirror",
        },
        ownerDefinition: createOwner("@acme/mirror:sync"),
      }),
      new TextEncoder().encode(JSON.stringify({ prCount: 95 })),
    );

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
      dataQueryService: new DataQueryService(catalog, dataRepo),
    });
    const context = await modelResolver.buildContext(new RunSensitiveValues());
    const celEvaluator = new CelEvaluator();

    const error = await assertRejects(() =>
      celEvaluator.evaluateAsync(
        'data.latest("mirror", "syncRunSummary").attributes.prCount',
        context as unknown as Record<string, unknown>,
      )
    );
    const message = (error as Error).message;
    assertStringIncludes(
      message,
      '"syncRunSummary" is an output spec name, but data.latest() takes a data name.',
    );
    assertStringIncludes(
      message,
      'mirror has 1 record of spec "syncRunSummary": "sync-2026-01-01T00-00-00Z".',
    );

    assertEquals(
      await celEvaluator.evaluateAsync(
        'data.latest("mirror", "sync-2026-01-01T00-00-00Z").attributes.prCount',
        context as unknown as Record<string, unknown>,
      ),
      95,
    );
    catalog.close();
  });
});

async function assertLifecycleQueries(
  indexedBy: "write-through" | "rebuild",
): Promise<void> {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const model = Definition.create({ name: "servers", globalArguments: {} });
    await definitionRepo.save(type, model);

    const dqs = new DataQueryService(catalog, dataRepo);
    // Populating the empty catalog first sends the saves below through
    // write-through; otherwise the first query rebuilds it from disk.
    if (indexedBy === "write-through") await dqs.query('name == ""');
    try {
      const saveServer = async (data: Data, body: unknown) =>
        await dataRepo.save(
          type,
          model.id,
          data,
          new TextEncoder().encode(JSON.stringify(body)),
        );
      const server = (name: string) =>
        Data.create({
          name,
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          tags: { type: "resource", specName: "server", modelName: "servers" },
          ownerDefinition: createOwner("test/model:servers"),
        });
      await saveServer(server("web"), { id: 1 });
      const db = server("db");
      await saveServer(db, { id: 2 });
      await saveServer(db.withDeletionMarker({ version: 2 }), {
        id: 2,
        deletedAt: "2026-10-21T00:00:00.000Z",
      });
      assertEquals(catalog.isPopulated(), indexedBy === "write-through");

      const versions = (records: unknown[]) =>
        (records as DataRecord[])
          .map((r) => `${r.name}@${r.version}:${r.lifecycle}`)
          .sort();

      assertEquals(versions(await dqs.query('modelName == "servers"')), [
        "db@2:deleted",
        "web@1:active",
      ]);
      assertEquals(catalog.isPopulated(), true);
      const live = 'modelName == "servers" && lifecycle == "active"';
      assertEquals(versions(await dqs.query(live)), ["web@1:active"]);
      assertEquals(
        versions(
          await dqs.query('modelName == "servers" && lifecycle == "deleted"'),
        ),
        ["db@2:deleted"],
      );
      // lifecycle is per version: the deleted resource's earlier version
      // is still an active row.
      assertEquals(
        versions(await dqs.query(`${live} && isLatest == false`)),
        ["db@1:active"],
      );

      const resolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      const context = await resolver.buildContext(new RunSensitiveValues());
      assertExists(context.data);
      assertEquals(versions(await context.data.query(live)), ["web@1:active"]);
      assertEquals(await context.data.query(live, "lifecycle"), ["active"]);
    } finally {
      catalog.close();
    }
  });
}

Deno.test("CEL Data Access: lifecycle leaves out a deleted resource in data query and data.query() alike, on a write-through catalog (swamp-club#3706)", async () => {
  await assertLifecycleQueries("write-through");
});

Deno.test("CEL Data Access: lifecycle leaves out a deleted resource in data query and data.query() alike, on a rebuilt catalog (swamp-club#3706)", async () => {
  await assertLifecycleQueries("rebuild");
});
