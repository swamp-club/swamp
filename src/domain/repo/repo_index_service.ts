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

export interface VerifyResult {
  valid: boolean;
  brokenLinks: string[];
  missingTargets: string[];
}

export interface PruneResult {
  removedLinks: string[];
}

export interface RebuildResult {
  modelsIndexed: number;
  workflowsIndexed: number;
  workflowRunsIndexed: number;
  vaultsIndexed: number;
}

export interface RepoIndexService {
  handleModelCreated(event: ModelCreated): Promise<void>;

  handleModelUpdated(event: ModelUpdated): Promise<void>;

  handleModelDeleted(event: ModelDeleted): Promise<void>;

  handleWorkflowCreated(event: WorkflowCreated): Promise<void>;

  handleWorkflowUpdated(event: WorkflowUpdated): Promise<void>;

  handleWorkflowDeleted(event: WorkflowDeleted): Promise<void>;

  handleWorkflowRunStarted(event: WorkflowRunStarted): Promise<void>;

  handleWorkflowRunCompleted(event: WorkflowRunCompleted): Promise<void>;

  handleWorkflowRunFailed(event: WorkflowRunFailed): Promise<void>;

  handleVaultCreated(event: VaultCreated): Promise<void>;

  handleVaultUpdated(event: VaultUpdated): Promise<void>;

  handleVaultDeleted(event: VaultDeleted): Promise<void>;

  handleVaultSecretUpdated(event: VaultSecretUpdated): Promise<void>;

  verify(): Promise<VerifyResult>;

  prune(): Promise<PruneResult>;

  rebuildAll(): Promise<RebuildResult>;
}
