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
import { join, normalize, relative } from "@std/path";
import { canonicalizePath } from "../../infrastructure/persistence/canonicalize_path.ts";
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
import { BUNDLE_STAGING_PREFIX } from "../../domain/extensions/install_journal.ts";

/**
 * only the segments below kindDir count, so a repo whose own ancestors match
 * the staging prefix still has its bundles enumerated
 */
function isInStagingDir(kindDir: string, path: string): boolean {
  return relative(kindDir, path).split(/[\\/]/).some((segment) =>
    segment.startsWith(BUNDLE_STAGING_PREFIX)
  );
}

export interface DoctorAggregateSummary {
  readonly name: string;
  readonly version: string;
  readonly origin: ExtensionOrigin;
  readonly sourceCount: number;
  readonly stateDistribution: Readonly<Record<RowStateTag, number>>;
}

export interface DoctorSourceDetail {
  readonly sourcePath: string;
  readonly stateTag: RowStateTag;
  readonly fingerprint: string;
  readonly bundlePath: string;
  readonly kind: string;
  readonly lastError?: string;
}

export interface DoctorCatalogOrphan {
  readonly sourcePath: string;
  readonly extensionName: string;
  readonly stateTag: RowStateTag;
  readonly bundlePath: string;
}

export interface DoctorBundleOrphan {
  readonly absolutePath: string;
  readonly repoRelativePath: string;
  readonly bundleDir: string;
}

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
  SWAMP_SUBDIRS.datastoreBundles,
  SWAMP_SUBDIRS.reportBundles,
  SWAMP_SUBDIRS.webhookBundles,
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
 * install staging dirs are skipped: their bundles are not installed yet, and
 * --repair must never delete them from under an install or its crash recovery
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
        if (isInStagingDir(absoluteDir, entry.path)) continue;
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

/**
 * catalog keys case-fold and slash-normalize on Windows, so recover the
 * filesystem spelling there when the file exists; other platforms keep the
 * input to avoid resolving symlink aliases
 */
async function toDisplayPath(path: string): Promise<string> {
  if (Deno.build.os !== "windows") return path;
  try {
    const real = await Deno.realPath(path);
    if (canonicalizePath(real) !== canonicalizePath(path)) {
      return normalize(path);
    }
    return real;
  } catch {
    return normalize(path);
  }
}

export async function buildAggregateState(deps: {
  extensions: readonly Extension[];
  repoDir: string;
}): Promise<DoctorAggregateReport> {
  const aggregates: DoctorAggregateSummary[] = [];
  const sourceDetails: DoctorSourceDetail[] = [];
  const catalogOrphans: DoctorCatalogOrphan[] = [];
  const displayPaths = new Set<string>();
  let totalSources = 0;
  let healthySources = 0;

  // states without a bundle return an empty string from extractBundlePath and
  // are filtered by the guard below; repo-relative comparison is immune to
  // symlink aliasing
  const referencedBundleRelPaths = new Set<string>();

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
      displayPaths.add(source.id.canonicalPath);
      if (bundlePath) displayPaths.add(bundlePath);
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

  const nativePaths = new Map(
    await Promise.all(
      [...displayPaths].map(async (path) =>
        [path, await toDisplayPath(path)] as const
      ),
    ),
  );

  const existsResults = await Promise.all(
    orphanCandidates.map((c) => fileExists(c.sourcePath)),
  );
  for (let i = 0; i < orphanCandidates.length; i++) {
    if (!existsResults[i]) {
      const orphan = orphanCandidates[i];
      catalogOrphans.push({
        ...orphan,
        sourcePath: nativePaths.get(orphan.sourcePath) ?? orphan.sourcePath,
        bundlePath: orphan.bundlePath
          ? (nativePaths.get(orphan.bundlePath) ?? orphan.bundlePath)
          : "",
      });
    }
  }

  const allBundleFiles = await enumerateBundleFiles(deps.repoDir);
  const bundleOrphans: DoctorBundleOrphan[] = [];
  for (const bf of allBundleFiles) {
    if (!referencedBundleRelPaths.has(bf.repoRelativePath)) {
      bundleOrphans.push(bf);
    }
  }

  return {
    aggregates,
    sourceDetails: sourceDetails.map((detail) => ({
      ...detail,
      sourcePath: nativePaths.get(detail.sourcePath) ?? detail.sourcePath,
      bundlePath: detail.bundlePath
        ? (nativePaths.get(detail.bundlePath) ?? detail.bundlePath)
        : "",
    })),
    catalogOrphans,
    bundleOrphans,
    totalSources,
    healthySources,
    orphanRowCount: catalogOrphans.length,
    orphanBundleFileCount: bundleOrphans.length,
  };
}
