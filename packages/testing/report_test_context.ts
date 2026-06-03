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

import type { DataHandle, LogLevel } from "./types.ts";
import type {
  MethodReportContext,
  ModelReportContext,
  ReportContext,
  TestData,
  TestDataRepository,
  TestDefinition,
  TestDefinitionRepository,
  WorkflowReportContext,
} from "./report_types.ts";

/** A log entry captured by the report test context's logger. */
export interface CapturedReportLog {
  level: LogLevel;
  message: string;
  args: unknown[];
}

/** Stored data artifact for the fake data repository. */
export interface StoredDataArtifact {
  modelType: string;
  modelId: string;
  data: TestData;
  content?: Uint8Array;
}

/** Base options shared by all report context scopes. */
interface BaseReportTestOptions {
  repoDir?: string;
  /** Pre-seed data artifacts for the fake data repository. */
  dataArtifacts?: StoredDataArtifact[];
  /** Pre-seed definitions for the fake definition repository. */
  definitions?: Array<{ modelType: string; definition: TestDefinition }>;
}

/** Options for creating a method-scope report context. */
export interface MethodReportTestContextOptions extends BaseReportTestOptions {
  scope: "method";
  modelType?: string;
  modelId?: string;
  definition?: Partial<MethodReportContext["definition"]>;
  globalArgs?: Record<string, unknown>;
  methodArgs?: Record<string, unknown>;
  methodName?: string;
  executionStatus?: "succeeded" | "failed";
  errorMessage?: string;
  dataHandles?: DataHandle[];
}

/** Options for creating a model-scope report context. */
export interface ModelReportTestContextOptions extends BaseReportTestOptions {
  scope: "model";
  modelType?: string;
  modelId?: string;
  definition?: Partial<ModelReportContext["definition"]>;
  globalArgs?: Record<string, unknown>;
  methodArgs?: Record<string, unknown>;
  methodName?: string;
  executionStatus?: "succeeded" | "failed";
  errorMessage?: string;
  dataHandles?: DataHandle[];
}

/** Options for creating a workflow-scope report context. */
export interface WorkflowReportTestContextOptions
  extends BaseReportTestOptions {
  scope: "workflow";
  workflowId?: string;
  workflowRunId?: string;
  workflowName?: string;
  workflowStatus?: "succeeded" | "failed";
  stepExecutions?: WorkflowReportContext["stepExecutions"];
}

/** Discriminated union of report test context options. */
export type ReportTestContextOptions =
  | MethodReportTestContextOptions
  | ModelReportTestContextOptions
  | WorkflowReportTestContextOptions;

/** The return value from createReportTestContext. */
export interface ReportTestContextResult {
  /** The ReportContext to pass to your report execute function. */
  context: ReportContext;
  /** Returns all log entries captured during execution. */
  getLogs(): CapturedReportLog[];
  /** Returns log entries filtered by level. */
  getLogsByLevel(level: LogLevel): CapturedReportLog[];
}

/**
 * Creates a test report context for unit testing extension report execute
 * functions.
 *
 * ```typescript
 * import { createReportTestContext } from "@systeminit/swamp-testing";
 *
 * Deno.test("report generates markdown summary", async () => {
 *   const { context } = createReportTestContext({
 *     scope: "method",
 *     modelType: "aws/ec2-instance",
 *     methodName: "create",
 *     executionStatus: "succeeded",
 *     dataHandles: [],
 *   });
 *
 *   const result = await myReport.execute(context);
 *   assertStringIncludes(result.markdown, "## Summary");
 * });
 * ```
 */
export function createReportTestContext(
  options: ReportTestContextOptions,
): ReportTestContextResult {
  const logs: CapturedReportLog[] = [];

  function captureLog(level: LogLevel, message: string, args: unknown[]) {
    logs.push({ level, message, args });
  }

  const logger = {
    debug(message: string, ...args: unknown[]) {
      captureLog("debug", message, args);
    },
    info(message: string, ...args: unknown[]) {
      captureLog("info", message, args);
    },
    warn(message: string, ...args: unknown[]) {
      captureLog("warning", message, args);
    },
    error(message: string, ...args: unknown[]) {
      captureLog("error", message, args);
    },
    fatal(message: string, ...args: unknown[]) {
      captureLog("fatal", message, args);
    },
  };

  const dataArtifacts = options.dataArtifacts ?? [];
  const storedDefinitions = options.definitions ?? [];

  const dataRepository: TestDataRepository = {
    findByName(
      modelType: string,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<TestData | null> {
      const match = dataArtifacts.find((a) =>
        a.modelType === modelType &&
        a.modelId === modelId &&
        a.data.name === dataName &&
        (version === undefined || a.data.version === version)
      );
      return Promise.resolve(match ? structuredClone(match.data) : null);
    },

    getContent(
      modelType: string,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<Uint8Array | null> {
      const match = dataArtifacts.find((a) =>
        a.modelType === modelType &&
        a.modelId === modelId &&
        a.data.name === dataName &&
        (version === undefined || a.data.version === version)
      );
      return Promise.resolve(
        match?.content ? new Uint8Array(match.content) : null,
      );
    },

    findAllForModel(
      modelType: string,
      modelId: string,
    ): Promise<TestData[]> {
      const matches = dataArtifacts
        .filter((a) => a.modelType === modelType && a.modelId === modelId)
        .map((a) => structuredClone(a.data));
      return Promise.resolve(matches);
    },

    findAllGlobal(): Promise<
      Array<{ data: TestData; modelType: string; modelId: string }>
    > {
      return Promise.resolve(
        dataArtifacts.map((a) => ({
          data: structuredClone(a.data),
          modelType: a.modelType,
          modelId: a.modelId,
        })),
      );
    },
  };

  const definitionRepository: TestDefinitionRepository = {
    findByName(
      modelType: string,
      name: string,
    ): Promise<TestDefinition | null> {
      const match = storedDefinitions.find((d) =>
        d.modelType === modelType && d.definition.name === name
      );
      return Promise.resolve(
        match ? structuredClone(match.definition) : null,
      );
    },

    findAll(modelType: string): Promise<TestDefinition[]> {
      return Promise.resolve(
        storedDefinitions
          .filter((d) => d.modelType === modelType)
          .map((d) => structuredClone(d.definition)),
      );
    },
  };

  const repoDir = options.repoDir ?? "/tmp/swamp-test";

  const base = {
    repoDir,
    logger,
    dataRepository,
    definitionRepository,
  };

  let context: ReportContext;

  if (options.scope === "workflow") {
    context = {
      ...base,
      scope: "workflow",
      workflowId: options.workflowId ?? crypto.randomUUID(),
      workflowRunId: options.workflowRunId ?? crypto.randomUUID(),
      workflowName: options.workflowName ?? "test-workflow",
      workflowStatus: options.workflowStatus ?? "succeeded",
      stepExecutions: options.stepExecutions ?? [],
    } satisfies WorkflowReportContext;
  } else if (options.scope === "model") {
    context = {
      ...base,
      scope: "model",
      modelType: options.modelType ?? "test/model",
      modelId: options.modelId ?? crypto.randomUUID(),
      definition: {
        id: options.definition?.id ?? crypto.randomUUID(),
        name: options.definition?.name ?? "test-instance",
        version: options.definition?.version ?? 1,
        tags: options.definition?.tags ?? {},
      },
      globalArgs: options.globalArgs ?? {},
      methodArgs: options.methodArgs ?? {},
      methodName: options.methodName ?? "run",
      executionStatus: options.executionStatus ?? "succeeded",
      ...(options.errorMessage !== undefined
        ? { errorMessage: options.errorMessage }
        : {}),
      dataHandles: options.dataHandles ?? [],
    } satisfies ModelReportContext;
  } else {
    context = {
      ...base,
      scope: "method",
      modelType: options.modelType ?? "test/model",
      modelId: options.modelId ?? crypto.randomUUID(),
      definition: {
        id: options.definition?.id ?? crypto.randomUUID(),
        name: options.definition?.name ?? "test-instance",
        version: options.definition?.version ?? 1,
        tags: options.definition?.tags ?? {},
      },
      globalArgs: options.globalArgs ?? {},
      methodArgs: options.methodArgs ?? {},
      methodName: options.methodName ?? "run",
      executionStatus: options.executionStatus ?? "succeeded",
      ...(options.errorMessage !== undefined
        ? { errorMessage: options.errorMessage }
        : {}),
      dataHandles: options.dataHandles ?? [],
    } satisfies MethodReportContext;
  }

  return {
    context,
    getLogs: () => [...logs],
    getLogsByLevel: (level: LogLevel) => logs.filter((l) => l.level === level),
  };
}
