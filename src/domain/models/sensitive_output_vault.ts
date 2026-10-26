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
 * The one resolver for which vault a sensitive output field is stored in.
 * The data writer stores with it, and the pre-run fast-fail and
 * `workflow validate` predict with it, so the three cannot drift.
 *
 * @module
 */

import type { ResourceOutputSpec } from "./model.ts";
import { collectSensitiveFieldMetadata } from "./sensitive_field_extractor.ts";

/** The vault configuration the resolver falls back to. */
export interface SensitiveOutputVaultConfig {
  /** The repo's configured default vault, when it is registered. */
  getDefaultVaultName(): string | undefined;
  /** The user (non-reserved) vaults, in registration order. */
  getUserVaultNames(): string[];
}

/** Where a sensitive field's vault may be named, most specific first. */
export interface SensitiveOutputVaultChoice {
  /** The field's own `vaultName` metadata. */
  fieldVaultName?: string;
  /**
   * A data output override's `vaultName` for the field's spec (definition
   * `resources` or a workflow step's `dataOutputOverrides`). It replaces the
   * spec's own, as the data writer has always applied it; an empty name is
   * ignored (see {@link overriddenSpecVaultName}).
   */
  overrideVaultName?: string;
  /** The resource spec's `vaultName`. */
  specVaultName?: string;
}

/**
 * A spec's `vaultName` once a data output override applies: the override's
 * when it names a vault, else the spec's own. An empty override name is
 * ignored, as the data writer has always treated it.
 */
export function overriddenSpecVaultName(
  specVaultName: string | undefined,
  overrideVaultName: string | undefined,
): string | undefined {
  return overrideVaultName ? overrideVaultName : specVaultName;
}

/**
 * The vault a sensitive field is stored in: the field's `vaultName`, else the
 * override's (when not empty), else the spec's, else the default vault, else
 * the first user vault. `undefined` when none applies (no vault is
 * configured).
 */
export function resolveSensitiveOutputVault(
  choice: SensitiveOutputVaultChoice,
  vaults: SensitiveOutputVaultConfig,
): string | undefined {
  return choice.fieldVaultName ??
    overriddenSpecVaultName(choice.specVaultName, choice.overrideVaultName) ??
    vaults.getDefaultVaultName() ?? vaults.getUserVaultNames()[0];
}

/** A vault a sensitive output may be stored in, and the key when known. */
export interface SensitiveOutputTarget {
  vaultName: string;
  /**
   * The field's own `vaultKey`. Absent when the key is generated at write
   * time (from the instance name, and per element for a field inside an
   * array element or record value), so it is not known before the run.
   */
  vaultKey?: string;
}

/**
 * Every vault, and key where a field fixes one, that the sensitive outputs of
 * `resources` may be stored under, given the data output overrides in force:
 * one per field naming its own vault, wherever the field sits in the schema
 * (nested objects, array elements, record values, union members), plus the
 * spec-level target for fields that do not (and for every field of a
 * `sensitiveOutput` spec, whose fields are only known at write time). A field
 * inside an array element or record value has a key per element, so its
 * target names no key. Each vault and key pair appears once, in
 * first-seen order; a target that resolves to no vault is left out (the
 * no-vault check reports it).
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

/**
 * Whether any sensitive output of `resources` names no vault of its own (no
 * field, override or spec `vaultName`), so it is stored in the default vault,
 * or in the first user vault when no default vault is in effect.
 */
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

/**
 * The vault choice of every sensitive output of `resources`: one per
 * sensitive field, with the field's own key, plus one for a
 * `sensitiveOutput` spec, whose fields are only known at write time.
 */
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

/**
 * Every vault the sensitive outputs of `resources` may be stored in (the
 * vaults of {@link sensitiveOutputTargets}), each once, in first-seen order.
 */
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
