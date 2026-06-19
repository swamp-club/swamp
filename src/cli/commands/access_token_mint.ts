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
  createServerTokenCreateDeps,
  parseDuration,
  serverTokenCreate,
  type ServerTokenCreateData,
  type ServerTokenCreateEvent,
  withDefaults,
} from "../../libswamp/mod.ts";
import { renderServerTokenCreate } from "../../presentation/output/access_token_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const DEFAULT_DURATION = "30d";

export const accessTokenMintCommand = new Command()
  .name("mint")
  .description(
    "Mint a server token for user authentication; the plaintext is shown once",
  )
  .example(
    "Mint a token for a user",
    "swamp access token mint adam-token --principal user:adam",
  )
  .example(
    "Mint with custom duration",
    "swamp access token mint adam-token --principal user:adam --duration 7d",
  )
  .arguments("<name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--principal <principal:string>",
    "Principal identity for the token (e.g. user:adam)",
    { required: true },
  )
  .option(
    "--email <email:string>",
    "Display email for the token holder (defaults to principal)",
  )
  .option(
    "--duration <duration:string>",
    "Token lifetime (e.g. 30m, 1h, 24h, 7d, 30d)",
    { default: DEFAULT_DURATION },
  )
  .option(
    "--vault <vault:string>",
    "Vault that stores the token plaintext (defaults to the sole configured vault)",
  )
  .action(async function (options: AnyOptions, name: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "access",
      "token",
      "mint",
    ]);

    const principal = options.principal as string;
    if (!principal.includes(":")) {
      throw new UserError(
        `Invalid --principal value "${principal}": expected format "user:<id>"`,
      );
    }

    const durationMs = parseDuration(options.duration as string);
    if (durationMs <= 0) {
      throw new UserError(
        `Invalid --duration value "${options.duration}": must be positive`,
      );
    }

    const email = (options.email as string | undefined) ?? principal;

    const { repoDir, repoContext, datastoreConfig, syncService } =
      await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

    cliCtx.logger.debug`Minting server token ${name}`;

    const libCtx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createServerTokenCreateDeps(
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
      let data: ServerTokenCreateData | undefined;
      await consumeStream(
        serverTokenCreate(libCtx, deps, {
          name,
          principalId: principal,
          principalEmail: email,
          durationMs,
          vaultName: options.vault as string | undefined,
        }),
        withDefaults<ServerTokenCreateEvent>({
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
          `Minting token '${name}' ended without completing`,
        );
      }
      renderServerTokenCreate(data, cliCtx.outputMode);
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

    cliCtx.logger.debug("Server token mint command completed");
  });
