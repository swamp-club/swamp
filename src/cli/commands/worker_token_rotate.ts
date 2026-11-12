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
import { pushNamespace } from "../../infrastructure/persistence/push_paths.ts";
import { UserError } from "../../domain/errors.ts";
import { runCommandInRootUnit } from "../command_root_unit.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "../../domain/models/worker/enrollment_token_model.ts";
import { consumeStream, withDefaults } from "../../libswamp/stream.ts";
import { parseDuration } from "../../libswamp/data/search.ts";
import {
  createWorkerTokenRotateDeps,
  workerTokenRotate,
  type WorkerTokenRotateData,
  type WorkerTokenRotateEvent,
} from "../../libswamp/worker/token_rotate.ts";
import { renderWorkerTokenRotate } from "../../presentation/output/worker_output.ts";
import { initializeControlPlaneVaultForCli } from "../control_plane_vault.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkerTokenRotateResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workerTokenRotateCommand = withRemoteOptions(
  new Command()
    .name("rotate")
    .description(
      `Replace a worker enrollment token's secret before it expires

The token keeps its name, so its workers keep theirs. With --server the
new token is sent to every connected worker over its own connection;
a worker started with "swamp worker connect --token-file" writes it back
to that file. The old
token stays valid until its original expiry (or the new token's, if
sooner), so machines that were not connected can still enroll with it.
Rotating again retires the old token at once. The new token is printed
once.`,
    )
    .example(
      "Rotate a token and deliver it to its connected workers",
      "swamp worker token rotate web-01 --server wss://swamp.example.com",
    )
    .example(
      "Rotate with a new 30-day lifetime",
      "swamp worker token rotate web-01 --duration 30d --server wss://swamp.example.com",
    )
    .arguments("<name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--duration <duration:string>",
      "Lifetime of the new token (e.g. 24h, 7d); defaults to the current token's lifetime",
    ),
).action(async function (options: AnyOptions, name: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "worker",
    "token",
    "rotate",
  ]);

  let durationMs: number | undefined;
  if (options.duration !== undefined) {
    durationMs = parseDuration(options.duration as string);
    if (durationMs <= 0) {
      throw new UserError(
        `Invalid --duration value "${options.duration}": must be positive`,
      );
    }
  }

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<WorkerTokenRotateResponse>(
      { server, token },
      {
        type: "worker.token.rotate",
        payload: durationMs !== undefined ? { name, durationMs } : { name },
      },
    );
    renderWorkerTokenRotate(
      response.data as unknown as WorkerTokenRotateData,
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

  cliCtx.logger.debug`Rotating enrollment token ${name}`;

  const namespace = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.namespace
    : undefined;

  // a locally minted token's secrets live in the control-plane vault
  await initializeControlPlaneVaultForCli(
    repoDir,
    syncService,
    {
      namespace,
      catalogInvalidate: () => repoContext.catalogStore.invalidate(),
    },
  );

  const libCtx = libSwampContextForRepo(repoContext, { logger: cliCtx.logger });
  const deps = await createWorkerTokenRotateDeps(
    libCtx,
    repoDir,
    repoContext,
    { vaultsDir },
  );

  const tokenDefinition = await repoContext.definitionRepo.findByName(
    ENROLLMENT_TOKEN_MODEL_TYPE,
    name,
  );
  let modelLocks: ModelLockResult | undefined;
  if (tokenDefinition) {
    const lockResult = await acquireModelLocks(
      datastoreConfig,
      [
        {
          modelType: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
          modelId: tokenDefinition.id,
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
      checkpoint: syncService
        ? async () => {
          await pushNamespace(syncService, namespace);
        }
        : undefined,
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
      let data: WorkerTokenRotateData | undefined;
      await consumeStream(
        workerTokenRotate(libCtx, deps, { name, durationMs }),
        withDefaults<WorkerTokenRotateEvent>({
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
          `Rotating token '${name}' ended without completing`,
        );
      }
      renderWorkerTokenRotate(data, cliCtx.outputMode);

      if (syncService) {
        await root.stage({ kind: "bulk", reason: "worker token rotate" });
        // published here through the root's checkpoint; with a model lock held
        // the root's lock push publishes again at command end
        await root.checkpoint();
      }
    },
  );

  cliCtx.logger.debug("Worker token rotate command completed");
});
