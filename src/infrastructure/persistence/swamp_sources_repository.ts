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

import { isAbsolute, resolve } from "@std/path";
import { expandGlob } from "@std/fs";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { expandEnvVars } from "./env_path.ts";
import { swampSourcesPath } from "./paths.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import {
  EXTENSION_KINDS,
  type ExtensionKind,
  isGlobPattern,
  parseSwampSources,
  type ResolvedSourceDirs,
  type SwampSource,
  type SwampSourcesConfig,
} from "../../domain/repo/swamp_sources.ts";
import type { RepoMarkerData } from "./repo_marker_repository.ts";

const logger = getLogger(["swamp", "sources"]);

/**
 * Reads and parses `.swamp-sources.yaml` from the repository root.
 *
 * @returns The parsed config, or null if the file does not exist.
 * @throws UserError if the file exists but is invalid.
 */
export async function readSwampSources(
  repoDir: string,
): Promise<SwampSourcesConfig | null> {
  const sourcesPath = swampSourcesPath(repoDir);
  try {
    const content = await Deno.readTextFile(sourcesPath);
    return parseSwampSources(content);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

/**
 * Writes a sources config to `.swamp-sources.yaml`.
 */
export async function writeSwampSources(
  repoDir: string,
  config: SwampSourcesConfig,
): Promise<void> {
  const sourcesPath = swampSourcesPath(repoDir);
  const content = stringifyYaml(
    config as unknown as Record<string, unknown>,
  );
  await atomicWriteTextFile(sourcesPath, content);
}

/**
 * Removes the `.swamp-sources.yaml` file.
 */
export async function removeSwampSources(repoDir: string): Promise<void> {
  const sourcesPath = swampSourcesPath(repoDir);
  try {
    await Deno.remove(sourcesPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}

/**
 * Expands source paths: resolves env vars/tilde, expands globs, and returns
 * a flat list of concrete (non-glob) sources.
 *
 * Each expanded path inherits the `only` filter from its parent source entry.
 */
export async function expandSourcePaths(
  sources: SwampSourcesConfig,
  repoDir: string,
): Promise<SwampSource[]> {
  const expanded: SwampSource[] = [];

  for (const source of sources.sources) {
    const expandedPath = expandEnvVars(source.path);
    const absolutePath = isAbsolute(expandedPath)
      ? expandedPath
      : resolve(repoDir, expandedPath);

    if (isGlobPattern(absolutePath)) {
      for await (const entry of expandGlob(absolutePath, { globstar: true })) {
        if (entry.isDirectory) {
          expanded.push({ path: entry.path, only: source.only });
        }
      }
    } else {
      expanded.push({ path: absolutePath, only: source.only });
    }
  }

  return expanded;
}

/**
 * Resolves extension directories for each expanded source.
 *
 * For each source path:
 * 1. Reads the source's own `.swamp.yaml` to find its extension directories
 * 2. Falls back to `extensions/<type>` defaults if no marker exists
 * 3. Filters by the `only` field if specified
 * 4. Validates that directories exist (warns but does not fail on missing)
 */
export async function resolveSourceExtensionDirs(
  expandedSources: SwampSource[],
): Promise<ResolvedSourceDirs[]> {
  const results: ResolvedSourceDirs[] = [];

  for (const source of expandedSources) {
    const sourceDir = source.path;
    const resolved: ResolvedSourceDirs = { sourcePath: sourceDir };

    // Try to read the source's own .swamp.yaml for directory overrides
    let sourceMarker: RepoMarkerData | null = null;
    try {
      const markerPath = resolve(sourceDir, ".swamp.yaml");
      const content = await Deno.readTextFile(markerPath);
      sourceMarker = parseYaml(content) as RepoMarkerData;
    } catch {
      // No marker file — use defaults
    }

    // Check if source dir itself exists
    try {
      const stat = await Deno.stat(sourceDir);
      if (!stat.isDirectory) {
        logger.warn`Source path is not a directory: ${sourceDir}`;
        results.push(resolved);
        continue;
      }
    } catch {
      logger.warn`Source path does not exist: ${sourceDir}`;
      results.push(resolved);
      continue;
    }

    const kinds = source.only ?? EXTENSION_KINDS;

    for (const kind of kinds) {
      const relDir = resolveKindDir(kind, sourceMarker);
      const absDir = isAbsolute(relDir) ? relDir : resolve(sourceDir, relDir);

      // Only include if the directory actually exists
      try {
        const stat = await Deno.stat(absDir);
        if (stat.isDirectory) {
          setKindDir(resolved, kind, absDir);
        }
      } catch {
        // Directory doesn't exist for this kind — skip silently
      }
    }

    results.push(resolved);
  }

  return results;
}

/**
 * Collects all resolved directories for a specific extension kind
 * from a list of resolved sources.
 */
export function collectDirsForKind(
  resolvedSources: ResolvedSourceDirs[],
  kind: ExtensionKind,
): string[] {
  const dirs: string[] = [];
  for (const source of resolvedSources) {
    const dir = getKindDir(source, kind);
    if (dir) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Resolves the extension directory for a given kind from a source's marker.
 * Uses marker fields if set, otherwise falls back to `extensions/<type>`.
 *
 * Note: This intentionally does NOT check environment variables (SWAMP_*_DIR)
 * because those apply to the consumer's repo, not the source repo.
 */
function resolveKindDir(
  kind: ExtensionKind,
  marker: RepoMarkerData | null,
): string {
  switch (kind) {
    case "models":
      return marker?.modelsDir ?? "extensions/models";
    case "vaults":
      return marker?.vaultsDir ?? "extensions/vaults";
    case "drivers":
      return marker?.driversDir ?? "extensions/drivers";
    case "datastores":
      return marker?.datastoresDir ?? "extensions/datastores";
    case "reports":
      return marker?.reportsDir ?? "extensions/reports";
    case "workflows":
      return marker?.workflowsDir ?? "extensions/workflows";
  }
}

function setKindDir(
  resolved: ResolvedSourceDirs,
  kind: ExtensionKind,
  dir: string,
): void {
  switch (kind) {
    case "models":
      resolved.modelsDir = dir;
      break;
    case "vaults":
      resolved.vaultsDir = dir;
      break;
    case "drivers":
      resolved.driversDir = dir;
      break;
    case "datastores":
      resolved.datastoresDir = dir;
      break;
    case "reports":
      resolved.reportsDir = dir;
      break;
    case "workflows":
      resolved.workflowsDir = dir;
      break;
  }
}

function getKindDir(
  resolved: ResolvedSourceDirs,
  kind: ExtensionKind,
): string | undefined {
  switch (kind) {
    case "models":
      return resolved.modelsDir;
    case "vaults":
      return resolved.vaultsDir;
    case "drivers":
      return resolved.driversDir;
    case "datastores":
      return resolved.datastoresDir;
    case "reports":
      return resolved.reportsDir;
    case "workflows":
      return resolved.workflowsDir;
  }
}
