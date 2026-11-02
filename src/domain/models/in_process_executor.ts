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

import { ExecutionOutputNames } from "./execution_output_names.ts";
import { errorPaths, userErrorCode } from "../errors.ts";
import type { Logger } from "@logtape/logtape";
import type {
  ExecutionRequest,
  ExecutionResult,
} from "./execution_envelope.ts";
import type { Definition } from "../definitions/definition.ts";
import type { MethodExecutionEvent } from "./method_events.ts";
import type {
  MethodContext,
  MethodDefinition,
  MethodResult,
  ModelDefinition,
  WorkflowGateApproveOptions,
  WorkflowGateRejectOptions,
} from "./model.ts";
import type { WorkflowGateService } from "./workflow_gate_service.ts";
import {
  createFileWriterFactory,
  createResourceDeleter,
  createResourceReader,
  createResourceWriter,
} from "./data_writer.ts";
import { DataAccessService } from "../data/data_access_service.ts";
import { withConsoleGuard } from "./console_guard.ts";
import { processTraceEnv } from "./process_trace_env.ts";

/**
 * without props a single-brace span is left as written so plain output such as
 * JSON displays verbatim; a template with no opening brace is not parsed, so }}
 * stays doubled
 */
function renderMessageTemplate(
  tpl: string,
  props: Record<string, unknown> | undefined,
): string {
  if (!tpl.includes("{")) return tpl;
  return tpl.replace(
    /\{\{|\}\}|\{(\w+)\}/g,
    (match, key: string | undefined) => {
      if (match === "{{") return "{";
      if (match === "}}") return "}";
      return props ? String(props[key!] ?? "") : match;
    },
  );
}

export function wrapLoggerWithOutput(
  logger: Logger,
  onEvent: ((event: MethodExecutionEvent) => void) | undefined,
): Logger {
  if (!onEvent) return logger;
  return new Proxy(logger, {
    get(target, prop, receiver) {
      if (
        prop === "info" || prop === "warn" || prop === "warning" ||
        prop === "error"
      ) {
        return (...args: unknown[]) => {
          const original = Reflect.get(target, prop, receiver) as (
            ...a: unknown[]
          ) => void;
          original.call(target, ...args);
          const tpl = args[0];
          let line: string;
          if (typeof tpl === "string") {
            line = renderMessageTemplate(
              tpl,
              args[1] as Record<string, unknown> | undefined,
            );
          } else if (Array.isArray(tpl)) {
            const values = args.slice(1);
            line = (tpl as string[]).reduce(
              (acc, str, i) =>
                acc + str + (i < values.length ? String(values[i]) : ""),
              "",
            );
          } else {
            line = String(tpl);
          }
          onEvent({
            type: "output",
            line,
            stream: prop === "warn" || prop === "warning" || prop === "error"
              ? "stderr"
              : "stdout",
            level: prop === "info"
              ? "info"
              : prop === "error"
              ? "error"
              : "warning",
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * lets InProcessExecutor delegate validation and execution without a circular
 * dependency on the full service
 */
export interface MethodExecutor {
  execute(
    definition: Definition,
    method: MethodDefinition,
    context: MethodContext,
  ): Promise<MethodResult>;
}

/**
 * runs every step without remote placement from live in-process objects given
 * at construction, ignoring the serialized parts of ExecutionRequest
 */
export class InProcessExecutor {
  contextWithWriters?: MethodContext;

  constructor(
    private readonly executor: MethodExecutor,
    private readonly definition: Definition,
    private readonly method: MethodDefinition,
    private readonly modelDef: ModelDefinition,
    private readonly context: MethodContext,
    private readonly methodName: string,
    private readonly modelInvocationService?: {
      invoke: (
        options: Parameters<NonNullable<MethodContext["runModel"]>>[0],
        callerContext: MethodContext,
      ) => ReturnType<NonNullable<MethodContext["runModel"]>>;
    },
    private readonly workflowGateService?: WorkflowGateService,
  ) {}

  async execute(
    request: ExecutionRequest,
  ): Promise<ExecutionResult> {
    const start = performance.now();
    const logs: string[] = [];
    const resources = this.modelDef.resources ?? {};
    const files = this.modelDef.files ?? {};

    const deferred = this.method.rollbackOnFailure === true;
    const outputNames = new ExecutionOutputNames();

    const {
      writeResource,
      getHandles: getResourceHandles,
      getDeferredReceipts: getResourceReceipts,
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
      this.context.redactor,
      deferred,
      Deno.build.os,
      outputNames,
    );

    const {
      createFileWriter,
      getHandles: getFileHandles,
      getDeferredReceipts: getFileReceipts,
      getUnfinalizedReceipts: getUnfinalizedFileReceipts,
    } = createFileWriterFactory(
      this.context.dataRepository,
      this.context.modelType,
      this.context.modelId,
      files,
      this.context.tagOverrides,
      this.context.dataOutputOverrides,
      { onEvent: this.context.onEvent },
      this.definition.tags,
      this.context.runtimeTags,
      this.definition.name,
      deferred,
      Deno.build.os,
      outputNames,
    );

    const readResource = createResourceReader(
      this.context.dataRepository,
      this.context.modelType,
      this.context.modelId,
      this.context.vaultService,
      this.context.redactor,
      this.modelDef.resources,
    );

    const deleteResource = createResourceDeleter(
      this.context.dataRepository,
      this.context.modelType,
      this.context.modelId,
    );

    const dataAccessService = new DataAccessService(
      this.context.definitionRepository,
      this.context.dataRepository,
      this.context.vaultService,
      this.context.redactor,
      this.context.dataQueryService,
    );
    const readModelData = (modelName: string, specName?: string) =>
      dataAccessService.readModelData(modelName, specName, {
        modelType: this.context.modelType,
        modelId: this.context.modelId,
        modelName: this.definition.name,
      });

    // Prefer an explicitly-set queryData (test fixtures), otherwise derive
    // a binding from dataQueryService. Production callers supply only
    // dataQueryService; the executor owns the single queryData binding.
    const dataQueryService = this.context.dataQueryService;
    const queryData = this.context.queryData ??
      (dataQueryService
        ? (predicate: string, select?: string) =>
          dataQueryService.query(predicate, { select })
        : undefined);

    this.contextWithWriters = {
      ...this.context,
      methodName: this.methodName,
      traceHeaders: request.traceHeaders,
      logger: wrapLoggerWithOutput(this.context.logger, this.context.onEvent),
      writeResource,
      readResource,
      deleteResource,
      readModelData,
      queryData,
      createFileWriter,
    };

    if (this.modelInvocationService?.invoke) {
      const svc = this.modelInvocationService;
      const callerCtx = this.contextWithWriters;
      this.contextWithWriters.runModel = (options) =>
        svc.invoke(options, callerCtx);
    }

    if (this.workflowGateService) {
      const gateSvc = this.workflowGateService;
      const callerInfo = {
        definitionName: this.definition.name,
        methodName: this.methodName,
      };
      const { signal, logger } = this.context;
      this.contextWithWriters.approveWorkflowGate = (
        options: WorkflowGateApproveOptions,
      ) => gateSvc.approve(options, callerInfo, signal, logger);
      this.contextWithWriters.rejectWorkflowGate = (
        options: WorkflowGateRejectOptions,
      ) => gateSvc.reject(options, callerInfo, signal, logger);
    }

    try {
      const result = await processTraceEnv.run(
        request.traceHeaders,
        () =>
          withConsoleGuard(
            () =>
              this.executor.execute(
                this.definition,
                this.method,
                this.contextWithWriters!,
              ),
            logs,
          ),
      );

      const durationMs = performance.now() - start;

      if (deferred) {
        const receipts = [
          ...getResourceReceipts(),
          ...getFileReceipts(),
        ];
        await this.context.dataRepository.advanceLatestMarkers(receipts);
      }

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
      };
    } catch (error) {
      const durationMs = performance.now() - start;

      if (deferred) {
        const receipts = [
          ...getResourceReceipts(),
          ...getFileReceipts(),
        ];
        await this.context.dataRepository.rollbackVersions(receipts);

        return {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          errorPaths: errorPaths(error),
          errorCode: userErrorCode(error),
          outputs: [],
          logs,
          durationMs,
        };
      }

      // a file writer handed a path but never finalised leaves a version no
      // commit or write claims, so roll it back; a rollback error is logged,
      // never put in place of the method's
      const unfinalized = getUnfinalizedFileReceipts();
      if (unfinalized.length > 0) {
        try {
          await this.context.dataRepository.rollbackVersions(unfinalized);
        } catch (rollbackError) {
          this.context.logger
            .warn`Rolling back the unfinalised file writes of a failed method failed: ${rollbackError}`;
        }
      }

      // collect handles for data already written before the throw, so a method
      // that writes then throws stays visible to workflow queries
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
        errorPaths: errorPaths(error),
        errorCode: userErrorCode(error),
        outputs,
        logs,
        durationMs,
      };
    }
  }
}
