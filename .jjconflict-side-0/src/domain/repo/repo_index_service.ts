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
 * RepoIndexService maintains logical views of the repository data.
 *
 * Logical views are symlinked directories that provide human/agent-friendly
 * exploration of the data directory, organized by model name and workflow name
 * rather than by type and UUID.
 */

import type {
  ModelCreated,
  ModelDeleted,
  ModelUpdated,
  VaultCreated,
  VaultDeleted,
  VaultSecretUpdated,
  VaultUpdated,
  WorkflowCreated,
  WorkflowDeleted,
  WorkflowRunCompleted,
  WorkflowRunFailed,
  WorkflowRunStarted,
  WorkflowUpdated,
} from "../events/types.ts";

/**
 * Result of a verify operation.
 */
export interface VerifyResult {
  valid: boolean;
  brokenLinks: string[];
  missingTargets: string[];
}

/**
 * Result of a prune operation.
 */
export interface PruneResult {
  removedLinks: string[];
}

/**
 * Result of a rebuild operation.
 */
export interface RebuildResult {
  modelsIndexed: number;
  workflowsIndexed: number;
  workflowRunsIndexed: number;
  vaultsIndexed: number;
}

/**
 * RepoIndexService interface for maintaining logical repository views.
 *
 * The service creates and maintains three logical view directories:
 *
 * Model View (`/models/{model-name}/`):
 * ```
 * definition.yaml → /.swamp/definitions/{type}/{id}.yaml
 * type/
 *   logs/         → symlinks to data with type=log tag
 *   files/        → symlinks to data with type=file tag
 *   resources/    → symlinks to data with type=resource tag
 * {tag-key}/{tag-value}/ → data organized by custom tag key/value pairs
 * outputs/
 *   {method}/     → /.swamp/outputs/{type}/{method}/
 * ```
 *
 * Workflow View (`/workflows/{workflow-name}/`):
 * ```
 * workflow.yaml   → ../.swamp/workflows/workflow-{id}.yaml
 * runs/
 *   latest/       → {latest-timestamp}/
 *   {timestamp}/
 *     run.yaml    → ../.swamp/workflow-runs/{workflow-id}/workflow-run-{run-id}.yaml
 *     steps/
 *       {step-name}/
 *         output.yaml → symlink to step output
 *         model/      → ../models/{model-name}/
 * ```
 *
 * Vault View (`/vaults/{vault-name}/`):
 * ```
 * vault.yaml      → ../.swamp/vault/{vault-type}/{id}.yaml
 * ```
 */
export interface RepoIndexService {
  // ============================================================================
  // Model Event Handlers
  // ============================================================================

  /**
   * Handles a ModelCreated event.
   * Creates the model view directory with symlinks.
   */
  handleModelCreated(event: ModelCreated): Promise<void>;

  /**
   * Handles a ModelUpdated event.
   * Updates symlinks for changed artifacts.
   */
  handleModelUpdated(event: ModelUpdated): Promise<void>;

  /**
   * Handles a ModelDeleted event.
   * Removes the model view directory.
   */
  handleModelDeleted(event: ModelDeleted): Promise<void>;

  // ============================================================================
  // Workflow Event Handlers
  // ============================================================================

  /**
   * Handles a WorkflowCreated event.
   * Creates the workflow view directory with symlinks.
   */
  handleWorkflowCreated(event: WorkflowCreated): Promise<void>;

  /**
   * Handles a WorkflowUpdated event.
   * Updates symlinks for the workflow definition.
   */
  handleWorkflowUpdated(event: WorkflowUpdated): Promise<void>;

  /**
   * Handles a WorkflowDeleted event.
   * Removes the workflow view directory.
   */
  handleWorkflowDeleted(event: WorkflowDeleted): Promise<void>;

  // ============================================================================
  // WorkflowRun Event Handlers
  // ============================================================================

  /**
   * Handles a WorkflowRunStarted event.
   * Creates the run directory and updates the latest symlink.
   */
  handleWorkflowRunStarted(event: WorkflowRunStarted): Promise<void>;

  /**
   * Handles a WorkflowRunCompleted event.
   * Updates step output symlinks.
   */
  handleWorkflowRunCompleted(event: WorkflowRunCompleted): Promise<void>;

  /**
   * Handles a WorkflowRunFailed event.
   * Updates step output symlinks for the failed run.
   */
  handleWorkflowRunFailed(event: WorkflowRunFailed): Promise<void>;

  // ============================================================================
  // Vault Event Handlers
  // ============================================================================

  /**
   * Handles a VaultCreated event.
   * Creates the vault view directory with symlinks.
   */
  handleVaultCreated(event: VaultCreated): Promise<void>;

  /**
   * Handles a VaultUpdated event.
   * Updates symlinks for the vault configuration.
   */
  handleVaultUpdated(event: VaultUpdated): Promise<void>;

  /**
   * Handles a VaultDeleted event.
   * Removes the vault view directory.
   */
  handleVaultDeleted(event: VaultDeleted): Promise<void>;

  /**
   * Handles a VaultSecretUpdated event.
   * Updates the secrets symlinks for the vault.
   */
  handleVaultSecretUpdated(event: VaultSecretUpdated): Promise<void>;

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  /**
   * Verifies the integrity of all symlinks.
   *
   * @returns Verification result with broken links
   */
  verify(): Promise<VerifyResult>;

  /**
   * Removes broken symlinks without rebuilding.
   *
   * @returns Prune result with removed links
   */
  prune(): Promise<PruneResult>;

  /**
   * Rebuilds all logical views from scratch.
   *
   * Deletes existing /models/ and /workflows/ directories
   * and recreates them from the /.swamp/ directory.
   *
   * @returns Rebuild result with counts
   */
  rebuildAll(): Promise<RebuildResult>;
}
