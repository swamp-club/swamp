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

import type {
  ExecutionCallbacks,
  ExecutionDriver,
  ExecutionRequest,
  ExecutionResult,
} from "./execution_driver.ts";
import type { Definition } from "../definitions/definition.ts";
import type {
  MethodContext,
  MethodDefinition,
  MethodResult,
  ModelDefinition,
} from "../models/model.ts";
import {
  createFileWriterFactory,
  createResourceReader,
  createResourceWriter,
} from "../models/data_writer.ts";
import { DataAccessService } from "../data/data_access_service.ts";

/**
 * Interface for the execute method of MethodExecutionService.
 * Allows RawExecutionDriver to delegate argument validation and
 * method execution without a circular dependency on the full service.
 */
export interface MethodExecutor {
  execute(
    definition: Definition,
    method: MethodDefinition,
    context: MethodContext,
  ): Promise<MethodResult>;
}

/**
 * Raw execution driver — runs model methods directly in the host Deno process.
 *
 * This is the default driver. It receives live in-process objects at
 * construction time and ignores the serialized parts of ExecutionRequest.
 *
 * Responsibility: create data writers, inject them into context, delegate
 * to MethodExecutor for argument validation and method execution, and
 * return the result as an ExecutionResult with "persisted" DriverOutputs.
 */
export class RawExecutionDriver implements ExecutionDriver {
  readonly type = "raw";

  /**
   * The context with writers injected, available after execute() completes.
   * Used by the execution service for follow-up actions.
   */
  contextWithWriters?: MethodContext;

  constructor(
    private readonly executor: MethodExecutor,
    private readonly definition: Definition,
    private readonly method: MethodDefinition,
    private readonly modelDef: ModelDefinition,
    private readonly context: MethodContext,
    private readonly methodName: string,
  ) {}

  async execute(
    _request: ExecutionRequest,
    _callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    const start = performance.now();
    const logs: string[] = [];
    const resources = this.modelDef.resources ?? {};
    const files = this.modelDef.files ?? {};

    const {
      writeResource,
      getHandles: getResourceHandles,
    } = createResourceWriter(
      this.context.dataRepository,
      this.context.modelType,
      this.context.modelId,
      resources,
      this.context.tagOverrides,
      this.context.dataOutputOverrides,
      this.definition.tags,
      this.context.runtimeTags,
      this.definition.name,
      this.context.vaultService,
      this.methodName,
      this.context.onEvent,
    );

    const {
      createFileWriter,
      getHandles: getFileHandles,
    } = createFileWriterFactory(
      this.context.dataRepository,
      this.context.modelType,
      this.context.modelId,
      files,
      this.context.tagOverrides,
      this.context.dataOutputOverrides,
      undefined, // callbacks
      this.definition.tags,
      this.context.runtimeTags,
      this.definition.name,
    );

    const readResource = createResourceReader(
      this.context.dataRepository,
      this.context.modelType,
      this.context.modelId,
      this.context.vaultService,
      this.context.redactor,
    );

    const dataAccessService = new DataAccessService(
      this.context.definitionRepository,
      this.context.dataRepository,
      this.context.vaultService,
      this.context.redactor,
      this.context.dataQueryService,
    );
    const readModelData = (modelName: string, specName?: string) =>
      dataAccessService.readModelData(modelName, specName);

    // Prefer an explicitly-set queryData (test fixtures), otherwise derive
    // a binding from dataQueryService. Production callers supply only
    // dataQueryService; the driver owns the single queryData binding.
    const dataQueryService = this.context.dataQueryService;
    const queryData = this.context.queryData ??
      (dataQueryService
        ? (predicate: string, select?: string) =>
          dataQueryService.query(predicate, { select })
        : undefined);

    this.contextWithWriters = {
      ...this.context,
      methodName: this.methodName,
      writeResource,
      readResource,
      readModelData,
      queryData,
      createFileWriter,
    };

    try {
      const result = await this.executor.execute(
        this.definition,
        this.method,
        this.contextWithWriters,
      );

      const durationMs = performance.now() - start;
      const writerHandles = [
        ...getResourceHandles(),
        ...getFileHandles(),
      ];
      const handles = result.dataHandles?.length
        ? result.dataHandles
        : writerHandles;
      const outputs = handles.map((handle) => ({
        kind: "persisted" as const,
        handle,
      }));

      return {
        status: "success",
        outputs,
        logs,
        durationMs,
        followUpActions: result.followUpActions,
      };
    } catch (error) {
      // Collect handles for data that was already written to disk before the
      // throw. Without this, data produced by a method that writes-then-throws
      // (e.g. code-review verdict=FAIL) would be invisible to workflow queries.
      const durationMs = performance.now() - start;
      const writerHandles = [
        ...getResourceHandles(),
        ...getFileHandles(),
      ];
      const outputs = writerHandles.map((handle) => ({
        kind: "persisted" as const,
        handle,
      }));

      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        outputs,
        logs,
        durationMs,
      };
    }
  }
}
