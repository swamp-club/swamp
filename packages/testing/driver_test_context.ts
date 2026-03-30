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

import type { DataHandle } from "./types.ts";
import type { ExecutionCallbacks, ExecutionRequest } from "./driver_types.ts";

/** A captured log line from execution callbacks. */
export interface CapturedDriverLog {
  line: string;
  timestamp: number;
}

/** A captured resource-written event from execution callbacks. */
export interface CapturedResourceEvent {
  handle: DataHandle;
  timestamp: number;
}

/** Options for creating an execution request. */
export interface TestExecutionRequestOptions {
  protocolVersion?: number;
  modelType?: string;
  modelId?: string;
  methodName?: string;
  globalArgs?: Record<string, unknown>;
  methodArgs?: Record<string, unknown>;
  definitionMeta?: Partial<ExecutionRequest["definitionMeta"]>;
  resourceSpecs?: Record<string, unknown>;
  fileSpecs?: Record<string, unknown>;
  bundle?: Uint8Array;
  traceHeaders?: Record<string, string>;
}

/** The return value from createDriverTestContext. */
export interface DriverTestContextResult {
  /** A well-formed ExecutionRequest with sensible defaults. */
  request: ExecutionRequest;
  /** ExecutionCallbacks that capture logs and resource events. */
  callbacks: ExecutionCallbacks;
  /** Returns all log lines captured via the onLog callback. */
  getCapturedLogs(): CapturedDriverLog[];
  /** Returns all resource events captured via onResourceWritten. */
  getCapturedResourceEvents(): CapturedResourceEvent[];
}

/**
 * Creates a test context for unit testing execution driver implementations.
 *
 * Provides a well-formed ExecutionRequest and callbacks that capture events
 * for inspection.
 *
 * ```typescript
 * import { createDriverTestContext } from "@systeminit/swamp-testing";
 *
 * Deno.test("driver executes method", async () => {
 *   const { request, callbacks, getCapturedLogs } = createDriverTestContext({
 *     methodName: "run",
 *     globalArgs: { region: "us-east-1" },
 *   });
 *
 *   const result = await myDriver.execute(request, callbacks);
 *   assertEquals(result.status, "success");
 *   assert(getCapturedLogs().length > 0);
 * });
 * ```
 */
export function createDriverTestContext(
  options?: TestExecutionRequestOptions,
): DriverTestContextResult {
  const capturedLogs: CapturedDriverLog[] = [];
  const capturedResourceEvents: CapturedResourceEvent[] = [];

  const request: ExecutionRequest = {
    protocolVersion: options?.protocolVersion ?? 1,
    modelType: options?.modelType ?? "test/model",
    modelId: options?.modelId ?? crypto.randomUUID(),
    methodName: options?.methodName ?? "run",
    globalArgs: options?.globalArgs ?? {},
    methodArgs: options?.methodArgs ?? {},
    definitionMeta: {
      id: options?.definitionMeta?.id ?? crypto.randomUUID(),
      name: options?.definitionMeta?.name ?? "test-instance",
      version: options?.definitionMeta?.version ?? 1,
      tags: options?.definitionMeta?.tags ?? {},
    },
    ...(options?.resourceSpecs !== undefined
      ? { resourceSpecs: options.resourceSpecs }
      : {}),
    ...(options?.fileSpecs !== undefined
      ? { fileSpecs: options.fileSpecs }
      : {}),
    ...(options?.bundle !== undefined ? { bundle: options.bundle } : {}),
    ...(options?.traceHeaders !== undefined
      ? { traceHeaders: options.traceHeaders }
      : {}),
  };

  const callbacks: ExecutionCallbacks = {
    onLog(line: string) {
      capturedLogs.push({ line, timestamp: Date.now() });
    },
    onResourceWritten(handle: DataHandle) {
      capturedResourceEvents.push({ handle, timestamp: Date.now() });
    },
  };

  return {
    request,
    callbacks,
    getCapturedLogs: () => [...capturedLogs],
    getCapturedResourceEvents: () => [...capturedResourceEvents],
  };
}
