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
import type { DefinitionId } from "../definitions/definition.ts";

/**
 * What an output's location says about it before it is read: the type and
 * method it is stored under, and the definition its file is named for.
 */
export interface OutputKey {
  type: ModelType;
  definitionId: string;
  methodName: string;
}

/**
 * Which of `keys` (distinct) the caller may read: one answer per key, in
 * order.
 */
export type SelectReadableOutputs = (
  keys: readonly OutputKey[],
) => Promise<readonly boolean[]>;

/** An output of a newest-first read, with its place in the scan's walk order. */
export interface NewestFirstOutput {
  output: ModelOutput;
  type: ModelType;
  method: string;
  /** Breaks ties between outputs started in the same millisecond. */
  position: number;
}

/**
 * The outputs of a time window, read a batch at a time, newest first. Outputs
 * whose start cannot be told without reading them come first, in walk order.
 * It holds nothing between calls, so a caller may stop at any point.
 */
export interface OutputsNewestFirst {
  /**
   * The next outputs, at most `count`. Empty only once none remain.
   *
   * @param count - The most outputs to read
   */
  next(count: number): Promise<NewestFirstOutput[]>;

  /**
   * True when every output not yet read is known to have started strictly
   * before `instant`, so no read can return one at or after it.
   *
   * @param instant - The instant to compare with
   */
  unreadStartedBefore(instant: Date): boolean;

  /** How many listed outputs have not been read or refused. */
  readonly unread: number;
}

/**
 * Repository interface for persisting and retrieving ModelOutputs.
 *
 * Stores outputs in the path structure:
 * /outputs/{normalized-type}/{method}/{model-id}-{timestamp}.yaml
 */
export interface OutputRepository {
  /**
   * Finds an output by its ID.
   *
   * @param type - The model type
   * @param method - The method name
   * @param id - The output ID
   * @returns The output if found, or null
   */
  findById(
    type: ModelType,
    method: string,
    id: ModelOutputId,
  ): Promise<ModelOutput | null>;

  /**
   * Finds the outputs of one method with the given IDs, reading the method's
   * outputs once however many IDs are asked for.
   *
   * @param type - The model type
   * @param method - The method name
   * @param ids - The output IDs to find
   * @returns The outputs found, by ID; an ID with no output is absent
   */
  findByIds(
    type: ModelType,
    method: string,
    ids: ReadonlySet<string>,
  ): Promise<Map<string, ModelOutput>>;

  /**
   * Finds all outputs for a given definition.
   *
   * @param type - The model type
   * @param definitionId - The definition ID
   * @returns Array of outputs
   */
  findByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
  ): Promise<ModelOutput[]>;

  /**
   * Finds the latest output for a given definition.
   *
   * @param type - The model type
   * @param definitionId - The definition ID
   * @returns The latest output if found, or null
   */
  findLatestByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
  ): Promise<ModelOutput | null>;

  /**
   * Finds all outputs of a given type.
   *
   * @param type - The model type
   * @returns Array of outputs
   */
  findAll(type: ModelType): Promise<ModelOutput[]>;

  /**
   * Finds all outputs across all types.
   *
   * The array is the caller's own, but implementations may share the
   * outputs in it with concurrent callers (swamp-club#4074), so they are
   * read-only. They are not filtered for any principal: authorize and
   * redact on values derived from them, never on the outputs themselves.
   *
   * With `selectReadable`, an implementation may leave out unread the
   * outputs whose location carries a key it refuses (swamp-club#4142). An
   * output whose location carries no key is returned for the caller to
   * judge, so the result still needs authorizing.
   *
   * @param signal - Stops the scan once aborted
   * @param selectReadable - Which output keys the caller may read
   * @returns Array of all outputs with their types and methods
   */
  findAllGlobal(
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<
    { output: ModelOutput; type: ModelType; method: string }[]
  >;

  /**
   * Finds all outputs across all types whose `startedAt` is at or after the
   * given cutoff. Prefer this over `findAllGlobal()` when the caller has a
   * time bound; implementations may short-circuit the underlying scan and skip
   * work that `findAllGlobal()` would do unconditionally. Its outputs are
   * read-only and shared as `findAllGlobal()`'s are.
   *
   * @param cutoff - Earliest `startedAt` to include (inclusive)
   * @param signal - Stops the scan once aborted
   * @param selectReadable - Which output keys the caller may read, as in
   *   `findAllGlobal()`
   * @returns Array of outputs whose `startedAt >= cutoff`
   */
  findAllGlobalSince(
    cutoff: Date,
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<{ output: ModelOutput; type: ModelType; method: string }[]>;

  /**
   * The outputs across all types started in `window`, for a caller that wants
   * only the most recent: outputs are read as `next` asks for them, instead of
   * every output in the window. Its outputs are read-only and shared as
   * `findAllGlobal()`'s are. Each is still to be checked against `window`.
   *
   * @param window - The earliest (inclusive) and latest (exclusive) `startedAt`
   * @param signal - Stops the reads once aborted
   * @param selectReadable - Which output keys the caller may read, as in
   *   `findAllGlobal()`, asked only about the outputs the reads reach
   * @returns The window's outputs, ready to read
   */
  findGlobalNewestFirst(
    window: { since?: Date; until?: Date },
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<OutputsNewestFirst>;

  /**
   * The outputs of one definition started in `window`, read as
   * `findGlobalNewestFirst()` reads the outputs of every type: as `next` asks
   * for them, instead of every output in the window. Each is still to be
   * checked against `window`.
   *
   * @param type - The model type
   * @param definitionId - The definition whose outputs to read
   * @param window - The earliest (inclusive) and latest (exclusive) `startedAt`
   * @param signal - Stops the reads once aborted
   * @param selectReadable - Which output keys the caller may read, as in
   *   `findAllGlobal()`, asked only about the outputs the reads reach
   * @returns The definition's outputs in the window, ready to read
   */
  findHistoryNewestFirst(
    type: ModelType,
    definitionId: DefinitionId,
    window: { since?: Date; until?: Date },
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<OutputsNewestFirst>;

  /**
   * Saves an output.
   *
   * @param type - The model type
   * @param method - The method name
   * @param output - The output to save
   */
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

  /**
   * Generates a new unique ID.
   */
  nextId(): ModelOutputId;

  /**
   * Returns the file path for an output.
   *
   * @param type - The model type
   * @param method - The method name
   * @param output - The output
   * @returns The file path
   */
  getPath(type: ModelType, method: string, output: ModelOutput): string;

  /**
   * Deletes all outputs older than the cutoff, with their own run logs, and
   * sweeps run logs that no remaining output references.
   * Returns the number of outputs deleted and bytes reclaimed (logs included).
   */
  deleteOlderThan(
    cutoff: Date,
    options?: { dryRun?: boolean },
  ): Promise<{ deleted: number; bytesReclaimed: number }>;

  /**
   * Deletes outputs that exceed their method's declared outputLifetime.
   * Scans all output directories on disk, looking up per-method lifetime
   * policies from the model registry when available. Methods without a declared
   * lifetime (or from unregistered types) use the fallback cutoff. The effective
   * cutoff for a method is the more aggressive (more recent) of the two.
   * Run logs are removed and swept as in {@link deleteOlderThan}.
   *
   * With `limit`, stops once that many outputs are deleted (or would be, on
   * a dry run) and reports `more: true` when another expired output remains;
   * the orphaned run-log sweep is then left to the batch that reports no
   * `more`. Implementations that do not batch may omit `more`.
   */
  deleteByMethodLifetime(
    fallbackCutoff: Date,
    options?: { dryRun?: boolean; limit?: number },
  ): Promise<{ deleted: number; bytesReclaimed: number; more?: boolean }>;
}
