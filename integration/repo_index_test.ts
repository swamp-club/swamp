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
import { ModelInput } from "../src/domain/models/model_input.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
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
    ".data/inputs",
    ".data/resources",
    ".data/data",
    ".data/outputs",
    ".data/workflows",
    ".data/workflow-runs",
    ".data/logs",
    ".data/files",
    "models",
    "workflows",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(dir, subdir));
  }
}

// ============================================================================
// Model Indexing Tests
// ============================================================================

Deno.test("Integration: model create via repository context creates index symlink", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create repository context with indexing enabled
    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");

    // Create and save a model
    const input = ModelInput.create({ name: "auto-indexed-model" });
    await ctx.inputRepo.save(type, input);

    // Verify the index directory was created automatically
    const modelDir = join(repoDir, "models", "auto-indexed-model");
    assertEquals(
      existsSync(modelDir),
      true,
      "Model index directory should exist",
    );

    // Verify the input.yaml symlink exists
    const inputSymlink = join(modelDir, "input.yaml");
    assertEquals(
      existsSync(inputSymlink),
      true,
      "input.yaml symlink should exist",
    );

    // Verify we can read through the symlink
    const content = await Deno.readTextFile(inputSymlink);
    assertEquals(
      content.includes("auto-indexed-model"),
      true,
      "Should be able to read model name through symlink",
    );
  });
});

Deno.test("Integration: model delete via repository context removes index symlink", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");

    // Create a model
    const input = ModelInput.create({ name: "delete-indexed-model" });
    await ctx.inputRepo.save(type, input);

    // Verify index exists
    const modelDir = join(repoDir, "models", "delete-indexed-model");
    assertEquals(existsSync(modelDir), true, "Index should exist after create");

    // Delete the model
    await ctx.inputRepo.delete(type, input.id);

    // Verify index was removed
    assertEquals(
      existsSync(modelDir),
      false,
      "Index should be removed after delete",
    );
  });
});

Deno.test("Integration: multiple models create separate index directories", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");

    // Create multiple models
    const model1 = ModelInput.create({ name: "model-alpha" });
    const model2 = ModelInput.create({ name: "model-beta" });
    const model3 = ModelInput.create({ name: "model-gamma" });

    await ctx.inputRepo.save(type, model1);
    await ctx.inputRepo.save(type, model2);
    await ctx.inputRepo.save(type, model3);

    // Verify all index directories exist
    assertEquals(existsSync(join(repoDir, "models", "model-alpha")), true);
    assertEquals(existsSync(join(repoDir, "models", "model-beta")), true);
    assertEquals(existsSync(join(repoDir, "models", "model-gamma")), true);

    // Each should have its own input.yaml symlink
    assertEquals(
      existsSync(join(repoDir, "models", "model-alpha", "input.yaml")),
      true,
    );
    assertEquals(
      existsSync(join(repoDir, "models", "model-beta", "input.yaml")),
      true,
    );
    assertEquals(
      existsSync(join(repoDir, "models", "model-gamma", "input.yaml")),
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

Deno.test("Integration: repo index rebuild indexes existing models", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create models WITHOUT indexing enabled
    const ctxNoIndex = createRepositoryContext({
      repoDir,
      enableIndexing: false,
    });
    const type = ModelType.create("swamp/echo");

    const model1 = ModelInput.create({ name: "rebuild-model-1" });
    const model2 = ModelInput.create({ name: "rebuild-model-2" });
    await ctxNoIndex.inputRepo.save(type, model1);
    await ctxNoIndex.inputRepo.save(type, model2);

    // Verify no index directories exist yet
    assertEquals(existsSync(join(repoDir, "models", "rebuild-model-1")), false);
    assertEquals(existsSync(join(repoDir, "models", "rebuild-model-2")), false);

    // Now rebuild the index
    const result = await ctxNoIndex.indexService.rebuildAll();

    assertEquals(result.modelsIndexed, 2, "Should index 2 models");

    // Verify index directories now exist
    assertEquals(existsSync(join(repoDir, "models", "rebuild-model-1")), true);
    assertEquals(existsSync(join(repoDir, "models", "rebuild-model-2")), true);
  });
});

Deno.test("Integration: repo index rebuild removes stale indexes", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);

    // Create a model with indexing
    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");

    const model = ModelInput.create({ name: "existing-model" });
    await ctx.inputRepo.save(type, model);

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
      "../.data/inputs/nonexistent/file.yaml",
      join(modelDir, "input.yaml"),
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
    const brokenLink = join(modelDir, "input.yaml");
    await Deno.symlink(
      "../.data/inputs/nonexistent/file.yaml",
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

    // Create a model without indexing
    const ctx = createRepositoryContext({ repoDir, enableIndexing: false });
    const type = ModelType.create("swamp/echo");
    const model = ModelInput.create({ name: "cli-rebuild-test" });
    await ctx.inputRepo.save(type, model);

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

    // Create a model with valid index
    const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
    const type = ModelType.create("swamp/echo");
    const model = ModelInput.create({ name: "verify-test" });
    await ctx.inputRepo.save(type, model);

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
      "../.data/inputs/nonexistent/file.yaml",
      join(modelDir, "input.yaml"),
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
    const brokenLink = join(modelDir, "input.yaml");
    await Deno.symlink(
      "../.data/inputs/nonexistent/file.yaml",
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
