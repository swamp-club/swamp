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

import type { TriggerType } from "../../domain/models/model_output.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import { parseRunTimeBound } from "../workflows/run_search.ts";

import {
  observeDiagnosticPhase,
  type PhaseTally,
} from "../../domain/diagnostics/diagnostic_phase.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * A single model output search result item.
 */
export interface ModelOutputSearchItem {
  id: string;
  definitionId: string;
  modelName?: string;
  type: string;
  methodName: string;
  status: string;
  startedAt: string;
  durationMs?: number;
  /** What started the method run, from the output's provenance. */
  triggeredBy?: TriggerType;
  /** The workflow whose run executed the method, when one did. */
  workflowId?: string;
  /** The current name of `workflowId`; absent when it no longer resolves. */
  workflowName?: string;
  /** The workflow run that executed the method. */
  workflowRunId?: string;
  /** The workflow step that executed the method. */
  stepName?: string;
}

/**
 * Data payload for the completed event.
 */
export interface ModelOutputSearchData {
  query: string;
  results: ModelOutputSearchItem[];
}

export type ModelOutputSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelOutputSearchData }
  | { kind: "error"; error: SwampError };

/** The output fields the search reads. */
export interface ModelOutputSearchOutput {
  id: string;
  definitionId: string;
  methodName: string;
  status: string;
  startedAt: Date;
  durationMs?: number;
  provenance?: {
    triggeredBy: TriggerType;
    workflowId?: string;
    workflowRunId?: string;
    stepName?: string;
  };
}

/** A model definition the `model` filter resolved to. */
export interface ModelOutputSearchModel {
  definitionId: string;
  name: string;
  type: { normalized: string };
}

/**
 * What an output file's location says about the output before it is read.
 */
export interface ModelOutputSearchKey {
  type: { normalized: string };
  definitionId: string;
  methodName: string;
}

/** Which of `keys` (distinct) may be read: one answer per key, in order. */
export type ModelOutputSearchSelector = (
  keys: readonly ModelOutputSearchKey[],
) => Promise<readonly boolean[]>;

/** An output the search may leave out unread, as `canRead` is asked of it. */
export interface ModelOutputSearchCandidate {
  definitionId: string;
  /** The model name the output's result would carry. */
  modelName?: string;
  type: string;
  methodName: string;
}

/**
 * The outputs of a window read a batch at a time, newest first: see
 * {@link ModelOutputSearchDeps.findOutputsNewestFirst}.
 */
export interface ModelOutputSearchNewestFirst {
  /** The next outputs, at most `count`. Empty only once none remain. */
  next(count: number): Promise<
    Array<{
      output: ModelOutputSearchOutput;
      type: { normalized: string };
      /** Breaks ties between outputs started in the same millisecond. */
      position: number;
    }>
  >;
  /** True when every output not read yet started strictly before `instant`. */
  unreadStartedBefore(instant: Date): boolean;
  /** How many listed outputs have not been read or refused. */
  readonly unread: number;
}

/**
 * Dependencies for the model output search generator.
 */
export interface ModelOutputSearchDeps {
  /**
   * Every output. With `selectReadable`, it may leave out unread the
   * outputs whose location carries a key it refuses.
   */
  findAllOutputsGlobal(selectReadable?: ModelOutputSearchSelector): Promise<
    Array<{
      output: ModelOutputSearchOutput;
      type: { normalized: string };
    }>
  >;
  /**
   * Outputs started at or after `cutoff`, for a `since` filter, leaving out
   * what `selectReadable` refuses as {@link findAllOutputsGlobal} does.
   * Optional: without it the search reads every output and filters.
   */
  findAllOutputsGlobalSince?(
    cutoff: Date,
    selectReadable?: ModelOutputSearchSelector,
  ): Promise<
    Array<{
      output: ModelOutputSearchOutput;
      type: { normalized: string };
    }>
  >;
  /**
   * The outputs started in `window`, read as they are asked for, newest first,
   * leaving out what `selectReadable` refuses as {@link findAllOutputsGlobal}
   * does. With it, a search with a `limit` and no `model` stops reading once it
   * holds the results it will return (swamp-club#4143). Optional: without it
   * the search reads every output and keeps the most recent.
   */
  findOutputsNewestFirst?(
    window: { since?: Date; until?: Date },
    selectReadable?: ModelOutputSearchSelector,
  ): Promise<ModelOutputSearchNewestFirst>;
  /**
   * Every definition with its type, primary definitions before
   * auto-definitions. Read at most once per search to name the outputs, so
   * history holding many deleted definitions costs one scan, not one per id
   * (swamp-club#3959). Not read when {@link resolveModelNames} is given.
   */
  findAllDefinitions(): Promise<
    Array<{
      definition: { id: string; name: string };
      type: { normalized: string };
    }>
  >;
  /**
   * The names of the given definitions, looked up together, in the order
   * asked: for each, the first definition of that type and id, primary
   * definitions before auto-definitions; undefined when none resolves. Given,
   * it names the outputs instead of {@link findAllDefinitions}, so only the
   * definitions owning outputs are read (swamp-club#4141).
   */
  resolveModelNames?(
    keys: ReadonlyArray<{ type: { normalized: string }; definitionId: string }>,
  ): Promise<ReadonlyArray<string | undefined>>;
  /**
   * The definitions a `model` filter (a name or an id) names. With
   * {@link findOutputsByDefinition} it reads only those models' outputs
   * instead of every output.
   */
  resolveModel?(idOrName: string): Promise<ModelOutputSearchModel[]>;
  /**
   * The outputs of one definition. With a `window` (the search's `since`
   * and `until`) it may leave out outputs started outside it without
   * reading them; the search checks every output against them anyway.
   */
  findOutputsByDefinition?(
    type: { normalized: string },
    definitionId: string,
    window?: { since?: Date; until?: Date },
  ): Promise<ModelOutputSearchOutput[]>;
  /**
   * The outputs of one definition started in `window`, read as they are asked
   * for, newest first, leaving out what `selectReadable` refuses. With it and
   * {@link resolveModel}, a search with a `limit` and a `model` stops reading
   * once it holds the results it will return (swamp-club#4174). Optional:
   * without it the search reads every output of the model and keeps the most
   * recent.
   */
  findOutputsByDefinitionNewestFirst?(
    type: { normalized: string },
    definitionId: string,
    window: { since?: Date; until?: Date },
    selectReadable?: ModelOutputSearchSelector,
  ): Promise<ModelOutputSearchNewestFirst>;
  /**
   * The current names of the given workflow ids, looked up together. An id
   * that no longer resolves is absent from the map.
   */
  resolveWorkflowNames?(
    ids: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, string>>;
  /**
   * Which of `candidates` the caller may read, one answer per candidate, in
   * order. With it, a search without `model`, or one reading newest first,
   * leaves out unread the outputs it refuses (swamp-club#4142). Outputs whose
   * location says nothing about them are still read, so the results still need
   * authorizing. A search reading newest first also asks it about each record
   * it reads, so `limit` counts only outputs it accepts.
   */
  canRead?(
    candidates: readonly ModelOutputSearchCandidate[],
  ): Promise<readonly boolean[]>;
}

/**
 * Input for the model output search generator.
 */
export interface ModelOutputSearchInput {
  query?: string;
  /** Opt in to provenance for output search; legacy history keeps its shape. */
  includeProvenance?: boolean;
  /** Only outputs of this model, by exact name or id. */
  model?: string;
  /**
   * Only outputs started at or after this ISO 8601 instant, or this long
   * ago for a duration like `7d`.
   */
  since?: string;
  /**
   * Only outputs started before this ISO 8601 instant or duration ago
   * (exclusive), as run search and the run summary read `until`.
   */
  until?: string;
  /** At most this many results, most recent first. */
  limit?: number;
}

/**
 * A time bound as a Date: a duration (`7d`) counts back from `now`, as the
 * run queries read one; anything else must parse as a date-time.
 */
function parseInstant(
  field: "since" | "until",
  value: string | undefined,
  now: number,
): Date | undefined | SwampError {
  if (value === undefined) return undefined;
  let date: Date;
  try {
    date = new Date(parseRunTimeBound(value, now));
  } catch {
    date = new Date(value);
  }
  if (Number.isNaN(date.getTime())) {
    return validationFailed(
      `Invalid ${field}: ${value} is not a duration like 7d or an ISO 8601 date-time`,
    );
  }
  return date;
}

/**
 * Searches model outputs across all types.
 *
 * Resolves model names from definition IDs and workflow names from the
 * outputs' provenance, filters by model and start time, sorts by startedAt
 * descending and keeps at most `limit`. Filtering for JSON mode is handled
 * by the renderer.
 *
 * With `limit` and {@link ModelOutputSearchDeps.findOutputsNewestFirst}, or for
 * a `model` {@link ModelOutputSearchDeps.findOutputsByDefinitionNewestFirst}, it
 * returns the same results reading only as far as they need.
 */
export async function* modelOutputSearch(
  _ctx: LibSwampContext,
  deps: ModelOutputSearchDeps,
  input: ModelOutputSearchInput,
): AsyncGenerator<ModelOutputSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.model.output.search",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const now = Date.now();
      const since = parseInstant("since", input.since, now);
      if (since !== undefined && !(since instanceof Date)) {
        yield { kind: "error", error: since };
        return;
      }
      const until = parseInstant("until", input.until, now);
      if (until !== undefined && !(until instanceof Date)) {
        yield { kind: "error", error: until };
        return;
      }
      if (
        input.limit !== undefined &&
        (!Number.isInteger(input.limit) || input.limit < 0)
      ) {
        yield {
          kind: "error",
          error: validationFailed(
            `Invalid limit: ${input.limit} is not a non-negative integer`,
          ),
        };
        return;
      }

      // Names are looked up once each, by the scan's choice of files and
      // then for the results alike (swamp-club#4141, swamp-club#4142).
      const namer = definitionNamer(deps);

      // Each key asked about with the name its outputs' results would carry,
      // so it is judged as their results are.
      const canRead = deps.canRead;
      const selectReadable: ModelOutputSearchSelector | undefined = canRead &&
        (async (keys) => {
          await namer.resolve(keys);
          return canRead(
            await Promise.all(keys.map(async (key) => ({
              definitionId: key.definitionId,
              modelName: await namer.nameOf(key.type, key.definitionId),
              type: key.type.normalized,
              methodName: key.methodName,
            }))),
          );
        });

      // Exported as the output_search diagnostic area's phases when the
      // caller runs this in it (swamp-club#4056); silent otherwise.
      const openNewestFirst = input.limit === undefined
        ? undefined
        : newestFirstOpener(
          deps,
          input.model,
          { since, until },
          selectReadable,
        );
      let results: ModelOutputSearchItem[];
      if (openNewestFirst !== undefined) {
        const limit = input.limit!;
        results = await observeDiagnosticPhase(
          "candidate_scan",
          {},
          (phase) =>
            readNewestFirst(
              openNewestFirst,
              limit,
              { since, until },
              namer,
              canRead,
              input.includeProvenance,
              phase.tally,
            ),
        );
      } else {
        const candidates = await observeDiagnosticPhase(
          "candidate_scan",
          {},
          async (phase) => {
            const found = await findCandidates(
              deps,
              input.model,
              since,
              until,
              selectReadable,
            );
            phase.tally.add("candidates", found.length);
            return found;
          },
        );

        const inWindow = candidates.filter(({ output }) =>
          startedInWindow(output, since, until)
        );
        await namer.resolve(
          inWindow
            .filter(({ modelName }) => modelName === undefined)
            .map(({ output, type }) => ({
              type,
              definitionId: output.definitionId,
            })),
        );

        const items: ModelOutputSearchItem[] = [];
        for (const { output, type, modelName: knownName } of inWindow) {
          const modelName = knownName ??
            await namer.nameOf(type, output.definitionId);
          if (
            input.model !== undefined &&
            output.definitionId !== input.model &&
            modelName !== input.model
          ) continue;

          items.push(
            toSearchItem(output, type, modelName, input.includeProvenance),
          );
        }

        // Sort by startedAt descending (most recent first)
        items.sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        );
        results = input.limit !== undefined
          ? items.slice(0, input.limit)
          : items;
      }

      // One lookup for every workflow the results name, not one per result.
      const workflowIds = new Set<string>();
      for (const item of results) {
        if (item.workflowId !== undefined) workflowIds.add(item.workflowId);
      }
      if (workflowIds.size > 0 && deps.resolveWorkflowNames) {
        const resolveWorkflowNames = deps.resolveWorkflowNames;
        const workflowNames = await observeDiagnosticPhase(
          "workflow_names",
          {},
          (phase) => {
            phase.tally.add("workflow_ids", workflowIds.size);
            return resolveWorkflowNames(workflowIds);
          },
        );
        for (const item of results) {
          if (item.workflowId === undefined) continue;
          const workflowName = workflowNames.get(item.workflowId);
          if (workflowName !== undefined) item.workflowName = workflowName;
        }
      }

      yield {
        kind: "completed",
        data: {
          query: input.query ?? "",
          results,
        },
      };
    })(),
  );
}

/** Whether an output started at or after `since` and before `until`. */
function startedInWindow(
  output: ModelOutputSearchOutput,
  since: Date | undefined,
  until: Date | undefined,
): boolean {
  const startedMs = output.startedAt.getTime();
  return !(since && startedMs < since.getTime()) &&
    !(until && startedMs >= until.getTime());
}

/** The search result for an output. */
function toSearchItem(
  output: ModelOutputSearchOutput,
  type: { normalized: string },
  modelName: string | undefined,
  includeProvenance: boolean | undefined,
): ModelOutputSearchItem {
  const provenance = includeProvenance ? output.provenance : undefined;
  return {
    id: output.id,
    definitionId: output.definitionId,
    modelName,
    type: type.normalized,
    methodName: output.methodName,
    status: output.status,
    startedAt: output.startedAt.toISOString(),
    durationMs: output.durationMs,
    ...(provenance ? { triggeredBy: provenance.triggeredBy } : {}),
    ...(provenance?.workflowId !== undefined
      ? { workflowId: provenance.workflowId }
      : {}),
    ...(provenance?.workflowRunId !== undefined
      ? { workflowRunId: provenance.workflowRunId }
      : {}),
    ...(provenance?.stepName !== undefined
      ? { stepName: provenance.stepName }
      : {}),
  };
}

/**
 * The fewest outputs a newest-first search asks for at once, so that reading
 * through outputs started in the same millisecond, or past records `canRead`
 * refuses, does not take one read at a time.
 */
const MIN_NEWEST_FIRST_BATCH = 16;

/**
 * The most outputs a newest-first search asks for at once. Batches take turns
 * at the shared reads, so this bounds how long a search with a large `limit`
 * can hold up one with a small `limit`.
 */
const MAX_NEWEST_FIRST_BATCH = 1024;

/** A newest-first read, of every output or of a model's definitions. */
interface NewestFirstRead extends Omit<ModelOutputSearchNewestFirst, "next"> {
  next(count: number): Promise<
    Array<{
      output: ModelOutputSearchOutput;
      type: { normalized: string };
      position: number;
      /** The name the output's result carries, when it is already known. */
      modelName?: string;
      /** Which definition's read it came from: breaks ties before `position`. */
      rank?: number;
    }>
  >;
}

/**
 * How a search with a limit opens its newest-first read, or undefined when
 * `deps` cannot read that way.
 */
function newestFirstOpener(
  deps: ModelOutputSearchDeps,
  model: string | undefined,
  window: { since?: Date; until?: Date },
  selectReadable: ModelOutputSearchSelector | undefined,
): (() => Promise<NewestFirstRead>) | undefined {
  if (model === undefined) {
    const findNewestFirst = deps.findOutputsNewestFirst;
    return findNewestFirst &&
      (() => findNewestFirst(window, selectReadable));
  }
  const { resolveModel, findOutputsByDefinitionNewestFirst } = deps;
  if (!resolveModel || !findOutputsByDefinitionNewestFirst) return undefined;
  return async () => {
    const definitions = (await resolveModel(model)).filter((definition) =>
      definition.definitionId === model || definition.name === model
    );
    const reads: ModelOutputSearchNewestFirst[] = [];
    for (const definition of definitions) {
      reads.push(
        await findOutputsByDefinitionNewestFirst(
          definition.type,
          definition.definitionId,
          window,
          deps.canRead && selectUnderName(deps.canRead, definition.name),
        ),
      );
    }
    return mergedRead(definitions, reads);
  };
}

/**
 * Asks `canRead` about keys under `name`, the name their outputs' results
 * carry, so they are judged as those results are.
 */
function selectUnderName(
  canRead: NonNullable<ModelOutputSearchDeps["canRead"]>,
  name: string,
): ModelOutputSearchSelector {
  return (keys) =>
    canRead(keys.map((key) => ({
      definitionId: key.definitionId,
      modelName: name,
      type: key.type.normalized,
      methodName: key.methodName,
    })));
}

/**
 * One read over each of `definitions`' `reads`, which it asks in turn. Each
 * output is named after its definition and ranked by its place in the list, so
 * outputs started in the same millisecond sort as a full scan's do: by
 * definition, then in walk order. Outputs already read are not in start order
 * across reads, so the search stops only once every read is past its results.
 */
function mergedRead(
  definitions: readonly ModelOutputSearchModel[],
  reads: readonly ModelOutputSearchNewestFirst[],
): NewestFirstRead {
  return {
    get unread() {
      return reads.reduce((sum, read) => sum + read.unread, 0);
    },
    unreadStartedBefore: (instant) =>
      reads.every((read) => read.unreadStartedBefore(instant)),
    async next(count) {
      const batch: Awaited<ReturnType<NewestFirstRead["next"]>> = [];
      for (const [rank, read] of reads.entries()) {
        for (const found of await read.next(count)) {
          batch.push({ ...found, modelName: definitions[rank].name, rank });
        }
      }
      return batch;
    },
  };
}

/**
 * The `limit` most recent outputs `canRead` accepts, reading only as far as it
 * takes to be sure of them: until the `limit`-th result started strictly after
 * every output still unread. The comparison is strict so that outputs started
 * in the same millisecond as it are read too, and it looks at that result, not
 * at how many are held, because an output whose name says nothing about its
 * start can be older than outputs not read yet. Results sort as a full scan's
 * do: by start time, then by definition, then in walk order.
 */
async function readNewestFirst(
  open: () => Promise<NewestFirstRead>,
  limit: number,
  window: { since?: Date; until?: Date },
  namer: ReturnType<typeof definitionNamer>,
  canRead: ModelOutputSearchDeps["canRead"],
  includeProvenance: boolean | undefined,
  tally: PhaseTally,
): Promise<ModelOutputSearchItem[]> {
  if (limit === 0) return [];
  const outputs = await open();
  const kept: Array<{
    item: ModelOutputSearchItem;
    startedMs: number;
    rank: number;
    position: number;
  }> = [];
  while (
    kept.length < limit ||
    !outputs.unreadStartedBefore(new Date(kept[limit - 1].startedMs))
  ) {
    const batch = await outputs.next(
      Math.min(
        Math.max(limit - kept.length, MIN_NEWEST_FIRST_BATCH),
        MAX_NEWEST_FIRST_BATCH,
      ),
    );
    if (batch.length === 0) break;
    tally.add("candidates", batch.length);

    const inWindow = batch.filter(({ output }) =>
      startedInWindow(output, window.since, window.until)
    );
    await namer.resolve(
      inWindow
        .filter(({ modelName }) => modelName === undefined)
        .map(({ output, type }) => ({
          type,
          definitionId: output.definitionId,
        })),
    );
    const named = await Promise.all(inWindow.map(async (found) => ({
      ...found,
      modelName: found.modelName ??
        await namer.nameOf(found.type, found.output.definitionId),
    })));
    const readable = canRead && named.length > 0
      ? await canRead(named.map(({ output, type, modelName }) => ({
        definitionId: output.definitionId,
        modelName,
        type: type.normalized,
        methodName: output.methodName,
      })))
      : undefined;

    named.forEach(({ output, type, modelName, rank, position }, i) => {
      if (readable !== undefined && readable[i] !== true) return;
      kept.push({
        item: toSearchItem(output, type, modelName, includeProvenance),
        startedMs: output.startedAt.getTime(),
        rank: rank ?? 0,
        position,
      });
    });
    kept.sort((a, b) =>
      b.startedMs - a.startedMs || a.rank - b.rank || a.position - b.position
    );
    if (kept.length > limit) kept.length = limit;
  }
  tally.add("left_unread", outputs.unread);
  return kept.map(({ item }) => item);
}

/**
 * Names definitions. With {@link ModelOutputSearchDeps.resolveModelNames},
 * `resolve` looks up together the names of the definitions not looked up
 * yet, once each, and `nameOf` answers from what was looked up. Otherwise
 * `resolve` does nothing, and one scan of every definition answers `nameOf`,
 * only once an output needs a name. Either way the first definition per type
 * and id wins, so a primary definition names its outputs over an
 * auto-definition sharing its id.
 */
function definitionNamer(deps: ModelOutputSearchDeps): {
  resolve(
    keys: ReadonlyArray<
      { type: { normalized: string }; definitionId: string }
    >,
  ): Promise<void>;
  nameOf(
    type: { normalized: string },
    definitionId: string,
  ): Promise<string | undefined>;
} {
  const keyOf = (type: { normalized: string }, definitionId: string) =>
    JSON.stringify([type.normalized, definitionId]);

  if (deps.resolveModelNames) {
    const resolveModelNames = deps.resolveModelNames;
    const names = new Map<string, string | undefined>();
    return {
      resolve: async (keys) => {
        const wanted = new Map<
          string,
          { type: { normalized: string }; definitionId: string }
        >();
        for (const { type, definitionId } of keys) {
          const key = keyOf(type, definitionId);
          if (!names.has(key) && !wanted.has(key)) {
            wanted.set(key, { type, definitionId });
          }
        }
        if (wanted.size === 0) return;
        await observeDiagnosticPhase("definition_names", {}, async (phase) => {
          phase.tally.add("definitions", wanted.size);
          const keys = [...wanted.keys()];
          const resolved = await resolveModelNames([...wanted.values()]);
          keys.forEach((key, i) => names.set(key, resolved[i]));
        });
      },
      nameOf: (type, definitionId) =>
        Promise.resolve(names.get(keyOf(type, definitionId))),
    };
  }

  let names: Promise<Map<string, string>> | undefined;
  return {
    resolve: () => Promise.resolve(),
    nameOf: async (type, definitionId) => {
      names ??= observeDiagnosticPhase(
        "definition_names",
        {},
        (phase) =>
          deps.findAllDefinitions().then((all) => {
            phase.tally.add("definitions", all.length);
            const index = new Map<string, string>();
            for (const entry of all) {
              const key = keyOf(entry.type, entry.definition.id);
              if (!index.has(key)) index.set(key, entry.definition.name);
            }
            return index;
          }),
      );
      return (await names).get(keyOf(type, definitionId));
    },
  };
}

/**
 * The outputs worth considering: only the named model's when the
 * repository can look them up by definition (within `since` and `until`
 * when it can skip the rest), otherwise every output (since the `since`
 * cutoff when the repository can skip older ones) that `selectReadable`
 * does not refuse.
 */
async function findCandidates(
  deps: ModelOutputSearchDeps,
  model: string | undefined,
  since: Date | undefined,
  until: Date | undefined,
  selectReadable: ModelOutputSearchSelector | undefined,
): Promise<
  Array<{
    output: ModelOutputSearchOutput;
    type: { normalized: string };
    modelName?: string;
  }>
> {
  if (
    model !== undefined && deps.resolveModel && deps.findOutputsByDefinition
  ) {
    const found: Array<{
      output: ModelOutputSearchOutput;
      type: { normalized: string };
      modelName?: string;
    }> = [];
    for (const definition of await deps.resolveModel(model)) {
      const outputs = await deps.findOutputsByDefinition(
        definition.type,
        definition.definitionId,
        since === undefined && until === undefined
          ? undefined
          : { since, until },
      );
      for (const output of outputs) {
        found.push({
          output,
          type: definition.type,
          modelName: definition.name,
        });
      }
    }
    return found;
  }
  if (since !== undefined && deps.findAllOutputsGlobalSince) {
    return await deps.findAllOutputsGlobalSince(since, selectReadable);
  }
  return await deps.findAllOutputsGlobal(selectReadable);
}
