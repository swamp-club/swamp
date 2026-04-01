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
  dataQuery,
  type DataQueryDeps,
} from "../../libswamp/mod.ts";
import { createDataQueryRenderer } from "../../presentation/renderers/data_query.ts";
import { renderInteractiveQuery } from "../../presentation/renderers/data_query_tui.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataQueryCommand = new Command()
  .name("query")
  .description(
    "Query data artifacts using CEL predicates (interactive TUI when no predicate given)",
  )
  .arguments("[predicate:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--limit <n:number>", "Maximum results", { default: 100 })
  .option(
    "--select <expr:string>",
    "CEL expression to extract fields from matching records (e.g. data.name)",
  )
  .example(
    "Interactive mode",
    "swamp data query",
  )
  .example("Filter by model", "swamp data query 'modelName == \"scanner\"'")
  .example(
    "Filter with size threshold",
    "swamp data query 'size > 1048576'",
  )
  .example(
    "Project a single field",
    "swamp data query 'dataType == \"resource\"' --select data.name",
  )
  .action(async function (options: AnyOptions, predicate?: string) {
    const ctx = createContext(options as GlobalOptions, ["data", "query"]);

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });

    if (!repoContext.catalogStore) {
      throw new UserError(
        "Data query requires a catalog store. Please report this as a bug.",
      );
    }

    const queryService = new DataQueryService(
      repoContext.catalogStore,
      repoContext.unifiedDataRepo,
    );

    const deps: DataQueryDeps = {
      query: (pred, opts) => queryService.query(pred, opts),
    };

    // Interactive TUI when no predicate is given, TTY, and not --json mode
    if (!predicate && Deno.stdout.isTerminal() && ctx.outputMode !== "json") {
      await renderInteractiveQuery({
        queryDeps: deps,
        distinctFn: (col) =>
          repoContext.catalogStore!.distinctValues(
            col as Parameters<
              typeof repoContext.catalogStore.distinctValues
            >[0],
          ),
        tagKeysFn: () => repoContext.catalogStore!.distinctTagKeys(),
        tagValuesFn: (key) => repoContext.catalogStore!.distinctTagValues(key),
      });
      return;
    }

    if (!predicate) {
      throw new UserError(
        "A CEL predicate is required in non-interactive mode.\n" +
          "Usage: swamp data query 'modelName == \"scanner\"'\n" +
          "Run without arguments in a terminal for interactive mode.",
      );
    }

    const libCtx = createLibSwampContext();

    const renderer = createDataQueryRenderer(ctx.outputMode);
    await consumeStream(
      dataQuery(libCtx, deps, {
        predicate,
        select: options.select as string | undefined,
        limit: (options.limit as number) ?? 100,
      }),
      renderer.handlers(),
    );

    ctx.logger.debug("Data query command completed");
  });
