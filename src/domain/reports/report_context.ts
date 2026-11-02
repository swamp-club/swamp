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

import type { Logger } from "@logtape/logtape";
import type { ModelType } from "../models/model_type.ts";
import type { DataHandle } from "../models/model.ts";
import type { ExecutionProvenance } from "../models/model_output.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { resolveExtensionFile } from "../extensions/extension_file_resolver.ts";

interface BaseReportContext {
  repoDir: string;
  logger: Logger;
  dataRepository: UnifiedDataRepository;
  definitionRepository: DefinitionRepository;
  swampSha?: string;

  /**
   * returns a deep clone with sensitive values replaced by ***; args are
   * returned unchanged when the model type has no schema
   */
  redactSensitiveArgs?(
    args: Record<string, unknown>,
    argsKind: "global" | "method",
  ): Record<string, unknown>;
}

export interface OutputSpecInfo {
  specName: string;
  kind: "resource" | "file";
  description?: string;
  schema?: object;
  contentType?: string;
}

export interface MethodReportContext extends BaseReportContext {
  scope: "method";
  modelType: ModelType;
  modelId: string;
  definition: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  dataHandles: DataHandle[];
  outputSpecs?: OutputSpecInfo[];
  /**
   * where the run came from: definition hash, model version, trigger, initiator
   * and, for a workflow step, the workflow run and step; the same record swamp
   * behavior history get shows
   */
  provenance?: ExecutionProvenance;
  /**
   * behaves like MethodContext.extensionFile; throws a typed UserError at
   * call time when the model is not shipped via an extension manifest
   */
  extensionFile: (relPath: string) => string;
}

export interface ModelReportContext extends BaseReportContext {
  scope: "model";
  modelType: ModelType;
  modelId: string;
  definition: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  dataHandles: DataHandle[];
  outputSpecs?: OutputSpecInfo[];
  /**
   * where the run came from: definition hash, model version, trigger, initiator
   * and, for a workflow step, the workflow run and step; the same record swamp
   * behavior history get shows
   */
  provenance?: ExecutionProvenance;
}

/**
 * restated rather than imported from workflows' StepSkipReasonData, because
 * workflows already depends on reports and the reverse edge would close a cycle
 * the architecture ratchet rejects
 */
export interface StepSkipReasonInfo {
  kind: "dependency" | "guarded" | "job_skipped";
  expression?: string;
}

export interface WorkflowReportContext extends BaseReportContext {
  scope: "workflow";
  workflowId: string;
  workflowRunId: string;
  workflowName: string;
  workflowStatus: "succeeded" | "failed";
  inputs?: Record<string, unknown>;
  stepExecutions: Array<{
    jobName: string;
    stepName: string;
    taskType: string;
    modelName: string;
    modelType: string;
    methodName: string;
    status: "succeeded" | "failed" | "skipped";
    dataHandles: DataHandle[];
    methodArgs: Record<string, unknown>;
    modelId: string;
    globalArgs: Record<string, unknown>;
    errorMessage?: string;
    /**
     * populated only when status is skipped; without it a report's skip count
     * cannot tell a guard-excluded step from a deselected one
     */
    skipReason?: StepSkipReasonInfo;
  }>;
}

export type ReportContext =
  | MethodReportContext
  | ModelReportContext
  | WorkflowReportContext;

export interface CommonReportContextDeps {
  repoDir: string;
  logger: Logger;
  dataRepository: UnifiedDataRepository;
  definitionRepository: DefinitionRepository;
  swampSha?: string;
}

export interface MethodReportInvocation {
  modelType: ModelType;
  modelId: string;
  definition: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  dataHandles: DataHandle[];
  outputSpecs?: OutputSpecInfo[];
  provenance: ExecutionProvenance;
  extensionFilesRoot?: string;
}

/**
 * all production sites route through this; redactSensitiveArgs is absent from
 * the input types and injected afterward by the report execution service
 */
export function buildMethodReportContext(
  common: CommonReportContextDeps,
  invocation: MethodReportInvocation,
): MethodReportContext {
  const root = invocation.extensionFilesRoot;
  return {
    scope: "method",
    repoDir: common.repoDir,
    logger: common.logger,
    dataRepository: common.dataRepository,
    definitionRepository: common.definitionRepository,
    swampSha: common.swampSha,
    modelType: invocation.modelType,
    modelId: invocation.modelId,
    definition: invocation.definition,
    globalArgs: invocation.globalArgs,
    methodArgs: invocation.methodArgs,
    methodName: invocation.methodName,
    executionStatus: invocation.executionStatus,
    errorMessage: invocation.errorMessage,
    dataHandles: invocation.dataHandles,
    outputSpecs: invocation.outputSpecs,
    provenance: invocation.provenance,
    extensionFile: (relPath: string) => resolveExtensionFile(root, relPath),
  };
}
