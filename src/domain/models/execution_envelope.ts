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

import type { DataHandle } from "./model.ts";

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

export type ExecutionOutput =
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

export interface ExecutionResult {
  status: "success" | "error";
  error?: string;
  /**
   * paths the error marked, so the error rebuilt from error can carry them to
   * telemetry
   */
  errorPaths?: string[];
  /**
   * the UserError code, so the error rebuilt from error is a UserError with
   * that code and a failed workflow step records it
   */
  errorCode?: string;
  outputs: ExecutionOutput[];
  logs: string[];
  durationMs: number;
}

const TRACE_HEADER_ENV_NAMES: ReadonlyMap<string, string> = new Map([
  ["traceparent", "TRACEPARENT"],
  ["tracestate", "TRACESTATE"],
]);

/**
 * only traceparent and tracestate are mapped and any other key is dropped, so a
 * header record can never name an arbitrary variable in a child's environment
 */
export function traceHeadersToEnv(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!headers) {
    return env;
  }
  for (const [key, value] of Object.entries(headers)) {
    const envName = TRACE_HEADER_ENV_NAMES.get(key.toLowerCase());
    if (envName) {
      env[envName] = value;
    }
  }
  return env;
}
