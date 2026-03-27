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

import { SWAMP_DATA_DIR } from "../../infrastructure/persistence/paths.ts";
import { readUpstreamExtensions } from "../../infrastructure/persistence/upstream_extensions.ts";
import { UserError } from "../../domain/errors.ts";

/**
 * Detects whether a repository has pulled extensions in the legacy layout
 * (files in extensions/{type}/ instead of .swamp/pulled-extensions/{type}/).
 *
 * Checks the upstream_extensions.json lockfile for file paths that don't
 * start with the .swamp/ prefix, indicating the old layout.
 *
 * @param lockfilePath Full path to upstream_extensions.json
 * @returns List of legacy file paths, or empty array if layout is current
 */
export async function detectLegacyExtensionLayout(
  lockfilePath: string,
): Promise<string[]> {
  const upstream = await readUpstreamExtensions(lockfilePath);
  const legacyFiles: string[] = [];

  for (const [_name, entry] of Object.entries(upstream)) {
    if (!entry.files) continue;
    for (const file of entry.files) {
      // Files in the new layout start with .swamp/
      // Bundle files already live in .swamp/ and are fine
      if (!file.startsWith(`${SWAMP_DATA_DIR}/`)) {
        legacyFiles.push(file);
      }
    }
  }

  return legacyFiles;
}

/**
 * Checks for legacy extension layout and throws a UserError if detected.
 * Call this at the start of extension commands to prevent operations on
 * repos that haven't been migrated.
 *
 * @param lockfilePath Full path to upstream_extensions.json
 */
export async function requireCurrentExtensionLayout(
  lockfilePath: string,
): Promise<void> {
  const legacyFiles = await detectLegacyExtensionLayout(lockfilePath);
  if (legacyFiles.length > 0) {
    throw new UserError(
      `This repo has pulled extensions in the old layout (extensions/).\n` +
        `Run 'swamp repo upgrade' to migrate them to .swamp/pulled-extensions/.`,
    );
  }
}
