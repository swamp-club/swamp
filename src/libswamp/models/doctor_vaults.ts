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

import type { ModelDefinition } from "../../domain/models/model.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { modelRequiresVault } from "../../domain/models/data_writer.ts";
import { reliesOnVaultFallback } from "../../domain/models/sensitive_output_vault.ts";
import { mergeDataOutputOverrides } from "../../domain/workflows/execution_service.ts";
import type { Definition } from "../../domain/definitions/definition.ts";

import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface VaultRequiredFinding {
  definitionId: string;
  definitionName: string;
  type: string;
}

export interface UnresolvedVaultDefinition {
  definitionId: string;
  definitionName: string;
  type: string;
}

/**
 * several user vaults and no default in effect: sensitive outputs naming no
 * vault go to the first user vault (by vault type, then id); advisory, does not
 * fail the scan
 */
export interface VaultFallbackWarning {
  fallbackVault: string;
  userVaults: string[];
  unregisteredDefaultVault?: string;
  definitions: VaultRequiredFinding[];
}

export interface DoctorVaultsData {
  scanned: number;
  hasVault: boolean;
  findings: VaultRequiredFinding[];
  unresolved: UnresolvedVaultDefinition[];
  fallbackWarning?: VaultFallbackWarning;
}

export interface DoctorVaultsVaultState {
  userVaultNames: string[];
  defaultVaultName?: string;
  configuredDefaultVault?: string;
}

export type DoctorVaultsEvent =
  | { kind: "scanning" }
  | { kind: "completed"; data: DoctorVaultsData }
  | { kind: "error"; error: SwampError };

export interface DoctorVaultsDeps {
  findAllDefinitions: () => Promise<
    { definition: Definition; type: ModelType }[]
  >;
  getModelDef: (
    type: ModelType,
  ) => ModelDefinition | undefined | Promise<ModelDefinition | undefined>;
  hasVault: () => Promise<boolean>;
  vaultState?: () => Promise<DoctorVaultsVaultState>;
}

export async function createDoctorVaultsDeps(
  repoDir: string,
  options?: { vaultsDir?: string; defaultVaultName?: string },
): Promise<DoctorVaultsDeps> {
  await modelRegistry.ensureLoaded();
  const primaryRepo = new YamlDefinitionRepository(repoDir);
  const autoRepo = new YamlDefinitionRepository(
    repoDir,
    undefined,
    swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
    false,
  );
  let vaultService: Promise<VaultService> | undefined;
  const loadVaults = () =>
    vaultService ??= VaultService.fromRepository(repoDir, {
      vaultsDir: options?.vaultsDir,
      defaultVaultName: options?.defaultVaultName,
    });
  return {
    findAllDefinitions: async () => {
      const [primary, auto] = await Promise.all([
        primaryRepo.findAllGlobal(),
        autoRepo.findAllGlobal(),
      ]);
      return [...primary, ...auto];
    },
    getModelDef: async (type) => {
      await modelRegistry.ensureTypeLoaded(type);
      return modelRegistry.get(type);
    },
    hasVault: async () => {
      const vs = await loadVaults();
      // Reserved vaults (serve's _token-secrets) never hold user data.
      return vs.getUserVaultNames().length > 0;
    },
    vaultState: async () => {
      const vs = await loadVaults();
      return {
        userVaultNames: vs.getUserVaultNames(),
        defaultVaultName: vs.getDefaultVaultName(),
        configuredDefaultVault: options?.defaultVaultName,
      };
    },
  };
}

export async function* doctorVaults(
  _ctx: LibSwampContext,
  deps: DoctorVaultsDeps,
): AsyncGenerator<DoctorVaultsEvent> {
  yield* withGeneratorSpan(
    "swamp.doctor.vaults",
    {},
    (async function* () {
      yield { kind: "scanning" };

      const hasVault = await deps.hasVault();
      const vaultState = await deps.vaultState?.();
      const all = await deps.findAllDefinitions();
      const findings: VaultRequiredFinding[] = [];
      const unresolved: UnresolvedVaultDefinition[] = [];
      const usesFallback: VaultRequiredFinding[] = [];

      for (const { definition, type } of all) {
        const modelDef = await deps.getModelDef(type);
        if (!modelDef) {
          unresolved.push({
            definitionId: definition.id,
            definitionName: definition.name,
            type: type.normalized,
          });
          continue;
        }

        if (modelRequiresVault(modelDef.resources) && !hasVault) {
          findings.push({
            definitionId: definition.id,
            definitionName: definition.name,
            type: type.normalized,
          });
        }

        if (
          reliesOnVaultFallback(
            modelDef.resources,
            mergeDataOutputOverrides(definition.resources, undefined),
          )
        ) {
          usesFallback.push({
            definitionId: definition.id,
            definitionName: definition.name,
            type: type.normalized,
          });
        }
      }

      const fallbackWarning = vaultFallbackWarning(vaultState, usesFallback);
      yield {
        kind: "completed",
        data: {
          scanned: all.length,
          hasVault,
          findings,
          unresolved,
          ...(fallbackWarning ? { fallbackWarning } : {}),
        },
      };
    })(),
  );
}

function vaultFallbackWarning(
  state: DoctorVaultsVaultState | undefined,
  definitions: VaultRequiredFinding[],
): VaultFallbackWarning | undefined {
  if (
    !state || state.defaultVaultName !== undefined ||
    state.userVaultNames.length < 2 || definitions.length === 0
  ) {
    return undefined;
  }
  return {
    fallbackVault: state.userVaultNames[0],
    userVaults: state.userVaultNames,
    // An empty defaultVault is no setting at all, not a missing vault.
    ...(state.configuredDefaultVault
      ? { unregisteredDefaultVault: state.configuredDefaultVault }
      : {}),
    definitions,
  };
}
