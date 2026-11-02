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
import {
  sortInTimeSlices,
  TimeSlice,
} from "../../infrastructure/persistence/scan_permits.ts";
export interface ModelOutputSearchItem {
  id: string;
  definitionId: string;
  modelName?: string;
  type: string;
  methodName: string;
  status: string;
  startedAt: string;
  durationMs?: number;
  triggeredBy?: TriggerType;
  workflowId?: string;
  workflowName?: string;
  workflowRunId?: string;
  stepName?: string;
}

export interface ModelOutputSearchData {
  query: string;
  results: ModelOutputSearchItem[];
}

export type ModelOutputSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelOutputSearchData }
  | { kind: "error"; error: SwampError };

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

export interface ModelOutputSearchModel {
  definitionId: string;
  name: string;
  type: { normalized: string };
}

export interface ModelOutputSearchKey {
  type: { normalized: string };
  definitionId: string;
  methodName: string;
}

export type ModelOutputSearchSelector = (
  keys: readonly ModelOutputSearchKey[],
) => Promise<readonly boolean[]>;

export interface ModelOutputSearchCandidate {
  definitionId: string;
  modelName?: string;
  type: string;
  methodName: string;
}

export interface ModelOutputSearchNewestFirst {
  next(count: number): Promise<
    Array<{
      output: ModelOutputSearchOutput;
      type: { normalized: string };
      position: number;
    }>
  >;
  unreadStartedBefore(instant: Date): boolean;
  readonly unread: number;
}

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
   * outputs started at or after cutoff for a since filter, leaving out what
   * selectReadable refuses; optional, without it the search reads every output
   * and filters
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
   * outputs started in window, read as asked for, newest first, leaving out what
   * selectReadable refuses. With it, a limit search with no model stops reading
   * once it holds its results. Optional: without it the search reads every output
   */
  findOutputsNewestFirst?(
    window: { since?: Date; until?: Date },
    selectReadable?: ModelOutputSearchSelector,
  ): Promise<ModelOutputSearchNewestFirst>;
  /**
   * every definition with its type, primary before auto-definitions; read at
   * most once per search so many deleted definitions cost one scan, not one per
   * id. Not read when resolveModelNames is given
   */
  findAllDefinitions(): Promise<
    Array<{
      definition: { id: string; name: string };
      type: { normalized: string };
    }>
  >;
  /**
   * names of the given definitions looked up together, in order asked: the
   * first of that type and id, primary before auto-definitions; undefined when
   * none resolves; replaces findAllDefinitions
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
   * outputs of one definition in window, read as asked for, newest first, minus
   * what selectReadable refuses; with resolveModel, a limited search for a
   * model stops reading once it has its results
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
   * which candidates the caller may read, in order; a search without model or
   * reading newest first skips refused outputs unread; outputs whose location
   * says nothing are still read and need authorizing
   */
  canRead?(
    candidates: readonly ModelOutputSearchCandidate[],
  ): Promise<readonly boolean[]>;
}

export interface ModelOutputSearchInput {
  query?: string;
  /** Opt in to provenance for output search; legacy history keeps its shape. */
  includeProvenance?: boolean;
  model?: string;
  since?: string;
  /**
   * Only outputs started before this ISO 8601 instant or duration ago
   * (exclusive), as run search and the run summary read `until`.
   */
  until?: string;
  limit?: number;
}

export function parseInstant(
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
 * with limit and a newest-first dep, or for a model, returns the same results
 * reading only as far as they need
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

      // names are looked up once each, shared by the scan's choice of files and
      // by the results
      const namer = definitionNamer(deps);

      const canRead = deps.canRead;
      const selectReadable = readableSelector(namer, canRead);

      // exported as the output_search diagnostic area's phases when the caller
      // runs this in it; silent otherwise
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

        const items: Array<{ item: ModelOutputSearchItem; startedMs: number }> =
          [];
        const slice = new TimeSlice();
        for (const { output, type, modelName: knownName } of inWindow) {
          if (slice.over) await slice.next();
          const modelName = knownName ??
            await namer.nameOf(type, output.definitionId);
          if (
            input.model !== undefined &&
            output.definitionId !== input.model &&
            modelName !== input.model
          ) continue;

          items.push({
            item: toSearchItem(
              output,
              type,
              modelName,
              input.includeProvenance,
            ),
            startedMs: output.startedAt.getTime(),
          });
        }

        const sorted = (await sortInTimeSlices(
          items,
          (a, b) => b.startedMs - a.startedMs,
        )).map(({ item }) => item);
        results = input.limit !== undefined
          ? sorted.slice(0, input.limit)
          : sorted;
      }

      await nameWorkflows(deps, results);

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

export async function nameWorkflows(
  deps: Pick<ModelOutputSearchDeps, "resolveWorkflowNames">,
  items: readonly Pick<ModelOutputSearchItem, "workflowId" | "workflowName">[],
): Promise<void> {
  const workflowIds = new Set<string>();
  for (const item of items) {
    if (item.workflowId !== undefined) workflowIds.add(item.workflowId);
  }
  if (workflowIds.size === 0 || !deps.resolveWorkflowNames) return;
  const resolveWorkflowNames = deps.resolveWorkflowNames;
  const workflowNames = await observeDiagnosticPhase(
    "workflow_names",
    {},
    (phase) => {
      phase.tally.add("workflow_ids", workflowIds.size);
      return resolveWorkflowNames(workflowIds);
    },
  );
  for (const item of items) {
    if (item.workflowId === undefined) continue;
    const workflowName = workflowNames.get(item.workflowId);
    if (workflowName !== undefined) item.workflowName = workflowName;
  }
}

/**
 * each key is asked about with the name its outputs' results would carry, so it
 * is judged as their results are
 */
export function readableSelector(
  namer: ReturnType<typeof definitionNamer>,
  canRead: ModelOutputSearchDeps["canRead"],
): ModelOutputSearchSelector | undefined {
  return canRead &&
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
}

export function startedInWindow(
  output: ModelOutputSearchOutput,
  since: Date | undefined,
  until: Date | undefined,
): boolean {
  const startedMs = output.startedAt.getTime();
  return !(since && startedMs < since.getTime()) &&
    !(until && startedMs >= until.getTime());
}

export function toSearchItem(
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

interface NewestFirstRead extends Omit<ModelOutputSearchNewestFirst, "next"> {
  next(count: number): Promise<
    Array<{
      output: ModelOutputSearchOutput;
      type: { normalized: string };
      position: number;
      modelName?: string;
      rank?: number;
    }>
  >;
}

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
 * outputs are ranked by definition then walk order, as a full scan sorts them;
 * reads are not in start order across each other, so the search stops only once
 * every read is past its results
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
 * stop once the limit-th result started strictly after every unread output;
 * strict so same-millisecond outputs are read too, and judged by that result
 * not the count held, since a name says nothing about start time
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
 * the first definition per type and id wins, so a primary definition names its
 * outputs over an auto-definition sharing its id; with resolveModelNames names
 * are looked up together, else one scan answers
 */
export function definitionNamer(
  deps: Pick<ModelOutputSearchDeps, "findAllDefinitions" | "resolveModelNames">,
): {
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
        const slice = new TimeSlice();
        for (const { type, definitionId } of keys) {
          if (slice.over) await slice.next();
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
 * only the named model's outputs when the repository can look them up by
 * definition, otherwise every output that selectReadable does not refuse;
 * since/until let it skip the rest when it can
 */
export async function findCandidates(
  deps: Pick<
    ModelOutputSearchDeps,
    | "findAllOutputsGlobal"
    | "findAllOutputsGlobalSince"
    | "resolveModel"
    | "findOutputsByDefinition"
  >,
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
