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
 * Dependencies for the model output search generator.
 */
export interface ModelOutputSearchDeps {
  findAllOutputsGlobal(): Promise<
    Array<{
      output: ModelOutputSearchOutput;
      type: { normalized: string };
    }>
  >;
  /**
   * Outputs started at or after `cutoff`, for a `since` filter. Optional:
   * without it the search reads every output and filters.
   */
  findAllOutputsGlobalSince?(cutoff: Date): Promise<
    Array<{
      output: ModelOutputSearchOutput;
      type: { normalized: string };
    }>
  >;
  findDefinitionById(
    type: { normalized: string },
    definitionId: string,
  ): Promise<{ name: string } | null>;
  /**
   * The definitions a `model` filter (a name or an id) names. With
   * {@link findOutputsByDefinition} it reads only those models' outputs
   * instead of every output.
   */
  resolveModel?(idOrName: string): Promise<ModelOutputSearchModel[]>;
  /** The outputs of one definition. */
  findOutputsByDefinition?(
    type: { normalized: string },
    definitionId: string,
  ): Promise<ModelOutputSearchOutput[]>;
  /**
   * The current names of the given workflow ids, looked up together. An id
   * that no longer resolves is absent from the map.
   */
  resolveWorkflowNames?(
    ids: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, string>>;
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

      const candidates = await findCandidates(deps, input.model, since);

      const names = new Map<string, Promise<string | undefined>>();
      const modelNameOf = (
        type: { normalized: string },
        definitionId: string,
      ): Promise<string | undefined> => {
        const key = JSON.stringify([type.normalized, definitionId]);
        let found = names.get(key);
        if (!found) {
          found = deps.findDefinitionById(type, definitionId).then((d) =>
            d?.name
          );
          names.set(key, found);
        }
        return found;
      };

      const items: ModelOutputSearchItem[] = [];
      for (const { output, type, modelName: knownName } of candidates) {
        const startedMs = output.startedAt.getTime();
        if (since && startedMs < since.getTime()) continue;
        if (until && startedMs >= until.getTime()) continue;

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
        const workflowNames = await deps.resolveWorkflowNames(workflowIds);
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
 * The outputs worth considering: only the named model's when the
 * repository can look them up by definition, otherwise every output (since
 * the `since` cutoff when the repository can skip older ones).
 */
async function findCandidates(
  deps: ModelOutputSearchDeps,
  model: string | undefined,
  since: Date | undefined,
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
    return await deps.findAllOutputsGlobalSince(since);
  }
  return await deps.findAllOutputsGlobal();
}
