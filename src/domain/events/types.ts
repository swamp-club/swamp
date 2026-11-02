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

export interface DomainEvent {
  readonly type: string;
  readonly timestamp: Date;
}

export interface ModelCreated extends DomainEvent {
  readonly type: "ModelCreated";
  readonly modelType: string;
  readonly modelInputId: string;
  readonly modelName: string;
}

export interface ModelUpdated extends DomainEvent {
  readonly type: "ModelUpdated";
  readonly modelType: string;
  readonly modelInputId: string;
  readonly modelName: string;
  /**
   * serve on a filesystem datastore matches them against the versions it sees
   * on disk to tell its own writes from a peer's
   */
  readonly dataVersions?: readonly DataVersionRef[];
}

export interface DataVersionRef {
  readonly name: string;
  readonly version: number;
}

export interface ModelDeleted extends DomainEvent {
  readonly type: "ModelDeleted";
  readonly modelType: string;
  readonly modelInputId: string;
  readonly modelName: string;
}

export interface DefinitionCreated extends DomainEvent {
  readonly type: "DefinitionCreated";
  readonly modelType: string;
  readonly definitionId: string;
  readonly definitionName: string;
}

export interface DefinitionUpdated extends DomainEvent {
  readonly type: "DefinitionUpdated";
  readonly modelType: string;
  readonly definitionId: string;
  readonly definitionName: string;
}

export interface DefinitionDeleted extends DomainEvent {
  readonly type: "DefinitionDeleted";
  readonly modelType: string;
  readonly definitionId: string;
  readonly definitionName: string;
}

export interface WorkflowCreated extends DomainEvent {
  readonly type: "WorkflowCreated";
  readonly workflowId: string;
  readonly workflowName: string;
}

export interface WorkflowUpdated extends DomainEvent {
  readonly type: "WorkflowUpdated";
  readonly workflowId: string;
  readonly workflowName: string;
}

export interface WorkflowDeleted extends DomainEvent {
  readonly type: "WorkflowDeleted";
  readonly workflowId: string;
  readonly workflowName: string;
}

export interface WorkflowRunStarted extends DomainEvent {
  readonly type: "WorkflowRunStarted";
  readonly workflowId: string;
  readonly workflowName: string;
  readonly runId: string;
}

export interface WorkflowRunCompleted extends DomainEvent {
  readonly type: "WorkflowRunCompleted";
  readonly workflowId: string;
  readonly workflowName: string;
  readonly runId: string;
}

export interface WorkflowRunFailed extends DomainEvent {
  readonly type: "WorkflowRunFailed";
  readonly workflowId: string;
  readonly workflowName: string;
  readonly runId: string;
}

export type RepositoryEvent =
  | ModelCreated
  | ModelUpdated
  | ModelDeleted
  | DefinitionCreated
  | DefinitionUpdated
  | DefinitionDeleted
  | WorkflowCreated
  | WorkflowUpdated
  | WorkflowDeleted
  | WorkflowRunStarted
  | WorkflowRunCompleted
  | WorkflowRunFailed
  | VaultCreated
  | VaultUpdated
  | VaultDeleted
  | VaultSecretUpdated
  | VaultSecretDeleted
  | VaultSecretRead
  | VaultSecretAnnotated;

export type EventType = RepositoryEvent["type"];

export function createModelCreated(
  modelType: string,
  modelInputId: string,
  modelName: string,
): ModelCreated {
  return {
    type: "ModelCreated",
    modelType,
    modelInputId,
    modelName,
    timestamp: new Date(),
  };
}

export function createModelUpdated(
  modelType: string,
  modelInputId: string,
  modelName: string,
  dataVersions?: readonly DataVersionRef[],
): ModelUpdated {
  return {
    type: "ModelUpdated",
    modelType,
    modelInputId,
    modelName,
    timestamp: new Date(),
    ...(dataVersions ? { dataVersions } : {}),
  };
}

export function createModelDeleted(
  modelType: string,
  modelInputId: string,
  modelName: string,
): ModelDeleted {
  return {
    type: "ModelDeleted",
    modelType,
    modelInputId,
    modelName,
    timestamp: new Date(),
  };
}

export function createDefinitionCreated(
  modelType: string,
  definitionId: string,
  definitionName: string,
): DefinitionCreated {
  return {
    type: "DefinitionCreated",
    modelType,
    definitionId,
    definitionName,
    timestamp: new Date(),
  };
}

export function createDefinitionUpdated(
  modelType: string,
  definitionId: string,
  definitionName: string,
): DefinitionUpdated {
  return {
    type: "DefinitionUpdated",
    modelType,
    definitionId,
    definitionName,
    timestamp: new Date(),
  };
}

export function createDefinitionDeleted(
  modelType: string,
  definitionId: string,
  definitionName: string,
): DefinitionDeleted {
  return {
    type: "DefinitionDeleted",
    modelType,
    definitionId,
    definitionName,
    timestamp: new Date(),
  };
}

export function createWorkflowCreated(
  workflowId: string,
  workflowName: string,
): WorkflowCreated {
  return {
    type: "WorkflowCreated",
    workflowId,
    workflowName,
    timestamp: new Date(),
  };
}

export function createWorkflowUpdated(
  workflowId: string,
  workflowName: string,
): WorkflowUpdated {
  return {
    type: "WorkflowUpdated",
    workflowId,
    workflowName,
    timestamp: new Date(),
  };
}

export function createWorkflowDeleted(
  workflowId: string,
  workflowName: string,
): WorkflowDeleted {
  return {
    type: "WorkflowDeleted",
    workflowId,
    workflowName,
    timestamp: new Date(),
  };
}

export function createWorkflowRunStarted(
  workflowId: string,
  workflowName: string,
  runId: string,
): WorkflowRunStarted {
  return {
    type: "WorkflowRunStarted",
    workflowId,
    workflowName,
    runId,
    timestamp: new Date(),
  };
}

export function createWorkflowRunCompleted(
  workflowId: string,
  workflowName: string,
  runId: string,
): WorkflowRunCompleted {
  return {
    type: "WorkflowRunCompleted",
    workflowId,
    workflowName,
    runId,
    timestamp: new Date(),
  };
}

export function createWorkflowRunFailed(
  workflowId: string,
  workflowName: string,
  runId: string,
): WorkflowRunFailed {
  return {
    type: "WorkflowRunFailed",
    workflowId,
    workflowName,
    runId,
    timestamp: new Date(),
  };
}

export interface VaultCreated extends DomainEvent {
  readonly type: "VaultCreated";
  readonly vaultId: string;
  readonly vaultType: string;
  readonly vaultName: string;
}

export interface VaultUpdated extends DomainEvent {
  readonly type: "VaultUpdated";
  readonly vaultId: string;
  readonly vaultType: string;
  readonly vaultName: string;
}

export interface VaultDeleted extends DomainEvent {
  readonly type: "VaultDeleted";
  readonly vaultId: string;
  readonly vaultType: string;
  readonly vaultName: string;
}

export interface VaultSecretUpdated extends DomainEvent {
  readonly type: "VaultSecretUpdated";
  readonly vaultId: string;
  readonly vaultType: string;
  readonly vaultName: string;
  readonly secretKey: string;
}

export function createVaultCreated(
  vaultId: string,
  vaultType: string,
  vaultName: string,
): VaultCreated {
  return {
    type: "VaultCreated",
    vaultId,
    vaultType,
    vaultName,
    timestamp: new Date(),
  };
}

export function createVaultUpdated(
  vaultId: string,
  vaultType: string,
  vaultName: string,
): VaultUpdated {
  return {
    type: "VaultUpdated",
    vaultId,
    vaultType,
    vaultName,
    timestamp: new Date(),
  };
}

export function createVaultDeleted(
  vaultId: string,
  vaultType: string,
  vaultName: string,
): VaultDeleted {
  return {
    type: "VaultDeleted",
    vaultId,
    vaultType,
    vaultName,
    timestamp: new Date(),
  };
}

export interface VaultSecretDeleted extends DomainEvent {
  readonly type: "VaultSecretDeleted";
  readonly vaultId: string;
  readonly vaultType: string;
  readonly vaultName: string;
  readonly secretKey: string;
}

export function createVaultSecretDeleted(
  vaultId: string,
  vaultType: string,
  vaultName: string,
  secretKey: string,
): VaultSecretDeleted {
  return {
    type: "VaultSecretDeleted",
    vaultId,
    vaultType,
    vaultName,
    secretKey,
    timestamp: new Date(),
  };
}

export interface VaultSecretRead extends DomainEvent {
  readonly type: "VaultSecretRead";
  readonly vaultId: string;
  readonly vaultType: string;
  readonly vaultName: string;
  readonly secretKey: string;
}

export function createVaultSecretUpdated(
  vaultId: string,
  vaultType: string,
  vaultName: string,
  secretKey: string,
): VaultSecretUpdated {
  return {
    type: "VaultSecretUpdated",
    vaultId,
    vaultType,
    vaultName,
    secretKey,
    timestamp: new Date(),
  };
}

export function createVaultSecretRead(
  vaultId: string,
  vaultType: string,
  vaultName: string,
  secretKey: string,
): VaultSecretRead {
  return {
    type: "VaultSecretRead",
    vaultId,
    vaultType,
    vaultName,
    secretKey,
    timestamp: new Date(),
  };
}

export interface VaultSecretAnnotated extends DomainEvent {
  readonly type: "VaultSecretAnnotated";
  readonly vaultId: string;
  readonly vaultType: string;
  readonly vaultName: string;
  readonly secretKey: string;
  readonly annotationFields: readonly string[];
}

export function createVaultSecretAnnotated(
  vaultId: string,
  vaultType: string,
  vaultName: string,
  secretKey: string,
  annotationFields: string[],
): VaultSecretAnnotated {
  return {
    type: "VaultSecretAnnotated",
    vaultId,
    vaultType,
    vaultName,
    secretKey,
    annotationFields,
    timestamp: new Date(),
  };
}
