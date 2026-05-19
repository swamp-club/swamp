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

/**
 * Extension-author-facing subset of swamp's MethodContext.
 *
 * These types mirror the fields that extension model `execute` functions
 * actually use. A CI test in the main swamp repo verifies structural
 * compatibility with the canonical types.
 */

// Type-only — used to type the `createCelEnvironment` field below.
// Extensions get Environment instances via `ctx.createCelEnvironment()` and
// rely on inference; no consumer-facing re-export is provided.
import type { Environment } from "cel-js";

/**
 * Lifetime determines how long data should be retained.
 * - Duration strings: "1h", "5m", "10d", "2w", "1mo", "10y"
 * - "ephemeral": Deleted when the process ends
 * - "infinite": Never automatically deleted
 * - "job": Lives until the job completes
 * - "workflow": Lives until the workflow completes
 */
export type Lifetime = string;

/**
 * Garbage collection policy determines version retention.
 * - number: Keep N most recent versions
 * - duration string: Keep versions created within the duration
 */
export type GarbageCollectionPolicy = number | string;

/** Owner definition tracks who created/owns the data. */
export interface OwnerDefinition {
  ownerType: "model-method" | "workflow-step" | "manual";
  ownerRef: string;
  definitionHash?: string;
  workflowId?: string;
  workflowRunId?: string;
}

/** Metadata attached to a data handle (excludes auto-generated fields). */
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

/** Lightweight reference to data already written during method execution. */
export interface DataHandle {
  /** Human-readable name of this data artifact. */
  name: string;
  /** The declared spec name (key in resources or files). */
  specName: string;
  /** Whether this handle is for a resource or file. */
  kind: "resource" | "file";
  /** Unique data ID. */
  dataId: string;
  /** Version number on disk. */
  version: number;
  /** Size in bytes. */
  size: number;
  /** Tags applied to the data. */
  tags: Record<string, string>;
  /** Metadata excluding auto-generated fields. */
  metadata: DataHandleMetadata;
}

/** Writer for binary or text file data. */
export interface DataWriter {
  /** The data ID assigned to this writer. */
  readonly dataId: string;
  /** The data name. */
  readonly name: string;
  /** Write all content at once. */
  writeAll(content: Uint8Array): Promise<DataHandle>;
  /** Write text content (encodes to UTF-8). */
  writeText(text: string): Promise<DataHandle>;
  /** Append a single line (streaming). */
  writeLine(line: string): Promise<void>;
  /** Pipe a stream to disk. */
  writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: { onLine?: (line: string) => void },
  ): Promise<DataHandle>;
  /** Get the file path for direct I/O. */
  getFilePath(): Promise<string>;
  /** Finalize a writer that used writeLine/getFilePath and return the handle. */
  finalize(): Promise<DataHandle>;
}

/** Definition metadata available during execution. */
export interface DefinitionInfo {
  id: string;
  name: string;
  version: number;
  tags: Record<string, string>;
}

/** Log level for captured log entries. */
export type LogLevel = "debug" | "info" | "warning" | "error" | "fatal";

/** A logger interface matching the subset extension authors use. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  fatal(message: string, ...args: unknown[]): void;
}

/** Event emitted during method execution. */
export interface MethodExecutionEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * The context object passed to extension model `execute` functions.
 *
 * This is the extension-author-facing subset of swamp's internal MethodContext.
 * It contains only the fields that extension models typically interact with.
 *
 * `TGlobalArgs` lets authoring-time type inference narrow `globalArgs` to the
 * model's inferred global-arguments schema. The default keeps bare
 * `MethodContext` usages (including `createModelTestContext`) backward
 * compatible with the pre-parameterised shape.
 */
export interface MethodContext<TGlobalArgs = Record<string, unknown>> {
  /** Cancellation signal for async operations. */
  signal: AbortSignal;
  /** The base directory for the repository. */
  repoDir: string;
  /** Pre-validated global arguments from the definition. */
  globalArgs: TGlobalArgs;
  /** Definition metadata for the current execution. */
  definition: DefinitionInfo;
  /** The name of the method being executed. */
  methodName: string;
  /** Logger for emitting log messages. */
  logger: Logger;
  /** Write a resource — validates against schema, serializes JSON, returns handle. */
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  /**
   * Read a previously stored resource by instance name.
   *
   * The `instanceName` is the `name` parameter from `writeResource`, not the
   * `specName`. For example, after `writeResource("state", "main", data)`,
   * read it back with `readResource("main")`.
   */
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  /** Create a file writer for binary/streaming content. */
  createFileWriter: (specName: string, name: string) => DataWriter;
  /**
   * Build a fresh, isolated cel-js `Environment` seeded with swamp's
   * baseline arithmetic-overload registrations. Use this to evaluate
   * CEL expressions over data the extension already holds (e.g. a
   * selector predicate over a fleet of hosts). Each call returns a
   * new Environment — registrations on one returned instance do not
   * affect any other.
   */
  createCelEnvironment: () => Environment;
  /** Optional callback for emitting domain events during execution. */
  onEvent?: (event: MethodExecutionEvent) => void;
}

/** Result returned from a model method execution. */
export interface MethodResult {
  /** Data handles referencing artifacts persisted during execution. */
  dataHandles?: DataHandle[];
}
