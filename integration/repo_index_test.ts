/**
 * Integration tests for the RepoIndexService.
 *
 * Tests the full flow:
 * 1. Create models/workflows via repository context (with events)
 * 2. Verify index symlinks are created automatically
 * 3. Test repo index command rebuilds correctly
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { existsSync } from "@std/fs";
import { ensureDir } from "@std/fs";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-index-integration-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  const subdirs = [
    // .swamp paths
    ".swamp/workflows",
    ".swamp/workflow-runs",
    ".swamp/definitions",
    ".swamp/data",
    ".swamp/outputs",
    // Logical view directories
    "models",
    "workflows",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(dir, subdir));
  }
}

// ============================================================================
// Model Indexing Tests (Definition-based)
// ============================================================================

Deno.test("Integration: definition create via repository context creates index symlink", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create repository context with indexing enabled
    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");

    // Create and save a definition
    const definition = Definition.create({
      name: "auto-indexed-model",
      version: 1,
      tags: {},
      attributes: { message: "hello" },
    });
    await ctx.definitionRepo.save(type, definition);

    // Verify the index directory was created automatically
    const modelDir = join(repoDir, "models", "auto-indexed-model");
    assertEquals(
      existsSync(modelDir),
      true,
      "Model index directory should exist",
    );

    // Verify the definition.yaml symlink exists
    const definitionSymlink = join(modelDir, "definition.yaml");
    assertEquals(
      existsSync(definitionSymlink),
      true,
      "definition.yaml symlink should exist",
    );

    // Verify we can read through the symlink
    const content = await Deno.readTextFile(definitionSymlink);
    assertEquals(
      content.includes("auto-indexed-model"),
      true,
      "Should be able to read model name through symlink",
    );
  });
});

Deno.test("Integration: definition delete via repository context removes index symlink", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");

    // Create a definition
    const definition = Definition.create({
      name: "delete-indexed-model",
      version: 1,
      tags: {},
      attributes: {},
    });
    await ctx.definitionRepo.save(type, definition);

    // Verify index exists
    const modelDir = join(repoDir, "models", "delete-indexed-model");
    assertEquals(existsSync(modelDir), true, "Index should exist after create");

    // Delete the definition
    await ctx.definitionRepo.delete(type, definition.id);

    // Verify index was removed
    assertEquals(
      existsSync(modelDir),
      false,
      "Index should be removed after delete",
    );
  });
});

Deno.test("Integration: multiple definitions create separate index directories", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");

    // Create multiple definitions
    const def1 = Definition.create({
      name: "model-alpha",
      version: 1,
      tags: {},
      attributes: {},
    });
    const def2 = Definition.create({
      name: "model-beta",
      version: 1,
      tags: {},
      attributes: {},
    });
    const def3 = Definition.create({
      name: "model-gamma",
      version: 1,
      tags: {},
      attributes: {},
    });

    await ctx.definitionRepo.save(type, def1);
    await ctx.definitionRepo.save(type, def2);
    await ctx.definitionRepo.save(type, def3);

    // Verify all index directories exist
    assertEquals(existsSync(join(repoDir, "models", "model-alpha")), true);
    assertEquals(existsSync(join(repoDir, "models", "model-beta")), true);
    assertEquals(existsSync(join(repoDir, "models", "model-gamma")), true);

    // Each should have its own definition.yaml symlink
    assertEquals(
      existsSync(join(repoDir, "models", "model-alpha", "definition.yaml")),
      true,
    );
    assertEquals(
      existsSync(join(repoDir, "models", "model-beta", "definition.yaml")),
      true,
    );
    assertEquals(
      existsSync(join(repoDir, "models", "model-gamma", "definition.yaml")),
      true,
    );
  });
});

// ============================================================================
// Workflow Indexing Tests
// ============================================================================

Deno.test("Integration: workflow create via repository context creates index", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });

    // Create a workflow
    const step = Step.create({
      name: "step1",
      task: StepTask.shell("echo hello"),
    });
    const job = Job.create({ name: "job1", steps: [step] });
    const workflow = Workflow.create({ name: "test-workflow", jobs: [job] });

    await ctx.workflowRepo.save(workflow);

    // Verify workflow index directory exists
    const workflowDir = join(repoDir, "workflows", "test-workflow");
    assertEquals(
      existsSync(workflowDir),
      true,
      "Workflow index directory should exist",
    );

    // Verify workflow.yaml symlink exists
    const workflowSymlink = join(workflowDir, "workflow.yaml");
    assertEquals(
      existsSync(workflowSymlink),
      true,
      "workflow.yaml symlink should exist",
    );

    // Verify runs directory exists
    const runsDir = join(workflowDir, "runs");
    assertEquals(existsSync(runsDir), true, "runs directory should exist");
  });
});

Deno.test("Integration: workflow run creates run index with latest symlink", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });

    // Create a workflow
    const step = Step.create({
      name: "step1",
      task: StepTask.shell("echo hello"),
    });
    const job = Job.create({ name: "job1", steps: [step] });
    const workflow = Workflow.create({
      name: "run-test-workflow",
      jobs: [job],
    });
    await ctx.workflowRepo.save(workflow);

    // Create and start a workflow run
    const run = WorkflowRun.create(workflow);
    run.start();
    await ctx.workflowRunRepo.save(workflow.id, run);

    // Verify runs directory structure
    const runsDir = join(repoDir, "workflows", "run-test-workflow", "runs");
    assertEquals(existsSync(runsDir), true, "runs directory should exist");

    // Verify latest symlink exists
    const latestPath = join(runsDir, "latest");
    assertEquals(existsSync(latestPath), true, "latest symlink should exist");

    // Verify we can follow latest to get run.yaml
    const runYaml = join(latestPath, "run.yaml");
    assertEquals(
      existsSync(runYaml),
      true,
      "Should find run.yaml via latest symlink",
    );
  });
});

// ============================================================================
// Repo Index Rebuild Tests
// ============================================================================

Deno.test("Integration: repo index rebuild indexes existing definitions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create definitions WITHOUT indexing enabled
    const ctxNoIndex = createRepositoryContext({
      repoDir,
      enableIndexing: false,
    });
    const type = ModelType.create("swamp/echo");

    const def1 = Definition.create({
      name: "rebuild-model-1",
      version: 1,
      tags: {},
      attributes: {},
    });
    const def2 = Definition.create({
      name: "rebuild-model-2",
      version: 1,
      tags: {},
      attributes: {},
    });
    await ctxNoIndex.definitionRepo.save(type, def1);
    await ctxNoIndex.definitionRepo.save(type, def2);

    // Verify no index directories exist yet
    assertEquals(existsSync(join(repoDir, "models", "rebuild-model-1")), false);
    assertEquals(existsSync(join(repoDir, "models", "rebuild-model-2")), false);

    // Now rebuild the index
    const result = await ctxNoIndex.indexService.rebuildAll();

    assertEquals(result.modelsIndexed, 2, "Should index 2 definitions");

    // Verify index directories now exist
    assertEquals(existsSync(join(repoDir, "models", "rebuild-model-1")), true);
    assertEquals(existsSync(join(repoDir, "models", "rebuild-model-2")), true);
  });
});

Deno.test("Integration: repo index rebuild removes stale indexes", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create a definition with indexing
    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");

    const definition = Definition.create({
      name: "existing-model",
      version: 1,
      tags: {},
      attributes: {},
    });
    await ctx.definitionRepo.save(type, definition);

    // Manually create a stale index directory (simulates a deleted model)
    const staleDir = join(repoDir, "models", "stale-deleted-model");
    await ensureDir(staleDir);
    assertEquals(
      existsSync(staleDir),
      true,
      "Stale directory should exist before rebuild",
    );

    // Rebuild - should remove stale directory
    const result = await ctx.indexService.rebuildAll();

    assertEquals(result.modelsIndexed, 1, "Should index 1 model");

    // Verify stale directory was removed
    assertEquals(
      existsSync(staleDir),
      false,
      "Stale directory should be removed",
    );

    // Verify real model still indexed
    assertEquals(existsSync(join(repoDir, "models", "existing-model")), true);
  });
});

Deno.test("Integration: repo index verify detects broken symlinks", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const ctx = createRepositoryContext({ repoDir, enableIndexing: false });

    // Create a model index directory with a broken symlink
    const modelDir = join(repoDir, "models", "broken-model");
    await ensureDir(modelDir);
    await Deno.symlink(
      "../.swamp/definitions/nonexistent/file.yaml",
      join(modelDir, "definition.yaml"),
    );

    // Verify should detect the broken link
    const result = await ctx.indexService.verify();

    assertEquals(result.valid, false, "Verification should fail");
    assertEquals(result.brokenLinks.length, 1, "Should have 1 broken link");
  });
});

Deno.test("Integration: repo index prune removes broken symlinks", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const ctx = createRepositoryContext({ repoDir, enableIndexing: false });

    // Create a model index directory with a broken symlink
    const modelDir = join(repoDir, "models", "prune-test-model");
    await ensureDir(modelDir);
    const brokenLink = join(modelDir, "definition.yaml");
    await Deno.symlink(
      "../.swamp/definitions/nonexistent/file.yaml",
      brokenLink,
    );

    // Prune should remove the broken link
    const result = await ctx.indexService.prune();

    assertEquals(result.removedLinks.length, 1, "Should remove 1 link");
    assertEquals(
      existsSync(brokenLink),
      false,
      "Broken link should be removed",
    );
  });
});

// ============================================================================
// CLI Integration Tests
// ============================================================================

async function runCliCommand(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "dev", ...args],
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

Deno.test("CLI: repo index rebuilds index", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create a definition without indexing
    const ctx = createRepositoryContext({ repoDir, enableIndexing: false });
    const type = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "cli-rebuild-test",
      version: 1,
      tags: {},
      attributes: {},
    });
    await ctx.definitionRepo.save(type, definition);

    // Verify no index exists
    assertEquals(
      existsSync(join(repoDir, "models", "cli-rebuild-test")),
      false,
    );

    // Run repo index command
    const result = await runCliCommand(
      ["repo", "index", "--repo-dir", repoDir, "--json"],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Command should succeed. stderr: ${result.stderr}`,
    );

    // Verify index was created
    assertEquals(existsSync(join(repoDir, "models", "cli-rebuild-test")), true);

    // Verify JSON output
    const output = JSON.parse(result.stdout);
    assertEquals(output.modelsIndexed, 1);
  });
});

Deno.test("CLI: repo index --verify checks integrity", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create a definition with valid index
    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");
    const definition = Definition.create({
      name: "verify-test",
      version: 1,
      tags: {},
      attributes: {},
    });
    await ctx.definitionRepo.save(type, definition);

    // Run verify
    const result = await runCliCommand(
      ["repo", "index", "--verify", "--repo-dir", repoDir, "--json"],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Verify should pass. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.valid, true);
    assertEquals(output.brokenLinks.length, 0);
  });
});

Deno.test("CLI: repo index --verify fails on broken symlinks", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create a broken symlink
    const modelDir = join(repoDir, "models", "broken-verify-test");
    await ensureDir(modelDir);
    await Deno.symlink(
      "../.swamp/definitions/nonexistent/file.yaml",
      join(modelDir, "definition.yaml"),
    );

    // Run verify
    const result = await runCliCommand(
      ["repo", "index", "--verify", "--repo-dir", repoDir, "--json"],
      Deno.cwd(),
    );

    // Should exit with error code
    assertEquals(result.code, 1, "Verify should fail on broken symlinks");

    const output = JSON.parse(result.stdout);
    assertEquals(output.valid, false);
    assertEquals(output.brokenLinks.length, 1);
  });
});

Deno.test("CLI: repo index --prune removes broken symlinks", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create a broken symlink
    const modelDir = join(repoDir, "models", "prune-cli-test");
    await ensureDir(modelDir);
    const brokenLink = join(modelDir, "definition.yaml");
    await Deno.symlink(
      "../.swamp/definitions/nonexistent/file.yaml",
      brokenLink,
    );

    // Run prune
    const result = await runCliCommand(
      ["repo", "index", "--prune", "--repo-dir", repoDir, "--json"],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Prune should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.removedLinks.length, 1);

    // Verify broken link was removed
    assertEquals(existsSync(brokenLink), false);
  });
});

// ============================================================================
// Definition-Based Model Indexing Tests (Issue #119)
// ============================================================================

Deno.test("Integration: definition create via repository context creates definition.yaml symlink", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create repository context with indexing enabled
    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");

    // Create and save a definition
    const definition = Definition.create({
      name: "definition-indexed-model",
      version: 1,
      tags: { env: "test" },
      attributes: { message: "hello" },
    });
    await ctx.definitionRepo.save(type, definition);

    // Verify the index directory was created automatically
    const modelDir = join(repoDir, "models", "definition-indexed-model");
    assertEquals(
      existsSync(modelDir),
      true,
      "Model index directory should exist",
    );

    // Verify the definition.yaml symlink exists (new format)
    const definitionSymlink = join(modelDir, "definition.yaml");
    assertEquals(
      existsSync(definitionSymlink),
      true,
      "definition.yaml symlink should exist",
    );

    // Verify we can read through the symlink
    const content = await Deno.readTextFile(definitionSymlink);
    assertEquals(
      content.includes("definition-indexed-model"),
      true,
      "Should be able to read definition name through symlink",
    );
    assertEquals(
      content.includes("message"),
      true,
      "Should be able to read attributes through symlink",
    );
  });
});

Deno.test("Integration: definition update via repository context updates logical view", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");

    // Create initial definition
    const definition = Definition.create({
      name: "update-test-model",
      version: 1,
      tags: {},
      attributes: { value: "original" },
    });
    await ctx.definitionRepo.save(type, definition);

    // Verify initial symlink exists and has original value
    const definitionSymlink = join(
      repoDir,
      "models",
      "update-test-model",
      "definition.yaml",
    );
    let content = await Deno.readTextFile(definitionSymlink);
    assertEquals(
      content.includes("original"),
      true,
      "Initial content should have original value",
    );

    // Update the definition
    const updatedDefinition = Definition.create({
      id: definition.id,
      name: "update-test-model",
      version: 2,
      tags: {},
      attributes: { value: "updated" },
    });
    await ctx.definitionRepo.save(type, updatedDefinition);

    // Verify symlink still exists and has updated value
    assertEquals(
      existsSync(definitionSymlink),
      true,
      "definition.yaml symlink should still exist after update",
    );
    content = await Deno.readTextFile(definitionSymlink);
    assertEquals(
      content.includes("updated"),
      true,
      "Updated content should have new value",
    );
  });
});

Deno.test("Integration: definition delete via repository context removes logical view", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");

    // Create a definition
    const definition = Definition.create({
      name: "delete-definition-model",
      version: 1,
      tags: {},
      attributes: {},
    });
    await ctx.definitionRepo.save(type, definition);

    // Verify index exists
    const modelDir = join(repoDir, "models", "delete-definition-model");
    assertEquals(existsSync(modelDir), true, "Index should exist after create");

    // Delete the definition
    await ctx.definitionRepo.delete(type, definition.id);

    // Verify index was removed
    assertEquals(
      existsSync(modelDir),
      false,
      "Index should be removed after delete",
    );
  });
});

Deno.test("Integration: repo index rebuild indexes definitions with type/ directory", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create definitions WITHOUT indexing enabled
    const ctxNoIndex = createRepositoryContext({
      repoDir,
      enableIndexing: false,
    });
    const type = ModelType.create("swamp/echo");

    const def1 = Definition.create({
      name: "rebuild-def-1",
      version: 1,
      tags: {},
      attributes: {},
    });
    const def2 = Definition.create({
      name: "rebuild-def-2",
      version: 1,
      tags: {},
      attributes: {},
    });
    await ctxNoIndex.definitionRepo.save(type, def1);
    await ctxNoIndex.definitionRepo.save(type, def2);

    // Verify no index directories exist yet
    assertEquals(
      existsSync(join(repoDir, "models", "rebuild-def-1")),
      false,
      "Index should not exist before rebuild",
    );
    assertEquals(
      existsSync(join(repoDir, "models", "rebuild-def-2")),
      false,
      "Index should not exist before rebuild",
    );

    // Now rebuild the index
    const result = await ctxNoIndex.indexService.rebuildAll();

    assertEquals(result.modelsIndexed, 2, "Should index 2 definitions");

    // Verify index directories now exist with definition.yaml symlinks
    const dir1 = join(repoDir, "models", "rebuild-def-1");
    const dir2 = join(repoDir, "models", "rebuild-def-2");
    assertEquals(existsSync(dir1), true, "First model dir should exist");
    assertEquals(existsSync(dir2), true, "Second model dir should exist");

    assertEquals(
      existsSync(join(dir1, "definition.yaml")),
      true,
      "First definition.yaml symlink should exist",
    );
    assertEquals(
      existsSync(join(dir2, "definition.yaml")),
      true,
      "Second definition.yaml symlink should exist",
    );

    // Verify type/ directory exists for tag-based organization
    assertEquals(
      existsSync(join(dir1, "type")),
      true,
      "type/ directory should exist for tag-based data",
    );
    assertEquals(
      existsSync(join(dir2, "type")),
      true,
      "type/ directory should exist for tag-based data",
    );
  });
});
