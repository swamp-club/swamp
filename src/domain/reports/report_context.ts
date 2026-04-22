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
import type { DataHandle } from "../models/model.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { resolveExtensionFile } from "../extensions/extension_file_resolver.ts";

/**
 * Base fields shared by all report contexts.
 */
interface BaseReportContext {
  repoDir: string;
  logger: Logger;
  dataRepository: UnifiedDataRepository;
  definitionRepository: DefinitionRepository;
  /** The git commit sha of the swamp repo at execution time */
  swampSha?: string;

  /**
   * Redacts fields marked `{ sensitive: true }` in the model type's Zod schema.
   * Returns a deep clone with sensitive values replaced by "***".
   * If the model type has no schema, returns args unchanged.
   *
   * @param args - The arguments object to redact
   * @param argsKind - Which schema to use: "global" or "method"
   */
  redactSensitiveArgs?(
    args: Record<string, unknown>,
    argsKind: "global" | "method",
  ): Record<string, unknown>;
}

/**
 * Lightweight description of a data output spec for report consumers.
 * Mirrors the shape produced by `toMethodDescribeData()` in schema_helpers.
 */
export interface OutputSpecInfo {
  specName: string;
  kind: "resource" | "file";
  description?: string;
  schema?: object;
  contentType?: string;
}

/**
 * Context provided to method-scope reports.
 */
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
  /** Output spec schemas from the model type definition. */
  outputSpecs?: OutputSpecInfo[];
  /**
   * Resolve a path to an asset declared in the extension's
   * `additionalFiles` manifest field. Same semantics as
   * `MethodContext.extensionFile`. Always populated by
   * `buildMethodReportContext`; throws a typed `UserError` at call time
   * when the model is not shipped via an extension manifest.
   */
  extensionFile: (relPath: string) => string;
}

/**
 * Context provided to model-scope reports.
 */
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
  /** Output spec schemas from the model type definition. */
  outputSpecs?: OutputSpecInfo[];
}

/**
 * Context provided to workflow-scope reports.
 */
export interface WorkflowReportContext extends BaseReportContext {
  scope: "workflow";
  workflowId: string;
  workflowRunId: string;
  workflowName: string;
  workflowStatus: "succeeded" | "failed";
  stepExecutions: Array<{
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
  }>;
}

/**
 * Discriminated union of all report context types.
 */
export type ReportContext =
  | MethodReportContext
  | ModelReportContext
  | WorkflowReportContext;

/**
 * Common dependencies shared across all MethodReportContext construction sites.
 * These come from the runtime environment (repositories, logging, repo path).
 */
export interface CommonReportContextDeps {
  repoDir: string;
  logger: Logger;
  dataRepository: UnifiedDataRepository;
  definitionRepository: DefinitionRepository;
  swampSha?: string;
}

/**
 * Per-invocation data specific to a single method execution.
 */
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
  extensionFilesRoot?: string;
}

/**
 * Single factory for MethodReportContext construction. All production sites
 * must route through this function — the architecture guard test in
 * report_context_arch_test.ts enforces this.
 *
 * Note: `redactSensitiveArgs` is deliberately absent from both input types.
 * It is injected after construction by the report execution service.
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
    extensionFile: (relPath: string) => resolveExtensionFile(root, relPath),
  };
}
