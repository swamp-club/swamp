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

import { observeDiagnosticPhase } from "../../domain/diagnostics/diagnostic_phase.ts";
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
   * The current names of the given workflow ids, looked up together. An id
   * that no longer resolves is absent from the map.
   */
  resolveWorkflowNames?(
    ids: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, string>>;
  /**
   * Which of `candidates` the caller may read, one answer per candidate, in
   * order. With it, a search without `model` leaves out unread the outputs
   * it refuses (swamp-club#4142). Outputs whose location says nothing about
   * them are still read, so the results still need authorizing.
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

      const inWindow = candidates.filter(({ output }) => {
        const startedMs = output.startedAt.getTime();
        return !(since && startedMs < since.getTime()) &&
          !(until && startedMs >= until.getTime());
      });
      await namer.resolve(
        inWindow
          .filter(({ modelName }) => modelName === undefined)
          .map(({ output, type }) => ({
            type,
            definitionId: output.definitionId,
          })),
      );
      const modelNameOf = namer.nameOf;

      const items: ModelOutputSearchItem[] = [];
      for (const { output, type, modelName: knownName } of inWindow) {
        const modelName = knownName ??
          await modelNameOf(type, output.definitionId);
        if (
          input.model !== undefined &&
          output.definitionId !== input.model &&
          modelName !== input.model
        ) continue;

        const provenance = input.includeProvenance
          ? output.provenance
          : undefined;
        items.push({
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
        });
      }

      // Sort by startedAt descending (most recent first)
      items.sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );
      const results = input.limit !== undefined
        ? items.slice(0, input.limit)
        : items;

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
