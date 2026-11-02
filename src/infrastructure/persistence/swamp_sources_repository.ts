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

import { isAbsolute, relative, resolve } from "@std/path";
import { walk } from "@std/fs";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { getConfig, getLogger } from "@logtape/logtape";
import { expandEnvVars } from "./env_path.ts";
import { expandSourceGlob } from "./source_glob_expander.ts";
import { swampSourcesPath } from "./paths.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { resolveSourceBaseDirs } from "./git_worktree.ts";
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
import { isWorkflowDocument } from "../../domain/workflows/workflow_document.ts";
import {
  DEFAULT_BEHAVIORS_DIR,
  DEFAULT_MODELS_DIR,
} from "../../domain/terminology/behavior_aliases.ts";

const logger = getLogger(["swamp", "sources"]);

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
 * a relative path matching nothing under sourceBaseDir but found under
 * legacyBaseDir resolves there with a warning, so sources recorded relative to
 * the git root keep loading
 */
export async function expandSourcePaths(
  sources: SwampSourcesConfig,
  repoDir: string,
  sourceBaseDir?: string,
  legacyBaseDir?: string,
): Promise<SwampSource[]> {
  const expanded: SwampSource[] = [];
  const baseDir = sourceBaseDir ?? repoDir;

  for (const source of sources.sources) {
    const expandedPath = expandEnvVars(source.path);
    const absolutePath = isAbsolute(expandedPath)
      ? expandedPath
      : resolve(baseDir, expandedPath);
    const legacyPath = isAbsolute(expandedPath) || legacyBaseDir === undefined
      ? undefined
      : resolve(legacyBaseDir, expandedPath);

    if (isGlobPattern(absolutePath)) {
      let paths = await expandSourceGlob(absolutePath);
      if (paths.length === 0 && legacyPath !== undefined) {
        paths = await expandSourceGlob(legacyPath);
        if (paths.length > 0) warnLegacySource(source.path, legacyBaseDir!);
      }
      for (const path of paths) {
        expanded.push({ path, only: source.only });
      }
    } else if (
      legacyPath !== undefined && await isMissing(absolutePath) &&
      await isDirectory(legacyPath)
    ) {
      warnLegacySource(source.path, legacyBaseDir!);
      expanded.push({ path: legacyPath, only: source.only });
    } else {
      expanded.push({ path: absolutePath, only: source.only });
    }
  }

  return expanded;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/**
 * true only when nothing is at the path: an unreadable path (permission denied)
 * is not treated as absent
 */
async function isMissing(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return false;
  } catch (error) {
    return error instanceof Deno.errors.NotFound;
  }
}

const warnedLegacySources = new Set<string>();

function warnLegacySource(path: string, gitRoot: string): void {
  const key = `${gitRoot}\0${path}`;
  if (warnedLegacySources.has(key)) return;
  // CLI startup expands sources before logging is configured, where the
  // record is dropped; only a delivered warning counts as given.
  if (getConfig() !== null) warnedLegacySources.add(key);
  logger
    .warn`Extension source ${path} resolved against the git repository root ${gitRoot}. Relative source paths are relative to the swamp repository: remove it with 'swamp extension source rm' and add it again with a path relative to the repository.`;
}

/**
 * the YAML is from an external repo, so extract only needed fields and validate
 * they are strings; a missing or unreadable marker returns null and callers
 * fall back to extension defaults
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
      datastoresDir: typeof obj.datastoresDir === "string"
        ? obj.datastoresDir
        : undefined,
      reportsDir: typeof obj.reportsDir === "string"
        ? obj.reportsDir
        : undefined,
      webhooksDir: typeof obj.webhooksDir === "string"
        ? obj.webhooksDir
        : undefined,
    };
  } catch {
    return null;
  }
}

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

async function probeBehaviorsDir(
  sourceDir: string,
  marker: RepoMarkerData | null,
  only: ReadonlyArray<ExtensionKind>,
): Promise<string | undefined> {
  // As for the repo itself: the behaviors dir exists only while the models
  // dir is the default, whether the marker leaves modelsDir unset or sets it
  // to the default value.
  const modelsDir = marker?.modelsDir;
  if (
    !only.includes("models") ||
    (modelsDir !== undefined && modelsDir !== DEFAULT_MODELS_DIR)
  ) {
    return undefined;
  }
  const absDir = resolve(sourceDir, DEFAULT_BEHAVIORS_DIR);
  try {
    return (await Deno.stat(absDir)).isDirectory ? absDir : undefined;
  } catch {
    return undefined;
  }
}

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

/** Skip .ts files larger than this during the content pre-scan.
 * Extension files are human-authored and far smaller; this guards
 * against generated files in the source tree. */
const PRE_SCAN_TS_MAX_BYTES = 2 * 1024 * 1024;

/** Cap per-file read for YAML during the content pre-scan. Workflow
 * YAML is small; this guards against large data fixtures. */
const PRE_SCAN_YAML_MAX_BYTES = 64 * 1024;

/**
 * only segments below sourceDir count, so a source checked out under
 * /actions-runner/_work/ or ~/build/ is still scanned; splits on both
 * separators for Windows
 */
function isPreScanExcluded(sourceDir: string, path: string): boolean {
  return relative(sourceDir, path).split(/[\\/]/).some((segment) =>
    segment.startsWith("_") || PRE_SCAN_SKIP_DIRS.has(segment)
  );
}

/**
 * ts files use the loaders' export-name regex so detection equals loader
 * acceptance; workflow yaml is parsed for a top-level jobs key, as a regex is
 * unreliable when headers come first
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
      })
    ) {
      if (isPreScanExcluded(sourceDir, entry.path)) continue;

      if (entry.isFile && entry.name.endsWith(".ts")) {
        if (entry.name.endsWith("_test.ts")) continue;
        try {
          const stat = await Deno.stat(entry.path);
          if (stat.size > PRE_SCAN_TS_MAX_BYTES) continue;
          const text = await Deno.readTextFile(entry.path);
          const kind = detectKindFromSource(text);
          if (kind) {
            found.add(kind);
            if (found.size === EXTENSION_KINDS.length - 1) return found;
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
          const yamlStat = await Deno.stat(entry.path);
          if (yamlStat.size > PRE_SCAN_YAML_MAX_BYTES) continue;
          const content = await Deno.readTextFile(entry.path);
          if (isWorkflowDocument(parseYaml(content))) {
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
 * if the standard layout yields no known kinds, a content pre-scan sets each
 * detected kind's dir to the source path; the standard layout always wins,
 * preventing double-loading
 */
export interface SourceResolutionResult {
  resolved: ResolvedSourceDirs[];
  warnings: SourceResolutionWarning[];
}

export interface SourceResolutionWarning {
  sourcePath: string;
  reason: "not_found" | "not_a_directory";
}

export async function resolveSourceExtensionDirs(
  expandedSources: SwampSource[],
  options?: { quiet?: boolean },
): Promise<SourceResolutionResult> {
  const results: ResolvedSourceDirs[] = [];
  const warnings: SourceResolutionWarning[] = [];

  for (const source of expandedSources) {
    const sourceDir = source.path;
    const resolved: ResolvedSourceDirs = { sourcePath: sourceDir };
    const marker = await readSourceMarker(sourceDir);

    try {
      const stat = await Deno.stat(sourceDir);
      if (!stat.isDirectory) {
        if (!options?.quiet) {
          logger.warn`Source path is not a directory: ${sourceDir}`;
        }
        warnings.push({ sourcePath: sourceDir, reason: "not_a_directory" });
        results.push(resolved);
        continue;
      }
    } catch {
      if (!options?.quiet) {
        logger.warn`Source path does not exist: ${sourceDir}`;
      }
      warnings.push({ sourcePath: sourceDir, reason: "not_found" });
      results.push(resolved);
      continue;
    }

    const only = source.only ?? EXTENSION_KINDS;
    const standard = await probeStandardLayout(sourceDir, marker, only);
    const behaviorsDir = await probeBehaviorsDir(sourceDir, marker, only);

    // layout detection stays by existing kind dirs, so a source with an
    // extensions/behaviors/ folder loads as before; the behaviors dir is added
    // on top of a standard layout
    if (standard.size > 0) {
      for (const [kind, dir] of standard) {
        setKindDir(resolved, kind, dir);
      }
      if (behaviorsDir !== undefined) resolved.behaviorsDir = behaviorsDir;
    } else {
      // falls back to content pre-scan: each detected kind's dir becomes the
      // source path, so the loader walks it and filters by export at the
      // pre-bundle step
      const detected = await contentPreScan(sourceDir);
      for (const kind of detected) {
        if (only.includes(kind)) {
          setKindDir(resolved, kind, sourceDir);
        }
      }
    }

    results.push(resolved);
  }

  return { resolved: results, warnings };
}

/**
 * order matters: the loader registers sources in .swamp-sources.yaml order and
 * skips an already registered type, so an earlier directory wins a type
 * conflict
 */
export function flattenSourceKindDirs(
  resolved: readonly ResolvedSourceDirs[],
): string[] {
  const dirs: string[] = [];
  for (const source of resolved) {
    for (
      const dir of [
        source.modelsDir,
        source.behaviorsDir,
        source.vaultsDir,
        source.datastoresDir,
        source.reportsDir,
        source.webhooksDir,
        source.workflowsDir,
      ]
    ) {
      if (dir !== undefined && !dirs.includes(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * missing sources are not reported again here; CLI startup already warns about
 * them
 */
export async function resolveMountedSourceDirs(
  repoDir: string,
): Promise<string[]> {
  const config = await readSwampSources(repoDir);
  if (!config) return [];
  const { baseDir, legacyBaseDir } = await resolveSourceBaseDirs(repoDir);
  const expanded = await expandSourcePaths(
    config,
    repoDir,
    baseDir,
    legacyBaseDir,
  );
  const { resolved } = await resolveSourceExtensionDirs(expanded, {
    quiet: true,
  });
  return flattenSourceKindDirs(resolved);
}

/**
 * a glob with no expansions returns [] so add is allowed; sourceList passes
 * legacyBaseDir so a legacy entry lists the kinds it loads with, sourceAdd does
 * not, so new entries resolve from the repository
 */
export async function resolveExtensionKindsForSource(
  source: SwampSource,
  repoDir: string,
  legacyBaseDir?: string,
): Promise<ExtensionKind[]> {
  const only = source.only ?? EXTENSION_KINDS;
  const onlySet = new Set<ExtensionKind>(only);
  const union = new Set<ExtensionKind>();

  const expanded = await expandSourcePaths(
    { sources: [source] },
    repoDir,
    repoDir,
    legacyBaseDir,
  );

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
    const behaviorsDir = await probeBehaviorsDir(ex.path, marker, only);
    if (standard.size > 0) {
      for (const kind of standard.keys()) union.add(kind);
      if (behaviorsDir !== undefined) union.add("models");
      continue;
    }

    const detected = await contentPreScan(ex.path);
    for (const kind of detected) {
      if (onlySet.has(kind)) union.add(kind);
    }
  }

  return EXTENSION_KINDS.filter((k) => union.has(k));
}

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
    // the behaviors directory loads as models, after the models directory so
    // the source's own precedence matches the repo's
    if (kind === "models" && source.behaviorsDir) {
      dirs.push(source.behaviorsDir);
    }
  }
  return dirs;
}

/**
 * does not check SWAMP_*_DIR env vars, which apply to the consumer's repo, not
 * the source repo
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
    case "datastores":
      return marker?.datastoresDir ?? "extensions/datastores";
    case "reports":
      return marker?.reportsDir ?? "extensions/reports";
    case "webhooks":
      return marker?.webhooksDir ?? "extensions/webhooks";
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
    case "datastores":
      resolved.datastoresDir = dir;
      break;
    case "reports":
      resolved.reportsDir = dir;
      break;
    case "webhooks":
      resolved.webhooksDir = dir;
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
    case "datastores":
      return resolved.datastoresDir;
    case "reports":
      return resolved.reportsDir;
    case "webhooks":
      return resolved.webhooksDir;
    case "workflows":
      return resolved.workflowsDir;
  }
}
