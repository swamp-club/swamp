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
  consumeStream,
  createLibSwampContext,
  createTypeDescribeDeps,
  typeDescribe,
  type TypeDescribeData,
  typeSearch,
  type TypeSearchDeps,
  type TypeSearchItem,
} from "../../libswamp/mod.ts";
import { createTypeSearchRenderer } from "../../presentation/renderers/type_search.tsx";
import { createTypeDescribeRenderer } from "../../presentation/renderers/type_describe.ts";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
} from "../context.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { modelRegistry } from "../../domain/models/model.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Creates a fetchPreview closure that fetches full type detail data.
 * This bridges the presentation layer to the libswamp typeDescribe application
 * service.
 */
function createTypeFetchPreview(): (
  item: TypeSearchItem,
) => Promise<TypeDescribeData> {
  const libCtx = createLibSwampContext();
  const describeDeps = createTypeDescribeDeps();

  return async (item: TypeSearchItem): Promise<TypeDescribeData> => {
    let result: TypeDescribeData | undefined;
    await consumeStream(
      typeDescribe(libCtx, describeDeps, ModelType.create(item.normalized)),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data;
        },
        error: () => {},
      },
    );
    if (!result) {
      throw new Error(`Type not found: ${item.normalized}`);
    }
    return result;
  };
}

export const typeSearchCommand = new Command()
  .name("search")
  .description("Search for model types")
  .example("Browse all types", "swamp type search")
  .example("Search by keyword", "swamp type search aws")
  // `--repo-dir` is accepted for agentic-flow consistency with other
  // commands; type search reads only the global extension catalog and
  // does not require an initialized repo.
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR; not required for type search)",
  )
  .arguments("[query:string]")
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, ["type", "search"]);
    const effectiveMode = interactiveOutputMode(ctx);
    const libCtx = createLibSwampContext();
    ctx.logger.debug`Searching types with query: ${query ?? "(none)"}`;

    await modelRegistry.ensureLoaded();
    const deps: TypeSearchDeps = {
      getRegisteredTypes: () => modelRegistry.types(),
    };

    const fetchPreview = effectiveMode === "log"
      ? createTypeFetchPreview()
      : undefined;

    const renderer = createTypeSearchRenderer(effectiveMode, fetchPreview);
    await consumeStream(
      typeSearch(libCtx, deps, { query }),
      renderer.handlers(),
    );

    const selected = renderer.selectedItem();
    if (selected) {
      ctx.logger.debug`Selected type: ${selected.normalized}`;
      // In JSON mode, still display the full type describe output after auto-select
      if (effectiveMode === "json") {
        const describeRenderer = createTypeDescribeRenderer(effectiveMode);
        const describeDeps = createTypeDescribeDeps();
        await consumeStream(
          typeDescribe(
            libCtx,
            describeDeps,
            ModelType.create(selected.normalized),
          ),
          describeRenderer.handlers(),
        );
      }
      // In interactive mode, the scrollback from the picker already contains
      // the type detail, so no additional typeDescribe call is needed.
    } else {
      ctx.logger.debug`Search cancelled`;
    }

    ctx.logger.debug("Type search command completed");
  });
