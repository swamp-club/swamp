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
import { expandGlob, walk } from "@std/fs";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { expandEnvVars } from "./env_path.ts";
import { swampSourcesPath } from "./paths.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import {
  detectKindFromSource,
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
 * Reads the source's own `.swamp.yaml` marker for directory overrides.
 *
 * The YAML is from an external repo, so we only extract fields we need
 * and validate they are strings before using them. Returns null when the
 * marker file is missing or unreadable — callers fall back to
 * `extensions/<kind>/` defaults in that case.
 *
 * Shared by `resolveSourceExtensionDirs` and
 * `resolveExtensionKindsForSource` so both agree on marker semantics.
 * A single pre-fix snapshot in swamp_sources_repository_test.ts pins the
 * behaviour of this extraction.
 */
async function readSourceMarker(
  sourceDir: string,
): Promise<RepoMarkerData | null> {
  try {
    const markerPath = resolve(sourceDir, ".swamp.yaml");
    const content = await Deno.readTextFile(markerPath);
    const raw = parseYaml(content);
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    return {
      swampVersion: typeof obj.swampVersion === "string"
        ? obj.swampVersion
        : "",
      initializedAt: typeof obj.initializedAt === "string"
        ? obj.initializedAt
        : "",
      modelsDir: typeof obj.modelsDir === "string" ? obj.modelsDir : undefined,
      workflowsDir: typeof obj.workflowsDir === "string"
        ? obj.workflowsDir
        : undefined,
      vaultsDir: typeof obj.vaultsDir === "string" ? obj.vaultsDir : undefined,
      driversDir: typeof obj.driversDir === "string"
        ? obj.driversDir
        : undefined,
      datastoresDir: typeof obj.datastoresDir === "string"
        ? obj.datastoresDir
        : undefined,
      reportsDir: typeof obj.reportsDir === "string"
        ? obj.reportsDir
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Probes the standard `<sourceDir>/extensions/<kind>/` layout for a single
 * source. Returns the kinds whose dir exists. Respects the marker's
 * `<kind>Dir` override and the caller's `only` filter. Does NOT perform
 * any content scanning — purely a directory-existence check.
 *
 * Returned in the `kindDirs` map using the ExtensionKind as key so callers
 * can read both "which kinds resolved" and "what absolute dir each maps
 * to" in one pass.
 */
async function probeStandardLayout(
  sourceDir: string,
  marker: RepoMarkerData | null,
  only: ReadonlyArray<ExtensionKind>,
): Promise<Map<ExtensionKind, string>> {
  const out = new Map<ExtensionKind, string>();
  for (const kind of only) {
    const relDir = resolveKindDir(kind, marker);
    const absDir = isAbsolute(relDir) ? relDir : resolve(sourceDir, relDir);
    try {
      const stat = await Deno.stat(absDir);
      if (stat.isDirectory) {
        out.set(kind, absDir);
      }
    } catch {
      // Kind dir missing — skip.
    }
  }
  return out;
}

/** Directories skipped during the content pre-scan: test helpers and
 * unrelated package detritus that would never hold an extension file. */
const PRE_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".swamp",
  "dist",
  "build",
  "target",
]);

/** Maximum recursion depth for the content pre-scan. Keeps cold add/list
 * bounded on large repos where the source path is something broad. */
const PRE_SCAN_MAX_DEPTH = 4;

/** Cap per-file read during the content pre-scan. Normal extension files
 * sit far below this; a 64 KiB bound prevents blowups on pathological
 * files with no `export` declaration. */
const PRE_SCAN_MAX_BYTES = 64 * 1024;

/**
 * Walks `sourceDir` looking for files that signal extension content.
 * Returns the set of kinds detected.
 *
 * For .ts files: reads up to PRE_SCAN_MAX_BYTES of the file and runs
 * `detectKindFromSource`, which uses the same export-name regex the
 * loaders use for their pre-bundle skip check — so pre-scan detection
 * equals loader acceptance.
 *
 * For workflow files (.yaml / .yml): parses the YAML and checks for a
 * top-level `jobs:` key. Regex shortcuts are unreliable because workflow
 * YAML often puts `jobs:` after `name:` / `description:` headers.
 *
 * Skips `_*` prefixed dirs (helper modules — matches loader convention),
 * node_modules / .git / .swamp / dist / build / target (unrelated
 * detritus), and `_test.ts` files. Bounded by PRE_SCAN_MAX_DEPTH.
 */
async function contentPreScan(
  sourceDir: string,
): Promise<Set<ExtensionKind>> {
  const found = new Set<ExtensionKind>();
  try {
    for await (
      const entry of walk(sourceDir, {
        maxDepth: PRE_SCAN_MAX_DEPTH,
        includeDirs: false,
        skip: [
          /(^|\/)_[^/]+($|\/)/, // _-prefixed paths (helper modules, _test.ts)
        ],
      })
    ) {
      // Secondary skip for well-known dirs that the regex-based skip above
      // can't express cleanly. walk doesn't drop the dir itself; it emits
      // files underneath. Cheaper to filter on the path.
      let inSkipDir = false;
      for (const d of PRE_SCAN_SKIP_DIRS) {
        if (
          entry.path.includes(`/${d}/`) || entry.path.endsWith(`/${d}`)
        ) {
          inSkipDir = true;
          break;
        }
      }
      if (inSkipDir) continue;

      if (entry.isFile && entry.name.endsWith(".ts")) {
        if (entry.name.endsWith("_test.ts")) continue;
        try {
          const stat = await Deno.stat(entry.path);
          const len = Math.min(stat.size, PRE_SCAN_MAX_BYTES);
          const file = await Deno.open(entry.path, { read: true });
          try {
            const buf = new Uint8Array(len);
            await file.read(buf);
            const text = new TextDecoder().decode(buf);
            const kind = detectKindFromSource(text);
            if (kind) {
              found.add(kind);
              // Short-circuit once every known kind has been seen.
              if (found.size === EXTENSION_KINDS.length - 1) return found;
            }
          } finally {
            file.close();
          }
        } catch {
          // Unreadable file — skip.
        }
      } else if (
        entry.isFile &&
        (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))
      ) {
        if (found.has("workflows")) continue;
        try {
          // Size cap mirrors the .ts branch above. Legitimate workflow
          // YAML files are small; this guards against a source dir that
          // happens to contain large YAML data fixtures (e.g. generated
          // dumps) that would otherwise be read fully into memory before
          // `parseYaml` could reject them.
          const yamlStat = await Deno.stat(entry.path);
          if (yamlStat.size > PRE_SCAN_MAX_BYTES) continue;
          const content = await Deno.readTextFile(entry.path);
          const raw = parseYaml(content);
          if (
            raw && typeof raw === "object" && !Array.isArray(raw) &&
            "jobs" in (raw as Record<string, unknown>)
          ) {
            found.add("workflows");
          }
        } catch {
          // Unparseable YAML — not a workflow.
        }
      }
    }
  } catch {
    // walk throws if sourceDir is not a directory; callers already stat'd
    // the path before calling us, so this branch is defensive.
  }
  return found;
}

/**
 * Resolves extension directories for each expanded source.
 *
 * For each source path:
 * 1. Reads the source's own `.swamp.yaml` to find its extension directories
 * 2. Falls back to `extensions/<type>` defaults if no marker exists
 * 3. Filters by the `only` field if specified
 * 4. Validates that directories exist (warns but does not fail on missing)
 *
 * Since issue #139: when the standard `<path>/extensions/<kind>/` layout
 * yields zero known kinds for a source, a content pre-scan walks the path
 * and sets each detected kind's dir to the source path itself. Standard
 * layout always wins over pre-scan when both are present (prevents
 * double-loading in transitional repos).
 */
export async function resolveSourceExtensionDirs(
  expandedSources: SwampSource[],
): Promise<ResolvedSourceDirs[]> {
  const results: ResolvedSourceDirs[] = [];

  for (const source of expandedSources) {
    const sourceDir = source.path;
    const resolved: ResolvedSourceDirs = { sourcePath: sourceDir };
    const marker = await readSourceMarker(sourceDir);

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

    const only = source.only ?? EXTENSION_KINDS;
    const standard = await probeStandardLayout(sourceDir, marker, only);

    if (standard.size > 0) {
      for (const [kind, dir] of standard) {
        setKindDir(resolved, kind, dir);
      }
    } else {
      // Standard layout yielded zero known kinds — fall back to content
      // pre-scan. Each detected kind's dir becomes the source path itself
      // so the loader walks the full path and filters by export at the
      // pre-bundle step.
      const detected = await contentPreScan(sourceDir);
      for (const kind of detected) {
        if (only.includes(kind)) {
          setKindDir(resolved, kind, sourceDir);
        }
      }
    }

    results.push(resolved);
  }

  return results;
}

/**
 * Returns the extension kinds a single source actually contributes,
 * respecting globs, marker overrides, the `only` filter, and both
 * supported layouts (standard `extensions/<kind>/` and non-standard
 * content-detected). Sorted by EXTENSION_KINDS declaration order.
 *
 * Used by `sourceAdd` to fail fast when a concrete path contributes
 * nothing, and by `sourceList` to populate `resolvedKinds` per entry.
 *
 * Semantics:
 *   - A glob with zero expansions returns `[]` — add is allowed because
 *     the user may populate the path later.
 *   - A glob with ≥1 expansions unions kinds across expansions.
 *   - A concrete path with zero kinds from both layouts returns `[]` —
 *     callers reject it at add time.
 */
export async function resolveExtensionKindsForSource(
  source: SwampSource,
  repoDir: string,
): Promise<ExtensionKind[]> {
  const only = source.only ?? EXTENSION_KINDS;
  const onlySet = new Set<ExtensionKind>(only);
  const union = new Set<ExtensionKind>();

  const expanded = await expandSourcePaths({ sources: [source] }, repoDir);

  for (const ex of expanded) {
    const marker = await readSourceMarker(ex.path);

    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(ex.path);
    } catch {
      continue;
    }
    if (!stat.isDirectory) continue;

    const standard = await probeStandardLayout(ex.path, marker, only);
    if (standard.size > 0) {
      for (const kind of standard.keys()) union.add(kind);
      continue;
    }

    const detected = await contentPreScan(ex.path);
    for (const kind of detected) {
      if (onlySet.has(kind)) union.add(kind);
    }
  }

  return EXTENSION_KINDS.filter((k) => union.has(k));
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
