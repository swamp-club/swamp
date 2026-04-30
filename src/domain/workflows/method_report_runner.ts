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
import type { ModelType } from "../models/model_type.ts";
import type { DataHandle, ModelDefinition } from "../models/model.ts";
import { modelRegistry } from "../models/model.ts";
import type { Definition } from "../definitions/definition.ts";
import type { DataArtifactRef } from "../models/model_output.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { buildOutputSpecs } from "../models/output_spec_builder.ts";
import {
  executeReports,
  type ReportEventCallback,
  type ReportFilterOptions,
} from "../reports/report_execution_service.ts";
import { reportRegistry } from "../reports/report_registry.ts";
import { buildMethodReportContext } from "../reports/report_context.ts";
import { BUILTIN_METHOD_REPORTS } from "../reports/builtin/mod.ts";
import type { WorkflowExecutionEvent } from "./execution_events.ts";

/**
 * Inputs for running per-step reports after a method execution.
 *
 * The runner uses `status` to discriminate between the success path
 * (method + model scope reports, returns produced artifacts) and the
 * failure path (method scope only, errors swallowed, returns []).
 */
export interface MethodReportArgs {
  /** Whether the method execution succeeded or failed. */
  status: "succeeded" | "failed";
  /** Error message; required when status === "failed". */
  errorMessage?: string;
  /** Data handles produced by the method; empty array on failure. */
  dataHandles: DataHandle[];

  // --- Identity ---
  modelType: ModelType;
  modelDef: ModelDefinition;
  evaluatedDefinition: Definition;
  /** Original (pre-evaluation) definition, only used for reportSelection. */
  originalDefinition: Definition;
  methodName: string;

  // --- Report context inputs ---
  reportGlobalArgs: Record<string, unknown>;
  reportMethodArgs: Record<string, unknown>;
  reportFilterOptions: ReportFilterOptions;
  /** Vary suffix derived from forEach variable, when applicable. */
  reportVarySuffix?: string;

  // --- Wiring ---
  repoDir: string;
  swampSha?: string;
  runLogger: Logger;
  unifiedDataRepo: UnifiedDataRepository;
  definitionRepository: DefinitionRepository;

  /** Event sink for report_started / report_completed / report_failed. */
  emitEvent?: (event: WorkflowExecutionEvent) => void;
  /** Job and step ids carried into emitted events. */
  jobName: string;
  stepName: string;
}

/**
 * Runs per-step reports and returns the data artifacts they produced.
 *
 * - status="succeeded": runs method + model scope reports. Returns the
 *   aggregated artifacts they produced. Caller appends these to its own
 *   output / savedArtifacts state.
 * - status="failed": runs method-scope reports only so consumers see a
 *   structured error. Internal try/catch ensures report errors do NOT
 *   mask the original execution error. Returns [].
 *
 * Imperative call site (not event-driven) preserves event ordering
 * relative to step_completed / step_failed.
 */
export class MethodReportRunner {
  async runFor(args: MethodReportArgs): Promise<DataArtifactRef[]> {
    if (reportRegistry.getAll().length === 0 || !args.reportFilterOptions) {
      return [];
    }
    if (args.status === "succeeded") {
      return await this.runSucceeded(args);
    }
    return await this.runFailed(args);
  }

  private async runSucceeded(
    args: MethodReportArgs,
  ): Promise<DataArtifactRef[]> {
    const collected: DataArtifactRef[] = [];

    const callbacks: ReportEventCallback = {
      onReportStarted: (name, scope) => {
        args.emitEvent?.({
          kind: "report_started",
          reportName: name,
          scope,
          jobId: args.jobName,
          stepId: args.stepName,
        });
      },
      onReportCompleted: (name, scope, markdown, json, reportDataHandles) => {
        args.emitEvent?.({
          kind: "report_completed",
          reportName: name,
          scope,
          markdown,
          json,
          jobId: args.jobName,
          stepId: args.stepName,
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
          jobId: args.jobName,
          stepId: args.stepName,
        });
      },
    };

    const stepModelDef = modelRegistry.get(args.modelType);
    const stepModelTypeReports = [
      ...BUILTIN_METHOD_REPORTS,
      ...(stepModelDef?.reports ?? []),
    ];

    const methodContext = buildMethodReportContext(
      {
        repoDir: args.repoDir,
        logger: args.runLogger,
        dataRepository: args.unifiedDataRepo,
        definitionRepository: args.definitionRepository,
        swampSha: args.swampSha,
      },
      {
        modelType: args.modelType,
        modelId: args.evaluatedDefinition.id,
        definition: {
          id: args.evaluatedDefinition.id,
          name: args.evaluatedDefinition.name,
          version: args.evaluatedDefinition.version,
          tags: args.evaluatedDefinition.tags,
        },
        globalArgs: args.reportGlobalArgs,
        methodArgs: args.reportMethodArgs,
        methodName: args.methodName,
        executionStatus: "succeeded",
        dataHandles: args.dataHandles,
        outputSpecs: buildOutputSpecs(args.modelDef),
        extensionFilesRoot: args.modelDef.extensionFilesRoot,
      },
    );

    // Method scope
    await executeReports(
      reportRegistry,
      methodContext,
      args.modelType,
      args.evaluatedDefinition.id,
      args.originalDefinition.reportSelection,
      args.reportFilterOptions,
      callbacks,
      args.methodName,
      stepModelTypeReports,
      args.reportVarySuffix,
    );

    // Model scope
    await executeReports(
      reportRegistry,
      { ...methodContext, scope: "model" },
      args.modelType,
      args.evaluatedDefinition.id,
      args.originalDefinition.reportSelection,
      args.reportFilterOptions,
      callbacks,
      args.methodName,
      stepModelTypeReports,
      args.reportVarySuffix,
    );

    return collected;
  }

  private async runFailed(
    args: MethodReportArgs,
  ): Promise<DataArtifactRef[]> {
    // Wrap in try/catch: caller is already inside its own catch block,
    // so throwing here would replace the real execution error with a
    // report error.
    try {
      const callbacks: ReportEventCallback = {
        onReportStarted: (name, scope) => {
          args.emitEvent?.({
            kind: "report_started",
            reportName: name,
            scope,
            jobId: args.jobName,
            stepId: args.stepName,
          });
        },
        onReportCompleted: (name, scope, markdown, json) => {
          args.emitEvent?.({
            kind: "report_completed",
            reportName: name,
            scope,
            markdown,
            json,
            jobId: args.jobName,
            stepId: args.stepName,
          });
        },
        onReportFailed: (name, scope, reportError) => {
          args.emitEvent?.({
            kind: "report_failed",
            reportName: name,
            scope,
            error: reportError,
            jobId: args.jobName,
            stepId: args.stepName,
          });
        },
      };

      const stepModelDef = modelRegistry.get(args.modelType);
      const stepModelTypeReports = [
        ...BUILTIN_METHOD_REPORTS,
        ...(stepModelDef?.reports ?? []),
      ];

      const failedMethodContext = buildMethodReportContext(
        {
          repoDir: args.repoDir,
          logger: args.runLogger,
          dataRepository: args.unifiedDataRepo,
          definitionRepository: args.definitionRepository,
          swampSha: args.swampSha,
        },
        {
          modelType: args.modelType,
          modelId: args.evaluatedDefinition.id,
          definition: {
            id: args.evaluatedDefinition.id,
            name: args.evaluatedDefinition.name,
            version: args.evaluatedDefinition.version,
            tags: args.evaluatedDefinition.tags,
          },
          globalArgs: args.reportGlobalArgs,
          methodArgs: args.reportMethodArgs,
          methodName: args.methodName,
          executionStatus: "failed",
          errorMessage: args.errorMessage,
          dataHandles: [],
          outputSpecs: buildOutputSpecs(args.modelDef),
          extensionFilesRoot: args.modelDef.extensionFilesRoot,
        },
      );

      // Method scope only on failure (no model-scope on failure path).
      await executeReports(
        reportRegistry,
        failedMethodContext,
        args.modelType,
        args.evaluatedDefinition.id,
        args.originalDefinition.reportSelection,
        args.reportFilterOptions,
        callbacks,
        args.methodName,
        stepModelTypeReports,
      );
    } catch (reportError) {
      args.runLogger.debug(
        "Failed to run reports for failed method: {error}",
        {
          error: reportError instanceof Error
            ? reportError.message
            : String(reportError),
        },
      );
    }
    return [];
  }
}
