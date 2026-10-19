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

/**
 * `swamp vault remove`: removes a vault's config and, for a local_encryption
 * vault, its stored secrets (swamp-club#3597).
 *
 * The config removal is the transactional use case. The secrets are removed
 * by {@link vaultRemoveStoredSecrets} only once that removal has committed
 * and published, so a removal that does not land never costs the secrets.
 *
 * @module
 */

import type { VaultConfig } from "../../domain/vaults/vault_config.ts";
import {
  isReservedVaultName,
  reservedVaultNameMessage,
  vaultCreateHint,
} from "../../domain/vaults/vault_name.ts";
import {
  isLocalEncryptionType,
  withRuntimeBaseDir,
} from "../../domain/vaults/local_encryption_key_source.ts";
import {
  localEncryptionSecretsDirFor,
  LocalEncryptionVaultProvider,
  type RemovedLocalEncryptionSecrets,
  removeLocalEncryptionSecrets,
} from "../../domain/vaults/local_encryption_vault_provider.ts";
import {
  findVaultReferences,
  type PossibleVaultReference,
  type VaultReferences,
  type VaultReferenceSite,
} from "../../domain/vaults/vault_references.ts";
import type { Definition } from "../../domain/definitions/definition.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import type { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** A local_encryption vault's stored secrets, which removal deletes. */
export interface VaultRemoveLocalStorage {
  /** The base directory the vault's storage resolves against. */
  baseDir: string;
  /** The vault's secrets directory. */
  directory: string;
  /** The secrets stored there. */
  secretKeys: string[];
}

export interface VaultRemovePreview {
  vaultName: string;
  vaultId: string;
  vaultType: string;
  /** Set for a local_encryption vault; other types keep their secrets. */
  localStorage?: VaultRemoveLocalStorage;
  references: VaultReferenceSite[];
  possibleReferences: PossibleVaultReference[];
}

export interface VaultRemoveData {
  vaultName: string;
  vaultId: string;
  vaultType: string;
  /** References the removal went ahead despite, with force. */
  forcedReferences: VaultReferenceSite[];
  timestamp: string;
  /**
   * The local secrets removed after the config removal was published, set by
   * the caller of {@link vaultRemoveStoredSecrets}. Absent for a vault whose
   * secrets live elsewhere.
   */
  secrets?: RemovedLocalEncryptionSecrets;
}

export type VaultRemoveEvent =
  | { kind: "removing" }
  | { kind: "completed"; data: VaultRemoveData }
  | { kind: "error"; error: SwampError };

export interface VaultRemoveInput {
  vaultName: string;
  /** Remove the vault even while something references it. */
  force?: boolean;
}

export interface VaultRemoveDeps {
  findVault: (name: string) => Promise<VaultConfig | null>;
  listVaultNames: () => Promise<string[]>;
  /** The vault `.swamp.yaml` names as `defaultVault`, if any. */
  getDefaultVaultName: () => Promise<string | undefined>;
  findReferences: (vaultName: string) => Promise<VaultReferences>;
  /** The local_encryption storage of `config`; undefined for other types. */
  findLocalStorage: (
    config: VaultConfig,
  ) => Promise<VaultRemoveLocalStorage | undefined>;
  deleteConfig: (config: VaultConfig) => Promise<void>;
  removeLocalSecrets: (
    storage: VaultRemoveLocalStorage,
    vaultName: string,
  ) => Promise<RemovedLocalEncryptionSecrets>;
}

/** The repositories vault remove reads and writes through. */
export interface VaultRemoveRepositories {
  /** The hooked repository, so the removal is staged and marked. */
  vaultConfigRepo: YamlVaultConfigRepository;
  /** Reads primary and auto-definitions alike. */
  definitionRepo: YamlDefinitionRepository;
  workflowRepo: WorkflowRepository;
}

/** Wires real infrastructure into VaultRemoveDeps. */
export function createVaultRemoveDeps(
  repoDir: string,
  repos: VaultRemoveRepositories,
): VaultRemoveDeps {
  const readMarker = () =>
    new RepoMarkerRepository().read(RepoPath.create(repoDir));

  return {
    findVault: (name) => repos.vaultConfigRepo.findByName(name),
    listVaultNames: async () => {
      const all = await repos.vaultConfigRepo.findAll();
      return all.map((v) => v.name);
    },
    getDefaultVaultName: async () => (await readMarker())?.defaultVault,
    findReferences: async (vaultName) => {
      const [found, workflows, marker] = await Promise.all([
        repos.definitionRepo.findAllIncludingAutoGlobal(),
        repos.workflowRepo.findAll(),
        readMarker(),
      ]);
      const definitions: Definition[] = found.map((d) => d.definition);
      return findVaultReferences(vaultName, {
        definitions,
        workflows,
        datastoreConfig: marker?.datastore,
      });
    },
    findLocalStorage: async (config) => {
      if (!isLocalEncryptionType(config.type)) return undefined;
      const providerConfig = withRuntimeBaseDir(
        config.type,
        config.config,
        repoDir,
      );
      const baseDir = providerConfig.base_dir as string;
      const directory = localEncryptionSecretsDirFor(baseDir, config.name);
      const secretKeys = await new LocalEncryptionVaultProvider(
        config.name,
        providerConfig,
      ).list();
      return { baseDir, directory, secretKeys };
    },
    deleteConfig: (config) => repos.vaultConfigRepo.delete(config),
    removeLocalSecrets: (storage, vaultName) =>
      removeLocalEncryptionSecrets(storage.baseDir, vaultName),
  };
}

/**
 * What removing the vault would do, for the confirmation prompt. Throws the
 * SwampError that {@link vaultRemove} would report: an unknown or reserved
 * vault, the default vault, or a referenced vault without force.
 */
export async function vaultRemovePreview(
  ctx: LibSwampContext,
  deps: VaultRemoveDeps,
  input: VaultRemoveInput,
): Promise<VaultRemovePreview> {
  ctx.logger.debug`Previewing vault removal: ${input.vaultName}`;
  const config = await deps.findVault(input.vaultName);
  if (!config) throw await vaultNotFound(deps, input.vaultName);

  const { references, refusal } = await checkRemovable(deps, config, input);
  if (refusal) throw refusal;

  return {
    vaultName: config.name,
    vaultId: config.id,
    vaultType: config.type,
    localStorage: await deps.findLocalStorage(config),
    references: references.references,
    possibleReferences: references.possibleReferences,
  };
}

/**
 * Removes the vault's config. The checks of {@link vaultRemovePreview} run
 * again here, since the repository may have changed since the preview.
 */
export async function* vaultRemove(
  ctx: LibSwampContext,
  deps: VaultRemoveDeps,
  input: VaultRemoveInput,
): AsyncIterable<VaultRemoveEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.vault.remove",
      {},
      (async function* () {
        yield { kind: "removing" };

        const config = await deps.findVault(input.vaultName);
        if (!config) {
          yield {
            kind: "error",
            error: await vaultNotFound(deps, input.vaultName),
          };
          return;
        }

        const { references, refusal } = await checkRemovable(
          deps,
          config,
          input,
        );
        if (refusal) {
          yield { kind: "error", error: refusal };
          return;
        }

        await deps.deleteConfig(config);
        ctx.logger.debug`Removed vault config: ${config.name}`;

        yield {
          kind: "completed",
          data: {
            vaultName: config.name,
            vaultId: config.id,
            vaultType: config.type,
            forcedReferences: references.references,
            timestamp: new Date().toISOString(),
          },
        };
      })(),
    ));
}

/**
 * Removes a removed vault's local secrets. Call it only once the config
 * removal of {@link vaultRemove} has committed and published. Returns
 * undefined for a vault whose secrets are not stored locally.
 */
export async function vaultRemoveStoredSecrets(
  ctx: LibSwampContext,
  deps: VaultRemoveDeps,
  preview: VaultRemovePreview,
): Promise<RemovedLocalEncryptionSecrets | undefined> {
  if (!preview.localStorage) return undefined;
  ctx.logger.debug`Removing local secrets: ${preview.localStorage.directory}`;
  return await deps.removeLocalSecrets(
    preview.localStorage,
    preview.vaultName,
  );
}

/**
 * The default vault is never removed; a referenced vault only with force.
 */
async function checkRemovable(
  deps: VaultRemoveDeps,
  config: VaultConfig,
  input: VaultRemoveInput,
): Promise<{ references: VaultReferences; refusal?: SwampError }> {
  const none: VaultReferences = { references: [], possibleReferences: [] };
  if (config.name === await deps.getDefaultVaultName()) {
    return {
      references: none,
      refusal: validationFailed(
        `Vault '${config.name}' is the repository's default vault ` +
          `(defaultVault in .swamp.yaml) and cannot be removed. Set ` +
          `defaultVault in .swamp.yaml to another vault first.`,
      ),
    };
  }

  const references = await deps.findReferences(config.name);
  if (references.references.length > 0 && !input.force) {
    const sites = references.references.map((r) =>
      `${r.kind} '${r.name}' (${r.via})`
    );
    return {
      references,
      refusal: validationFailed(
        `Vault '${config.name}' is referenced by: ${sites.join(", ")}. ` +
          `Remove these references, or re-run with --force to remove the ` +
          `vault anyway.`,
        { references: references.references },
      ),
    };
  }
  return { references };
}

async function vaultNotFound(
  deps: VaultRemoveDeps,
  vaultName: string,
): Promise<SwampError> {
  const names = await deps.listVaultNames();
  const available = names.length > 0
    ? ` Available vaults: ${names.join(", ")}`
    : "";
  if (isReservedVaultName(vaultName)) {
    return notFound(
      "Vault",
      `${vaultName}. ${reservedVaultNameMessage(vaultName)}${available}`,
    );
  }
  if (names.length === 0) {
    return notFound(
      "Vault",
      `${vaultName}. No vaults are configured. ${vaultCreateHint(vaultName)}`,
    );
  }
  return notFound("Vault", `${vaultName}.${available}`);
}
