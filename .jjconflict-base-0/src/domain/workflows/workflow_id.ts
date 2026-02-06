/**
 * Branded type for Workflow IDs.
 */
export type WorkflowId = string & { readonly _brand: unique symbol };

/**
 * Creates a WorkflowId from a string.
 */
export function createWorkflowId(id: string): WorkflowId {
  return id as WorkflowId;
}

/**
 * Branded type for WorkflowRun IDs.
 */
export type WorkflowRunId = string & { readonly _brand: unique symbol };

/**
 * Creates a WorkflowRunId from a string.
 */
export function createWorkflowRunId(id: string): WorkflowRunId {
  return id as WorkflowRunId;
}
