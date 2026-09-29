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

/** The parts of a removed catalog row that bundle eviction needs. */
export interface RemovedCatalogRow {
  readonly source_path: string;
  readonly bundle_path?: string;
}

/** The catalog query bundle eviction needs. */
export interface BundleReferenceLookup {
  hasRowWithBundlePath(bundlePath: string): boolean;
}

/**
 * Deletes the bundle files of catalog rows that were just removed, so
 * doctor does not report them as orphans (swamp-club#2490).
 *
 * A bundle is kept when the row's source still exists — checked through
 * `realPath`, so the same file reached through another spelling of the
 * repo root (`/tmp` vs `/private/tmp`, swamp-club#2570) counts as
 * existing, and its bundle may be the one a live row uses — or when any
 * remaining row references the same bundle path. Best-effort: a failed
 * delete is logged, never thrown.
 *
 * Call only after the transaction that removed the rows has committed,
 * so a rollback never costs a bundle.
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
