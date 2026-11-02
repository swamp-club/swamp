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

import type { ModelType } from "./model_type.ts";
import type { ModelOutput, ModelOutputId } from "./model_output.ts";
import type { OutputSummary } from "./output_summary.ts";
import type { DefinitionId } from "../definitions/definition.ts";

export interface OutputKey {
  type: ModelType;
  definitionId: string;
  methodName: string;
}

export type SelectReadableOutputs = (
  keys: readonly OutputKey[],
) => Promise<readonly boolean[]>;

export interface NewestFirstOutput {
  output: OutputSummary;
  type: ModelType;
  method: string;
  position: number;
}

/**
 * The outputs of a time window, read a batch at a time, newest first. Outputs
 * whose start cannot be told without reading them come first, in walk order.
 * It holds nothing between calls, so a caller may stop at any point.
 */
export interface OutputsNewestFirst {
  next(count: number): Promise<NewestFirstOutput[]>;

  unreadStartedBefore(instant: Date): boolean;

  readonly unread: number;
}

export interface OutputSummaryOptions {
  /**
   * Fill in `errorMessage` on every run that did not succeed, which opens
   * those runs' records.
   */
  errorMessages?: boolean;
}

export interface OutputRepository {
  findById(
    type: ModelType,
    method: string,
    id: ModelOutputId,
  ): Promise<ModelOutput | null>;

  findByIds(
    type: ModelType,
    method: string,
    ids: ReadonlySet<string>,
  ): Promise<Map<string, ModelOutput>>;

  findByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
  ): Promise<ModelOutput[]>;

  findLatestByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
  ): Promise<ModelOutput | null>;

  findAll(type: ModelType): Promise<ModelOutput[]>;

  /**
   * returned outputs may be shared with concurrent callers, so treat them as
   * read-only; they are not filtered for any principal, so authorize and redact
   * on derived values. selectReadable may omit refused keys.
   */
  findAllGlobal(
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<
    { output: ModelOutput; type: ModelType; method: string }[]
  >;

  findAllGlobalSummaries(
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<{ output: OutputSummary; type: ModelType; method: string }[]>;

  /**
   * prefer over findAllGlobalSummaries() when the caller has a time bound;
   * implementations may short-circuit the scan. Summaries are read-only and
   * shared.
   */
  findAllGlobalSince(
    cutoff: Date,
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
    options?: OutputSummaryOptions,
  ): Promise<{ output: OutputSummary; type: ModelType; method: string }[]>;

  findGlobalNewestFirst(
    window: { since?: Date; until?: Date },
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<OutputsNewestFirst>;

  findHistoryNewestFirst(
    type: ModelType,
    definitionId: DefinitionId,
    window: { since?: Date; until?: Date },
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<OutputsNewestFirst>;

  save(type: ModelType, method: string, output: ModelOutput): Promise<void>;

  /**
   * Deletes an output together with its own run log. A log the output only
   * references (a workflow step's output points at its workflow run's log)
   * is left in place.
   *
   * @param type - The model type
   * @param method - The method name
   * @param id - The output ID
   */
  delete(type: ModelType, method: string, id: ModelOutputId): Promise<void>;

  nextId(): ModelOutputId;

  getPath(type: ModelType, method: string, output: ModelOutput): string;

  deleteOlderThan(
    cutoff: Date,
    options?: { dryRun?: boolean },
  ): Promise<{ deleted: number; bytesReclaimed: number }>;

  /**
   * deletes outputs past their method's outputLifetime or the fallback cutoff,
   * whichever is more recent. With limit, the orphaned run-log sweep waits for
   * the batch reporting no more.
   */
  deleteByMethodLifetime(
    fallbackCutoff: Date,
    options?: { dryRun?: boolean; limit?: number },
  ): Promise<{ deleted: number; bytesReclaimed: number; more?: boolean }>;
}
