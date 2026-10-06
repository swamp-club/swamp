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

import { extname, isAbsolute, join, resolve } from "@std/path";
import { markErrorPaths, UserError } from "../domain/errors.ts";

/** Manifest file names a directory argument may hold, in lookup order. */
export const MANIFEST_FILE_NAMES = [
  "manifest.yaml",
  "manifest.yml",
  "manifest.json",
] as const;

export interface ResolveManifestArgumentOptions {
  /** The manifest argument exactly as the author typed it. */
  argument: string;
  /** The directory the command was run from. */
  cwd: string;
  /** The swamp repository directory (`--repo-dir`). */
  repoDir: string;
  /** The extensions source root (`--extensions-dir`), when given. */
  extensionsDir?: string;
}

/** Which base a relative manifest argument was resolved against. */
export type ManifestArgumentBase =
  | "absolute"
  | "cwd"
  | "extensionsDir"
  | "repoDir";

export interface ResolvedManifestArgument {
  /** The manifest file the argument names. */
  absoluteManifestPath: string;
  /** The base the argument matched under (swamp-club#3018). */
  base: ManifestArgumentBase;
}

interface Candidate {
  base: ManifestArgumentBase;
  path: string;
}

/**
 * Turn the manifest argument of `extension push`, `quality` and `fmt` into
 * the manifest file it names (swamp-club#3018, swamp-club#2747).
 *
 * An absolute argument is used as given. A relative argument is tried
 * against the current directory first, then `--extensions-dir` when set,
 * then the repo dir, so a path typed from where the author stands wins and
 * scripts that pass repo-relative paths with `--repo-dir` keep working. A
 * candidate matches when it is a file, or a directory holding one of
 * {@link MANIFEST_FILE_NAMES}; the first match wins. Every candidate is
 * `stat`ed, never read, so a directory can never reach `readTextFile`.
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
    addCandidate("cwd", cwd);
    if (extensionsDir !== undefined) {
      addCandidate("extensionsDir", extensionsDir);
    }
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
