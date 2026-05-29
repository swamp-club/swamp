// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * A definition holding one or more sensitive global arguments as cleartext
 * literals. The remediation guidance is value-free — it never echoes the
 * offending secret, only the field path and the vault coordinates to migrate
 * the value to.
 */
export interface SensitiveLeakFinding {
  definitionId: string;
  definitionName: string;
  type: string;
  /** Dot-paths of the sensitive global args holding a literal secret. */
  leakedPaths: string[];
  /** Per-path remediation guidance. */
  remediations: SensitiveArgRemediation[];
}

/**
 * A definition whose type schema could not be resolved, so its sensitive
 * global args could not be assessed. Reported (not silently skipped) because it
 * is a best-effort residual: a missing/unloadable extension type means the scan
 * cannot vouch for that definition.
 */
export interface UnresolvedDefinition {
  definitionId: string;
  definitionName: string;
  type: string;
}

/** Outcome of a `doctor secrets` scan. */
export interface DoctorSecretsData {
  /** Total definitions inspected (across models/ and auto-definitions). */
  scanned: number;
  findings: SensitiveLeakFinding[];
  unresolved: UnresolvedDefinition[];
}

export type DoctorSecretsEvent =
  | { kind: "scanning" }
  | { kind: "completed"; data: DoctorSecretsData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the `doctor secrets` scan. */
export interface DoctorSecretsDeps {
  /** Enumerates every definition to scan, paired with its model type. */
  findAllDefinitions: () => Promise<
    { definition: Definition; type: ModelType }[]
  >;
  /** Resolves the model definition (and thus the schema) for a type. */
  getModelDef: (
    type: ModelType,
  ) => ModelDefinition | undefined | Promise<ModelDefinition | undefined>;
}

/**
 * Wires real infrastructure into {@link DoctorSecretsDeps}.
 *
 * Scans two trees: the source-of-truth definitions under `models/` (these are
 * the datastore-synced files — a literal authored on another machine lands here
 * after a pull) and the locally auto-created definitions under
 * `.swamp/auto-definitions`. The public `findAllGlobal()` only walks its own
 * `baseDir`, so a second repository is pointed at the auto-definitions tree to
 * cover both without changing shared enumeration behaviour.
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
 * Read-only scan that reports definitions whose `sensitive: true` global
 * arguments hold a cleartext literal value. It reuses the same domain rule
 * (`findLiteralSensitiveGlobalArgs`) that the persistence chokepoint enforces
 * at write time, so what this surfaces is exactly what a re-save would now
 * refuse. It never writes — reporting only, with value-free remediation
 * guidance the caller can render.
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
