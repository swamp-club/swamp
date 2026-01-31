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
  | WorkflowCreated
  | WorkflowUpdated
  | WorkflowDeleted
  | WorkflowRunStarted
  | WorkflowRunCompleted
  | WorkflowRunFailed
  | VaultCreated
  | VaultUpdated
  | VaultDeleted;

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
