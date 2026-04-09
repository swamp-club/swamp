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
 * Integration tests for vary dimensions on dataOutputOverrides.
 *
 * Tests the full flow:
 * 1. Write data with composite names via vary dimensions
 * 2. Read varied data via data.latest() with vary values
 * 3. forEach + vary produces isolated data per environment
 * 4. Each varied data name has independent versioning
 */

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";
import { Data } from "../src/domain/data/data.ts";
import type { OwnerDefinition } from "../src/domain/data/data_metadata.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { ModelResolver } from "../src/domain/expressions/model_resolver.ts";
import { CelEvaluator } from "../src/infrastructure/cel/cel_evaluator.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { composeDataName } from "../src/domain/data/mod.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-vary-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
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

async function initializeTestRepo(repoDir: string): Promise<void> {
  const subdirs = [
    "models",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/logs",
    "workflows",
    ".swamp/workflow-runs",
    ".swamp/workflows-evaluated",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(repoDir, subdir));
  }

  const markerData = {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml(markerData as Record<string, unknown>),
  );
}

async function createShellModel(repoDir: string, name: string): Promise<void> {
  const modelData = {
    type: "command/shell",
    typeVersion: 1,
    id: crypto.randomUUID(),
    name,
    version: 1,
    tags: {},
    globalArguments: {},
    methods: {
      execute: {
        arguments: {
          run: "echo 'hello'",
        },
      },
    },
  };

  const modelDir = join(repoDir, "models/command/shell");
  await ensureDir(modelDir);
  await Deno.writeTextFile(
    join(modelDir, `${modelData.id}.yaml`),
    stringifyYaml(modelData as Record<string, unknown>),
  );
}

async function runCliCommand(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

// ============================================================================
// Composite Name + Data Access Integration
// ============================================================================

Deno.test("Vary: data.latest() resolves composite name from persisted data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:vary");

    // Create a model
    const model = Definition.create({
      name: "scanner",
      globalArguments: {},
    });
    await definitionRepo.save(type, model);

    // Write data with composite names (simulating what vary produces)
    for (const env of ["dev", "staging", "prod"]) {
      const compositeName = composeDataName("result", [env]);
      const data = Data.create({
        name: compositeName,
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource", specName: "result", modelName: "scanner" },
        ownerDefinition: owner,
      });

      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(JSON.stringify({ env, count: env.length })),
      );
    }

    // Build context and verify data.latest() with vary works
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
      const context = await modelResolver.buildContext();
      assertExists(context.data);

      // Each environment has its own data
      const devData = await context.data.latest("scanner", "result-dev");
      assertExists(devData);
      assertEquals(devData.attributes.env, "dev");

      const prodData = await context.data.latest("scanner", "result-prod");
      assertExists(prodData);
      assertEquals(prodData.attributes.env, "prod");

      // Non-varied base name has no data
      const baseData = await context.data.latest("scanner", "result");
      assertEquals(baseData, null);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("Vary: CEL data.latest() with vary array resolves composite name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:cel-vary");

    const model = Definition.create({
      name: "scanner",
      globalArguments: {},
    });
    await definitionRepo.save(type, model);

    // Write varied data
    const prodData = Data.create({
      name: "result-prod",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", specName: "result", modelName: "scanner" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      prodData,
      new TextEncoder().encode(
        JSON.stringify({ status: "healthy", count: 42 }),
      ),
    );

    // Build context
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
      const context = await modelResolver.buildContext();

      // Evaluate CEL expression with vary array
      const celEvaluator = new CelEvaluator();
      const result = await celEvaluator.evaluateAsync(
        'data.latest("scanner", "result", ["prod"]).attributes.count',
        context,
      );
      assertEquals(result, 42);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("Vary: each varied data name has independent versioning", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:versioning");

    const model = Definition.create({
      name: "scanner",
      globalArguments: {},
    });
    await definitionRepo.save(type, model);

    // Write 3 versions for dev, 1 version for prod
    const devData = Data.create({
      name: "result-dev",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: "scanner" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 3; i++) {
      await dataRepo.save(
        type,
        model.id,
        devData,
        new TextEncoder().encode(JSON.stringify({ iteration: i })),
      );
    }

    const prodData = Data.create({
      name: "result-prod",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: "scanner" },
      ownerDefinition: owner,
    });
    await dataRepo.save(
      type,
      model.id,
      prodData,
      new TextEncoder().encode(JSON.stringify({ iteration: 1 })),
    );

    // Build context
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
      const context = await modelResolver.buildContext();
      assertExists(context.data);

      // Dev has 3 versions
      const devVersions = context.data.listVersions("scanner", "result-dev");
      assertEquals(devVersions.length, 3);

      const devLatest = await context.data.latest("scanner", "result-dev");
      assertExists(devLatest);
      assertEquals(devLatest.version, 3);
      assertEquals(devLatest.attributes.iteration, 3);

      // Prod has 1 version
      const prodVersions = context.data.listVersions("scanner", "result-prod");
      assertEquals(prodVersions.length, 1);

      const prodLatest = await context.data.latest("scanner", "result-prod");
      assertExists(prodLatest);
      assertEquals(prodLatest.version, 1);
      assertEquals(prodLatest.attributes.iteration, 1);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("Vary: CEL data.version() with vary resolves specific version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:cel-version");

    const model = Definition.create({
      name: "scanner",
      globalArguments: {},
    });
    await definitionRepo.save(type, model);

    const data = Data.create({
      name: "result-staging",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    // Write 2 versions
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ value: "first" })),
    );
    await dataRepo.save(
      type,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ value: "second" })),
    );

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    const celEvaluator = new CelEvaluator();

    // Access version 1 with vary
    const v1 = await celEvaluator.evaluateAsync(
      'data.version("scanner", "result", ["staging"], 1).attributes.value',
      context,
    );
    assertEquals(v1, "first");

    // Access version 2 with vary
    const v2 = await celEvaluator.evaluateAsync(
      'data.version("scanner", "result", ["staging"], 2).attributes.value',
      context,
    );
    assertEquals(v2, "second");
  });
});

Deno.test("Vary: CEL data.listVersions() with vary lists correct versions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");
    const owner = createOwner("test/model:cel-list");

    const model = Definition.create({
      name: "scanner",
      globalArguments: {},
    });
    await definitionRepo.save(type, model);

    const data = Data.create({
      name: "result-prod",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 4; i++) {
      await dataRepo.save(
        type,
        model.id,
        data,
        new TextEncoder().encode(JSON.stringify({ v: i })),
      );
    }

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    const celEvaluator = new CelEvaluator();
    const versions = celEvaluator.evaluate(
      'data.listVersions("scanner", "result", ["prod"])',
      context,
    );
    assertEquals(versions, [1, 2, 3, 4]);
  });
});

// ============================================================================
// CLI: forEach + vary workflow integration
// ============================================================================

Deno.test("CLI: forEach + vary produces isolated data per environment", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModel(repoDir, "test-model");

    // Create workflow with forEach + vary on dataOutputOverrides
    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-vary-foreach",
      version: 1,
      inputs: {
        properties: {
          environments: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
        },
        required: ["environments"],
      },
      jobs: [
        {
          name: "scan-job",
          steps: [
            {
              name: "scan-${{self.env}}",
              forEach: {
                item: "env",
                in: "${{ inputs.environments }}",
              },
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "execute",
                inputs: {
                  environment: "${{ self.env }}",
                },
              },
              dataOutputOverrides: [
                {
                  specName: "result",
                  vary: ["environment"],
                },
              ],
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    };

    const workflowDir = join(repoDir, "workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "test-vary-foreach",
        "--repo-dir",
        repoDir,
        "--input",
        '{"environments": ["dev", "prod"]}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);

    // Parse output and verify all steps succeeded
    const output = JSON.parse(result.stdout);
    const job = output.jobs?.find(
      (j: { name: string }) => j.name === "scan-job",
    );

    const steps = job?.steps as { name: string; status: string }[];
    const expandedSteps = steps.filter((s) => !s.name.includes("${{"));

    // Both environment steps should have succeeded
    for (const step of expandedSteps) {
      assertEquals(
        step.status,
        "succeeded",
        `Expected ${step.name} to succeed but got ${step.status}`,
      );
    }
  });
});

Deno.test("CLI: vary schema validates in workflow YAML", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModel(repoDir, "test-model");

    // Create workflow with vary field in dataOutputOverrides
    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-vary-validate",
      version: 1,
      jobs: [
        {
          name: "job1",
          steps: [
            {
              name: "step1",
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "execute",
                inputs: {
                  run: "echo hello",
                  region: "us-east-1",
                },
              },
              dataOutputOverrides: [
                {
                  specName: "result",
                  vary: ["region"],
                },
              ],
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    };

    const workflowDir = join(repoDir, "workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    // Validate the workflow — should parse without errors
    const result = await runCliCommand(
      [
        "workflow",
        "validate",
        "test-vary-validate",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should validate. stderr: ${result.stderr}`);
  });
});
