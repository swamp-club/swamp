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

import { CalVer } from "./calver.ts";
import { Definition } from "../definitions/definition.ts";
import { UserError } from "../errors.ts";
import type { ModelDefinition } from "./model.ts";

/** Error code raised when a definition records an unparseable `typeVersion`. */
export const MALFORMED_TYPE_VERSION_CODE = "malformed_type_version";

/**
 * Result of an upgrade attempt.
 */
export interface UpgradeResult {
  /** Whether the definition was upgraded */
  upgraded: boolean;
  /** The (possibly upgraded) definition */
  definition: Definition;
  /** The original typeVersion (undefined when the definition records none) */
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
 *
 * A definition that records no `typeVersion` is left alone. Absence is not a
 * version — it says nobody stated which version the arguments were authored
 * for, and it cannot distinguish arguments that need the whole chain from
 * arguments already in the current shape. Running the chain over the latter
 * transforms them a second time and corrupts them, so the safe reading is to
 * skip. Callers surface the skip instead: a method run warns when the type
 * declares an upgrade chain, and the remedy is to record the version the
 * arguments were actually authored for (swamp-club#2412).
 *
 * A `typeVersion` that is present but unparseable is a different failure and
 * raises `UserError`. Someone stated an intent and got the format wrong;
 * silently ignoring what they wrote is the same defect as silently corrupting.
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

    // Refuse a malformed version before anything else, so the definition is
    // rejected whether or not its type happens to declare an upgrade chain.
    if (fromVersion !== undefined && !CalVer.isValid(fromVersion)) {
      throw new UserError(
        `Definition '${definition.name}' records typeVersion "${fromVersion}", ` +
          `which is not a valid CalVer version. Expected format ` +
          `YYYY.MM.DD.MICRO (e.g. "${toVersion}"). Correct it to the version ` +
          `the definition's global arguments were authored for, or remove it.`,
        MALFORMED_TYPE_VERSION_CODE,
      );
    }

    // No upgrades defined — nothing to do
    if (!modelDef.upgrades || modelDef.upgrades.length === 0) {
      return { upgraded: false, definition, fromVersion, toVersion };
    }

    // No recorded version — never guess. See the class comment.
    if (fromVersion === undefined) {
      return { upgraded: false, definition, fromVersion, toVersion };
    }

    // If typeVersion is >= model version, no upgrade needed
    const fromCv = CalVer.create(fromVersion);
    if (CalVer.compare(fromCv, CalVer.create(toVersion)) >= 0) {
      return { upgraded: false, definition, fromVersion, toVersion };
    }

    // Filter upgrades to those with toVersion > definition.typeVersion
    const applicableUpgrades = modelDef.upgrades.filter((upgrade) =>
      CalVer.compare(CalVer.create(upgrade.toVersion), fromCv) > 0
    );

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
