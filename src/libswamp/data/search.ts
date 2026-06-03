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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import { UserError } from "../../domain/errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * A single data search result item.
 */
export interface DataSearchItem {
  id: string;
  name: string;
  version: number;
  contentType: string;
  type: string;
  lifetime: string;
  ownerType: string;
  ownerRef: string;
  modelId: string;
  modelName: string;
  modelType: string;
  streaming: boolean;
  size: number;
  createdAt: string;
  tags: Record<string, string>;
  workflowTag?: string;
  jobTag?: string;
  stepTag?: string;
}

/**
 * Data payload for the completed event.
 */
export interface DataSearchData {
  query: string;
  filters: Record<string, string>;
  results: DataSearchItem[];
  total: number;
  limited: boolean;
}

export type DataSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: DataSearchData }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies for the data search generator.
 */
export interface DataSearchDeps {
  findAllGlobal(): Promise<
    Array<{
      data: {
        id: string;
        name: string;
        version: number;
        contentType: string;
        type: string;
        lifetime: string;
        ownerDefinition: { ownerType: string; ownerRef: string };
        streaming: boolean;
        size?: number;
        createdAt: Date;
        tags: Record<string, string>;
      };
      modelType: { normalized: string };
      modelId: string;
    }>
  >;
  findDefinitionById(
    type: { normalized: string },
    defId: string,
  ): Promise<{ name: string } | null>;
  findDefinitionByIdOrName(
    idOrName: string,
  ): Promise<{ definition: { name: string } } | null>;
}

/**
 * Input for the data search generator.
 */
export interface DataSearchInput {
  query?: string;
  type?: string;
  lifetime?: string;
  ownerType?: string;
  workflow?: string;
  model?: string;
  contentType?: string;
  since?: string;
  output?: string;
  run?: string;
  streaming?: boolean;
  tags?: Record<string, string>;
  limit?: number;
}

/**
 * Parses a duration string (e.g., "1h", "1d", "7d", "1w", "1mo") to
 * milliseconds. Reused by workflow run search.
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(mo|y|h|m|d|w)$/);
  if (!match) {
    throw new UserError(
      `Invalid duration format: "${duration}". Expected format like 1h, 1d, 7d, 1w, 1mo`,
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "mo":
      return value * 30 * 24 * 60 * 60 * 1000;
    case "y":
      return value * 365 * 24 * 60 * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "m":
      return value * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "w":
      return value * 7 * 24 * 60 * 60 * 1000;
    default:
      throw new UserError(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Parses an array of "KEY=VALUE" strings into a Record<string, string>.
 * Reused by workflow run search.
 */
export function parseTags(raw: string[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const entry of raw) {
    const eqIdx = entry.indexOf("=");
    if (eqIdx < 1) {
      throw new UserError(
        `Invalid tag format: "${entry}". Expected KEY=VALUE`,
      );
    }
    tags[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
  }
  return tags;
}

/**
 * Filters data search items. All filters combine with AND logic.
 */
function filterData(
  items: DataSearchItem[],
  input: DataSearchInput,
): DataSearchItem[] {
  let result = items;

  if (input.type) result = result.filter((i) => i.type === input.type);
  if (input.lifetime) {
    result = result.filter((i) => i.lifetime === input.lifetime);
  }
  if (input.ownerType) {
    result = result.filter((i) => i.ownerType === input.ownerType);
  }
  if (input.workflow) {
    result = result.filter((i) => i.workflowTag === input.workflow);
  }
  if (input.model) {
    result = result.filter((i) => i.modelName === input.model);
  }
  if (input.contentType) {
    result = result.filter((i) => i.contentType === input.contentType);
  }
  if (input.streaming) result = result.filter((i) => i.streaming);
  if (input.since) {
    const cutoff = Date.now() - parseDuration(input.since);
    result = result.filter(
      (i) => new Date(i.createdAt).getTime() >= cutoff,
    );
  }
  if (input.output) {
    const outputId = input.output;
    result = result.filter(
      (i) => i.ownerRef.split(":").includes(outputId) || i.id === outputId,
    );
  }
  if (input.run) {
    const runId = input.run;
    result = result.filter((i) => i.ownerRef.split(":").includes(runId));
  }
  if (input.tags) {
    const tagEntries = Object.entries(input.tags);
    result = result.filter((i) =>
      tagEntries.every(([k, v]) => i.tags[k] === v)
    );
  }
  if (input.query) {
    const q = input.query.toLowerCase();
    result = result.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.type.toLowerCase().includes(q) ||
        i.modelName.toLowerCase().includes(q) ||
        i.ownerRef.toLowerCase().includes(q),
    );
  }

  return result;
}

/**
 * Builds active filters record for output metadata.
 */
function buildFilters(input: DataSearchInput): Record<string, string> {
  const filters: Record<string, string> = {};
  if (input.type) filters.type = input.type;
  if (input.lifetime) filters.lifetime = input.lifetime;
  if (input.ownerType) filters.ownerType = input.ownerType;
  if (input.workflow) filters.workflow = input.workflow;
  if (input.model) filters.model = input.model;
  if (input.contentType) filters.contentType = input.contentType;
  if (input.since) filters.since = input.since;
  if (input.output) filters.output = input.output;
  if (input.run) filters.run = input.run;
  if (input.streaming) filters.streaming = "true";
  if (input.tags) {
    for (const [k, v] of Object.entries(input.tags)) {
      filters[`tag:${k}`] = v;
    }
  }
  return filters;
}

/**
 * Searches data artifacts across all models with rich filtering.
 */
export async function* dataSearch(
  _ctx: LibSwampContext,
  deps: DataSearchDeps,
  input: DataSearchInput,
): AsyncGenerator<DataSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.data.search",
    { "search.query": input.query ?? "" },
    (async function* () {
      yield { kind: "resolving" };

      // Validate model if provided
      if (input.model) {
        const modelResult = await deps.findDefinitionByIdOrName(input.model);
        if (!modelResult) {
          yield {
            kind: "error",
            error: validationFailed(`Model not found: ${input.model}`),
          };
          return;
        }
      }

      // Fetch and convert all data
      const allResults = await deps.findAllGlobal();
      const items: DataSearchItem[] = [];

      for (const { data, modelType, modelId } of allResults) {
        let modelName = modelId;
        const definition = await deps.findDefinitionById(modelType, modelId);
        if (definition) {
          modelName = definition.name;
        }

        items.push({
          id: data.id,
          name: data.name,
          version: data.version,
          contentType: data.contentType,
          type: data.type,
          lifetime: data.lifetime,
          ownerType: data.ownerDefinition.ownerType,
          ownerRef: data.ownerDefinition.ownerRef,
          modelId,
          modelName,
          modelType: modelType.normalized,
          streaming: data.streaming,
          size: data.size ?? 0,
          createdAt: data.createdAt.toISOString(),
          tags: data.tags,
          workflowTag: data.tags.workflow,
          jobTag: data.tags.job,
          stepTag: data.tags.step,
        });
      }

      // Apply filters
      const filtered = filterData(items, input);

      // Sort by createdAt descending
      filtered.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      // Apply limit
      const limit = input.limit ?? 50;
      const total = filtered.length;
      const limited = total > limit;
      const results = filtered.slice(0, limit);

      yield {
        kind: "completed",
        data: {
          query: input.query ?? "",
          filters: buildFilters(input),
          results,
          total,
          limited,
        },
      };
    })(),
  );
}
