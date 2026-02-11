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

import { z } from "zod";
import type { DefinitionId } from "../definitions/definition.ts";

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
] as const;
export type ExecutionStatus = typeof ExecutionStatuses[number];

/**
 * What triggered the execution.
 */
export const TriggerTypes = ["manual", "workflow"] as const;
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
}

/**
 * Zod schema for a data artifact reference.
 */
export const DataArtifactRefSchema = z.object({
  dataId: z.string().uuid(),
  name: z.string().min(1),
  version: z.number().int().positive(),
  tags: z.record(z.string(), z.string()),
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
    );
  }

  /**
   * Reconstructs a ModelOutput from persisted data.
   *
   * @param data - The persisted data
   * @returns A ModelOutput instance
   */
  static fromData(data: ModelOutputData): ModelOutput {
    const validated = ModelOutputSchema.parse(data);
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
    );
  }

  /**
   * Gets the current execution status.
   */
  get status(): ExecutionStatus {
    return this._status;
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
  markRunning(): void {
    if (this._status !== "pending") {
      throw new Error(
        `Cannot mark output as running: status is ${this._status}`,
      );
    }
    this._status = "running";
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
    this._durationMs = completed.getTime() - this.startedAt.getTime();
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
    this._durationMs = completed.getTime() - this.startedAt.getTime();
    this._error = error;
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
    return this._status === "succeeded" || this._status === "failed";
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
