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
  datastoreClaim,
  type DatastoreClaimData,
} from "../../libswamp/datastores/claim.ts";
import { createDatastoreClaimRenderer } from "../../presentation/renderers/datastore_claim.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { runInCoordinatorRoot } from "../coordinator_root.ts";
import {
  requestNewerServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { DatastoreClaimResponse } from "../../serve/protocol.ts";
import {
  v3ClaimCommitLog,
  v3DatastoreConfigOf,
} from "../../infrastructure/datastore_v3/v3_repo_context.ts";
import { resolverEngine } from "../../domain/datastore/datastore_path_resolver.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Makes swamp serve the owner of a v3 datastore (swamp-club#4063): from then
 * on a checkout that writes the datastore's storage directly is refused,
 * and writes go through serve. Through a running serve (`--server`, or the
 * serve address the environment or .swamp.yaml names) serve writes the
 * claim under its own writer lease; otherwise this command takes the lease
 * itself, so run it in serve's checkout while serve is stopped.
 */
export const datastoreClaimCommand = withRemoteOptions(
  new Command()
    .name("claim")
    .description(
      "Make swamp serve the owner of a v3 datastore: direct writes are refused, and writes go through serve",
    )
    .example(
      "Claim through the running serve",
      "swamp datastore claim --address https://swamp.example.com --server https://swamp.example.com",
    )
    .example(
      "Claim in serve's checkout while serve is stopped",
      "swamp datastore claim --address https://swamp.example.com",
    )
    .option(
      "--address <url:string>",
      "The address clients reach serve at, as they put it in serverAddress",
      { required: true },
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "datastore",
    "claim",
  ]);
  const address = options.address as string;
  const renderer = createDatastoreClaimRenderer(cliCtx.outputMode);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestNewerServerResponse<DatastoreClaimResponse>(
      "swamp datastore claim",
      { server, token },
      { type: "datastore.claim", payload: { address } },
    );
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as DatastoreClaimData,
        };
      })(),
      renderer.handlers(),
    );
    return;
  }

  // Takes the writer lease: a claim commits under its fence.
  const { repoDir, repoContext, datastoreResolver } =
    await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
      v3OwnerCheck: { as: "claimer" },
    });
  const commitLog = resolverEngine(datastoreResolver) === "v3"
    ? v3ClaimCommitLog(
      repoDir,
      await v3DatastoreConfigOf(repoDir, datastoreResolver.config()),
    )
    : undefined;

  await runInCoordinatorRoot(repoContext, async () => {
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    await consumeStream(
      datastoreClaim(ctx, commitLog === undefined ? {} : { commitLog }, {
        address,
      }),
      renderer.handlers(),
    );
  });
});
