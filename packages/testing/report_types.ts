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
 * Extension-author-facing subset of swamp's report interfaces.
 *
 * These types mirror the interfaces that extension report implementations
 * actually use. A CI test in the main swamp repo verifies structural
 * compatibility with the canonical types.
 */

import type { DataHandle, Logger } from "./types.ts";

/** The scope at which a report operates. */
export type ReportScope = "method" | "model" | "workflow";

/** The result produced by a report execution. */
export interface ReportResult {
  markdown: string;
  json: Record<string, unknown>;
}

/**
 * Simplified data repository interface for report extension authors.
 *
 * This is the extension-facing subset of swamp's UnifiedDataRepository.
 * Only methods that report authors typically call are included.
 */
export interface TestDataRepository {
  findByName(
    modelType: string,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<TestData | null>;
  getContent(
    modelType: string,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
  findAllForModel(
    modelType: string,
    modelId: string,
  ): Promise<TestData[]>;
  findAllGlobal(): Promise<
    Array<{ data: TestData; modelType: string; modelId: string }>
  >;
}

/**
 * Simplified definition repository interface for report extension authors.
 *
 * This is the extension-facing subset of swamp's DefinitionRepository.
 */
export interface TestDefinitionRepository {
  findByName(
    modelType: string,
    name: string,
  ): Promise<TestDefinition | null>;
  findAll(modelType: string): Promise<TestDefinition[]>;
}

/** Simplified data artifact for testing. */
export interface TestData {
  name: string;
  kind: "resource" | "file";
  dataId: string;
  version: number;
  size: number;
  contentType: string;
  attributes?: Record<string, unknown>;
}

/** Simplified definition for testing. */
export interface TestDefinition {
  id: string;
  name: string;
  version: number;
  tags: Record<string, string>;
}

/** Base fields shared by all report contexts. */
interface BaseReportContext {
  repoDir: string;
  logger: Logger;
  dataRepository: TestDataRepository;
  definitionRepository: TestDefinitionRepository;
  redactSensitiveArgs?(
    args: Record<string, unknown>,
    argsKind: "global" | "method",
  ): Record<string, unknown>;
}

/** Context provided to method-scope and model-scope reports. */
export interface MethodReportContext extends BaseReportContext {
  scope: "method";
  modelType: string;
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
}

/** Context provided to model-scope reports. */
export interface ModelReportContext extends BaseReportContext {
  scope: "model";
  modelType: string;
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
}

/** Context provided to workflow-scope reports. */
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

/** Discriminated union of all report context types. */
export type ReportContext =
  | MethodReportContext
  | ModelReportContext
  | WorkflowReportContext;
