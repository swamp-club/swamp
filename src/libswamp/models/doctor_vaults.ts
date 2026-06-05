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

/**
 * A model definition whose registered type has sensitive resource output
 * fields but no vault is configured in the repository.
 */
export interface VaultRequiredFinding {
  definitionId: string;
  definitionName: string;
  type: string;
}

/**
 * A definition whose type schema could not be resolved.
 */
export interface UnresolvedVaultDefinition {
  definitionId: string;
  definitionName: string;
  type: string;
}

/** Outcome of a `doctor vaults` scan. */
export interface DoctorVaultsData {
  scanned: number;
  hasVault: boolean;
  findings: VaultRequiredFinding[];
  unresolved: UnresolvedVaultDefinition[];
}

export type DoctorVaultsEvent =
  | { kind: "scanning" }
  | { kind: "completed"; data: DoctorVaultsData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the `doctor vaults` scan. */
export interface DoctorVaultsDeps {
  findAllDefinitions: () => Promise<
    { definition: Definition; type: ModelType }[]
  >;
  getModelDef: (
    type: ModelType,
  ) => ModelDefinition | undefined | Promise<ModelDefinition | undefined>;
  hasVault: () => Promise<boolean>;
}

/**
 * Wires real infrastructure into {@link DoctorVaultsDeps}.
 */
export async function createDoctorVaultsDeps(
  repoDir: string,
): Promise<DoctorVaultsDeps> {
  await modelRegistry.ensureLoaded();
  const primaryRepo = new YamlDefinitionRepository(repoDir);
  const autoRepo = new YamlDefinitionRepository(
    repoDir,
    undefined,
    swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
    false,
  );
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
      const vs = await VaultService.fromRepository(repoDir);
      return vs.getVaultNames().length > 0;
    },
  };
}

/**
 * Read-only scan that reports model definitions with sensitive resource
 * outputs when no vault is configured. These models will fail at runtime
 * when they try to write sensitive data.
 */
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
      const all = await deps.findAllDefinitions();
      const findings: VaultRequiredFinding[] = [];
      const unresolved: UnresolvedVaultDefinition[] = [];

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
      }

      yield {
        kind: "completed",
        data: { scanned: all.length, hasVault, findings, unresolved },
      };
    })(),
  );
}
