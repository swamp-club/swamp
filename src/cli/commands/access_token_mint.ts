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
import { parsePrincipal } from "../../domain/access/principal.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
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
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { AccessTokenMintResponse } from "../../serve/protocol.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../../domain/vaults/control_plane_vault_provider.ts";
import { initializeControlPlaneVaultForCli } from "../control_plane_vault.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  serverTokenModel,
} from "../../domain/models/access/server_token_model.ts";
import { migrateTokenSecrets } from "../../serve/token_secret_migration.ts";
import { createResourceWriter } from "../../domain/models/data_writer.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { tokenVaultRejectedMessage } from "../access_token_vault_guidance.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const DEFAULT_DURATION = "30d";

export const accessTokenMintCommand = withRemoteOptions(
  new Command()
    .name("mint")
    .description(
      "Mint a server token for user authentication",
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
      "Principal identity for the token: user:<id> or worker:<id> (e.g. user:adam)",
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
      "Not supported: token secrets are always stored in the control-plane vault. Passing it prints how to copy the credential into another vault",
    ),
).action(async function (options: AnyOptions, name: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "access",
    "token",
    "mint",
  ]);

  const principal = options.principal as string;
  try {
    parsePrincipal(principal);
  } catch (error) {
    throw new UserError(
      `Invalid --principal value "${principal}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const durationMs = parseDuration(options.duration as string);
  if (durationMs <= 0) {
    throw new UserError(
      `Invalid --duration value "${options.duration}": must be positive`,
    );
  }

  const email = (options.email as string | undefined) ?? principal;

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    if (options.vault !== undefined) {
      throw new UserError(
        tokenVaultRejectedMessage("mint", name, options.vault as string, {
          remote: true,
        }),
      );
    }
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<AccessTokenMintResponse>(
      { server, token },
      {
        type: "access.token.mint",
        payload: {
          name,
          principalId: principal,
          principalEmail: email,
          durationMs,
        },
      },
    );
    renderServerTokenCreate(
      response.data as unknown as ServerTokenCreateData,
      cliCtx.outputMode,
    );
    return;
  }

  const requestedVault = options.vault as string | undefined;
  if (requestedVault !== undefined) {
    throw new UserError(
      tokenVaultRejectedMessage("mint", name, requestedVault),
    );
  }

  const { repoDir, repoContext, datastoreConfig, syncService, vaultsDir } =
    await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

  cliCtx.logger.debug`Minting server token ${name}`;

  const namespace = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.namespace
    : undefined;

  await initializeControlPlaneVaultForCli(
    repoDir,
    syncService,
    {
      namespace,
      catalogInvalidate: () => repoContext.catalogStore.invalidate(),
    },
  );

  const libCtx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = await createServerTokenCreateDeps(
    libCtx,
    repoDir,
    repoContext,
    { vaultsDir },
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
        vaultName: TOKEN_SECRETS_VAULT_NAME,
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

    const migrationVaultService = await VaultService.fromRepository(
      repoDir,
      { vaultsDir },
    );
    await migrateTokenSecrets({
      tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
      vaultService: migrationVaultService,
      dataQueryService: repoContext.dataQueryService,
      updateTokenVaultName: async (
        tokenName,
        newVaultName,
        currentAttrs,
      ) => {
        const def = await repoContext.definitionRepo.findByName(
          SERVER_TOKEN_MODEL_TYPE,
          tokenName,
        );
        if (!def) {
          throw new Error(
            `Definition not found for token '${tokenName}' — skipping migration`,
          );
        }
        const { writeResource } = createResourceWriter(
          repoContext.unifiedDataRepo,
          SERVER_TOKEN_MODEL_TYPE,
          def.id,
          serverTokenModel.resources!,
          undefined,
          undefined,
          undefined,
          undefined,
          tokenName,
        );
        await writeResource(
          "token",
          "token-main",
          { ...currentAttrs, vaultName: newVaultName },
        );
      },
    });

    if (syncService) {
      await syncService.markDirty();
      await syncService.pushChanged({ namespace });

      repoContext.catalogStore.invalidate();
      const verifyResult = await findDefinitionByIdOrName(
        repoContext.definitionRepo,
        name,
      );
      if (!verifyResult) {
        throw new UserError(
          `Server token '${name}' was minted but its definition could not be ` +
            `read back after sync — the token will not be usable by serve. ` +
            `Re-mint the token after resolving the datastore issue.`,
        );
      }
    }
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
