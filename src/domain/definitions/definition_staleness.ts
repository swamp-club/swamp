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

import { CalVer } from "../models/calver.ts";

/**
 * stranded: behind with no covering upgrade, so nothing migrates it; unknown:
 * no version recorded, the chain does not run; invalid: unparseable CalVer, so
 * a method run fails
 */
export type StalenessState =
  | "current"
  | "upgradable"
  | "stranded"
  | "unknown"
  | "invalid";

export interface DefinitionStaleness {
  readonly state: StalenessState;
  readonly definitionVersion: string | undefined;
  readonly modelVersion: string;
}

/**
 * unknown and invalid are excluded: neither is evidence the arguments are
 * stale; unknown warns only when an upgrade chain exists, invalid fails the run
 */
export function isBehind(staleness: DefinitionStaleness): boolean {
  return staleness.state === "upgradable" || staleness.state === "stranded";
}

/**
 * takes the model's version and upgrade chain as parameters so the domain
 * module stays free of the model registry
 */
export function resolveStaleness(
  definitionVersion: string | undefined,
  modelVersion: string,
  upgradeToVersions: readonly string[] = [],
): DefinitionStaleness {
  // absence and malformation get separate states and neither throws: model get
  // must not fail on the hand-edited definition it describes; refusing a
  // malformed value is DefinitionUpgradeService's job
  if (definitionVersion === undefined) {
    return { state: "unknown", definitionVersion, modelVersion };
  }
  if (!CalVer.isValid(definitionVersion)) {
    return { state: "invalid", definitionVersion, modelVersion };
  }

  const from = CalVer.create(definitionVersion);
  const to = CalVer.create(modelVersion);
  if (CalVer.compare(from, to) >= 0) {
    return { state: "current", definitionVersion, modelVersion };
  }

  // the chain closes the gap only if some entry targets a version newer than
  // the definition records, the same predicate DefinitionUpgradeService uses
  const covered = upgradeToVersions.some(
    (candidate) => CalVer.compare(CalVer.create(candidate), from) > 0,
  );
  return {
    state: covered ? "upgradable" : "stranded",
    definitionVersion,
    modelVersion,
  };
}
