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
  createServerTokenRotateDeps,
  parseDuration,
  serverTokenRotate,
  type ServerTokenRotateData,
  type ServerTokenRotateEvent,
  withDefaults,
} from "../../libswamp/mod.ts";
import { renderServerTokenRotate } from "../../presentation/output/access_token_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const DEFAULT_DURATION = "30d";

export const accessTokenRotateCommand = new Command()
  .name("rotate")
  .description(
    "Revoke an existing token and mint a replacement with the same name and principal",
  )
  .example(
    "Rotate a compromised token",
    "swamp access token rotate sarah-token",
  )
  .example(
    "Rotate with custom duration",
    "swamp access token rotate sarah-token --duration 7d",
  )
  .arguments("<name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--duration <duration:string>",
    "Lifetime for the new token (e.g. 30m, 1h, 24h, 7d, 30d)",
    { default: DEFAULT_DURATION },
  )
  .action(async function (options: AnyOptions, name: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "access",
      "token",
      "rotate",
    ]);

    const durationMs = parseDuration(options.duration as string);
    if (durationMs <= 0) {
      throw new UserError(
        `Invalid --duration value "${options.duration}": must be positive`,
      );
    }

    const { repoDir, repoContext, datastoreConfig, syncService } =
      await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

    cliCtx.logger.debug`Rotating server token ${name}`;

    const libCtx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createServerTokenRotateDeps(
      libCtx,
      repoDir,
      repoContext,
    );

    const preResult = await findDefinitionByIdOrName(
      repoContext.definitionRepo,
      name,
    );
    if (!preResult) {
      throw new UserError(
        `Server token '${name}' not found. ` +
          "Use 'swamp access token list' to see existing tokens.",
      );
    }

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
    const flushModelLocks = lockResult.flush;

    try {
      let data: ServerTokenRotateData | undefined;
      await consumeStream(
        serverTokenRotate(libCtx, deps, {
          name,
          durationMs,
        }),
        withDefaults<ServerTokenRotateEvent>({
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
      renderServerTokenRotate(data, cliCtx.outputMode);
    } finally {
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

    cliCtx.logger.debug("Server token rotate command completed");
  });
