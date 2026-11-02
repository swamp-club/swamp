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
 * the one resolver for which vault a sensitive output field is stored in; the
 * data writer, the pre-run fast-fail and workflow validate all use it so they
 * cannot drift
 */

import type { ResourceOutputSpec } from "./model.ts";
import { collectSensitiveFieldMetadata } from "./sensitive_field_extractor.ts";

export interface SensitiveOutputVaultConfig {
  getDefaultVaultName(): string | undefined;
  getUserVaultNames(): string[];
}

export interface SensitiveOutputVaultChoice {
  fieldVaultName?: string;
  /**
   * an override replaces the spec's own vaultName, as the data writer applies
   * it; an empty name is ignored
   */
  overrideVaultName?: string;
  specVaultName?: string;
}

export function overriddenSpecVaultName(
  specVaultName: string | undefined,
  overrideVaultName: string | undefined,
): string | undefined {
  return overrideVaultName ? overrideVaultName : specVaultName;
}

export function resolveSensitiveOutputVault(
  choice: SensitiveOutputVaultChoice,
  vaults: SensitiveOutputVaultConfig,
): string | undefined {
  return choice.fieldVaultName ??
    overriddenSpecVaultName(choice.specVaultName, choice.overrideVaultName) ??
    vaults.getDefaultVaultName() ?? vaults.getUserVaultNames()[0];
}

export interface SensitiveOutputTarget {
  vaultName: string;
  /**
   * absent when the key is generated at write time (per instance, and per
   * element inside arrays or records), so it is not known before the run
   */
  vaultKey?: string;
}

/**
 * every vault, and key where a field fixes one, a sensitive output may use,
 * deduplicated in first-seen order. Per-element fields name no key; targets
 * resolving to no vault are left to the no-vault check.
 */
export function sensitiveOutputTargets(
  resources: Record<string, ResourceOutputSpec> | undefined,
  dataOutputOverrides:
    | ReadonlyArray<{ specName: string; vaultName?: string }>
    | undefined,
  vaults: SensitiveOutputVaultConfig,
): SensitiveOutputTarget[] {
  const targets = new Map<string, SensitiveOutputTarget>();
  for (
    const { choice, key } of sensitiveOutputChoices(
      resources,
      dataOutputOverrides,
    )
  ) {
    const vaultName = resolveSensitiveOutputVault(choice, vaults);
    if (vaultName === undefined) continue;
    const id = `${vaultName}\0${key === undefined ? "\0" : key}`;
    if (!targets.has(id)) {
      targets.set(
        id,
        key === undefined ? { vaultName } : { vaultName, vaultKey: key },
      );
    }
  }
  return [...targets.values()];
}

export function reliesOnVaultFallback(
  resources: Record<string, ResourceOutputSpec> | undefined,
  dataOutputOverrides:
    | ReadonlyArray<{ specName: string; vaultName?: string }>
    | undefined,
): boolean {
  const noVaults: SensitiveOutputVaultConfig = {
    getDefaultVaultName: () => undefined,
    getUserVaultNames: () => [],
  };
  return sensitiveOutputChoices(resources, dataOutputOverrides).some(
    ({ choice }) => resolveSensitiveOutputVault(choice, noVaults) === undefined,
  );
}

function sensitiveOutputChoices(
  resources: Record<string, ResourceOutputSpec> | undefined,
  dataOutputOverrides:
    | ReadonlyArray<{ specName: string; vaultName?: string }>
    | undefined,
): { choice: SensitiveOutputVaultChoice; key?: string }[] {
  const choices: { choice: SensitiveOutputVaultChoice; key?: string }[] = [];
  for (const [specName, spec] of Object.entries(resources ?? {})) {
    const fields = collectSensitiveFieldMetadata(spec.schema);
    if (!spec.sensitiveOutput && fields.length === 0) continue;
    const overrideVaultName = dataOutputOverrides?.find((o) =>
      o.specName === specName
    )?.vaultName;
    for (const field of fields) {
      choices.push({
        choice: {
          fieldVaultName: field.vaultName,
          overrideVaultName,
          specVaultName: spec.vaultName,
        },
        // A field inside an array element or record value is stored under a
        // key per element, which is only known at write time.
        key: field.perElement ? undefined : field.vaultKey,
      });
    }
    if (spec.sensitiveOutput) {
      choices.push({
        choice: { overrideVaultName, specVaultName: spec.vaultName },
      });
    }
  }
  return choices;
}

export function sensitiveOutputTargetVaults(
  resources: Record<string, ResourceOutputSpec> | undefined,
  dataOutputOverrides:
    | ReadonlyArray<{ specName: string; vaultName?: string }>
    | undefined,
  vaults: SensitiveOutputVaultConfig,
): string[] {
  return [
    ...new Set(
      sensitiveOutputTargets(resources, dataOutputOverrides, vaults).map((t) =>
        t.vaultName
      ),
    ),
  ];
}
