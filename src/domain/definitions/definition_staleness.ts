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
 * How an instance's recorded type version relates to the model type currently
 * registered from the bundle on disk.
 *
 * - `current` — the definition was authored or migrated for this model version.
 * - `upgradable` — the definition is behind, and the model's upgrade chain
 *   covers the gap, so the next method run migrates it.
 * - `stranded` — the definition is behind and no upgrade entry covers the gap.
 *   The extension bumped its version without shipping a `VersionUpgrade`, so
 *   nothing will ever migrate this instance (swamp-club#900).
 * - `unknown` — the definition records no usable type version, either because
 *   it records none at all (the signal for a legacy pre-CalVer definition; see
 *   swamp-club#2412 for what the upgrade chain should do with it) or because
 *   the recorded value will not parse as CalVer.
 */
export type StalenessState =
  | "current"
  | "upgradable"
  | "stranded"
  | "unknown";

/**
 * Value object describing the relationship between a definition and its
 * registered model type. Immutable and compared by value — two results with the
 * same fields are equivalent.
 */
export interface DefinitionStaleness {
  readonly state: StalenessState;
  /** The definition's own recorded type version, if it has one. */
  readonly definitionVersion: string | undefined;
  /** The version of the model type currently registered from the bundle. */
  readonly modelVersion: string;
}

/**
 * Whether a staleness result describes a definition that is behind its type.
 * `unknown` is deliberately excluded: a legacy definition is not evidence of
 * staleness, and treating it as such would warn on every run.
 */
export function isBehind(staleness: DefinitionStaleness): boolean {
  return staleness.state === "upgradable" || staleness.state === "stranded";
}

/**
 * Resolves how a definition's recorded type version relates to its model type.
 *
 * Takes the model's version and upgrade chain as plain parameters rather than
 * reading the model registry, so the domain module stays free of that
 * dependency and the comparison is trivially testable.
 *
 * @param definitionVersion - The definition's `typeVersion`, if recorded
 * @param modelVersion - The registered model type's current version
 * @param upgradeToVersions - `toVersion` of each entry in the model's upgrade
 *   chain, in the order the model declares them
 */
export function resolveStaleness(
  definitionVersion: string | undefined,
  modelVersion: string,
  upgradeToVersions: readonly string[] = [],
): DefinitionStaleness {
  // An unparseable version resolves to `unknown` rather than throwing. The
  // schema types this field as a plain optional string, and definitions under
  // models/ are git-committed files people hand-edit, so a malformed value is
  // reachable. `model get` is the command you reach for to diagnose exactly
  // that, and it must not fail on the definition it is meant to describe.
  if (definitionVersion === undefined || !CalVer.isValid(definitionVersion)) {
    return { state: "unknown", definitionVersion, modelVersion };
  }

  const from = CalVer.create(definitionVersion);
  const to = CalVer.create(modelVersion);
  if (CalVer.compare(from, to) >= 0) {
    return { state: "current", definitionVersion, modelVersion };
  }

  // Behind. The chain closes the gap only if some entry targets a version
  // newer than what the definition records — that is the same predicate
  // DefinitionUpgradeService uses to select applicable upgrades.
  const covered = upgradeToVersions.some(
    (candidate) => CalVer.compare(CalVer.create(candidate), from) > 0,
  );
  return {
    state: covered ? "upgradable" : "stranded",
    definitionVersion,
    modelVersion,
  };
}
