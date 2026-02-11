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
 * Domain Events for the swamp repository system.
 *
 * These events are emitted by repositories when mutations occur,
 * allowing the RepoIndexService to maintain logical views.
 */

/**
 * Base interface for all domain events.
 */
export interface DomainEvent {
  readonly type: string;
  readonly timestamp: Date;
}

// ============================================================================
// Model Events
// ============================================================================

/**
 * Emitted when a new model input is created.
 */
export interface ModelCreated extends DomainEvent {
  readonly type: "ModelCreated";
  readonly modelType: string;
  readonly modelInputId: string;
  readonly modelName: string;
}

/**
 * Emitted when a model input or its associated artifacts are updated.
 */
export interface ModelUpdated extends DomainEvent {
  readonly type: "ModelUpdated";
  readonly modelType: string;
  readonly modelInputId: string;
  readonly modelName: string;
}

/**
 * Emitted when a model input is deleted.
 */
export interface ModelDeleted extends DomainEvent {
  readonly type: "ModelDeleted";
  readonly modelType: string;
  readonly modelInputId: string;
  readonly modelName: string;
}

// ============================================================================
// Definition Events
// ============================================================================

/**
 * Emitted when a new definition is created.
 */
export interface DefinitionCreated extends DomainEvent {
  readonly type: "DefinitionCreated";
  readonly modelType: string;
  readonly definitionId: string;
  readonly definitionName: string;
}

/**
 * Emitted when a definition is updated.
 */
export interface DefinitionUpdated extends DomainEvent {
  readonly type: "DefinitionUpdated";
  readonly modelType: string;
  readonly definitionId: string;
  readonly definitionName: string;
}

/**
 * Emitted when a definition is deleted.
 */
export interface DefinitionDeleted extends DomainEvent {
  readonly type: "DefinitionDeleted";
  readonly modelType: string;
  readonly definitionId: string;
  readonly definitionName: string;
}

// ============================================================================
// Workflow Events
// ============================================================================

/**
 * Emitted when a new workflow is created.
 */
export interface WorkflowCreated extends DomainEvent {
  readonly type: "WorkflowCreated";
  readonly workflowId: string;
  readonly workflowName: string;
}

/**
 * Emitted when a workflow is updated.
 */
export interface WorkflowUpdated extends DomainEvent {
  readonly type: "WorkflowUpdated";
  readonly workflowId: string;
  readonly workflowName: string;
}

/**
 * Emitted when a workflow is deleted.
 */
export interface WorkflowDeleted extends DomainEvent {
  readonly type: "WorkflowDeleted";
  readonly workflowId: string;
  readonly workflowName: string;
}

// ============================================================================
// WorkflowRun Events
// ============================================================================

/**
 * Emitted when a workflow run starts execution.
 */
export interface WorkflowRunStarted extends DomainEvent {
  readonly type: "WorkflowRunStarted";
  readonly workflowId: string;
  readonly workflowName: string;
  readonly runId: string;
}

/**
 * Emitted when a workflow run completes successfully.
 */
export interface WorkflowRunCompleted extends DomainEvent {
  readonly type: "WorkflowRunCompleted";
  readonly workflowId: string;
  readonly workflowName: string;
  readonly runId: string;
}

/**
 * Emitted when a workflow run fails.
 */
export interface WorkflowRunFailed extends DomainEvent {
  readonly type: "WorkflowRunFailed";
  readonly workflowId: string;
  readonly workflowName: string;
  readonly runId: string;
}

// ============================================================================
// Event Type Union
// ============================================================================

/**
 * Union type of all domain events.
 */
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
  | VaultSecretUpdated;

/**
 * Event type discriminator values.
 */
export type EventType = RepositoryEvent["type"];

// ============================================================================
// Event Factory Functions
// ============================================================================

/**
 * Creates a ModelCreated event.
 */
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

/**
 * Creates a ModelUpdated event.
 */
export function createModelUpdated(
  modelType: string,
  modelInputId: string,
  modelName: string,
): ModelUpdated {
  return {
    type: "ModelUpdated",
    modelType,
    modelInputId,
    modelName,
    timestamp: new Date(),
  };
}

/**
 * Creates a ModelDeleted event.
 */
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

/**
 * Creates a DefinitionCreated event.
 */
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

/**
 * Creates a DefinitionUpdated event.
 */
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

/**
 * Creates a DefinitionDeleted event.
 */
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

/**
 * Creates a WorkflowCreated event.
 */
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

/**
 * Creates a WorkflowUpdated event.
 */
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

/**
 * Creates a WorkflowDeleted event.
 */
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

/**
 * Creates a WorkflowRunStarted event.
 */
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

/**
 * Creates a WorkflowRunCompleted event.
 */
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

/**
 * Creates a WorkflowRunFailed event.
 */
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

// ============================================================================
// Vault Events
// ============================================================================

/**
 * Emitted when a new vault configuration is created.
 */
export interface VaultCreated extends DomainEvent {
  readonly type: "VaultCreated";
  readonly vaultId: string;
  readonly vaultType: string;
  readonly vaultName: string;
}

/**
 * Emitted when a vault configuration is updated.
 */
export interface VaultUpdated extends DomainEvent {
  readonly type: "VaultUpdated";
  readonly vaultId: string;
  readonly vaultType: string;
  readonly vaultName: string;
}

/**
 * Emitted when a vault configuration is deleted.
 */
export interface VaultDeleted extends DomainEvent {
  readonly type: "VaultDeleted";
  readonly vaultId: string;
  readonly vaultType: string;
  readonly vaultName: string;
}

/**
 * Emitted when a secret is added or updated in a vault.
 */
export interface VaultSecretUpdated extends DomainEvent {
  readonly type: "VaultSecretUpdated";
  readonly vaultId: string;
  readonly vaultType: string;
  readonly vaultName: string;
  readonly secretKey: string;
}

/**
 * Creates a VaultCreated event.
 */
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

/**
 * Creates a VaultUpdated event.
 */
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

/**
 * Creates a VaultDeleted event.
 */
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

/**
 * Creates a VaultSecretUpdated event.
 */
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
