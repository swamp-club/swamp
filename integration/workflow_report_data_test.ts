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

/**
 * report data lookups use a post-execution name lookup instead of the step's
 * modelId; for auto-created models it may return another id or null, so these
 * tests assert the ids match
 */

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";
import { withGateCredentialEnv } from "./auth_gate_fixture.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "../src/infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-report-data-" });
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

async function setupRepoDir(dir: string): Promise<void> {
  const subdirs = [
    "models",
    "workflows",
    "vaults",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/logs",
    ".swamp/workflow-runs",
    ".swamp/secrets",
    ".swamp/auto-definitions",
    ".swamp/definitions-evaluated",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(dir, subdir));
  }

  const markerData = {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    join(dir, ".swamp.yaml"),
    stringifyYaml(markerData as Record<string, unknown>),
  );
}

async function runCliCommand(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  // Every CLI child needs a swamp-club credential to pass the auth gate.
  return await withGateCredentialEnv(async (env) => {
    const command = new Deno.Command(Deno.execPath(), {
      args: [...CLI_ARGS, ...args],
      stdout: "piped",
      stderr: "piped",
      cwd,
      env,
      clearEnv: true,
    });

    const { code, stdout, stderr } = await command.output();
    return {
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
      code,
    };
  });
}

Deno.test("runWorkflowReports: auto-created model data is accessible via findByNameGlobal modelId", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    const workflow = Workflow.create({
      name: "auto-create-report-test",
      jobs: [
        Job.create({
          name: "auto-job",
          steps: [
            Step.create({
              name: "auto-step",
              task: StepTask.directExecution(
                "command/shell",
                "auto-test-model",
                "execute",
                { run: "echo 'auto-created data'" },
              ),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "auto-create-report-test",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Workflow should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");

    const stepData = output.jobs[0].steps[0];
    assertExists(
      stepData.dataArtifacts,
      `Step should have dataArtifacts: ${JSON.stringify(stepData)}`,
    );
    assertEquals(
      stepData.dataArtifacts.length > 0,
      true,
      "Step should have at least one data artifact",
    );

    const evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );

    const autoDefRepo = new YamlDefinitionRepository(
      repoDir,
      undefined,
      swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
      false,
    );
    const autoDefResult = await autoDefRepo.findByNameGlobal("auto-test-model");
    assertExists(
      autoDefResult,
      "Auto-created definition should exist in auto-definitions directory",
    );
    const realModelId = autoDefResult.definition.id;
    const evaluatedLookup = await evaluatedDefRepo.findByNameGlobal(
      "auto-test-model",
    );

    const definitionLookup = await definitionRepo.findByNameGlobal(
      "auto-test-model",
    );

    const lookupResult = evaluatedLookup ?? definitionLookup;
    assertExists(
      lookupResult,
      "At least one repository should find the auto-created definition by name. " +
        "evaluatedDefRepo found: " +
        (evaluatedLookup ? `yes (id=${evaluatedLookup.definition.id})` : "no") +
        ", definitionRepo found: " +
        (definitionLookup
          ? `yes (id=${definitionLookup.definition.id})`
          : "no"),
    );

    const lookedUpModelId = lookupResult.definition.id;

    assertEquals(
      lookedUpModelId,
      realModelId,
      `ModelId mismatch! The definition found by findByNameGlobal ` +
        `(id=${lookedUpModelId}) does not match the auto-created definition ` +
        `(id=${realModelId}). This causes getContent to return null in ` +
        `workflow-scope reports because data was written under the real ID ` +
        `but reports look up data using the mismatched ID.`,
    );

    const realData = await dataRepo.findAllForModel(
      SHELL_MODEL_TYPE,
      realModelId,
    );
    assertEquals(
      realData.length > 0,
      true,
      `Data should be accessible using the real modelId (${realModelId})`,
    );

    const lookedUpData = await dataRepo.findAllForModel(
      SHELL_MODEL_TYPE,
      lookedUpModelId,
    );
    assertEquals(
      lookedUpData.length > 0,
      true,
      `Data should be accessible using the looked-up modelId (${lookedUpModelId}). ` +
        `If this fails but the real modelId works, it confirms the bug: ` +
        `runWorkflowReports looks up the wrong modelId for auto-created models.`,
    );

    for (const data of realData) {
      const contentViaReal = await dataRepo.getContent(
        SHELL_MODEL_TYPE,
        realModelId,
        data.name,
      );
      assertExists(
        contentViaReal,
        `getContent should work with real modelId for data "${data.name}"`,
      );

      const contentViaLookup = await dataRepo.getContent(
        SHELL_MODEL_TYPE,
        lookedUpModelId,
        data.name,
      );
      assertExists(
        contentViaLookup,
        `getContent should work with looked-up modelId for data "${data.name}". ` +
          `This is the exact failure path in the bug: reports call ` +
          `getContent with the modelId from findByNameGlobal, but data ` +
          `was written under a different modelId.`,
      );
    }
  });
});

Deno.test("runWorkflowReports: pre-created model data is accessible via findByNameGlobal modelId", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    const model = Definition.create({
      name: "precreated-model",
      methods: {
        execute: { arguments: { run: "echo 'precreated data'" } },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);
    const preCreatedModelId = model.id;

    const workflow = Workflow.create({
      name: "precreated-report-test",
      jobs: [
        Job.create({
          name: "pre-job",
          steps: [
            Step.create({
              name: "pre-step",
              task: StepTask.model("precreated-model", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "precreated-report-test",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Workflow should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");

    const evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(repoDir);
    const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );

    const evaluatedLookup = await evaluatedDefRepo.findByNameGlobal(
      "precreated-model",
    );

    const definitionLookup = await definitionRepo.findByNameGlobal(
      "precreated-model",
    );

    const lookupResult = evaluatedLookup ?? definitionLookup;
    assertExists(
      lookupResult,
      "Pre-created model should be found by name lookup",
    );

    assertEquals(
      lookupResult.definition.id,
      preCreatedModelId,
      "Looked-up modelId should match the pre-created definition's ID",
    );

    const data = await dataRepo.findAllForModel(
      SHELL_MODEL_TYPE,
      preCreatedModelId,
    );
    assertEquals(
      data.length > 0,
      true,
      "Data should be persisted for pre-created model",
    );

    for (const d of data) {
      const content = await dataRepo.getContent(
        SHELL_MODEL_TYPE,
        lookupResult.definition.id,
        d.name,
      );
      assertExists(
        content,
        `getContent should work for pre-created model data "${d.name}"`,
      );
    }
  });
});

Deno.test("runWorkflowReports: auto-create vs pre-create modelId diagnostic", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    const preModel = Definition.create({
      name: "diag-precreated",
      methods: {
        execute: { arguments: { run: "echo 'diag precreated'" } },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, preModel);

    const workflow = Workflow.create({
      name: "diag-workflow",
      jobs: [
        Job.create({
          name: "diag-job",
          steps: [
            Step.create({
              name: "auto-step",
              task: StepTask.directExecution(
                "command/shell",
                "diag-autocreated",
                "execute",
                { run: "echo 'diag autocreated'" },
              ),
            }),
            Step.create({
              name: "pre-step",
              task: StepTask.model("diag-precreated", "execute"),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "diag-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Workflow should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");

    const evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(repoDir);
    const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );

    const autoDefRepo = new YamlDefinitionRepository(
      repoDir,
      undefined,
      swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
      false,
    );
    const autoCreatedDef = await autoDefRepo.findByNameGlobal(
      "diag-autocreated",
    );
    assertExists(autoCreatedDef, "Auto-created definition should exist");
    const autoRealId = autoCreatedDef.definition.id;

    const autoEvaluated = await evaluatedDefRepo.findByNameGlobal(
      "diag-autocreated",
    );
    const autoDefinition = await definitionRepo.findByNameGlobal(
      "diag-autocreated",
    );

    const autoLookup = autoEvaluated ?? autoDefinition;

    const preLookup = await evaluatedDefRepo.findByNameGlobal(
      "diag-precreated",
    ) ?? await definitionRepo.findByNameGlobal("diag-precreated");

    assertExists(preLookup, "Pre-created model should be findable by name");

    assertEquals(
      preLookup.definition.id,
      preModel.id,
      "Pre-created model: looked-up ID should match original ID",
    );

    const preData = await dataRepo.findAllForModel(
      SHELL_MODEL_TYPE,
      preModel.id,
    );
    assertEquals(
      preData.length > 0,
      true,
      "Pre-created model should have data",
    );
    for (const d of preData) {
      const content = await dataRepo.getContent(
        SHELL_MODEL_TYPE,
        preLookup.definition.id,
        d.name,
      );
      assertExists(
        content,
        `Pre-created: getContent works with looked-up ID for "${d.name}"`,
      );
    }

    const autoData = await dataRepo.findAllForModel(
      SHELL_MODEL_TYPE,
      autoRealId,
    );
    assertEquals(
      autoData.length > 0,
      true,
      `Auto-created model should have data under real ID (${autoRealId})`,
    );

    assertExists(
      autoLookup,
      "Auto-created model should be findable by name via evaluatedDefRepo " +
        "or definitionRepo. If this fails, reports cannot access the modelId " +
        "at all and will use an empty string.",
    );

    assertEquals(
      autoLookup.definition.id,
      autoRealId,
      `Auto-created model: looked-up ID (${autoLookup.definition.id}) should ` +
        `match real ID (${autoRealId}). A mismatch means getContent will ` +
        `look in the wrong directory.`,
    );

    for (const d of autoData) {
      const content = await dataRepo.getContent(
        SHELL_MODEL_TYPE,
        autoLookup.definition.id,
        d.name,
      );
      assertExists(
        content,
        `Auto-created: getContent should work with looked-up ID for "${d.name}". ` +
          `Failure here confirms the report data bug.`,
      );
    }
  });
});
