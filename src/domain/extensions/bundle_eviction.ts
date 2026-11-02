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

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["swamp", "extensions", "bundle-eviction"]);

export interface RemovedCatalogRow {
  readonly source_path: string;
  readonly bundle_path?: string;
}

export interface BundleReferenceLookup {
  hasRowWithBundlePath(bundlePath: string): boolean;
}

/**
 * a bundle is kept when the row's source still exists (via realPath, so
 * repo-root spellings match) or a remaining row references it. Best-effort;
 * call only after the removing transaction commits.
 */
export function evictRemovedBundles(
  removed: readonly RemovedCatalogRow[],
  catalog: BundleReferenceLookup,
): void {
  const seen = new Set<string>();
  for (const row of removed) {
    const bundlePath = row.bundle_path;
    if (!bundlePath || seen.has(bundlePath)) continue;
    seen.add(bundlePath);
    if (!sourceIsGone(row.source_path)) continue;
    if (catalog.hasRowWithBundlePath(bundlePath)) continue;
    try {
      Deno.removeSync(bundlePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        logger.warn`Could not remove stale bundle ${bundlePath}: ${error}`;
      }
    }
  }
}

function sourceIsGone(sourcePath: string): boolean {
  try {
    Deno.realPathSync(sourcePath);
    return false;
  } catch (error) {
    return error instanceof Deno.errors.NotFound;
  }
}
