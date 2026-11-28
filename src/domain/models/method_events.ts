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

/**
 * topology-agnostic, carrying no jobId or stepId; the workflow execution layer
 * wraps them with topology context
 */
export type MethodExecutionEvent =
  | {
    type: "output";
    line: string;
    stream: "stdout" | "stderr";
    /**
     * stream folds warnings and errors together, so this keeps the difference;
     * absent on events from older workers
     */
    level?: "info" | "warning" | "error";
  }
  | {
    type: "vault_secret_stored";
    fieldPath: string;
    vaultName: string;
    vaultKey: string;
  }
  | {
    type: "schema_validation_warning";
    specName: string;
    instanceName: string;
    error: string;
  }
  | {
    type: "vault_single_quote_warning";
    message: string;
  }
  | {
    /**
     * a written data name cannot be stored on Windows as written; the write
     * went ahead on this host
     */
    type: "data_name_portability_warning";
    message: string;
  }
  | {
    /** a tag source set a key the writer stamps itself, so its value was dropped */
    type: "stamped_tag_ignored";
    message: string;
  }
  | {
    /**
     * A sensitive value read through data stays in the command line because
     * the shell cannot expand an environment variable where it sits.
     */
    type: "sensitive_value_in_command_line";
    message: string;
  }
  | {
    type: "step_queued";
    requirement: string;
  }
  | {
    type: "step_target_disconnected";
    target: string;
  }
  | {
    type: "nested_model_invocation";
    targetModelType: string;
    targetMethod: string;
    callerModelType: string;
    callerMethod: string;
  };

const BACKPRESSURE = Symbol.for("swamp.outputBackpressure");
const PENDING_BACKPRESSURE = Symbol.for("swamp.pendingOutputBackpressure");

/**
 * marks a promise an output event's delivery returned as backpressure, the
 * only kind a producer of output waits on; it never rejects
 */
export function asOutputBackpressure(
  promise: Promise<void> | undefined,
): Promise<void> | undefined {
  if (promise === undefined) return undefined;
  return Object.assign(promise, { [BACKPRESSURE]: true });
}

export function isOutputBackpressure(
  value: unknown,
): value is Promise<void> {
  return value instanceof Promise &&
    (value as unknown as Record<symbol, unknown>)[BACKPRESSURE] === true;
}

/** the backpressure a logger wrapped for output has pending, if any */
export function pendingOutputBackpressure(
  logger: unknown,
): Promise<void> | undefined {
  if (logger === null || typeof logger !== "object") return undefined;
  const pending = (logger as Record<symbol, unknown>)[PENDING_BACKPRESSURE];
  return typeof pending === "function"
    ? (pending as () => Promise<void> | undefined)()
    : undefined;
}

export const PENDING_OUTPUT_BACKPRESSURE: typeof PENDING_BACKPRESSURE =
  PENDING_BACKPRESSURE;
