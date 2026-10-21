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

import { parse } from "@std/jsonc";

/**
 * The names of a Deno project config, in the order Deno picks one when a
 * directory holds both (swamp-club#3612).
 */
export const DENO_CONFIG_FILE_NAMES = ["deno.json", "deno.jsonc"] as const;

/**
 * A Deno project config read as Deno reads it — JSON with comments and
 * trailing commas — or undefined when it is not an object.
 */
export function parseDenoConfig(
  text: string,
): Record<string, unknown> | undefined {
  const value = parse(text);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * The config at `path`, or undefined when it cannot be read or parsed, or
 * is not an object.
 */
export async function readDenoConfig(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return parseDenoConfig(await Deno.readTextFile(path));
  } catch {
    return undefined;
  }
}
