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
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import {
  consumeStream,
  createLibSwampContext,
  createWorkerTokenRevokeDeps,
  withDefaults,
  workerTokenRevoke,
  type WorkerTokenRevokeData,
  type WorkerTokenRevokeEvent,
} from "../../libswamp/mod.ts";
import { renderWorkerTokenRevoke } from "../../presentation/output/worker_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workerTokenRevokeCommand = new Command()
  .name("revoke")
  .description("Invalidate a worker enrollment token before it expires")
  .example("Revoke a token", "swamp worker token revoke ci-runner-3")
  .arguments("<name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, name: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "worker",
      "token",
      "revoke",
    ]);

    const { repoDir, repoContext, datastoreConfig, syncService } =
      await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

    cliCtx.logger.debug`Revoking enrollment token ${name}`;

    const libCtx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createWorkerTokenRevokeDeps(
      libCtx,
      repoDir,
      repoContext,
    );

    // Per-model lock around the state transition — mirrors
    // `swamp model method run`.
    const preResult = await findDefinitionByIdOrName(
      repoContext.definitionRepo,
      name,
    );
    let flushModelLocks: (() => Promise<void>) | null = null;
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
      flushModelLocks = lockResult.flush;
    }

    try {
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
    } finally {
      if (flushModelLocks) {
        try {
          await flushModelLocks();
        } catch (releaseError) {
          cliCtx.logger.warn(
            "Failed to release locks during cleanup: {error}",
            {
              error: releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
            },
          );
        }
      }
    }

    cliCtx.logger.debug("Worker token revoke command completed");
  });
