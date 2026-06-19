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
  createServerTokenRevokeDeps,
  serverTokenRevoke,
  type ServerTokenRevokeData,
  type ServerTokenRevokeEvent,
  withDefaults,
} from "../../libswamp/mod.ts";
import { renderServerTokenRevoke } from "../../presentation/output/access_token_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const accessTokenRevokeCommand = new Command()
  .name("revoke")
  .description("Invalidate a server token before it expires")
  .example("Revoke a token", "swamp access token revoke adam-token")
  .arguments("<name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, name: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "access",
      "token",
      "revoke",
    ]);

    const { repoDir, repoContext, datastoreConfig, syncService } =
      await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

    cliCtx.logger.debug`Revoking server token ${name}`;

    const libCtx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createServerTokenRevokeDeps(
      libCtx,
      repoDir,
      repoContext,
    );

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
      let data: ServerTokenRevokeData | undefined;
      await consumeStream(
        serverTokenRevoke(libCtx, deps, { name }),
        withDefaults<ServerTokenRevokeEvent>({
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
      renderServerTokenRevoke(data, cliCtx.outputMode);
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

    cliCtx.logger.debug("Server token revoke command completed");
  });
