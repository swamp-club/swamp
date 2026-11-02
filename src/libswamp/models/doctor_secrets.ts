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

import type { Definition } from "../../domain/definitions/definition.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  buildSensitiveArgRemediations,
  findLiteralSensitiveGlobalArgs,
  type SensitiveArgRemediation,
} from "../../domain/models/sensitive_field_extractor.ts";

export type { SensitiveArgRemediation };
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/**
 * remediation guidance is value-free: it never echoes the secret, only the
 * field path and the vault coordinates
 */
export interface SensitiveLeakFinding {
  definitionId: string;
  definitionName: string;
  type: string;
  leakedPaths: string[];
  remediations: SensitiveArgRemediation[];
}

/**
 * reported, not skipped: with no resolvable type schema the scan cannot vouch
 * for the definition
 */
export interface UnresolvedDefinition {
  definitionId: string;
  definitionName: string;
  type: string;
}

export interface DoctorSecretsData {
  scanned: number;
  findings: SensitiveLeakFinding[];
  unresolved: UnresolvedDefinition[];
}

export type DoctorSecretsEvent =
  | { kind: "scanning" }
  | { kind: "completed"; data: DoctorSecretsData }
  | { kind: "error"; error: SwampError };

export interface DoctorSecretsDeps {
  findAllDefinitions: () => Promise<
    { definition: Definition; type: ModelType }[]
  >;
  getModelDef: (
    type: ModelType,
  ) => ModelDefinition | undefined | Promise<ModelDefinition | undefined>;
}

/**
 * scans models/ (datastore-synced) and .swamp/auto-definitions; findAllGlobal
 * only walks its own baseDir, so a second repository covers the
 * auto-definitions tree
 */
export async function createDoctorSecretsDeps(
  repoDir: string,
): Promise<DoctorSecretsDeps> {
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
  };
}

/**
 * read-only; reuses the rule the persistence chokepoint enforces at write time,
 * so findings are what a re-save would refuse
 */
export async function* doctorSecrets(
  _ctx: LibSwampContext,
  deps: DoctorSecretsDeps,
): AsyncGenerator<DoctorSecretsEvent> {
  yield* withGeneratorSpan(
    "swamp.doctor.secrets",
    {},
    (async function* () {
      yield { kind: "scanning" };

      const all = await deps.findAllDefinitions();
      const findings: SensitiveLeakFinding[] = [];
      const unresolved: UnresolvedDefinition[] = [];

      for (const { definition, type } of all) {
        const modelDef = await deps.getModelDef(type);
        if (!modelDef) {
          // Best-effort residual: without the type schema we cannot know which
          // global args are sensitive, so flag it rather than skip silently.
          unresolved.push({
            definitionId: definition.id,
            definitionName: definition.name,
            type: type.normalized,
          });
          continue;
        }

        const leakedPaths = findLiteralSensitiveGlobalArgs(
          modelDef.globalArguments,
          definition.globalArguments,
        );
        if (leakedPaths.length > 0) {
          findings.push({
            definitionId: definition.id,
            definitionName: definition.name,
            type: type.normalized,
            leakedPaths,
            remediations: buildSensitiveArgRemediations(
              leakedPaths,
              modelDef.globalArguments,
              definition.globalArguments,
            ),
          });
        }
      }

      yield {
        kind: "completed",
        data: { scanned: all.length, findings, unresolved },
      };
    })(),
  );
}
