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
 * No-op implementation of RepoIndexService.
 *
 * Replaces the SymlinkRepoIndexService. All event handlers and
 * maintenance operations are no-ops since logical views are no longer
 * maintained via symlinks.
 */

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
  VaultSecretUpdated,
  VaultUpdated,
  WorkflowCreated,
  WorkflowDeleted,
  WorkflowRunCompleted,
  WorkflowRunFailed,
  WorkflowRunStarted,
  WorkflowUpdated,
} from "../../domain/events/types.ts";

export class NoopRepoIndexService implements RepoIndexService {
  handleModelCreated(_event: ModelCreated): Promise<void> {
    return Promise.resolve();
  }

  handleModelUpdated(_event: ModelUpdated): Promise<void> {
    return Promise.resolve();
  }

  handleModelDeleted(_event: ModelDeleted): Promise<void> {
    return Promise.resolve();
  }

  handleWorkflowCreated(_event: WorkflowCreated): Promise<void> {
    return Promise.resolve();
  }

  handleWorkflowUpdated(_event: WorkflowUpdated): Promise<void> {
    return Promise.resolve();
  }

  handleWorkflowDeleted(_event: WorkflowDeleted): Promise<void> {
    return Promise.resolve();
  }

  handleWorkflowRunStarted(_event: WorkflowRunStarted): Promise<void> {
    return Promise.resolve();
  }

  handleWorkflowRunCompleted(_event: WorkflowRunCompleted): Promise<void> {
    return Promise.resolve();
  }

  handleWorkflowRunFailed(_event: WorkflowRunFailed): Promise<void> {
    return Promise.resolve();
  }

  handleVaultCreated(_event: VaultCreated): Promise<void> {
    return Promise.resolve();
  }

  handleVaultUpdated(_event: VaultUpdated): Promise<void> {
    return Promise.resolve();
  }

  handleVaultDeleted(_event: VaultDeleted): Promise<void> {
    return Promise.resolve();
  }

  handleVaultSecretUpdated(_event: VaultSecretUpdated): Promise<void> {
    return Promise.resolve();
  }

  verify(): Promise<VerifyResult> {
    return Promise.resolve({
      valid: true,
      brokenLinks: [],
      missingTargets: [],
    });
  }

  prune(): Promise<PruneResult> {
    return Promise.resolve({ removedLinks: [] });
  }

  rebuildAll(): Promise<RebuildResult> {
    return Promise.resolve({
      modelsIndexed: 0,
      workflowsIndexed: 0,
      workflowRunsIndexed: 0,
      vaultsIndexed: 0,
    });
  }
}
