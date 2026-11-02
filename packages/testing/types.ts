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

// type-only: extensions get Environment instances via
// ctx.createCelEnvironment() and rely on inference; no re-export is provided.
import type { Environment } from "cel-js";

/**
 * how long data is retained: a duration such as "1h" or "2w", or "ephemeral"
 * (process end), "infinite", "job" or "workflow" (until it completes).
 */
export type Lifetime = string;

/**
 * a number keeps the N most recent versions; a duration string keeps versions
 * created within it.
 */
export type GarbageCollectionPolicy = number | string;

export interface OwnerDefinition {
  ownerType: "model-method" | "workflow-step" | "manual";
  ownerRef: string;
  definitionHash?: string;
  workflowId?: string;
  workflowRunId?: string;
}

export interface DataHandleMetadata {
  contentType: string;
  lifetime: Lifetime;
  garbageCollection: GarbageCollectionPolicy;
  streaming: boolean;
  tags: Record<string, string>;
  ownerDefinition: OwnerDefinition;
  lifecycle?: "active" | "deleted";
  renamedTo?: string;
}

export interface DataHandle {
  name: string;
  specName: string;
  kind: "resource" | "file";
  dataId: string;
  version: number;
  size: number;
  tags: Record<string, string>;
  metadata: DataHandleMetadata;
  attributes?: Record<string, unknown>;
}

export interface DataWriter {
  readonly dataId: string;
  readonly name: string;
  writeAll(content: Uint8Array): Promise<DataHandle>;
  writeText(text: string): Promise<DataHandle>;
  writeLine(line: string): Promise<void>;
  writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: { onLine?: (line: string) => void },
  ): Promise<DataHandle>;
  getFilePath(): Promise<string>;
  finalize(): Promise<DataHandle>;
}

export interface DefinitionInfo {
  id: string;
  name: string;
  version: number;
  tags: Record<string, string>;
}

export type LogLevel = "debug" | "info" | "warning" | "error" | "fatal";

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  warning(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  fatal(message: string, ...args: unknown[]): void;
}

export interface MethodExecutionEvent {
  type: string;
  [key: string]: unknown;
}

export interface DataRecord {
  id: string;
  name: string;
  version: number;
  isLatest: boolean;
  createdAt: string;
  namespace: string;
  attributes: Record<string, unknown>;
  tags: Record<string, string>;
  modelName: string;
  modelId: string;
  modelType: string;
  specName: string;
  dataType: string;
  contentType: string;
  lifetime: string;
  ownerType: string;
  streaming: boolean;
  size: number;
  content: unknown;
  /**
   * local filesystem path of the stored content; set for records from the CEL
   * data.* functions and empty elsewhere. Optional so existing fixtures that
   * build literals keep type-checking.
   */
  path?: string;
  ownerRef: string;
  workflowRunId: string;
  workflowName: string;
  jobName: string;
  stepName: string;
  source: string;
}

/**
 * TGlobalArgs narrows globalArgs to the model's inferred schema; the default
 * keeps bare MethodContext usages compatible with the pre-parameterised shape.
 */
export interface MethodContext<TGlobalArgs = Record<string, unknown>> {
  signal: AbortSignal;
  repoDir: string;
  globalArgs: TGlobalArgs;
  definition: DefinitionInfo;
  methodName: string;
  /**
   * W3C Trace Context headers for this execution; pass them to subprocesses as
   * TRACEPARENT/TRACESTATE or on outbound requests. Always this execution's
   * own, even when methods run concurrently. Absent or empty when tracing is
   * disabled.
   */
  traceHeaders?: Readonly<Record<string, string>>;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  /**
   * reads back a resource by instance name, the name given to writeResource,
   * not the specName.
   */
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  createFileWriter: (specName: string, name: string) => DataWriter;
  /**
   * reads data from another model by name, parsing JSON and resolving vault
   * references; an empty array if the model does not exist or has no data.
   */
  readModelData: (
    modelName: string,
    specName?: string,
  ) => Promise<DataRecord[]>;
  /**
   * builds a fresh, isolated cel-js Environment with swamp's baseline
   * arithmetic overloads; registrations on one instance do not affect any
   * other.
   */
  createCelEnvironment: () => Environment;
  onEvent?: (event: MethodExecutionEvent) => void;
}

export interface MethodResult {
  dataHandles?: DataHandle[];
}
