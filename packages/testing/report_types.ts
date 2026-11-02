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

import type { DataHandle, Logger } from "./types.ts";

export type ReportScope = "method" | "model" | "workflow";

export interface ReportResult {
  markdown: string;
  json: Record<string, unknown>;
}

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

export interface TestDefinitionRepository {
  findByName(
    modelType: string,
    name: string,
  ): Promise<TestDefinition | null>;
  findAll(modelType: string): Promise<TestDefinition[]>;
}

export interface TestData {
  name: string;
  kind: "resource" | "file";
  dataId: string;
  version: number;
  size: number;
  contentType: string;
  attributes?: Record<string, unknown>;
}

export interface TestDefinition {
  id: string;
  name: string;
  version: number;
  tags: Record<string, string>;
}

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
  }>;
}

export type ReportContext =
  | MethodReportContext
  | ModelReportContext
  | WorkflowReportContext;
