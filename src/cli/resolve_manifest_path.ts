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

import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { markErrorPaths, UserError } from "../domain/errors.ts";

export const MANIFEST_FILE_NAMES = [
  "manifest.yaml",
  "manifest.yml",
  "manifest.json",
] as const;

export interface ResolveManifestArgumentOptions {
  argument: string;
  cwd: string;
  repoDir: string;
  extensionsDir?: string;
}

export type ManifestArgumentBase =
  | "absolute"
  | "cwd"
  | "extensionsDir"
  | "repoDir";

export interface ResolvedManifestArgument {
  absoluteManifestPath: string;
  base: ManifestArgumentBase;
}

interface Candidate {
  base: ManifestArgumentBase;
  path: string;
}

/**
 * a relative argument is tried against --extensions-dir first (the worktree
 * setup runs from the main checkout), then cwd, then the repo dir; candidates
 * are stat-ed, never read
 */
export async function resolveManifestArgument(
  options: ResolveManifestArgumentOptions,
): Promise<ResolvedManifestArgument> {
  const { argument, cwd, repoDir, extensionsDir } = options;

  const ext = extname(argument).toLowerCase();
  if (ext === ".ts" || ext === ".js") {
    throw markErrorPaths(
      new UserError(
        `Expected a manifest path but got a TypeScript/JavaScript file: ${argument}\n` +
          "Pass the manifest directory or manifest.yaml path instead.\n\n" +
          "Example:\n" +
          "  swamp extension fmt extensions/models/my-model/manifest.yaml",
      ),
      [argument],
    );
  }

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (base: ManifestArgumentBase, dir?: string) => {
    const path = dir === undefined ? resolve(argument) : resolve(dir, argument);
    if (seen.has(path)) return;
    seen.add(path);
    candidates.push({ base, path });
  };
  if (isAbsolute(argument)) {
    addCandidate("absolute");
  } else {
    if (extensionsDir !== undefined) {
      addCandidate("extensionsDir", extensionsDir);
    }
    addCandidate("cwd", cwd);
    addCandidate("repoDir", repoDir);
  }

  let directoryWithoutManifest: string | undefined;
  for (const candidate of candidates) {
    const info = await statOrNull(candidate.path);
    if (info === null) continue;
    if (info.isFile) {
      return { absoluteManifestPath: candidate.path, base: candidate.base };
    }
    if (!info.isDirectory) continue;
    for (const name of MANIFEST_FILE_NAMES) {
      const manifestPath = join(candidate.path, name);
      const manifestInfo = await statOrNull(manifestPath);
      if (manifestInfo?.isFile) {
        return { absoluteManifestPath: manifestPath, base: candidate.base };
      }
    }
    directoryWithoutManifest ??= candidate.path;
  }

  if (directoryWithoutManifest !== undefined) {
    throw markErrorPaths(
      new UserError(
        `No manifest.yaml found in ${directoryWithoutManifest}\n` +
          "Pass the extension directory that holds manifest.yaml, or the manifest file itself.",
      ),
      [argument, directoryWithoutManifest],
    );
  }
  const looked = candidates.map((c) => c.path);
  throw markErrorPaths(
    new UserError(
      `Manifest file not found: ${argument} (looked in ${looked.join(", ")})`,
    ),
    [argument, ...looked],
  );
}

async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    // A dangling symlink or a component that is not a directory reads as
    // absent too; anything else (permissions) is the caller's problem.
    if (error instanceof Deno.errors.NotADirectory) return null;
    throw error;
  }
}

/**
 * only the prefix naming the repository is swapped; components below it are
 * kept as written so a symlink inside the repository, even one back to its
 * root, is still seen by the symlink check
 */
export async function respellUnderRepoDir(
  path: string,
  repoDir: string,
): Promise<string> {
  const target = resolve(path);
  if (!escapes(relative(repoDir, target))) return path;
  const realRepoDir = await realPathOrNull(repoDir);
  if (realRepoDir === null) return path;
  let repoRoot: string | undefined;
  for (let ancestor = target;; ancestor = dirname(ancestor)) {
    if (await realPathOrNull(ancestor) === realRepoDir) repoRoot = ancestor;
    if (dirname(ancestor) === ancestor) break;
  }
  return repoRoot === undefined
    ? path
    : join(repoDir, relative(repoRoot, target));
}

function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + SEPARATOR) || isAbsolute(rel);
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}
