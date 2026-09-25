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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  consumeStream,
  createModelDeleteDeps,
  type LibSwampContext,
  modelDelete,
  type ModelDeleteDeps,
  type ModelDeleteEvent,
  type SwampError,
  withDefaults,
} from "../libswamp/mod.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import type { DataRecord } from "../domain/data/data_record.ts";
import type { DataQueryService } from "../domain/data/data_query_service.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  ServerTokenSchema,
  serverTokenSecretKey,
} from "../domain/models/access/server_token_model.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";
import type { VaultService } from "../domain/vaults/vault_service.ts";
import { YamlDefinitionRepository } from "../infrastructure/persistence/yaml_definition_repository.ts";
import { oauthAccessTokenKey } from "./device_auth_handler.ts";
import { type SyncGate, withSyncGate } from "./sync_gate.ts";
import type {
  ServerTokenGcDeps,
  TokenGcInfo,
} from "./server_token_gc_service.ts";

const logger = getSwampLogger(["serve", "token-gc"]);

export interface ServerTokenGcDepsInput {
  readonly intervalMs: number;
  readonly gracePeriodMs: number;
  readonly dataQueryService: Pick<DataQueryService, "query">;
  readonly definitionRepo: Pick<YamlDefinitionRepository, "findByName">;
  readonly vaultService: Pick<VaultService, "delete" | "supportsDelete">;
  /** Built over the process's shared repositories and `markDirty` hook. */
  readonly modelDeleteDeps: ModelDeleteDeps;
  readonly libCtx: LibSwampContext;
  /** Pushes local changes to the remote datastore; absent without one. */
  readonly pushChanged?: () => Promise<void>;
  /** Serve's sync gate; absent without a remote datastore. */
  readonly syncGate?: SyncGate;
}

/**
 * Builds the repositories the server token GC deletes through.
 *
 * Server-token definitions live in the auto-definitions directory, so the
 * lookup and the delete go through a repository rooted there, as the admin
 * grant store and `access.reload` do. The shared repository treats that
 * directory as secondary: its type-scoped `findByName` does not record a
 * secondary file's path, so its `delete` would find nothing to remove. Data,
 * outputs and marks still go through the process's shared repositories.
 */
export function createServerTokenGcRepos(
  repoDir: string,
  repoContext: RepositoryContext,
  datastoreResolver?: DatastorePathResolver,
): Pick<ServerTokenGcDepsInput, "definitionRepo" | "modelDeleteDeps"> {
  const autoDefRepo = new YamlDefinitionRepository(
    repoDir,
    repoContext.eventBus,
    repoContext.autoDefinitionsDir,
    false,
    repoContext.markDirty,
  );
  return {
    definitionRepo: autoDefRepo,
    modelDeleteDeps: createModelDeleteDeps(
      repoDir,
      datastoreResolver,
      repoContext.unifiedDataRepo,
      repoContext.markDirty,
      autoDefRepo,
    ),
  };
}

/**
 * Wires `ServerTokenGcService` to the repository, the vaults and the sync
 * service.
 *
 * Every secret key it deletes is derived from the token name, never read
 * from the persisted `token-main` record: anyone who can write the datastore
 * could otherwise point a revoked record at an unrelated secret and have
 * serve delete it.
 */
export function createServerTokenGcDeps(
  input: ServerTokenGcDepsInput,
): ServerTokenGcDeps {
  const {
    dataQueryService,
    definitionRepo,
    vaultService,
    modelDeleteDeps,
    libCtx,
    pushChanged,
    syncGate,
  } = input;

  return {
    intervalMs: input.intervalMs,
    gracePeriodMs: input.gracePeriodMs,

    listTokens: async () => {
      const records = await dataQueryService.query(
        `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && name == "token-main"`,
        { loadAttributes: true },
      ) as DataRecord[];
      const tokens: TokenGcInfo[] = [];
      for (const record of records) {
        const parsed = ServerTokenSchema.safeParse(record.attributes);
        if (!parsed.success) continue;
        const token = parsed.data;
        if (token.name !== record.modelName) {
          logger.warn(
            "Skipping server token record {modelName}: its token name {name} does not match",
            { modelName: record.modelName, name: token.name },
          );
          continue;
        }
        tokens.push({
          name: token.name,
          definitionId: record.modelId,
          state: token.state,
          expiresAt: token.expiresAt,
          revokedAt: token.revokedAt,
          vaultName: token.vaultName,
          secretKey: token.secretKey,
        });
      }
      return tokens;
    },

    deleteTokenSecret: async (token) => {
      const key = serverTokenSecretKey(token.name);
      if (!vaultService.supportsDelete(TOKEN_SECRETS_VAULT_NAME)) {
        throw new Error(
          `Vault ${TOKEN_SECRETS_VAULT_NAME} does not support deleting secrets`,
        );
      }
      await deleteIgnoringNotFound(vaultService, TOKEN_SECRETS_VAULT_NAME, key);

      // Tokens minted before secrets moved to the control-plane store record
      // the vault that still holds their secret.
      if (!token.vaultName || token.vaultName === TOKEN_SECRETS_VAULT_NAME) {
        return;
      }
      if (token.secretKey !== key) {
        logger.warn(
          "Not deleting secret {secretKey} named by server token {name}: expected {expected}",
          { secretKey: token.secretKey, name: token.name, expected: key },
        );
        return;
      }
      if (!vaultService.supportsDelete(token.vaultName)) {
        logger.warn(
          "Cannot delete secret for server token {name}: vault {vault} does not support deletion",
          { name: token.name, vault: token.vaultName },
        );
        return;
      }
      await deleteIgnoringNotFound(vaultService, token.vaultName, key);
    },

    deleteOAuthAccessToken: async (tokenName) => {
      await deleteIgnoringNotFound(
        vaultService,
        TOKEN_SECRETS_VAULT_NAME,
        oauthAccessTokenKey(tokenName),
      );
    },

    deleteTokenRecord: async (definitionId, tokenName) => {
      // Look the definition up by type and name, then check the id.
      // modelDelete's default lookup searches every model type by name (so a
      // user model sharing the token's name could match) and falls back to
      // parsing every definition for an id.
      const scopedDeps: ModelDeleteDeps = {
        ...modelDeleteDeps,
        lookupDefinition: async () => {
          const definition = await definitionRepo.findByName(
            SERVER_TOKEN_MODEL_TYPE,
            tokenName,
          );
          if (!definition || definition.id !== definitionId) return null;
          return { definition, type: SERVER_TOKEN_MODEL_TYPE };
        },
      };
      // The local delete and the push that commits it are one unit: a
      // poller pull landing between them would restore the deleted files
      // and the push would keep them (swamp-club#2247). The GC runs from a
      // timer, never inside a gated handler, so the non-reentrant gate is
      // safe to take here.
      await withSyncGate(syncGate, async () => {
        let failure: SwampError | undefined;
        try {
          await consumeStream(
            modelDelete(libCtx, scopedDeps, {
              modelIdOrName: definitionId,
              force: true,
            }),
            withDefaults<ModelDeleteEvent>({
              error: (e) => {
                failure = e.error;
              },
            }),
          );
        } finally {
          // not_found: already deleted, e.g. by an HA peer's sweep, so
          // there is nothing to push. Otherwise push whatever was deleted,
          // even after a partial failure, so no delete is left uncommitted.
          if (failure?.code !== "not_found") {
            await pushDeletes(pushChanged);
          }
        }
        if (failure && failure.code !== "not_found") {
          throw new Error(failure.message);
        }
      });
    },
  };
}

async function pushDeletes(
  pushChanged: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!pushChanged) return;
  try {
    await pushChanged();
  } catch (err) {
    // The deletes stay marked dirty and go out with the next push.
    logger.warn(
      "Failed to push server token GC deletes to the remote datastore: {error}",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}

async function deleteIgnoringNotFound(
  vaultService: Pick<VaultService, "delete">,
  vaultName: string,
  secretKey: string,
): Promise<void> {
  try {
    await vaultService.delete(vaultName, secretKey, "serve:token-gc");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(message)) return;
    throw err;
  }
}
