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
import {
  createDatastoreStatusDeps,
  datastoreStatus,
  type DatastoreStatusData,
  outboxEntryStatusesOf,
} from "../../libswamp/datastores/status.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { createDatastoreStatusRenderer } from "../../presentation/renderers/datastore_status.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requireInitializedRepoReadOnly,
  resolveDatastoreForRepo,
  v3LocationOf,
} from "../repo_context.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  ServerResponseError,
  withRemoteOptions,
} from "../remote_run.ts";
import type { DatastoreStatusResponse } from "../../serve/protocol.ts";
import { resolverEngine } from "../../domain/datastore/datastore_path_resolver.ts";
import { v3DatastoreFor } from "../../infrastructure/datastore_v3/v3_repo_context.ts";
import { readExplicitLeases } from "../../infrastructure/datastore_v3/explicit_model_leases.ts";
import type { DatastoreServeSection } from "../../libswamp/datastores/status.ts";

/** How long a serve-mode checkout waits for serve's own section. */
const SERVE_SECTION_TIMEOUT_MS = 5_000;

/**
 * Serve's section of a serve-mode checkout's status (swamp-club#4195): its
 * explicit leases and quarantine, which only an admin may read. Serve not
 * answering, or refusing the caller, leaves the section out with the
 * reason; the checkout's own status is never failed by it.
 */
async function serveSectionOf(
  serverUrl: string,
  options: AnyOptions,
): Promise<DatastoreServeSection> {
  try {
    const token = await resolveServerTokenFromOptions(serverUrl, options);
    const response = await requestServerResponse<DatastoreStatusResponse>(
      { server: serverUrl, token, timeoutMs: SERVE_SECTION_TIMEOUT_MS },
      { type: "datastore.status", payload: {} },
    );
    const data = response.data as unknown as DatastoreStatusData;
    return {
      kind: "shown",
      explicitLeases: data.explicitLeases ?? [],
      ...(data.quarantine !== undefined ? { quarantine: data.quarantine } : {}),
      ...(data.quarantineTruncated === true
        ? { quarantineTruncated: true }
        : {}),
    };
  } catch (error) {
    if (error instanceof ServerResponseError && error.code === "unauthorized") {
      return { kind: "absent", reason: "needs admin on serve" };
    }
    if (error instanceof ServerResponseError) {
      return { kind: "absent", reason: `serve refused (${error.code})` };
    }
    return { kind: "absent", reason: "serve is unreachable" };
  }
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Shows current datastore configuration and health.
 */
export const datastoreStatusCommand = withRemoteOptions(
  new Command()
    .description("Show datastore configuration and health")
    .example("Show datastore health", "swamp datastore status")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "datastore",
    "status",
  ]);
  cliCtx.logger.debug("Executing datastore status command");

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<DatastoreStatusResponse>(
      { server, token },
      {
        type: "datastore.status",
        payload: {},
      },
    );
    const renderer = createDatastoreStatusRenderer(cliCtx.outputMode);
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as unknown as DatastoreStatusData,
        };
      })(),
      renderer.handlers(),
    );
    return;
  }

  const { repoDir, datastoreResolver } = await requireInitializedRepoReadOnly({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: cliCtx.outputMode,
  });

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  // The v3 datastore this checkout reads: through serve, its own copy
  // (swamp-club#4195); otherwise the datastore itself.
  const resolution = resolverEngine(datastoreResolver) === "v3"
    ? await resolveDatastoreForRepo(repoDir)
    : undefined;
  const v3Location = resolution !== undefined
    ? await v3LocationOf(resolution)
    : undefined;
  // A checkout written through serve runs this here, not on serve, so it
  // can show what it saved offline; serve's own section is added when serve
  // answers (swamp-club#4195).
  const serveUpstream = resolution?.serveUpstream;
  const deps = await createDatastoreStatusDeps(datastoreResolver, {
    ...(v3Location !== undefined
      ? {
        describeCommitLog: () => v3DatastoreFor(repoDir, v3Location).describe(),
        // What this checkout saved offline, or could not land
        // (swamp-club#4195).
        listOutboxEntries: async () =>
          outboxEntryStatusesOf(
            (await v3DatastoreFor(repoDir, v3Location).outbox.entries())
              .entries,
          ),
      }
      : {}),
    ...(serveUpstream !== undefined && v3Location !== undefined &&
        resolution !== undefined
      ? {
        // This checkout's copy, not the storage its config names.
        config: resolution.datastoreConfig,
        listHeldLeases: async () =>
          (await readExplicitLeases(v3Location.path)).map((lease) => ({
            lockKey: lease.lockKey,
            fence: lease.fence,
            expiresAt: lease.expiresAt,
          })),
        serveSection: () => serveSectionOf(serveUpstream.serverUrl, options),
      }
      : {}),
  });
  const renderer = createDatastoreStatusRenderer(cliCtx.outputMode);
  await consumeStream(datastoreStatus(ctx, deps), renderer.handlers());

  cliCtx.logger.debug("Datastore status command completed");
});
