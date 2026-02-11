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

import { CalVer } from "./calver.ts";
import { Definition } from "../definitions/definition.ts";
import type { ModelDefinition } from "./model.ts";

/**
 * Result of an upgrade attempt.
 */
export interface UpgradeResult {
  /** Whether the definition was upgraded */
  upgraded: boolean;
  /** The (possibly upgraded) definition */
  definition: Definition;
  /** The original typeVersion (may be undefined for legacy definitions) */
  fromVersion: string | undefined;
  /** The target version (always the model's current version) */
  toVersion: string;
}

/**
 * Domain service that applies version upgrades to definitions.
 *
 * When a definition's `typeVersion` is behind the model's current `version`,
 * the upgrade chain runs all applicable upgrades in order, transforming
 * attributes at each step.
 */
export class DefinitionUpgradeService {
  /**
   * Upgrades a definition to the model's current version by applying
   * all applicable upgrade functions in order.
   *
   * @param definition - The definition to potentially upgrade
   * @param modelDef - The model definition with the upgrade chain
   * @returns The upgrade result
   */
  upgrade(definition: Definition, modelDef: ModelDefinition): UpgradeResult {
    const fromVersion = definition.typeVersion;
    const toVersion = modelDef.version;

    // No upgrades defined — nothing to do
    if (!modelDef.upgrades || modelDef.upgrades.length === 0) {
      return { upgraded: false, definition, fromVersion, toVersion };
    }

    // If typeVersion is defined and >= model version, no upgrade needed
    if (fromVersion !== undefined) {
      const fromCv = CalVer.create(fromVersion);
      const toCv = CalVer.create(toVersion);
      if (CalVer.compare(fromCv, toCv) >= 0) {
        return { upgraded: false, definition, fromVersion, toVersion };
      }
    }

    // Filter upgrades to those with toVersion > definition.typeVersion
    const applicableUpgrades = fromVersion === undefined
      ? modelDef.upgrades // undefined typeVersion → apply all upgrades
      : modelDef.upgrades.filter((upgrade) => {
        const upgradeCv = CalVer.create(upgrade.toVersion);
        const fromCv = CalVer.create(fromVersion);
        return CalVer.compare(upgradeCv, fromCv) > 0;
      });

    if (applicableUpgrades.length === 0) {
      return { upgraded: false, definition, fromVersion, toVersion };
    }

    // Apply upgrades in order
    let currentArgs = definition.globalArguments;
    for (const upgrade of applicableUpgrades) {
      currentArgs = upgrade.upgradeAttributes(currentArgs);
    }

    // Create a new definition with the upgraded global arguments
    const upgradedDefinition = Definition.withUpgradedGlobalArguments(
      definition,
      currentArgs,
      toVersion,
    );

    return {
      upgraded: true,
      definition: upgradedDefinition,
      fromVersion,
      toVersion,
    };
  }
}
