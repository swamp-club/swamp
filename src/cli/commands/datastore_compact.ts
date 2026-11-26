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
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  datastoreCompact,
  type DatastoreCompactDeps,
} from "../../libswamp/datastores/compact.ts";
import { createDatastoreCompactRenderer } from "../../presentation/renderers/datastore_compact.ts";
import {
  type CommandContext,
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { runInCoordinatorRoot } from "../coordinator_root.ts";
import { catalogDbPath } from "../../infrastructure/persistence/repository_factory.ts";
import {
  datastoreCompactHistory,
  type DatastoreCompactHistoryData,
} from "../../libswamp/datastores/compact_history.ts";
import { createDatastoreCompactHistoryRenderer } from "../../presentation/renderers/datastore_compact_history.ts";
import {
  requestNewerServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { DatastoreHistoryCompactResponse } from "../../serve/protocol.ts";
import {
  compactV3HistoryNow,
  HISTORY_COMPACT_BUDGET_MS,
  SERVE_HISTORY_COMPACT_WAIT_MS,
  v3DatastoreConfigOf,
} from "../../infrastructure/datastore_v3/v3_repo_context.ts";
import { resolverEngine } from "../../domain/datastore/datastore_path_resolver.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

// serve may wait out a maintenance run before its own budget starts
const HISTORY_COMPACT_REQUEST_TIMEOUT_MS = HISTORY_COMPACT_BUDGET_MS +
  SERVE_HISTORY_COMPACT_WAIT_MS + 30_000;

export const datastoreCompactCommand = withRemoteOptions(
  new Command()
    .name("compact")
    .description(
      "Checkpoint the WAL and vacuum the catalog database to reclaim disk space; with --history, fold a v3 datastore's old commits into its compacted base",
    )
    .example(
      "Compact the catalog database",
      "swamp datastore compact",
    )
    .example(
      "Compact and output stats as JSON",
      "swamp datastore compact --json",
    )
    .example(
      "Fold the v3 commit history now, through the running serve",
      "swamp datastore compact --history --server https://swamp.example.com",
    )
    .option(
      "--history",
      "Fold the v3 commit history the compaction policy allows now, instead of at the next hourly or closing compaction (at least 500 commits; the newest 2,500 are kept). Members then load the newer base, as after an hourly compaction. --server and --token apply only with it",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "datastore",
    "compact",
  ]);
  if (options.history === true) {
    await compactHistory(options, cliCtx);
    return;
  }
  if (
    options.server !== undefined || options.token !== undefined ||
    options.tokenFile !== undefined || options.caCert !== undefined
  ) {
    throw new UserError(
      "--server, --token, --token-file and --ca-cert apply only with " +
        "--history: the catalog database compacted without it is this " +
        "checkout's own.",
    );
  }

  const { repoDir, repoContext, datastoreResolver } =
    await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

  await runInCoordinatorRoot(repoContext, async () => {
    // Use the centralized catalog-path helper — the catalog is repo-local and
    // its location must match createCatalogStore exactly, never be recomputed.
    const dbPath = catalogDbPath(repoDir, datastoreResolver);

    // compact through the repo context's own store: vacuum renames the
    // catalog into place, which Windows refuses while a second connection in
    // this process holds it open.
    const deps: DatastoreCompactDeps = {
      checkpoint: () => repoContext.catalogStore.checkpoint(),
      vacuum: () => repoContext.catalogStore.vacuum(),
      catalogDbSize: async () => {
        try {
          const stat = await Deno.stat(dbPath);
          return stat.size;
        } catch {
          return 0;
        }
      },
    };

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const renderer = createDatastoreCompactRenderer(cliCtx.outputMode);
    await consumeStream(datastoreCompact(ctx, deps), renderer.handlers());
  });
});

async function compactHistory(
  options: AnyOptions,
  cliCtx: CommandContext,
): Promise<void> {
  const renderer = createDatastoreCompactHistoryRenderer(cliCtx.outputMode);
  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestNewerServerResponse<
      DatastoreHistoryCompactResponse
    >(
      "swamp datastore compact --history",
      { server, token, timeoutMs: HISTORY_COMPACT_REQUEST_TIMEOUT_MS },
      { type: "datastore.history.compact", payload: {} },
    );
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as DatastoreCompactHistoryData,
        };
      })(),
      renderer.handlers(),
    );
    return;
  }

  // a writing command: the compaction runs under its writer lease and fence
  const { repoDir, repoContext, datastoreResolver } =
    await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });
  const config = resolverEngine(datastoreResolver) === "v3"
    ? await v3DatastoreConfigOf(repoDir, datastoreResolver.config())
    : undefined;

  await runInCoordinatorRoot(repoContext, async () => {
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    await consumeStream(
      datastoreCompactHistory(
        ctx,
        config === undefined ? {} : {
          compactHistory: (signal) =>
            compactV3HistoryNow(
              repoDir,
              config,
              HISTORY_COMPACT_BUDGET_MS,
              signal,
            ),
        },
      ),
      renderer.handlers(),
    );
  });
}
