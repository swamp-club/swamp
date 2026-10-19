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
  countLocalEncryptionSecrets,
  localEncryptionSecretsDirFor,
  localEncryptionSecretsWithin,
  removeLocalEncryptionSecrets,
} from "../../domain/vaults/local_encryption_vault_provider.ts";
import { resolveSensitiveOutputVault } from "../../domain/models/sensitive_output_vault.ts";
import {
  findVaultReferences,
  type PossibleVaultReference,
  type VaultReferences,
  type VaultReferenceSite,
} from "../../domain/expressions/vault_reference_finder.ts";
import type { Definition } from "../../domain/definitions/definition.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
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
  secretCount: number;
  /**
   * False when the directory lies outside this repository's `.swamp`: a
   * `base_dir` another checkout recorded in the config. Those secrets are
   * that checkout's, so they are kept.
   */
  removable: boolean;
}

/** What happened to a local_encryption vault's secrets. */
export interface VaultRemoveSecrets {
  directory: string;
  /** Whether the directory was removed. */
  removed: boolean;
  secretCount: number;
  /** The directory lies outside this repository, so it was kept. */
  keptOutsideRepository?: boolean;
}

/** The vault swamp stores sensitive outputs in when none is named. */
export interface EffectiveDefaultVault {
  name: string;
  /** Named by `defaultVault`; otherwise it is the first vault, by fallback. */
  configured: boolean;
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
  /** Sources that compute a vault name at run time and may use this vault. */
  possibleReferences: PossibleVaultReference[];
  timestamp: string;
  /**
   * The local secrets, handled after the config removal was published by the
   * caller of {@link vaultRemoveStoredSecrets}. Absent for a vault whose
   * secrets live with its provider.
   */
  secrets?: VaultRemoveSecrets;
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
  /** Every vault config, as read from each file. */
  listVaults: () => Promise<{ id: string; name: string }[]>;
  /**
   * The config stored at the path `config`'s type and id give, which is the
   * file a removal deletes; null when no file is there.
   */
  findStoredAt: (config: VaultConfig) => Promise<VaultConfig | null>;
  /**
   * The vault sensitive outputs go to when none is named: `defaultVault`
   * when it names a vault, else the first user vault.
   */
  getEffectiveDefaultVault: () => Promise<EffectiveDefaultVault | undefined>;
  findReferences: (vaultName: string) => Promise<VaultReferences>;
  /** The local_encryption storage of `config`; undefined for other types. */
  findLocalStorage: (
    config: VaultConfig,
  ) => Promise<VaultRemoveLocalStorage | undefined>;
  deleteConfig: (config: VaultConfig) => Promise<void>;
  removeLocalSecrets: (
    storage: VaultRemoveLocalStorage,
    vaultName: string,
  ) => Promise<VaultRemoveSecrets>;
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
  const secretsBoundary = swampPath(repoDir);

  return {
    findVault: (name) => repos.vaultConfigRepo.findByName(name),
    listVaults: async () => {
      const all = await repos.vaultConfigRepo.findAll();
      return all.map((v) => ({ id: v.id, name: v.name }));
    },
    findStoredAt: async (config) => {
      try {
        return await repos.vaultConfigRepo.findById(config.type, config.id);
      } catch {
        // A file there that does not parse is not this config.
        return null;
      }
    },
    getEffectiveDefaultVault: async () => {
      const [all, marker] = await Promise.all([
        repos.vaultConfigRepo.findAll(),
        readMarker(),
      ]);
      const userVaults = all.map((v) => v.name).filter((n) =>
        !isReservedVaultName(n)
      );
      const configured = marker?.defaultVault;
      // The same rule the data writer stores sensitive outputs by.
      const name = resolveSensitiveOutputVault({}, {
        getDefaultVaultName: () =>
          configured !== undefined && userVaults.includes(configured)
            ? configured
            : undefined,
        getUserVaultNames: () => userVaults,
      });
      return name === undefined
        ? undefined
        : { name, configured: name === configured };
    },
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
      return {
        baseDir,
        directory,
        secretCount: await countLocalEncryptionSecrets(directory),
        removable: await localEncryptionSecretsWithin(
          baseDir,
          config.name,
          secretsBoundary,
        ),
      };
    },
    deleteConfig: (config) => repos.vaultConfigRepo.delete(config),
    removeLocalSecrets: (storage, vaultName) =>
      removeLocalEncryptionSecrets(storage.baseDir, vaultName, secretsBoundary),
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

  let localStorage: VaultRemoveLocalStorage | undefined;
  try {
    localStorage = await deps.findLocalStorage(config);
  } catch (error) {
    throw validationFailed(
      `Cannot locate the stored secrets of vault '${config.name}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    vaultName: config.name,
    vaultId: config.id,
    vaultType: config.type,
    localStorage,
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
            possibleReferences: references.possibleReferences,
            timestamp: new Date().toISOString(),
          },
        };
      })(),
    ));
}

/**
 * Removes a removed vault's local secrets. Call it only once the config
 * removal of {@link vaultRemove} has committed and published. Returns
 * undefined for a vault whose secrets are not stored locally, and keeps a
 * directory outside this repository.
 */
export async function vaultRemoveStoredSecrets(
  ctx: LibSwampContext,
  deps: VaultRemoveDeps,
  preview: VaultRemovePreview,
): Promise<VaultRemoveSecrets | undefined> {
  const storage = preview.localStorage;
  if (!storage) return undefined;
  if (!storage.removable) {
    return {
      directory: storage.directory,
      removed: false,
      secretCount: storage.secretCount,
      keptOutsideRepository: true,
    };
  }
  ctx.logger.debug`Removing local secrets: ${storage.directory}`;
  return await deps.removeLocalSecrets(storage, preview.vaultName);
}

/**
 * The default vault is never removed, nor a name or id two configs share, nor
 * a config whose file is not where the removal would delete; a referenced
 * vault only with force.
 */
async function checkRemovable(
  deps: VaultRemoveDeps,
  config: VaultConfig,
  input: VaultRemoveInput,
): Promise<{ references: VaultReferences; refusal?: SwampError }> {
  const none: VaultReferences = { references: [], possibleReferences: [] };
  const vaults = await deps.listVaults();
  const sameName = vaults.filter((v) => v.name === config.name);
  if (sameName.length > 1) {
    return {
      references: none,
      refusal: validationFailed(
        `${sameName.length} vault configs are named '${config.name}' and ` +
          `share one secrets directory. Rename or delete the extra config ` +
          `with 'swamp vault edit <id>' first.`,
      ),
    };
  }

  // The removal deletes the file at vaults/<type>/<id>.yaml. A copied file
  // that kept its source's id would otherwise delete the source's config.
  const sameId = vaults.filter((v) => v.id === config.id);
  if (sameId.length > 1) {
    return {
      references: none,
      refusal: validationFailed(
        `Vault configs ${
          sameId.map((v) => `'${v.name}'`).join(", ")
        } share the id ${config.id}, so removing '${config.name}' could ` +
          `delete another vault's config. Give the copy a new id and a file ` +
          `named after it, or delete its file by hand.`,
      ),
    };
  }
  const stored = await deps.findStoredAt(config);
  if (stored?.name !== config.name) {
    return {
      references: none,
      refusal: validationFailed(
        `Vault '${config.name}' is not stored at the file its type ` +
          `(${config.type}) and id (${config.id}) name, so removing it would ` +
          `not delete its config. Move its file to match, or delete it by ` +
          `hand.`,
      ),
    };
  }

  const effectiveDefault = await deps.getEffectiveDefaultVault();
  if (effectiveDefault?.name === config.name) {
    return {
      references: none,
      refusal: validationFailed(
        effectiveDefault.configured
          ? `Vault '${config.name}' is the repository's default vault ` +
            `(defaultVault in .swamp.yaml) and cannot be removed. Set ` +
            `defaultVault in .swamp.yaml to another vault first.`
          : `Vault '${config.name}' is the repository's default vault: ` +
            `.swamp.yaml names no existing defaultVault, so sensitive ` +
            `outputs are stored in the first vault. Set defaultVault in ` +
            `.swamp.yaml to another vault first.`,
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
  const names = (await deps.listVaults()).map((v) => v.name);
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
