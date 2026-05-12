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

import type { Logger } from "@logtape/logtape";
import type { DataHandle } from "../models/model.ts";
import type { DataArtifactRef } from "../models/model_output.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import {
  executeReports,
  type ReportEventCallback,
  type ReportFilterOptions,
} from "../reports/report_execution_service.ts";
import { reportRegistry } from "../reports/report_registry.ts";
import type { WorkflowReportContext } from "../reports/report_context.ts";
import { BUILTIN_WORKFLOW_REPORTS } from "../reports/builtin/mod.ts";
import { ModelType } from "../models/model_type.ts";
import type { Workflow } from "./workflow.ts";
import type { WorkflowExecutionEvent } from "./execution_events.ts";

/**
 * Per-step execution detail collected during workflow execution.
 *
 * Built up as the service yields `model_resolved` and `step_completed`
 * events so the workflow-scope report context can describe what each
 * step did.
 */
export interface WorkflowStepExecutionDetail {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: DataHandle[];
  methodArgs: Record<string, unknown>;
  modelId: string;
  globalArgs: Record<string, unknown>;
}

/**
 * Inputs for running workflow-scope reports after a workflow completes.
 */
export interface WorkflowReportArgs {
  workflow: Workflow;
  workflowRunId: string;
  workflowStatus: "succeeded" | "failed";
  stepExecutions: WorkflowStepExecutionDetail[];
  reportFilterOptions: ReportFilterOptions;
  repoDir: string;
  runLogger: Logger;
  unifiedDataRepo: UnifiedDataRepository;
  definitionRepository: DefinitionRepository;
  emitEvent?: (event: WorkflowExecutionEvent) => void;
}

/**
 * Runs workflow-scope reports after a workflow completes and returns the
 * data artifacts they produced.
 *
 * Mirrors {@link MethodReportRunner} for method/model-scope reports.
 * Caller appends the returned DataArtifactRef entries to the WorkflowRun
 * aggregate via `addWorkflowDataArtifact` so they participate in the
 * `--workflow` retrieval path.
 *
 * Errors raised inside report execution are swallowed and logged — a
 * broken report must not mask the workflow result.
 */
export class WorkflowReportRunner {
  async runFor(args: WorkflowReportArgs): Promise<DataArtifactRef[]> {
    if (reportRegistry.getAll().length === 0) {
      return [];
    }

    const collected: DataArtifactRef[] = [];

    const callbacks: ReportEventCallback = {
      onReportStarted: (name, scope) => {
        args.emitEvent?.({
          kind: "report_started",
          reportName: name,
          scope,
        });
      },
      onReportCompleted: (name, scope, markdown, json, reportDataHandles) => {
        args.emitEvent?.({
          kind: "report_completed",
          reportName: name,
          scope,
          markdown,
          json,
        });
        for (const handle of reportDataHandles) {
          collected.push({
            dataId: handle.dataId,
            name: handle.name,
            version: handle.version,
            tags: handle.tags,
          });
        }
      },
      onReportFailed: (name, scope, error) => {
        args.emitEvent?.({
          kind: "report_failed",
          reportName: name,
          scope,
          error,
        });
      },
    };

    const context: WorkflowReportContext = {
      scope: "workflow",
      repoDir: args.repoDir,
      logger: args.runLogger,
      dataRepository: args.unifiedDataRepo,
      definitionRepository: args.definitionRepository,
      workflowId: args.workflow.id,
      workflowRunId: args.workflowRunId,
      workflowName: args.workflow.name,
      workflowStatus: args.workflowStatus,
      stepExecutions: args.stepExecutions,
    };

    try {
      await executeReports(
        reportRegistry,
        context,
        ModelType.create("workflow"),
        args.workflow.id,
        args.workflow.reportSelection,
        args.reportFilterOptions,
        callbacks,
        undefined,
        BUILTIN_WORKFLOW_REPORTS,
      );
    } catch (reportError) {
      args.runLogger.debug(
        "Failed to run workflow-scope reports: {error}",
        {
          error: reportError instanceof Error
            ? reportError.message
            : String(reportError),
        },
      );
    }

    return collected;
  }
}
