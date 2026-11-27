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

import type { SwampSource } from "../../domain/repo/swamp_sources.ts";
import { expandSourcePaths } from "../../infrastructure/persistence/swamp_sources_repository.ts";
import { hasAppDescriptors } from "../../infrastructure/persistence/filesystem_app_catalog.ts";

/**
 * apps are not an extension kind and the catalog ignores `only`, so a source
 * holding one contributes something whatever kinds it resolves to
 */
export async function resolveSourceHasApps(
  source: SwampSource,
  baseDir: string,
  legacyBaseDir?: string,
): Promise<boolean> {
  const expanded = await expandSourcePaths(
    { sources: [source] },
    baseDir,
    baseDir,
    legacyBaseDir,
  );
  for (const entry of expanded) {
    if (await hasAppDescriptors(entry.path)) return true;
  }
  return false;
}
