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

import { Command } from "@cliffy/command";
import {
  consumeStream,
  createLibSwampContext,
  dataQuery,
  type DataQueryData,
  type DataQueryDeps,
  requireSingleResult,
  userErrorFromSwampError,
} from "../../libswamp/mod.ts";
import { createDataQueryRenderer } from "../../presentation/renderers/data_query.ts";
import { renderInteractiveQuery } from "../../presentation/renderers/data_query_tui.tsx";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { createLatestRunResolver } from "../../domain/workflows/workflow_lookup.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type {
  DataQueryPayload,
  DataQueryResponse,
} from "../../serve/protocol.ts";
import type { OutputMode } from "../../presentation/output/output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Builds the `data.query` request sent with `--server`. A single-result query
 * asks for two matches, enough to tell one from several. That limit is safe
 * remotely because the server filters every query by read access, and the
 * query service fills a filtered limit from records that survive its stale-row
 * check. The check itself runs on the client (renderRemoteQueryResponse) so
 * older servers need no protocol change.
 */
export function remoteQueryPayload(
  predicate: string,
  options: { limit?: number; select?: string; single: boolean },
): DataQueryPayload {
  return {
    predicate,
    limit: options.single ? 2 : options.limit,
    select: options.select,
  };
}

/**
 * Applies `--single` to a `--server` query response, then renders it. The
 * match count comes from the records the response carries rather than its
 * `total`, so a malformed response fails as a clear error instead of crashing
 * the renderer.
 */
export function renderRemoteQueryResponse(
  predicate: string,
  data: DataQueryData,
  outputMode: OutputMode,
  single: boolean,
): void {
  if (single) {
    const matches = data.projected
      ? data.projected.shape === "scalar"
        ? data.projected.values
        : data.projected.rows
      : data.results;
    const error = requireSingleResult({
      predicate,
      total: matches?.length ?? 0,
    });
    if (error) throw userErrorFromSwampError(error);
  }
  createDataQueryRenderer(outputMode, false, { single }).handlers().completed({
    kind: "completed",
    data,
  });
}

export const dataQueryCommand = withRemoteOptions(
  new Command()
    .name("query")
    .description(
      "Query data artifacts using CEL predicates (interactive TUI when no predicate given)",
    )
    .arguments("[predicate:string]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--limit <n:number>",
      "Maximum results (unlimited when omitted)",
    )
    .option(
      "--select <expr:string>",
      "CEL expression to extract fields from matching records (e.g. data.name)",
    )
    .option(
      "--single",
      "Require exactly one match; with --json, print the match (or its --select value) on its own instead of a results list",
      { conflicts: ["limit"] },
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
    .example(
      "Get exactly one record as an object",
      'swamp data query \'modelName == "scanner" && name == "state"\' --single --json',
    )
    .example(
      "Read from a workflow's latest run",
      "swamp data query 'workflowRunId == latestRun(\"deploy\") && version >= 0'",
    ),
).action(async function (options: AnyOptions, predicate?: string) {
  const ctx = createContext(options as GlobalOptions, ["data", "query"]);
  const single = options.single === true;

  if (single && !predicate) {
    throw new UserError(
      "A CEL predicate is required with --single.\n" +
        'Usage: swamp data query \'modelName == "scanner" && name == "state"\' --single',
    );
  }

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    if (!predicate) {
      throw new UserError(
        "A CEL predicate is required when using --server.\n" +
          "Interactive TUI mode is not available for remote queries.\n" +
          "Usage: swamp data query 'modelName == \"scanner\"' --server <url>",
      );
    }
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<DataQueryResponse>(
      { server, token },
      {
        type: "data.query",
        payload: remoteQueryPayload(predicate, {
          limit: options.limit as number | undefined,
          select: options.select as string | undefined,
          single,
        }),
      },
    );
    renderRemoteQueryResponse(
      predicate,
      response.data as unknown as DataQueryData,
      ctx.outputMode,
      single,
    );
    return;
  }

  const { repoContext, datastoreResolver } =
    await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });
  const showNamespace = !!datastoreResolver.config().namespace;

  if (!repoContext.catalogStore) {
    throw new UserError(
      "Data query requires a catalog store. Please report this as a bug.",
    );
  }

  const queryService = repoContext.dataQueryService;
  const latestRunResolver = createLatestRunResolver(
    repoContext.workflowRepo,
    repoContext.workflowRunRepo,
  );

  const deps: DataQueryDeps = {
    query: (pred, opts) =>
      queryService.query(pred, { ...opts, latestRunResolver }),
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

  const renderer = createDataQueryRenderer(ctx.outputMode, showNamespace, {
    single,
  });
  await consumeStream(
    dataQuery(libCtx, deps, {
      predicate,
      select: options.select as string | undefined,
      limit: options.limit as number | undefined,
      single,
    }),
    renderer.handlers(),
  );

  ctx.logger.debug("Data query command completed");
});
