/**
 * Symlink-based implementation of RepoIndexService.
 *
 * Maintains logical views using filesystem symlinks for human/agent-friendly
 * exploration of the repository data.
 */

import { ensureDir } from "@std/fs";
import { join, relative } from "@std/path";
import { getLogger } from "@logtape/logtape";
import type {
  PruneResult,
  RebuildResult,
  RepoIndexService,
  VerifyResult,
} from "../../domain/repo/repo_index_service.ts";
import type {
  ModelCreated,
  ModelDeleted,
  ModelUpdated,
  VaultCreated,
  VaultDeleted,
  VaultUpdated,
  WorkflowCreated,
  WorkflowDeleted,
  WorkflowRunCompleted,
  WorkflowRunFailed,
  WorkflowRunStarted,
  WorkflowUpdated,
} from "../../domain/events/types.ts";
import type { InputRepository } from "../../domain/models/repositories.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type { YamlVaultConfigRepository } from "../persistence/yaml_vault_config_repository.ts";

const logger = getLogger(["swamp", "repo-index"]);

/**
 * Index mode for symlink creation.
 * - "symlink": Standard symlinks (default on Unix)
 * - "junction": Directory junctions (Windows, no admin required)
 */
export type IndexMode = "symlink" | "junction";

/**
 * Configuration for SymlinkRepoIndexService.
 */
export interface SymlinkRepoIndexServiceConfig {
  repoDir: string;
  inputRepo: InputRepository;
  workflowRepo: WorkflowRepository;
  workflowRunRepo: WorkflowRunRepository;
  vaultConfigRepo?: YamlVaultConfigRepository;
  mode?: IndexMode;
}

/**
 * Symlink-based implementation of RepoIndexService.
 */
export class SymlinkRepoIndexService implements RepoIndexService {
  private readonly repoDir: string;
  private readonly inputRepo: InputRepository;
  private readonly workflowRepo: WorkflowRepository;
  private readonly workflowRunRepo: WorkflowRunRepository;
  private readonly vaultConfigRepo: YamlVaultConfigRepository | null;
  private readonly mode: IndexMode;

  constructor(config: SymlinkRepoIndexServiceConfig) {
    this.repoDir = config.repoDir;
    this.inputRepo = config.inputRepo;
    this.workflowRepo = config.workflowRepo;
    this.workflowRunRepo = config.workflowRunRepo;
    this.vaultConfigRepo = config.vaultConfigRepo ?? null;
    this.mode = config.mode ??
      (Deno.build.os === "windows" ? "junction" : "symlink");
  }

  // ============================================================================
  // Model Event Handlers
  // ============================================================================

  async handleModelCreated(event: ModelCreated): Promise<void> {
    await this.indexModel(event.modelType, event.modelInputId, event.modelName);
  }

  async handleModelUpdated(event: ModelUpdated): Promise<void> {
    await this.indexModel(event.modelType, event.modelInputId, event.modelName);
  }

  async handleModelDeleted(event: ModelDeleted): Promise<void> {
    const modelDir = join(this.repoDir, "models", event.modelName);
    await this.removeDirectory(modelDir);
  }

  // ============================================================================
  // Workflow Event Handlers
  // ============================================================================

  async handleWorkflowCreated(event: WorkflowCreated): Promise<void> {
    await this.indexWorkflow(event.workflowId, event.workflowName);
  }

  async handleWorkflowUpdated(event: WorkflowUpdated): Promise<void> {
    await this.indexWorkflow(event.workflowId, event.workflowName);
  }

  async handleWorkflowDeleted(event: WorkflowDeleted): Promise<void> {
    const workflowDir = join(this.repoDir, "workflows", event.workflowName);
    await this.removeDirectory(workflowDir);
  }

  // ============================================================================
  // WorkflowRun Event Handlers
  // ============================================================================

  async handleWorkflowRunStarted(event: WorkflowRunStarted): Promise<void> {
    await this.indexWorkflowRun(
      event.workflowId,
      event.workflowName,
      event.runId,
    );
  }

  async handleWorkflowRunCompleted(event: WorkflowRunCompleted): Promise<void> {
    await this.indexWorkflowRun(
      event.workflowId,
      event.workflowName,
      event.runId,
    );
  }

  async handleWorkflowRunFailed(event: WorkflowRunFailed): Promise<void> {
    await this.indexWorkflowRun(
      event.workflowId,
      event.workflowName,
      event.runId,
    );
  }

  // ============================================================================
  // Vault Event Handlers
  // ============================================================================

  async handleVaultCreated(event: VaultCreated): Promise<void> {
    await this.indexVault(event.vaultId, event.vaultType, event.vaultName);
  }

  async handleVaultUpdated(event: VaultUpdated): Promise<void> {
    await this.indexVault(event.vaultId, event.vaultType, event.vaultName);
  }

  async handleVaultDeleted(event: VaultDeleted): Promise<void> {
    const vaultDir = join(this.repoDir, "vaults", event.vaultName);
    await this.removeDirectory(vaultDir);
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  async verify(): Promise<VerifyResult> {
    const brokenLinks: string[] = [];
    const missingTargets: string[] = [];

    // Check models directory
    const modelsDir = join(this.repoDir, "models");
    await this.verifyDirectory(modelsDir, brokenLinks, missingTargets);

    // Check workflows directory
    const workflowsDir = join(this.repoDir, "workflows");
    await this.verifyDirectory(workflowsDir, brokenLinks, missingTargets);

    // Check vaults directory
    const vaultsDir = join(this.repoDir, "vaults");
    await this.verifyDirectory(vaultsDir, brokenLinks, missingTargets);

    return {
      valid: brokenLinks.length === 0 && missingTargets.length === 0,
      brokenLinks,
      missingTargets,
    };
  }

  async prune(): Promise<PruneResult> {
    const removedLinks: string[] = [];

    // Prune models directory
    const modelsDir = join(this.repoDir, "models");
    await this.pruneDirectory(modelsDir, removedLinks);

    // Prune workflows directory
    const workflowsDir = join(this.repoDir, "workflows");
    await this.pruneDirectory(workflowsDir, removedLinks);

    // Prune vaults directory
    const vaultsDir = join(this.repoDir, "vaults");
    await this.pruneDirectory(vaultsDir, removedLinks);

    return { removedLinks };
  }

  async rebuildAll(): Promise<RebuildResult> {
    // Ensure index directories exist
    await ensureDir(join(this.repoDir, "models"));
    await ensureDir(join(this.repoDir, "workflows"));
    await ensureDir(join(this.repoDir, "vaults"));

    let modelsIndexed = 0;
    let workflowsIndexed = 0;
    let workflowRunsIndexed = 0;
    let vaultsIndexed = 0;

    // Get all models from data directory
    const allInputs = await this.inputRepo.findAllGlobal();
    const dataModelNames = new Set(allInputs.map(({ input }) => input.name));

    // Get existing indexed model directories
    const indexedModelNames = await this.getIndexedNames(
      join(this.repoDir, "models"),
    );

    // Remove indexes for models that no longer exist in data
    for (const name of indexedModelNames) {
      if (!dataModelNames.has(name)) {
        await this.removeDirectory(join(this.repoDir, "models", name));
      }
    }

    // Index all models (creates new or updates existing)
    for (const { input, type } of allInputs) {
      await this.indexModel(type.normalized, input.id, input.name);
      modelsIndexed++;
    }

    // Get all workflows from data directory
    const allWorkflows = await this.workflowRepo.findAll();
    const dataWorkflowNames = new Set(allWorkflows.map((w) => w.name));

    // Get existing indexed workflow directories
    const indexedWorkflowNames = await this.getIndexedNames(
      join(this.repoDir, "workflows"),
    );

    // Remove indexes for workflows that no longer exist in data
    for (const name of indexedWorkflowNames) {
      if (!dataWorkflowNames.has(name)) {
        await this.removeDirectory(join(this.repoDir, "workflows", name));
      }
    }

    // Index all workflows and their runs
    for (const workflow of allWorkflows) {
      await this.indexWorkflow(workflow.id, workflow.name);
      workflowsIndexed++;

      // Get all runs for this workflow
      const runs = await this.workflowRunRepo.findAllByWorkflowId(workflow.id);

      // Index all runs
      for (const run of runs) {
        await this.indexWorkflowRun(workflow.id, workflow.name, run.id);
        workflowRunsIndexed++;
      }
    }

    // Index vaults if repository is available
    if (this.vaultConfigRepo) {
      const allVaults = await this.vaultConfigRepo.findAll();
      const dataVaultNames = new Set(allVaults.map((v) => v.name));

      // Get existing indexed vault directories
      const vaultsDir = join(this.repoDir, "vaults");
      const indexedVaultNames = await this.getIndexedNames(vaultsDir);

      // Remove indexes for vaults that no longer exist in data
      for (const name of indexedVaultNames) {
        if (!dataVaultNames.has(name)) {
          await this.removeDirectory(join(vaultsDir, name));
        }
      }

      // Index all vaults
      for (const vault of allVaults) {
        await this.indexVault(vault.id, vault.type, vault.name);
        vaultsIndexed++;
      }
    }

    return {
      modelsIndexed,
      workflowsIndexed,
      workflowRunsIndexed,
      vaultsIndexed,
    };
  }

  /**
   * Gets the names of indexed directories.
   */
  private async getIndexedNames(dir: string): Promise<Set<string>> {
    const names = new Set<string>();
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isDirectory || entry.isSymlink) {
          names.add(entry.name);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    return names;
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Creates or updates the index for a model.
   */
  private async indexModel(
    modelType: string,
    modelInputId: string,
    modelName: string,
  ): Promise<void> {
    const modelDir = join(this.repoDir, "models", modelName);
    await ensureDir(modelDir);

    // Symlink to input.yaml
    const inputTarget = join(
      ".data",
      "inputs",
      modelType,
      `${modelInputId}.yaml`,
    );
    await this.createSymlink(
      join(this.repoDir, inputTarget),
      join(modelDir, "input.yaml"),
    );

    // Symlink to resource.yaml if it exists
    const resourceTarget = join(
      ".data",
      "resources",
      modelType,
      `${modelInputId}.yaml`,
    );
    const resourcePath = join(this.repoDir, resourceTarget);
    if (await this.exists(resourcePath)) {
      await this.createSymlink(resourcePath, join(modelDir, "resource.yaml"));
    }

    // Symlink to data.yaml if it exists
    const dataTarget = join(".data", "data", modelType, `${modelInputId}.yaml`);
    const dataPath = join(this.repoDir, dataTarget);
    if (await this.exists(dataPath)) {
      await this.createSymlink(dataPath, join(modelDir, "data.yaml"));
    }

    // Symlink to logs directory if it exists
    const logsTarget = join(".data", "logs", modelType, modelInputId);
    const logsPath = join(this.repoDir, logsTarget);
    if (await this.exists(logsPath)) {
      await this.createSymlink(logsPath, join(modelDir, "logs"));
    }

    // Symlink to files directory if it exists
    const filesTarget = join(".data", "files", modelType, modelInputId);
    const filesPath = join(this.repoDir, filesTarget);
    if (await this.exists(filesPath)) {
      await this.createSymlink(filesPath, join(modelDir, "files"));
    }

    // Create outputs directory and symlink method directories
    const outputsDir = join(modelDir, "outputs");
    await ensureDir(outputsDir);

    // Scan for output method directories
    const methodsDir = join(this.repoDir, ".data", "outputs", modelType);
    if (await this.exists(methodsDir)) {
      try {
        for await (const entry of Deno.readDir(methodsDir)) {
          if (entry.isDirectory) {
            const methodName = entry.name;
            const methodTarget = join(methodsDir, methodName);
            await this.createSymlink(
              methodTarget,
              join(outputsDir, methodName),
            );
          }
        }
      } catch (error) {
        logger.debug`Failed to read outputs directory: ${error}`;
      }
    }
  }

  /**
   * Creates or updates the index for a workflow.
   */
  private async indexWorkflow(
    workflowId: string,
    workflowName: string,
  ): Promise<void> {
    const workflowDir = join(this.repoDir, "workflows", workflowName);
    await ensureDir(workflowDir);

    // Symlink to workflow.yaml
    const workflowTarget = join(
      this.repoDir,
      ".data",
      "workflows",
      `workflow-${workflowId}.yaml`,
    );
    await this.createSymlink(
      workflowTarget,
      join(workflowDir, "workflow.yaml"),
    );

    // Ensure runs directory exists
    await ensureDir(join(workflowDir, "runs"));
  }

  /**
   * Creates or updates the index for a workflow run.
   */
  private async indexWorkflowRun(
    workflowId: string,
    workflowName: string,
    runId: string,
  ): Promise<void> {
    const workflowDir = join(this.repoDir, "workflows", workflowName);
    const runsDir = join(workflowDir, "runs");
    await ensureDir(runsDir);

    // Get the run to extract timestamp
    const run = await this.workflowRunRepo.findById(
      createWorkflowId(workflowId),
      createWorkflowRunId(runId),
    );

    if (!run) {
      return;
    }

    // Use startedAt as the timestamp, or run ID if not started
    const timestamp = run.startedAt
      ? run.startedAt.toISOString().replace(/[:.]/g, "-")
      : runId;

    const runDir = join(runsDir, timestamp);
    await ensureDir(runDir);

    // Symlink to run.yaml
    const runTarget = join(
      this.repoDir,
      ".data",
      "workflow-runs",
      workflowId,
      `workflow-run-${runId}.yaml`,
    );
    await this.createSymlink(runTarget, join(runDir, "run.yaml"));

    // Update latest symlink
    await this.updateLatestSymlink(runsDir, timestamp);

    // Create steps directory if run has jobs
    if (run.jobs.length > 0) {
      const stepsDir = join(runDir, "steps");
      await ensureDir(stepsDir);

      for (const job of run.jobs) {
        for (const step of job.steps) {
          const stepDir = join(stepsDir, step.stepName);
          await ensureDir(stepDir);

          // Note: Step output symlinks would require additional context
          // about which model was executed. This can be enhanced later
          // when step execution records the model name.
        }
      }
    }
  }

  /**
   * Creates or updates the index for a vault.
   * Structure: /vaults/{vault-name}/vault.yaml -> /.data/vault/{vault-type}/{id}.yaml
   */
  private async indexVault(
    vaultId: string,
    vaultType: string,
    vaultName: string,
  ): Promise<void> {
    const vaultDir = join(this.repoDir, "vaults", vaultName);
    await ensureDir(vaultDir);

    // Symlink to vault.yaml
    const vaultTarget = join(
      this.repoDir,
      ".data",
      "vault",
      vaultType,
      `${vaultId}.yaml`,
    );
    await this.createSymlink(vaultTarget, join(vaultDir, "vault.yaml"));
  }

  /**
   * Updates the "latest" symlink to point to the most recent run.
   */
  private async updateLatestSymlink(
    runsDir: string,
    currentTimestamp: string,
  ): Promise<void> {
    const latestPath = join(runsDir, "latest");

    // Find all run directories and determine the latest
    let latestTimestamp = currentTimestamp;

    try {
      for await (const entry of Deno.readDir(runsDir)) {
        if (entry.isDirectory && entry.name !== "latest") {
          if (entry.name > latestTimestamp) {
            latestTimestamp = entry.name;
          }
        }
      }
    } catch (error) {
      logger.debug`Failed to read runs directory for latest symlink: ${error}`;
    }

    // Create symlink to the latest directory
    const targetDir = join(runsDir, latestTimestamp);
    await this.createSymlink(targetDir, latestPath);
  }

  /**
   * Creates a symlink atomically using temp + rename pattern.
   *
   * This avoids race conditions by creating the symlink at a temporary path
   * and then atomically renaming it to the final location.
   */
  private async createSymlink(target: string, path: string): Promise<void> {
    // Calculate relative path from symlink location to target
    const linkDir = join(path, "..");
    const relativeTarget = relative(linkDir, target);

    // Determine if target is a directory for symlink type
    let isDirectory = false;
    try {
      const stat = await Deno.stat(target);
      isDirectory = stat.isDirectory;
    } catch (error) {
      // Target doesn't exist yet, assume file
      logger.debug`Target ${target} doesn't exist yet, assuming file: ${error}`;
    }

    // Create symlink with appropriate options
    const symlinkType = this.mode === "junction" && isDirectory
      ? "junction"
      : isDirectory
      ? "dir"
      : "file";

    // Create a temporary symlink path
    const tempPath = `${path}.tmp.${crypto.randomUUID()}`;

    try {
      // Create symlink at temp location
      await Deno.symlink(relativeTarget, tempPath, { type: symlinkType });
    } catch (error) {
      // On Windows, if symlinks fail, try with type: "junction" for directories
      if (
        Deno.build.os === "windows" &&
        error instanceof Deno.errors.PermissionDenied
      ) {
        if (isDirectory) {
          await Deno.symlink(relativeTarget, tempPath, { type: "junction" });
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    // Atomically rename temp symlink to final path
    try {
      await Deno.rename(tempPath, path);
    } catch (error) {
      // Clean up temp symlink on failure
      try {
        await Deno.remove(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Removes a directory and all its contents.
   */
  private async removeDirectory(path: string): Promise<void> {
    try {
      await Deno.remove(path, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  /**
   * Checks if a path exists.
   */
  private async exists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Recursively verifies symlinks in a directory.
   */
  private async verifyDirectory(
    dir: string,
    brokenLinks: string[],
    missingTargets: string[],
  ): Promise<void> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        const fullPath = join(dir, entry.name);

        if (entry.isSymlink) {
          // Check if the symlink target exists
          try {
            await Deno.stat(fullPath);
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) {
              brokenLinks.push(fullPath);

              // Try to get the target
              try {
                const target = await Deno.readLink(fullPath);
                missingTargets.push(target);
              } catch (readLinkError) {
                logger
                  .debug`Failed to read link target for ${fullPath}: ${readLinkError}`;
              }
            }
          }
        } else if (entry.isDirectory) {
          await this.verifyDirectory(fullPath, brokenLinks, missingTargets);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  /**
   * Recursively removes broken symlinks in a directory.
   */
  private async pruneDirectory(
    dir: string,
    removedLinks: string[],
  ): Promise<void> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        const fullPath = join(dir, entry.name);

        if (entry.isSymlink) {
          // Check if the symlink target exists
          try {
            await Deno.stat(fullPath);
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) {
              // Remove broken symlink
              await Deno.remove(fullPath);
              removedLinks.push(fullPath);
            }
          }
        } else if (entry.isDirectory) {
          await this.pruneDirectory(fullPath, removedLinks);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
}
