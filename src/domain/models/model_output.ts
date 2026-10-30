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

import { z } from "zod";
import type { DefinitionId } from "../definitions/definition.ts";
import { markModelWording, modelWording } from "../behavior_wording.ts";
import { errorPaths, markErrorPaths } from "../errors.ts";

/**
 * Branded type for ModelOutput IDs.
 */
export type ModelOutputId = string & { readonly _brand: unique symbol };

/**
 * Creates a ModelOutputId from a string.
 */
export function createModelOutputId(id: string): ModelOutputId {
  return id as ModelOutputId;
}

/**
 * Valid execution statuses.
 */
export const ExecutionStatuses = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type ExecutionStatus = typeof ExecutionStatuses[number];

/**
 * Whether a run with `status` has finished. A finished record never changes
 * again: `ModelOutput` moves only out of `pending` and `running`.
 */
export function isSettledStatus(status: ExecutionStatus): boolean {
  return status === "succeeded" || status === "failed" ||
    status === "cancelled";
}

/**
 * What triggered the execution.
 */
export const TriggerTypes = ["manual", "workflow", "model"] as const;
export type TriggerType = typeof TriggerTypes[number];

/**
 * Zod schema for execution error details.
 */
export const ExecutionErrorSchema = z.object({
  message: z.string(),
  stack: z.string().optional(),
});

/**
 * Type representing execution error details.
 */
export type ExecutionError = z.infer<typeof ExecutionErrorSchema>;

/** Masks text the way the run's redactor does. */
export interface ErrorRedactor {
  readonly hasSecrets: boolean;
  redact(text: string): string;
}

/**
 * The {@link ExecutionError} a failure record holds for `error`, its message
 * and stack passed through the run's redactor, so a method error that echoes
 * a delivered value, or a sentinel in a typed run, lands masked in
 * `outputs/<type>/<method>/*.yaml` (design/enablers/typed-secrets.md Section
 * 7.1). Without a redactor, or with one holding nothing, the text is kept as
 * it is. The method boundary builds its failure record's error here; the run
 * and workflow entry points, which write their own records, adopt it when
 * Phase 3.5 and Phase 4 wire them.
 */
export function executionErrorFrom(
  error: unknown,
  redactor?: ErrorRedactor,
): ExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const clean = (text: string) =>
    redactor?.hasSecrets ? redactor.redact(text) : text;
  return {
    message: clean(message),
    ...(stack === undefined ? {} : { stack: clean(stack) }),
  };
}

/**
 * `error` with its message and stack passed through `redactor`, as
 * {@link executionErrorFrom} reads them, for a caller that rethrows or
 * reports it (swamp-club#3681). A string `code` is passed through it too,
 * since a workflow step records it next to the message (swamp-club#3773).
 * It is the same value when the redactor holds
 * nothing or nothing changes. Otherwise an Error becomes a copy that keeps
 * its class, name, cause, own properties (a code, recovered data handles,
 * written versions, an AggregateError's errors), marked paths and model
 * spelling, the spelling redacted too. Any other value becomes its redacted
 * `String()` text, which is how every reader shows a thrown non-Error. Only
 * the error's own message and stack are read, as `executionErrorFrom` reads
 * them: a wrapped cause is kept as it is.
 */
export function redactedError(
  error: unknown,
  redactor?: ErrorRedactor,
): unknown {
  if (!redactor?.hasSecrets) return error;
  if (!(error instanceof Error)) {
    const text = String(error);
    const shown = redactor.redact(text);
    return shown === text ? error : shown;
  }
  const failure = executionErrorFrom(error, redactor);
  const code = (error as { code?: unknown }).code;
  const shownCode = typeof code === "string" ? redactor.redact(code) : code;
  if (
    failure.message === error.message && failure.stack === error.stack &&
    shownCode === code
  ) {
    return error;
  }
  const cleaned = new Error(failure.message);
  // Own, so it still reads after the class is restored below, even where
  // the class defines `name` as an accessor.
  cleaned.name = error.name;
  if (failure.stack !== undefined) cleaned.stack = failure.stack;
  const codeChanged = shownCode !== code;
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === "message" || key === "stack") continue;
    if (key === "code" && codeChanged) continue;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor) Object.defineProperty(cleaned, key, descriptor);
  }
  // A plain data property whatever the original was, so an accessor or a
  // non-configurable code cannot make the copy throw.
  if (codeChanged) {
    Object.defineProperty(cleaned, "code", {
      value: shownCode,
      writable: true,
      enumerable: Object.getOwnPropertyDescriptor(error, "code")?.enumerable ??
        true,
      configurable: true,
    });
  }
  // The class is kept, so a coded UserError is still one and a workflow step
  // keeps its error code (swamp-club#3748).
  Object.setPrototypeOf(cleaned, Object.getPrototypeOf(error));
  const spelling = modelWording(error);
  if (spelling !== undefined) {
    markModelWording(cleaned, redactor.redact(spelling));
  }
  return markErrorPaths(cleaned, errorPaths(error));
}

/**
 * Zod schema for execution provenance.
 */
export const ExecutionProvenanceSchema = z.object({
  definitionHash: z.string(),
  modelVersion: z.preprocess(
    (val) => (typeof val === "number" ? String(val) : val),
    z.string(),
  ),
  triggeredBy: z.enum(TriggerTypes),
  workflowId: z.string().optional(),
  workflowRunId: z.string().optional(),
  stepName: z.string().optional(),
  parentOutputId: z.string().uuid().optional(),
  callerExtension: z.string().optional(),
  initiatedBy: z.string().optional(),
  bundleFingerprint: z.string().optional(),
});

/**
 * Type representing execution provenance.
 */
export type ExecutionProvenance = z.infer<typeof ExecutionProvenanceSchema>;

/**
 * Represents a reference to a Data artifact.
 */
export interface DataArtifactRef {
  dataId: string;
  name: string;
  version: number;
  tags: Record<string, string>;
  /**
   * The SHA-256 of the version's content, recorded on a v3 datastore
   * (swamp-club#3279), where a removed version can be written again: it
   * tells the content this run produced from a later re-save. Absent on v2
   * records, and on any version whose save reported no checksum.
   */
  sha256?: string;
}

/**
 * Zod schema for a data artifact reference.
 */
export const DataArtifactRefSchema = z.object({
  dataId: z.string().uuid(),
  name: z.string().min(1),
  version: z.number().int().positive(),
  tags: z.record(z.string(), z.string()),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

/**
 * Zod schema for artifacts produced by the execution.
 */
export const ArtifactsProducedSchema = z.object({
  dataArtifacts: z.array(DataArtifactRefSchema).default([]),
});

/**
 * Type representing artifacts produced.
 */
export type ArtifactsProduced = z.infer<typeof ArtifactsProducedSchema>;

/**
 * Zod schema for the core properties of a ModelOutput.
 */
export const ModelOutputSchema = z.object({
  id: z.string().uuid(),
  definitionId: z.string().uuid(),
  methodName: z.string().min(1),
  status: z.enum(ExecutionStatuses),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  error: ExecutionErrorSchema.optional(),
  retryCount: z.number().int().nonnegative().default(0),
  provenance: ExecutionProvenanceSchema,
  artifacts: ArtifactsProducedSchema.optional(),
  logFile: z.string().optional(),
  pid: z.number().int().positive().optional(),
});

/**
 * Type representing the data stored in a ModelOutput.
 */
export type ModelOutputData = z.infer<typeof ModelOutputSchema>;

/**
 * Properties required to create a new ModelOutput.
 */
export interface CreateModelOutputProps {
  id?: string;
  definitionId: DefinitionId;
  methodName: string;
  status?: ExecutionStatus;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  error?: ExecutionError;
  retryCount?: number;
  provenance: ExecutionProvenance;
  artifacts?: ArtifactsProduced;
  logFile?: string;
}

/**
 * Milliseconds from start to completion, floored at 0. Both are wall-clock
 * readings, so a clock stepped backward mid-run can put completion first.
 */
function durationBetween(startedAt: Date, completedAt: Date): number {
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

/**
 * ModelOutput is an entity tracking execution state and metadata for each method run.
 *
 * Tracks status, timing, errors, provenance (what triggered it), and artifacts produced.
 */
export class ModelOutput {
  private constructor(
    readonly id: ModelOutputId,
    readonly definitionId: DefinitionId,
    readonly methodName: string,
    private _status: ExecutionStatus,
    readonly startedAt: Date,
    private _completedAt: Date | undefined,
    private _durationMs: number | undefined,
    private _error: ExecutionError | undefined,
    private _retryCount: number,
    readonly provenance: ExecutionProvenance,
    private _artifacts: ArtifactsProduced,
    private _logFile: string | undefined,
    private _pid: number | undefined = undefined,
  ) {}

  /**
   * Creates a new ModelOutput instance.
   *
   * @param props - Properties for the new output
   * @returns A new ModelOutput instance
   */
  static create(props: CreateModelOutputProps): ModelOutput {
    const id = props.id ?? crypto.randomUUID();
    const startedAt = props.startedAt ?? new Date();

    const validated = ModelOutputSchema.parse({
      id,
      definitionId: props.definitionId,
      methodName: props.methodName,
      status: props.status ?? "pending",
      startedAt: startedAt.toISOString(),
      completedAt: props.completedAt?.toISOString(),
      durationMs: props.durationMs,
      error: props.error,
      retryCount: props.retryCount ?? 0,
      provenance: props.provenance,
      artifacts: props.artifacts ?? { dataArtifacts: [] },
      logFile: props.logFile,
    });

    return new ModelOutput(
      createModelOutputId(validated.id),
      validated.definitionId as DefinitionId,
      validated.methodName,
      validated.status,
      new Date(validated.startedAt),
      validated.completedAt ? new Date(validated.completedAt) : undefined,
      validated.durationMs,
      validated.error,
      validated.retryCount,
      validated.provenance,
      validated.artifacts ?? { dataArtifacts: [] },
      validated.logFile,
      validated.pid,
    );
  }

  /**
   * Reconstructs a ModelOutput from persisted data.
   *
   * A negative durationMs is read as 0. Records written before durations
   * were clamped carry one when the clock stepped backward mid-run; the
   * timestamps themselves are kept as recorded.
   *
   * @param data - The persisted data
   * @returns A ModelOutput instance
   */
  static fromData(data: ModelOutputData): ModelOutput {
    const validated = ModelOutputSchema.parse(
      typeof data.durationMs === "number" && data.durationMs < 0
        ? { ...data, durationMs: 0 }
        : data,
    );
    return new ModelOutput(
      createModelOutputId(validated.id),
      validated.definitionId as DefinitionId,
      validated.methodName,
      validated.status,
      new Date(validated.startedAt),
      validated.completedAt ? new Date(validated.completedAt) : undefined,
      validated.durationMs,
      validated.error,
      validated.retryCount,
      validated.provenance,
      validated.artifacts ?? { dataArtifacts: [] },
      validated.logFile,
      validated.pid,
    );
  }

  /**
   * Gets the current execution status.
   */
  get status(): ExecutionStatus {
    return this._status;
  }

  get pid(): number | undefined {
    return this._pid;
  }

  /**
   * Gets the completion timestamp.
   */
  get completedAt(): Date | undefined {
    return this._completedAt;
  }

  /**
   * Gets the duration in milliseconds.
   */
  get durationMs(): number | undefined {
    return this._durationMs;
  }

  /**
   * Gets the error details if the execution failed.
   */
  get error(): ExecutionError | undefined {
    return this._error ? { ...this._error } : undefined;
  }

  /**
   * Gets the retry count.
   */
  get retryCount(): number {
    return this._retryCount;
  }

  /**
   * Gets the artifacts produced by this execution.
   */
  get artifacts(): ArtifactsProduced {
    return {
      dataArtifacts: [...this._artifacts.dataArtifacts],
    };
  }

  /**
   * Gets the log file path for this execution.
   */
  get logFile(): string | undefined {
    return this._logFile;
  }

  /**
   * Sets the log file path for this execution.
   */
  setLogFile(path: string): void {
    this._logFile = path;
  }

  /**
   * Marks the execution as running.
   */
  markRunning(pid?: number): void {
    if (this._status !== "pending") {
      throw new Error(
        `Cannot mark output as running: status is ${this._status}`,
      );
    }
    this._status = "running";
    this._pid = pid;
  }

  /**
   * Marks the execution as succeeded.
   *
   * @param completedAt - The completion timestamp (defaults to now)
   */
  markSucceeded(completedAt?: Date): void {
    if (this._status !== "running") {
      throw new Error(
        `Cannot mark output as succeeded: status is ${this._status}`,
      );
    }
    const completed = completedAt ?? new Date();
    this._status = "succeeded";
    this._completedAt = completed;
    this._durationMs = durationBetween(this.startedAt, completed);
  }

  /**
   * Marks the execution as failed.
   *
   * @param error - The error details
   * @param completedAt - The completion timestamp (defaults to now)
   */
  markFailed(error: ExecutionError, completedAt?: Date): void {
    if (this._status !== "running") {
      throw new Error(
        `Cannot mark output as failed: status is ${this._status}`,
      );
    }
    const completed = completedAt ?? new Date();
    this._status = "failed";
    this._completedAt = completed;
    this._durationMs = durationBetween(this.startedAt, completed);
    this._error = error;
  }

  /**
   * Marks the execution as cancelled.
   *
   * @param reason - Optional reason for cancellation
   */
  markCancelled(reason?: string): void {
    if (
      this._status !== "pending" && this._status !== "running"
    ) {
      throw new Error(
        `Cannot mark output as cancelled: status is ${this._status}`,
      );
    }
    const completed = new Date();
    this._status = "cancelled";
    this._completedAt = completed;
    this._durationMs = durationBetween(this.startedAt, completed);
    if (reason !== undefined) {
      this._error = { message: reason };
    }
  }

  /**
   * Increments the retry count.
   */
  incrementRetryCount(): void {
    this._retryCount++;
  }

  /**
   * Adds a data artifact reference to this execution.
   *
   * @param artifact - The data artifact reference to add
   */
  addDataArtifact(artifact: DataArtifactRef): void {
    // Validate the artifact
    DataArtifactRefSchema.parse(artifact);
    this._artifacts.dataArtifacts.push({ ...artifact });
  }

  /**
   * Checks if the execution is in a terminal state.
   */
  get isComplete(): boolean {
    return isSettledStatus(this._status);
  }

  /**
   * Converts the output to a plain data object for persistence.
   */
  toData(): ModelOutputData {
    const data: ModelOutputData = {
      id: this.id,
      definitionId: this.definitionId,
      methodName: this.methodName,
      status: this._status,
      startedAt: this.startedAt.toISOString(),
      retryCount: this._retryCount,
      provenance: { ...this.provenance },
      artifacts: {
        dataArtifacts: this._artifacts.dataArtifacts.map((a) => ({ ...a })),
      },
    };

    if (this._completedAt) {
      data.completedAt = this._completedAt.toISOString();
    }
    if (this._durationMs !== undefined) {
      data.durationMs = this._durationMs;
    }
    if (this._error) {
      data.error = { ...this._error };
    }
    if (this._logFile) {
      data.logFile = this._logFile;
    }
    if (this._pid !== undefined) {
      data.pid = this._pid;
    }

    return data;
  }
}

/**
 * Computes a hash of the definition attributes for provenance tracking.
 *
 * @param attributes - The attributes to hash
 * @returns The hex-encoded SHA-256 hash
 */
export async function computeDefinitionHash(
  attributes: Record<string, unknown>,
): Promise<string> {
  const json = JSON.stringify(attributes, Object.keys(attributes).sort());
  const data = new TextEncoder().encode(json);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
