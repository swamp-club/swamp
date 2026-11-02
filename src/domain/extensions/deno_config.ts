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

/** listed in the order Deno picks one when a directory holds both */
export const DENO_CONFIG_FILE_NAMES = ["deno.json", "deno.jsonc"] as const;

export function parseDenoConfig(
  text: string,
): Record<string, unknown> | undefined {
  const value = parse(text);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export async function readDenoConfig(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return parseDenoConfig(await Deno.readTextFile(path));
  } catch {
    return undefined;
  }
}
