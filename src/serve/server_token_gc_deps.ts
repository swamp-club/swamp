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
import type { FileSystemUnifiedDataRepository } from "../infrastructure/persistence/unified_data_repository.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import type { DataRecord } from "../domain/data/data_record.ts";
import type { DataQueryService } from "../domain/data/data_query_service.ts";
import type {
  Definition,
  DefinitionId,
} from "../domain/definitions/definition.ts";
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

const TOKEN_DATA_NAME = "token-main";

export interface ServerTokenGcDepsInput {
  readonly intervalMs: number;
  readonly gracePeriodMs: number;
  readonly dataQueryService: Pick<DataQueryService, "query">;
  readonly definitionRepo: Pick<YamlDefinitionRepository, "findByName">;
  readonly dataRepo: Pick<FileSystemUnifiedDataRepository, "getContent">;
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
 * Builds the repositories the server token GC reads and deletes through.
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
): Pick<
  ServerTokenGcDepsInput,
  "definitionRepo" | "dataRepo" | "modelDeleteDeps"
> {
  const autoDefRepo = new YamlDefinitionRepository(
    repoDir,
    repoContext.eventBus,
    repoContext.autoDefinitionsDir,
    false,
    repoContext.markDirty,
  );
  return {
    definitionRepo: autoDefRepo,
    dataRepo: repoContext.unifiedDataRepo,
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
 * serve delete it. And because that key is shared by every definition that
 * has carried the name, the secret is only deleted when the record being
 * collected belongs to the definition that currently owns the name.
 */
export function createServerTokenGcDeps(
  input: ServerTokenGcDepsInput,
): ServerTokenGcDeps {
  const {
    dataQueryService,
    definitionRepo,
    dataRepo,
    vaultService,
    modelDeleteDeps,
    libCtx,
    pushChanged,
    syncGate,
  } = input;

  const readToken = async (
    definitionId: string,
    name: string,
  ): Promise<TokenGcInfo | null> => {
    const content = await dataRepo.getContent(
      SERVER_TOKEN_MODEL_TYPE,
      definitionId,
      TOKEN_DATA_NAME,
    );
    if (!content) return null;
    try {
      return toTokenGcInfo(
        JSON.parse(new TextDecoder().decode(content)),
        definitionId,
        name,
      );
    } catch {
      return null;
    }
  };

  const deleteSecret = async (token: TokenGcInfo): Promise<void> => {
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
  };

  const deleteRecords = async (definition: Definition): Promise<void> => {
    // The lookup is pinned to the definition already resolved by type and
    // name: modelDelete's default lookup searches every model type by name,
    // so a user model sharing the token's name could match. The workflow
    // reference check is skipped because it also matches by name, and a
    // server-token definition is never a workflow step's model.
    const scopedDeps: ModelDeleteDeps = {
      ...modelDeleteDeps,
      lookupDefinition: () =>
        Promise.resolve({ definition, type: SERVER_TOKEN_MODEL_TYPE }),
      findAllWorkflows: () => Promise.resolve([]),
    };
    let failure: SwampError | undefined;
    await consumeStream(
      modelDelete(libCtx, scopedDeps, {
        modelIdOrName: definition.id,
        force: true,
      }),
      withDefaults<ModelDeleteEvent>({
        error: (e) => {
          failure = e.error;
        },
      }),
    );
    if (failure) throw new Error(failure.message);
  };

  const deleteOrphanedData = async (definitionId: string): Promise<void> => {
    const id = definitionId as DefinitionId;
    const artifacts = await modelDeleteDeps.findDataArtifacts(
      SERVER_TOKEN_MODEL_TYPE,
      id,
    );
    for (const data of artifacts) {
      await modelDeleteDeps.deleteData(SERVER_TOKEN_MODEL_TYPE, id, data.name);
    }
  };

  return {
    intervalMs: input.intervalMs,
    gracePeriodMs: input.gracePeriodMs,

    listTokens: async () => {
      const records = await dataQueryService.query(
        `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && name == "${TOKEN_DATA_NAME}"`,
        { loadAttributes: true },
      ) as DataRecord[];
      const tokens: TokenGcInfo[] = [];
      for (const record of records) {
        const token = toTokenGcInfo(
          record.attributes,
          record.modelId,
          record.modelName,
        );
        if (token) tokens.push(token);
      }
      return tokens;
    },

    collectToken: (listed, isEligible) =>
      // One unit under the sync gate. Mints, rotations and revokes hold the
      // gate while they write, so the re-read below sees the token as it is
      // now rather than as the sweep listed it. The local deletes and the
      // push that commits them must not interleave with a poller pull
      // either, or the pull would restore the deleted files
      // (swamp-club#2247). The GC runs from a timer, never inside a gated
      // handler, so taking the non-reentrant gate here is safe.
      withSyncGate(syncGate, async () => {
        const token = await readToken(listed.definitionId, listed.name);
        if (!token || !isEligible(token)) return "skipped";

        let touchedLocalFiles = false;
        try {
          const owner = await definitionRepo.findByName(
            SERVER_TOKEN_MODEL_TYPE,
            token.name,
          );
          if (!owner || owner.id !== token.definitionId) {
            // The record outlived its definition. The name, and with it
            // the name-keyed secret, belongs to another definition or to
            // none, so only this record's data is deleted.
            logger.warn(
              "Server token record {name} ({id}) has no definition; deleting its data and leaving the {name} secret alone",
              { name: token.name, id: token.definitionId },
            );
            touchedLocalFiles = true;
            await deleteOrphanedData(token.definitionId);
            return "collected";
          }

          // The secret goes first, and a failure stops here so the next
          // sweep retries: once it is gone, no stale copy of the records
          // (such as an HA peer's local cache) can authenticate.
          await deleteSecret(token);
          try {
            await deleteIgnoringNotFound(
              vaultService,
              TOKEN_SECRETS_VAULT_NAME,
              oauthAccessTokenKey(token.name),
            );
          } catch (err) {
            logger.warn(
              "Failed to delete OAuth access token for {name}: {error}",
              {
                name: token.name,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          }
          touchedLocalFiles = true;
          await deleteRecords(owner);
          return "collected";
        } finally {
          // Push whatever was deleted, even after a partial failure, so no
          // delete is left uncommitted.
          if (touchedLocalFiles) await pushDeletes(pushChanged);
        }
      }),
  };
}

/**
 * Validates a `token-main` record. A record whose token name differs from
 * the model it is stored under is skipped: that name drives the secret key
 * and the definition lookup.
 */
function toTokenGcInfo(
  attributes: unknown,
  definitionId: string,
  modelName: string,
): TokenGcInfo | null {
  const parsed = ServerTokenSchema.safeParse(attributes);
  if (!parsed.success) return null;
  const token = parsed.data;
  if (token.name !== modelName) {
    logger.warn(
      "Skipping server token record {modelName}: its token name {name} does not match",
      { modelName, name: token.name },
    );
    return null;
  }
  return {
    name: token.name,
    definitionId,
    state: token.state,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    vaultName: token.vaultName,
    secretKey: token.secretKey,
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
