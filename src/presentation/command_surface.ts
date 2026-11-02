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
 * the CLI tree a command ran in; both run the same code and differ only in
 * wording. JSON field names, error codes and log categories never depend on the
 * surface.
 */
export type CommandSurface = "model" | "behavior";

export const DEFAULT_COMMAND_SURFACE: CommandSurface = "model";

export function surfaceNoun(surface: CommandSurface): string {
  return surface;
}

export function surfaceNounPlural(surface: CommandSurface): string {
  return `${surface}s`;
}

export function surfaceNounCapitalized(surface: CommandSurface): string {
  return surface === "model" ? "Model" : "Behavior";
}

export function surfaceMethodNoun(surface: CommandSurface): string {
  return surface === "model" ? "model method" : "method";
}
