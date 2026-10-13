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
 * The CLI spelling a command was reached through: the legacy `swamp model …`
 * tree or the preferred `swamp behavior …` tree (swamp-club#3331). Behavior
 * is the product term for a model (design/primitives/behaviors.md); the two
 * trees run the same application code, and only the words a person reads in
 * log-mode output differ. JSON output, error messages, error codes and log
 * categories never depend on the surface.
 */
export type CommandSurface = "model" | "behavior";

/** The surface a renderer uses when none is given: the legacy wording. */
export const DEFAULT_COMMAND_SURFACE: CommandSurface = "model";

/** The noun for one instance on `surface`: `model` or `behavior`. */
export function surfaceNoun(surface: CommandSurface): string {
  return surface;
}

/** The plural noun on `surface`: `models` or `behaviors`. */
export function surfaceNounPlural(surface: CommandSurface): string {
  return `${surface}s`;
}

/** The noun capitalised for a label: `Model` or `Behavior`. */
export function surfaceNounCapitalized(surface: CommandSurface): string {
  return surface === "model" ? "Model" : "Behavior";
}

/**
 * The words for a method on `surface`. The glossary renames "model method"
 * to plain "method", so the behavior surface drops the noun.
 */
export function surfaceMethodNoun(surface: CommandSurface): string {
  return surface === "model" ? "model method" : "method";
}
