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

import type { DataHandle } from "../models/model.ts";

/**
 * Serializable request envelope sent to an execution driver.
 */
export interface ExecutionRequest {
  /** Protocol version for forward compatibility. */
  protocolVersion: number;
  /** The model type identifier. */
  modelType: string;
  /** The model/definition ID. */
  modelId: string;
  /** The method name to execute. */
  methodName: string;
  /** Pre-validated global arguments from the definition. */
  globalArgs: Record<string, unknown>;
  /** Pre-validated per-method arguments. */
  methodArgs: Record<string, unknown>;
  /** Definition metadata. */
  definitionMeta: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  /** Resource output spec metadata (spec names, tags, etc.). */
  resourceSpecs?: Record<string, unknown>;
  /** File output spec metadata (spec names, content types, etc.). */
  fileSpecs?: Record<string, unknown>;
  /** Optional bundled module for out-of-process execution. */
  bundle?: Uint8Array;
}

/**
 * Callbacks for real-time events during execution.
 */
export interface ExecutionCallbacks {
  /** Called when a log line is emitted. */
  onLog?: (line: string) => void;
  /** Called when a resource is written. */
  onResourceWritten?: (handle: DataHandle) => void;
}

/**
 * A single output from a driver execution.
 *
 * - `"persisted"`: data was written in-process; handle references existing data.
 * - `"pending"`: data needs to be persisted by the host (for out-of-process drivers).
 */
export type DriverOutput =
  | { kind: "persisted"; handle: DataHandle }
  | {
    kind: "pending";
    specName: string;
    name: string;
    type: "resource" | "file";
    content: Uint8Array;
    tags?: Record<string, string>;
    /** Execution metadata from the driver (exit code, timing, etc.). */
    metadata?: Record<string, unknown>;
  };

/**
 * Result returned by an execution driver.
 */
export interface ExecutionResult {
  /** Whether execution succeeded or failed. */
  status: "success" | "error";
  /** Error message if status is "error". */
  error?: string;
  /** Outputs produced during execution. */
  outputs: DriverOutput[];
  /** Log lines captured during execution. */
  logs: string[];
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** Follow-up actions from the method result (in-process drivers only). */
  followUpActions?: unknown[];
}

/**
 * Pluggable execution driver interface.
 *
 * Drivers control how model methods are executed — in-process (raw),
 * in a container (docker), or remotely (lambda, ssh, etc.).
 */
export interface ExecutionDriver {
  /** The driver type identifier. */
  readonly type: string;

  /**
   * Execute a model method.
   *
   * @param request - The execution request envelope
   * @param callbacks - Optional real-time event callbacks
   * @returns The execution result
   */
  execute(
    request: ExecutionRequest,
    callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult>;

  /** Optional initialization (e.g., pull Docker image). */
  initialize?(): Promise<void>;

  /** Optional cleanup (e.g., stop container). */
  shutdown?(): Promise<void>;
}
