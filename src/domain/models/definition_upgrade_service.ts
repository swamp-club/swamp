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

export const MALFORMED_TYPE_VERSION_CODE = "malformed_type_version";

export interface UpgradeResult {
  upgraded: boolean;
  definition: Definition;
  fromVersion: string | undefined;
  toVersion: string;
}

/**
 * a definition with no typeVersion is skipped, since absence cannot tell
 * arguments needing the chain from ones already current and rerunning it
 * corrupts them; an unparseable one raises UserError
 */
export class DefinitionUpgradeService {
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

    if (!modelDef.upgrades || modelDef.upgrades.length === 0) {
      return { upgraded: false, definition, fromVersion, toVersion };
    }

    if (fromVersion === undefined) {
      return { upgraded: false, definition, fromVersion, toVersion };
    }

    const fromCv = CalVer.create(fromVersion);
    if (CalVer.compare(fromCv, CalVer.create(toVersion)) >= 0) {
      return { upgraded: false, definition, fromVersion, toVersion };
    }

    const applicableUpgrades = modelDef.upgrades.filter((upgrade) =>
      CalVer.compare(CalVer.create(upgrade.toVersion), fromCv) > 0
    );

    if (applicableUpgrades.length === 0) {
      return { upgraded: false, definition, fromVersion, toVersion };
    }

    let currentArgs = definition.globalArguments;
    for (const upgrade of applicableUpgrades) {
      currentArgs = upgrade.upgradeAttributes(currentArgs);
    }

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
