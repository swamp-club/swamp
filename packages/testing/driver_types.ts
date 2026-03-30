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
 * Extension-author-facing subset of swamp's execution driver interfaces.
 *
 * These types mirror the interfaces that extension driver implementations
 * actually use. A CI test in the main swamp repo verifies structural
 * compatibility with the canonical types.
 */

import type { DataHandle } from "./types.ts";

/** Serializable request envelope sent to an execution driver. */
export interface ExecutionRequest {
  protocolVersion: number;
  modelType: string;
  modelId: string;
  methodName: string;
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  definitionMeta: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  resourceSpecs?: Record<string, unknown>;
  fileSpecs?: Record<string, unknown>;
  bundle?: Uint8Array;
  traceHeaders?: Record<string, string>;
}

/** Callbacks for real-time events during execution. */
export interface ExecutionCallbacks {
  onLog?: (line: string) => void;
  onResourceWritten?: (handle: DataHandle) => void;
}

/** A single output from a driver execution. */
export type DriverOutput =
  | { kind: "persisted"; handle: DataHandle }
  | {
    kind: "pending";
    specName: string;
    name: string;
    type: "resource" | "file";
    content: Uint8Array;
    tags?: Record<string, string>;
    metadata?: Record<string, unknown>;
  };

/** Result returned by an execution driver. */
export interface ExecutionResult {
  status: "success" | "error";
  error?: string;
  outputs: DriverOutput[];
  logs: string[];
  durationMs: number;
  followUpActions?: unknown[];
}

/**
 * Pluggable execution driver interface.
 *
 * Extension authors implement this interface to control how model methods
 * are executed — in-process, in a container, or remotely.
 */
export interface ExecutionDriver {
  readonly type: string;
  execute(
    request: ExecutionRequest,
    callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult>;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
}
