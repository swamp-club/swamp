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

import {
  type ExecutionStatus,
  ExecutionStatuses,
  type ModelOutput,
  type TriggerType,
  TriggerTypes,
} from "./model_output.ts";

/**
 * What a listing of a method's runs needs to know about one run: a read-only
 * projection of a {@link ModelOutput}, without the content (artifacts, inputs,
 * log file) only a caller opening that one run needs.
 */
export interface OutputSummary {
  readonly id: string;
  readonly definitionId: string;
  readonly methodName: string;
  readonly status: ExecutionStatus;
  readonly startedAt: Date;
  readonly durationMs?: number;
  readonly provenance: {
    readonly triggeredBy: TriggerType;
    readonly workflowId?: string;
    readonly workflowRunId?: string;
    readonly stepName?: string;
  };
  /**
   * The run's error message, on a summary read from its record. Never stored
   * outside the record, so retention has only the record to remove.
   */
  readonly errorMessage?: string;
}

/** An {@link OutputSummary} as stored: one line of a summary shard. */
export interface OutputSummaryData {
  id: string;
  definitionId: string;
  methodName: string;
  status: ExecutionStatus;
  startedAt: string;
  durationMs?: number;
  triggeredBy: TriggerType;
  workflowId?: string;
  workflowRunId?: string;
  stepName?: string;
}

const STATUSES: ReadonlySet<string> = new Set(ExecutionStatuses);
const TRIGGERS: ReadonlySet<string> = new Set(TriggerTypes);

/** The summary of `output`. */
export function outputSummaryOf(output: ModelOutput): OutputSummary {
  const { triggeredBy, workflowId, workflowRunId, stepName } =
    output.provenance;
  const errorMessage = output.error?.message;
  return {
    id: output.id,
    definitionId: output.definitionId,
    methodName: output.methodName,
    status: output.status,
    startedAt: output.startedAt,
    ...(output.durationMs !== undefined
      ? { durationMs: output.durationMs }
      : {}),
    provenance: {
      triggeredBy,
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(workflowRunId !== undefined ? { workflowRunId } : {}),
      ...(stepName !== undefined ? { stepName } : {}),
    },
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

/** `summary` as stored, leaving out its error message. */
export function outputSummaryToData(summary: OutputSummary): OutputSummaryData {
  return {
    id: summary.id,
    definitionId: summary.definitionId,
    methodName: summary.methodName,
    status: summary.status,
    startedAt: summary.startedAt.toISOString(),
    ...(summary.durationMs !== undefined
      ? { durationMs: summary.durationMs }
      : {}),
    triggeredBy: summary.provenance.triggeredBy,
    ...(summary.provenance.workflowId !== undefined
      ? { workflowId: summary.provenance.workflowId }
      : {}),
    ...(summary.provenance.workflowRunId !== undefined
      ? { workflowRunId: summary.provenance.workflowRunId }
      : {}),
    ...(summary.provenance.stepName !== undefined
      ? { stepName: summary.provenance.stepName }
      : {}),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * The summary stored as `data`, or undefined when it is not one. Stored
 * summaries are not trusted, and are checked by hand rather than by a schema
 * because a search reads tens of thousands of them.
 */
export function outputSummaryFromData(
  data: unknown,
): OutputSummary | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const row = data as Record<string, unknown>;
  const { id, definitionId, methodName, status, startedAt, durationMs } = row;
  const { triggeredBy, workflowId, workflowRunId, stepName } = row;
  if (
    !isNonEmptyString(id) || !isNonEmptyString(definitionId) ||
    !isNonEmptyString(methodName) || typeof status !== "string" ||
    !STATUSES.has(status) || typeof startedAt !== "string" ||
    typeof triggeredBy !== "string" || !TRIGGERS.has(triggeredBy) ||
    !isOptionalString(workflowId) || !isOptionalString(workflowRunId) ||
    !isOptionalString(stepName)
  ) {
    return undefined;
  }
  if (
    durationMs !== undefined &&
    (!Number.isSafeInteger(durationMs) || (durationMs as number) < 0)
  ) {
    return undefined;
  }
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime()) || started.toISOString() !== startedAt) {
    return undefined;
  }
  return {
    id,
    definitionId,
    methodName,
    status: status as ExecutionStatus,
    startedAt: started,
    ...(durationMs !== undefined ? { durationMs: durationMs as number } : {}),
    provenance: {
      triggeredBy: triggeredBy as TriggerType,
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(workflowRunId !== undefined ? { workflowRunId } : {}),
      ...(stepName !== undefined ? { stepName } : {}),
    },
  };
}
