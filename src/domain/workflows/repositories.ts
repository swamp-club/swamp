import type { WorkflowId, WorkflowRunId } from "./workflow_id.ts";
import type { Workflow } from "./workflow.ts";
import type { WorkflowRun } from "./workflow_run.ts";

/**
 * Repository interface for Workflow aggregate persistence.
 */
export interface WorkflowRepository {
  /**
   * Finds a workflow by ID.
   */
  findById(id: WorkflowId): Promise<Workflow | null>;

  /**
   * Finds a workflow by name.
   */
  findByName(name: string): Promise<Workflow | null>;

  /**
   * Finds all workflows.
   */
  findAll(): Promise<Workflow[]>;

  /**
   * Saves a workflow.
   */
  save(workflow: Workflow): Promise<void>;

  /**
   * Deletes a workflow.
   */
  delete(id: WorkflowId): Promise<void>;

  /**
   * Generates a new workflow ID.
   */
  nextId(): WorkflowId;

  /**
   * Gets the file path for a workflow.
   */
  getPath(id: WorkflowId): string;
}

/**
 * Repository interface for WorkflowRun aggregate persistence.
 */
export interface WorkflowRunRepository {
  /**
   * Finds a workflow run by ID.
   */
  findById(
    workflowId: WorkflowId,
    runId: WorkflowRunId,
  ): Promise<WorkflowRun | null>;

  /**
   * Finds all runs for a workflow.
   */
  findAllByWorkflowId(workflowId: WorkflowId): Promise<WorkflowRun[]>;

  /**
   * Finds the most recent run for a workflow.
   */
  findLatestByWorkflowId(workflowId: WorkflowId): Promise<WorkflowRun | null>;

  /**
   * Saves a workflow run.
   */
  save(workflowId: WorkflowId, run: WorkflowRun): Promise<void>;

  /**
   * Generates a new workflow run ID.
   */
  nextId(): WorkflowRunId;

  /**
   * Gets the file path for a workflow run.
   */
  getPath(workflowId: WorkflowId, runId: WorkflowRunId): string;
}
