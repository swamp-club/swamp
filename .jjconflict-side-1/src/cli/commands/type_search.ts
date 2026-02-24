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

import { Command } from "@cliffy/command";
import {
  renderTypeSearch,
  type TypeSearchData,
  type TypeSearchItem,
} from "../../presentation/output/type_search_output.tsx";
import { renderTypeDescribe } from "../../presentation/output/type_describe_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { z } from "zod";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts a Zod schema to JSON Schema format.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): object {
  return z.toJSONSchema(schema);
}

/**
 * Gets all registered types as TypeSearchItem array.
 */
function getAllTypes(): TypeSearchItem[] {
  return modelRegistry.types().map((t) => ({
    raw: t.raw,
    normalized: t.normalized,
  }));
}

/**
 * Filters types by a query string (case-insensitive match on raw or normalized).
 */
function filterTypes(types: TypeSearchItem[], query: string): TypeSearchItem[] {
  if (!query) {
    return types;
  }
  const lowerQuery = query.toLowerCase();
  return types.filter(
    (t) =>
      t.raw.toLowerCase().includes(lowerQuery) ||
      t.normalized.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Displays the type describe output for a selected type.
 */
function displayTypeDescribe(item: TypeSearchItem, options: AnyOptions): void {
  const ctx = createContext(options as GlobalOptions, ["type", "search"]);
  const modelType = ModelType.create(item.normalized);
  const definition = modelRegistry.get(modelType);

  if (!definition) {
    throw new UserError(`Type not found: ${item.normalized}`);
  }

  const globalArguments = definition.globalArguments
    ? zodToJsonSchema(definition.globalArguments)
    : undefined;

  const methods = Object.entries(definition.methods).map(([name, method]) => ({
    name,
    description: method.description,
    arguments: zodToJsonSchema(method.arguments),
  }));

  renderTypeDescribe(
    {
      type: {
        raw: modelType.raw,
        normalized: modelType.normalized,
      },
      version: definition.version,
      globalArguments,
      methods,
    },
    ctx.outputMode,
  );
}

export const typeSearchCommand = new Command()
  .name("search")
  .description("Search for model types")
  .arguments("[query:string]")
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, ["type", "search"]);
    ctx.logger.debug`Searching types with query: ${query ?? "(none)"}`;

    const allTypes = getAllTypes();

    if (ctx.outputMode === "json") {
      // Non-interactive: filter and output JSON
      const filteredTypes = filterTypes(allTypes, query ?? "");
      const data: TypeSearchData = {
        query: query ?? "",
        results: filteredTypes,
      };
      await renderTypeSearch(data, ctx.outputMode);
    } else {
      // Interactive: show fuzzy search UI
      const data: TypeSearchData = {
        query: query ?? "",
        results: allTypes,
      };

      const selected = await renderTypeSearch(data, ctx.outputMode);

      if (selected) {
        ctx.logger.debug`Selected type: ${selected.normalized}`;
        // Display the type description
        displayTypeDescribe(selected, options);
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Type search command completed");
  });
