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
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  acquireModelLocks,
  libSwampContextForRepo,
  type ModelLockResult,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { runCommandInRootUnit } from "../command_root_unit.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import {
  consumeStream,
  createWorkerTokenRevokeDeps,
  withDefaults,
  workerTokenRevoke,
  type WorkerTokenRevokeData,
  type WorkerTokenRevokeEvent,
} from "../../libswamp/mod.ts";
import { renderWorkerTokenRevoke } from "../../presentation/output/worker_output.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkerTokenRevokeResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workerTokenRevokeCommand = withRemoteOptions(
  new Command()
    .name("revoke")
    .description(
      `Invalidate a worker enrollment token before it expires

Workers already connected on the token are disconnected and their
credentials revoked. With --server this happens at once; otherwise a
running orchestrator does it at its next token check, about every 30
seconds.`,
    )
    .example("Revoke a token", "swamp worker token revoke ci-runner-3")
    .arguments("<name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions, name: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "worker",
    "token",
    "revoke",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<WorkerTokenRevokeResponse>(
      { server, token },
      {
        type: "worker.token.revoke",
        payload: { name },
      },
    );
    renderWorkerTokenRevoke(
      response.data as unknown as WorkerTokenRevokeData,
      cliCtx.outputMode,
    );
    return;
  }

  const {
    repoDir,
    repoContext,
    datastoreConfig,
    syncService,
    vaultsDir,
  } = await requireInitializedRepoUnlocked({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: cliCtx.outputMode,
  });

  cliCtx.logger.debug`Revoking enrollment token ${name}`;

  const namespace = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.namespace
    : undefined;

  const libCtx = libSwampContextForRepo(repoContext, { logger: cliCtx.logger });
  const deps = await createWorkerTokenRevokeDeps(
    libCtx,
    repoDir,
    repoContext,
    { vaultsDir },
  );

  // Per-model lock around the state transition — mirrors
  // `swamp model method run`.
  const preResult = await findDefinitionByIdOrName(
    repoContext.definitionRepo,
    name,
  );
  let modelLocks: ModelLockResult | undefined;
  if (preResult) {
    const lockResult = await acquireModelLocks(
      datastoreConfig,
      [
        {
          modelType: preResult.type.normalized,
          modelId: preResult.definition.id,
        },
      ],
      repoDir,
      syncService,
      repoContext.catalogStore,
    );
    if (lockResult.synced) repoContext.catalogStore.invalidate();
    modelLocks = lockResult;
  }

  await runCommandInRootUnit(
    repoContext,
    {
      push: modelLocks?.push,
      release: modelLocks?.release,
      onCleanupError: (releaseError) => {
        cliCtx.logger.warn(
          "Failed to release locks during cleanup: {error}",
          {
            error: releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
          },
        );
      },
    },
    async (root) => {
      let data: WorkerTokenRevokeData | undefined;
      await consumeStream(
        workerTokenRevoke(libCtx, deps, { name }),
        withDefaults<WorkerTokenRevokeEvent>({
          completed: (event) => {
            data = event.data;
          },
          error: (event) => {
            throw new UserError(event.error.message);
          },
        }),
      );
      if (data === undefined) {
        throw new UserError(
          `Revoking token '${name}' ended without completing`,
        );
      }
      renderWorkerTokenRevoke(data, cliCtx.outputMode);

      if (syncService) {
        await root.stage({ kind: "bulk", reason: "worker token revoke" });
        // Published here; a root cannot push mid-command
        // (PINNED_CLI_PUSH_CALLS). When a model lock is held, the root's lock
        // push publishes again when the command ends.
        await syncService.pushChanged({ namespace });
      }
    },
  );

  cliCtx.logger.debug("Worker token revoke command completed");
});
