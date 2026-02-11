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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { SymlinkRepoIndexService } from "./symlink_repo_index_service.ts";
import { YamlDefinitionRepository } from "../persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../persistence/yaml_workflow_run_repository.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  createModelCreated,
  createModelDeleted,
} from "../../domain/events/types.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-index-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  // Create standard data directory structure
  const subdirs = [
    // .swamp paths
    ".swamp/definitions",
    ".swamp/data",
    ".swamp/outputs",
    ".swamp/workflows",
    ".swamp/workflow-runs",
    // Logical view directories
    "models",
    "workflows",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(dir, subdir));
  }
}

function createIndexService(dir: string) {
  const definitionRepo = new YamlDefinitionRepository(dir);
  const workflowRepo = new YamlWorkflowRepository(dir);
  const workflowRunRepo = new YamlWorkflowRunRepository(dir);

  return {
    indexService: new SymlinkRepoIndexService({
      repoDir: dir,
      definitionRepo,
      workflowRepo,
      workflowRunRepo,
    }),
    definitionRepo,
    workflowRepo,
    workflowRunRepo,
  };
}

Deno.test("SymlinkRepoIndexService.handleModelCreated creates model directory", async () => {
  await withTempDir(async (dir) => {
    await setupRepoDir(dir);
    const { indexService, definitionRepo } = createIndexService(dir);
    const type = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "my-test-model",
      version: 1,
      tags: {},
      globalArguments: { message: "hello" },
    });
    await definitionRepo.save(type, definition);

    const event = createModelCreated(
      type.normalized,
      definition.id,
      definition.name,
    );
    await indexService.handleModelCreated(event);

    // Check that the model directory was created
    const modelDir = join(dir, "models", "my-test-model");
    const stat = await Deno.stat(modelDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("SymlinkRepoIndexService.handleModelCreated creates definition.yaml symlink", async () => {
  await withTempDir(async (dir) => {
    await setupRepoDir(dir);
    const { indexService, definitionRepo } = createIndexService(dir);
    const type = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "my-definition-model",
      version: 1,
      tags: {},
      globalArguments: { message: "hello" },
    });
    await definitionRepo.save(type, definition);

    const event = createModelCreated(
      type.normalized,
      definition.id,
      definition.name,
    );
    await indexService.handleModelCreated(event);

    // Check that definition.yaml symlink exists and points to correct file
    const symlinkPath = join(
      dir,
      "models",
      "my-definition-model",
      "definition.yaml",
    );
    const linkInfo = await Deno.lstat(symlinkPath);
    assertEquals(linkInfo.isSymlink, true);

    // Read through symlink should work
    const content = await Deno.readTextFile(symlinkPath);
    assertEquals(content.includes("my-definition-model"), true);
  });
});

Deno.test("SymlinkRepoIndexService.handleModelDeleted removes model directory", async () => {
  await withTempDir(async (dir) => {
    await setupRepoDir(dir);
    const { indexService, definitionRepo } = createIndexService(dir);
    const type = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "delete-me",
      version: 1,
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    // Create the model view
    const createEvent = createModelCreated(
      type.normalized,
      definition.id,
      definition.name,
    );
    await indexService.handleModelCreated(createEvent);

    // Verify it exists
    const modelDir = join(dir, "models", "delete-me");
    const stat = await Deno.stat(modelDir);
    assertEquals(stat.isDirectory, true);

    // Delete it
    const deleteEvent = createModelDeleted(
      type.normalized,
      definition.id,
      definition.name,
    );
    await indexService.handleModelDeleted(deleteEvent);

    // Verify it's gone
    let exists = true;
    try {
      await Deno.stat(modelDir);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        exists = false;
      }
    }
    assertEquals(exists, false);
  });
});

Deno.test("SymlinkRepoIndexService.rebuildAll indexes all definitions", async () => {
  await withTempDir(async (dir) => {
    await setupRepoDir(dir);
    const { indexService, definitionRepo } = createIndexService(dir);
    const type = ModelType.create("swamp/echo");

    // Create multiple definitions
    const def1 = Definition.create({
      name: "def-one",
      version: 1,
      tags: {},
      globalArguments: {},
    });
    const def2 = Definition.create({
      name: "def-two",
      version: 1,
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, def1);
    await definitionRepo.save(type, def2);

    // Rebuild all
    const result = await indexService.rebuildAll();

    assertEquals(result.modelsIndexed, 2);

    // Verify both model directories exist
    const dir1 = join(dir, "models", "def-one");
    const dir2 = join(dir, "models", "def-two");
    const stat1 = await Deno.stat(dir1);
    const stat2 = await Deno.stat(dir2);
    assertEquals(stat1.isDirectory, true);
    assertEquals(stat2.isDirectory, true);

    // Verify definition.yaml symlinks exist
    const symlink1 = join(dir1, "definition.yaml");
    const symlink2 = join(dir2, "definition.yaml");
    const linkInfo1 = await Deno.lstat(symlink1);
    const linkInfo2 = await Deno.lstat(symlink2);
    assertEquals(linkInfo1.isSymlink, true);
    assertEquals(linkInfo2.isSymlink, true);
  });
});

Deno.test("SymlinkRepoIndexService.rebuildAll removes stale indexes", async () => {
  await withTempDir(async (dir) => {
    await setupRepoDir(dir);
    const { indexService, definitionRepo } = createIndexService(dir);
    const type = ModelType.create("swamp/echo");

    // Create a model and its index
    const definition = Definition.create({
      name: "my-model",
      version: 1,
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const event = createModelCreated(
      type.normalized,
      definition.id,
      definition.name,
    );
    await indexService.handleModelCreated(event);

    // Create a stale directory that shouldn't exist after rebuild
    // (represents a model that was deleted from data but index wasn't updated)
    const staleDir = join(dir, "models", "stale-model");
    await ensureDir(staleDir);

    // Rebuild - should remove stale-model since it doesn't exist in data
    await indexService.rebuildAll();

    // Stale directory should be gone
    let exists = true;
    try {
      await Deno.stat(staleDir);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        exists = false;
      }
    }
    assertEquals(exists, false);

    // But the real model should still be indexed
    const realDir = join(dir, "models", "my-model");
    const stat = await Deno.stat(realDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("SymlinkRepoIndexService.verify detects broken symlinks", async () => {
  await withTempDir(async (dir) => {
    await setupRepoDir(dir);
    const { indexService } = createIndexService(dir);

    // Create a model directory with a broken symlink
    const modelDir = join(dir, "models", "broken-model");
    await ensureDir(modelDir);
    await Deno.symlink(
      "../.swamp/definitions/nonexistent/file.yaml",
      join(modelDir, "definition.yaml"),
    );

    const result = await indexService.verify();

    assertEquals(result.valid, false);
    assertEquals(result.brokenLinks.length, 1);
  });
});

Deno.test("SymlinkRepoIndexService.verify returns valid for good symlinks", async () => {
  await withTempDir(async (dir) => {
    await setupRepoDir(dir);
    const { indexService, definitionRepo } = createIndexService(dir);
    const type = ModelType.create("swamp/echo");

    // Create a model with valid symlinks
    const definition = Definition.create({
      name: "good-model",
      version: 1,
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const event = createModelCreated(
      type.normalized,
      definition.id,
      definition.name,
    );
    await indexService.handleModelCreated(event);

    const result = await indexService.verify();

    assertEquals(result.valid, true);
    assertEquals(result.brokenLinks.length, 0);
  });
});

Deno.test("SymlinkRepoIndexService.prune removes broken symlinks", async () => {
  await withTempDir(async (dir) => {
    await setupRepoDir(dir);
    const { indexService } = createIndexService(dir);

    // Create a model directory with a broken symlink
    const modelDir = join(dir, "models", "broken-model");
    await ensureDir(modelDir);
    const brokenLink = join(modelDir, "definition.yaml");
    await Deno.symlink(
      "../.swamp/definitions/nonexistent/file.yaml",
      brokenLink,
    );

    const result = await indexService.prune();

    assertEquals(result.removedLinks.length, 1);

    // Verify the symlink is gone
    let exists = true;
    try {
      await Deno.lstat(brokenLink);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        exists = false;
      }
    }
    assertEquals(exists, false);
  });
});

Deno.test("SymlinkRepoIndexService indexes workflows", async () => {
  await withTempDir(async (dir) => {
    await setupRepoDir(dir);
    const { indexService, workflowRepo } = createIndexService(dir);

    // Create a workflow
    const step = Step.create({
      name: "step1",
      task: StepTask.model("test-model", "run"),
    });
    const job = Job.create({ name: "job1", steps: [step] });
    const workflow = Workflow.create({ name: "my-workflow", jobs: [job] });
    await workflowRepo.save(workflow);

    // Rebuild to index
    const result = await indexService.rebuildAll();

    assertEquals(result.workflowsIndexed, 1);

    // Verify workflow directory exists
    const workflowDir = join(dir, "workflows", "my-workflow");
    const stat = await Deno.stat(workflowDir);
    assertEquals(stat.isDirectory, true);

    // Verify workflow.yaml symlink exists
    const symlinkPath = join(workflowDir, "workflow.yaml");
    const linkInfo = await Deno.lstat(symlinkPath);
    assertEquals(linkInfo.isSymlink, true);
  });
});

Deno.test("SymlinkRepoIndexService indexes workflow runs with latest symlink", async () => {
  await withTempDir(async (dir) => {
    await setupRepoDir(dir);
    const { indexService, workflowRepo, workflowRunRepo } = createIndexService(
      dir,
    );

    // Create a workflow
    const step = Step.create({
      name: "step1",
      task: StepTask.model("test-model", "run"),
    });
    const job = Job.create({ name: "job1", steps: [step] });
    const workflow = Workflow.create({ name: "my-workflow", jobs: [job] });
    await workflowRepo.save(workflow);

    // Create a workflow run
    const run = WorkflowRun.create(workflow);
    run.start();
    await workflowRunRepo.save(workflow.id, run);

    // Rebuild to index
    const result = await indexService.rebuildAll();

    assertEquals(result.workflowRunsIndexed, 1);

    // Verify runs directory exists
    const runsDir = join(dir, "workflows", "my-workflow", "runs");
    const runsDirStat = await Deno.stat(runsDir);
    assertEquals(runsDirStat.isDirectory, true);

    // Verify latest symlink exists
    const latestPath = join(runsDir, "latest");
    const latestInfo = await Deno.lstat(latestPath);
    assertEquals(latestInfo.isSymlink, true);
  });
});
