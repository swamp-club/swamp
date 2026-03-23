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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

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

/**
 * Dependencies for the model output search generator.
 */
export interface ModelOutputSearchDeps {
  findAllOutputsGlobal(): Promise<
    Array<{
      output: {
        id: string;
        definitionId: string;
        methodName: string;
        status: string;
        startedAt: Date;
        durationMs?: number;
      };
      type: { normalized: string };
    }>
  >;
  findDefinitionById(
    type: { normalized: string },
    definitionId: string,
  ): Promise<{ name: string } | null>;
}

/**
 * Input for the model output search generator.
 */
export interface ModelOutputSearchInput {
  query?: string;
}

/**
 * Searches model outputs across all types.
 *
 * Resolves model names from definition IDs, sorts by startedAt descending.
 * Filtering for JSON mode is handled by the renderer.
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

      const allResults = await deps.findAllOutputsGlobal();
      const items: ModelOutputSearchItem[] = [];

      for (const { output, type } of allResults) {
        let modelName: string | undefined;
        const definition = await deps.findDefinitionById(
          type,
          output.definitionId,
        );
        if (definition) {
          modelName = definition.name;
        }

        items.push({
          id: output.id,
          definitionId: output.definitionId,
          modelName,
          type: type.normalized,
          methodName: output.methodName,
          status: output.status,
          startedAt: output.startedAt.toISOString(),
          durationMs: output.durationMs,
        });
      }

      // Sort by startedAt descending (most recent first)
      items.sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );

      yield {
        kind: "completed",
        data: {
          query: input.query ?? "",
          results: items,
        },
      };
    })(),
  );
}
