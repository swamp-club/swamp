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

import { walk } from "@std/fs";
import { join, relative } from "@std/path";
import type {
  Extension,
  ExtensionOrigin,
} from "../../domain/extensions/extension.ts";
import {
  ROW_STATE_TAGS,
  type RowStateTag,
} from "../../domain/extensions/row_state.ts";
import type { Source } from "../../domain/extensions/source.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";

/** Per-extension aggregate summary. */
export interface DoctorAggregateSummary {
  readonly name: string;
  readonly version: string;
  readonly origin: ExtensionOrigin;
  readonly sourceCount: number;
  readonly stateDistribution: Readonly<Record<RowStateTag, number>>;
}

/** Per-source detail (shown in verbose mode). */
export interface DoctorSourceDetail {
  readonly sourcePath: string;
  readonly stateTag: RowStateTag;
  readonly fingerprint: string;
  readonly bundlePath: string;
  readonly kind: string;
  readonly lastError?: string;
}

/** A catalog row whose source_path doesn't exist on disk. */
export interface DoctorCatalogOrphan {
  readonly sourcePath: string;
  readonly extensionName: string;
  readonly stateTag: RowStateTag;
  readonly bundlePath: string;
}

/** A bundle file on disk not referenced by any catalog row. */
export interface DoctorBundleOrphan {
  readonly absolutePath: string;
  readonly repoRelativePath: string;
  readonly bundleDir: string;
}

/** Full aggregate-state report. */
export interface DoctorAggregateReport {
  readonly aggregates: readonly DoctorAggregateSummary[];
  readonly sourceDetails: readonly DoctorSourceDetail[];
  readonly catalogOrphans: readonly DoctorCatalogOrphan[];
  readonly bundleOrphans: readonly DoctorBundleOrphan[];
  readonly totalSources: number;
  readonly healthySources: number;
  readonly orphanRowCount: number;
  readonly orphanBundleFileCount: number;
}

const BUNDLE_DIR_NAMES: readonly string[] = [
  SWAMP_SUBDIRS.bundles,
  SWAMP_SUBDIRS.vaultBundles,
  SWAMP_SUBDIRS.driverBundles,
  SWAMP_SUBDIRS.datastoreBundles,
  SWAMP_SUBDIRS.reportBundles,
];

function toForwardSlashes(p: string): string {
  return p.replaceAll("\\", "/");
}

function emptyDistribution(): Record<RowStateTag, number> {
  const dist: Record<string, number> = {};
  for (const tag of ROW_STATE_TAGS) {
    dist[tag] = 0;
  }
  return dist as Record<RowStateTag, number>;
}

function extractBundlePath(source: Source): string {
  const s = source.state;
  switch (s.tag) {
    case "Indexed":
    case "Bundled":
    case "ValidationFailed":
    case "OrphanedBundleOnly":
      return s.bundle.canonicalPath;
    default:
      return "";
  }
}

function extractLastError(source: Source): string | undefined {
  const s = source.state;
  switch (s.tag) {
    case "BundleBuildFailed":
    case "ValidationFailed":
    case "EntryPointUnreadable":
      return s.lastError;
    default:
      return undefined;
  }
}

/**
 * Walks all bundle directories under `.swamp/` and returns every `.js`
 * file found. Missing directories are silently skipped.
 */
export async function enumerateBundleFiles(
  repoDir: string,
): Promise<DoctorBundleOrphan[]> {
  const files: DoctorBundleOrphan[] = [];
  for (const bundleDir of BUNDLE_DIR_NAMES) {
    const absoluteDir = join(repoDir, ".swamp", bundleDir);
    try {
      for await (
        const entry of walk(absoluteDir, {
          includeDirs: false,
          includeSymlinks: false,
        })
      ) {
        if (entry.name.endsWith(".js")) {
          files.push({
            absolutePath: entry.path,
            repoRelativePath: toForwardSlashes(relative(repoDir, entry.path)),
            bundleDir,
          });
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
  }
  return files;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Builds the aggregate-state report from Extension aggregates. */
export async function buildAggregateState(deps: {
  extensions: readonly Extension[];
  repoDir: string;
}): Promise<DoctorAggregateReport> {
  const aggregates: DoctorAggregateSummary[] = [];
  const sourceDetails: DoctorSourceDetail[] = [];
  const catalogOrphans: DoctorCatalogOrphan[] = [];
  let totalSources = 0;
  let healthySources = 0;

  // Collect repo-relative bundle paths from all sources. States without
  // a bundle (Tombstoned, BundleBuildFailed, EntryPointUnreadable) return
  // "" from extractBundlePath and are filtered by the if-guard below.
  // Repo-relative comparison is immune to symlink aliasing.
  const referencedBundleRelPaths = new Set<string>();

  // Collect source metadata and paths to check in a single pass,
  // then batch the fileExists calls with Promise.all.
  interface OrphanCandidate {
    sourcePath: string;
    extensionName: string;
    stateTag: RowStateTag;
    bundlePath: string;
  }
  const orphanCandidates: OrphanCandidate[] = [];

  for (const ext of deps.extensions) {
    const dist = emptyDistribution();
    let sourceCount = 0;

    for (const source of ext.sources.values()) {
      sourceCount++;
      totalSources++;
      dist[source.state.tag]++;

      if (source.state.tag === "Indexed") {
        healthySources++;
      }

      const bundlePath = extractBundlePath(source);
      if (bundlePath) {
        referencedBundleRelPaths.add(
          toForwardSlashes(relative(deps.repoDir, bundlePath)),
        );
      }

      const lastError = extractLastError(source);
      sourceDetails.push({
        sourcePath: source.id.canonicalPath,
        stateTag: source.state.tag,
        fingerprint: source.fingerprint,
        bundlePath,
        kind: source.kind,
        ...(lastError ? { lastError } : {}),
      });

      if (
        source.state.tag !== "Tombstoned" &&
        source.state.tag !== "OrphanedBundleOnly"
      ) {
        orphanCandidates.push({
          sourcePath: source.id.canonicalPath,
          extensionName: ext.name,
          stateTag: source.state.tag,
          bundlePath,
        });
      }
    }

    aggregates.push({
      name: ext.name,
      version: ext.version,
      origin: ext.origin,
      sourceCount,
      stateDistribution: dist,
    });
  }

  // Batch all fileExists checks in parallel.
  const existsResults = await Promise.all(
    orphanCandidates.map((c) => fileExists(c.sourcePath)),
  );
  for (let i = 0; i < orphanCandidates.length; i++) {
    if (!existsResults[i]) {
      catalogOrphans.push(orphanCandidates[i]);
    }
  }

  // Detect bundle orphans: files on disk not referenced by any catalog row.
  // Compare via repo-relative paths to avoid symlink aliasing.
  const allBundleFiles = await enumerateBundleFiles(deps.repoDir);
  const bundleOrphans: DoctorBundleOrphan[] = [];
  for (const bf of allBundleFiles) {
    if (!referencedBundleRelPaths.has(bf.repoRelativePath)) {
      bundleOrphans.push(bf);
    }
  }

  return {
    aggregates,
    sourceDetails,
    catalogOrphans,
    bundleOrphans,
    totalSources,
    healthySources,
    orphanRowCount: catalogOrphans.length,
    orphanBundleFileCount: bundleOrphans.length,
  };
}
