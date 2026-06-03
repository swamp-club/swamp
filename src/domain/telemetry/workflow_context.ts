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
 * Captures the workflow context surrounding a method invocation that
 * happened inside a workflow run. Present only on child telemetry entries
 * — direct CLI invocations and parent workflow-run entries omit it.
 *
 * Fields are individually optional so the bridge can populate what is
 * known at the failure point. For example, a step that fails before the
 * model can be resolved leaves `modelType` undefined; a step that fails
 * before DriverPlan resolution leaves `driver` undefined.
 */
export interface WorkflowContext {
  readonly workflowName: string;
  readonly runId: string;
  readonly jobName: string;
  readonly stepName: string;
  readonly modelType?: string;
  readonly driver?: string;
}

/**
 * Data transfer object for WorkflowContext.
 */
export interface WorkflowContextData {
  workflowName: string;
  runId: string;
  jobName: string;
  stepName: string;
  modelType?: string;
  driver?: string;
}

/**
 * Creates a WorkflowContext value object.
 */
export function createWorkflowContext(
  props: WorkflowContextData,
): WorkflowContext {
  return {
    workflowName: props.workflowName,
    runId: props.runId,
    jobName: props.jobName,
    stepName: props.stepName,
    modelType: props.modelType,
    driver: props.driver,
  };
}

/**
 * Converts a WorkflowContext to its data representation.
 */
export function workflowContextToData(
  context: WorkflowContext,
): WorkflowContextData {
  const data: WorkflowContextData = {
    workflowName: context.workflowName,
    runId: context.runId,
    jobName: context.jobName,
    stepName: context.stepName,
  };
  if (context.modelType !== undefined) {
    data.modelType = context.modelType;
  }
  if (context.driver !== undefined) {
    data.driver = context.driver;
  }
  return data;
}

/**
 * Reconstructs a WorkflowContext from data.
 */
export function workflowContextFromData(
  data: WorkflowContextData,
): WorkflowContext {
  return createWorkflowContext(data);
}
