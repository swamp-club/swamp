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

import { join } from "@std/path";

/** Entry in upstream_extensions.json. */
export interface UpstreamExtensionEntry {
  version: string;
  pulledAt: string;
  files?: string[];
  include?: string[];
}

/** Shape of upstream_extensions.json. */
export type UpstreamExtensionsMap = Record<string, UpstreamExtensionEntry>;

/**
 * Reads upstream_extensions.json and returns the parsed map.
 */
export async function readUpstreamExtensions(
  modelsDir: string,
): Promise<UpstreamExtensionsMap> {
  const jsonPath = join(modelsDir, "upstream_extensions.json");
  try {
    const content = await Deno.readTextFile(jsonPath);
    return JSON.parse(content) as UpstreamExtensionsMap;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }
    throw error;
  }
}
