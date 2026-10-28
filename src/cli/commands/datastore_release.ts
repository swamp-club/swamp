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
  datastoreRelease,
  type DatastoreReleaseData,
} from "../../libswamp/datastores/release.ts";
import { createDatastoreReleaseRenderer } from "../../presentation/renderers/datastore_release.ts";
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
import type { DatastoreReleaseResponse } from "../../serve/protocol.ts";
import {
  v3ClaimCommitLog,
  v3DatastoreConfigOf,
} from "../../infrastructure/datastore_v3/v3_repo_context.ts";
import { resolverEngine } from "../../domain/datastore/datastore_path_resolver.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Removes the claim `swamp datastore claim` made (swamp-club#4063), so
 * checkouts write the v3 datastore's storage directly again. Through a
 * running serve, serve removes it; otherwise this command takes the writer
 * lease itself, which also releases the claim of an owner serve that is
 * gone for good.
 */
export const datastoreReleaseCommand = withRemoteOptions(
  new Command()
    .name("release")
    .description(
      "Remove swamp serve's claim on a v3 datastore, so checkouts write it directly again",
    )
    .example(
      "Release through the running serve",
      "swamp datastore release --server https://swamp.example.com",
    )
    .example(
      "Release in serve's checkout while serve is stopped",
      "swamp datastore release",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "datastore",
    "release",
  ]);
  const renderer = createDatastoreReleaseRenderer(cliCtx.outputMode);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestNewerServerResponse<
      DatastoreReleaseResponse
    >(
      "swamp datastore release",
      { server, token },
      { type: "datastore.release", payload: {} },
    );
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as DatastoreReleaseData,
        };
      })(),
      renderer.handlers(),
    );
    return;
  }

  // Takes the writer lease: a release commits under its fence.
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
      datastoreRelease(ctx, commitLog === undefined ? {} : { commitLog }),
      renderer.handlers(),
    );
  });
});
