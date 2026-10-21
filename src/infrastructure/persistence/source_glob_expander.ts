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
  type GlobOptions,
  globToRegExp,
  isAbsolute,
  isGlob,
  join,
  joinGlobs,
  normalize,
  resolve,
  SEPARATOR_PATTERN,
} from "@std/path";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["swamp", "sources"]);

/** The filesystem calls the expander makes; tests substitute their own. */
export interface SourceGlobFs {
  readDir(path: string): AsyncIterable<Deno.DirEntry>;
  stat(path: string): Promise<Deno.FileInfo>;
}

const denoFs: SourceGlobFs = {
  readDir: (path) => Deno.readDir(path),
  stat: (path) => Deno.stat(path),
};

// The options swamp has always expanded source globs with (the @std/fs
// expandGlob defaults plus globstar).
const GLOB_OPTIONS: GlobOptions = {
  extended: true,
  globstar: true,
  caseInsensitive: false,
};

const GLOB_ESCAPE_CHAR = Deno.build.os === "windows" ? "`" : "\\";
const GLOB_METACHARS = "*?{}[]()|+@!";

interface Entry {
  path: string;
  isDirectory: boolean;
}

/**
 * Expands a source glob to the directories it matches.
 *
 * Returns what `expandGlob(glob, { globstar: true })` from `@std/fs` returns,
 * filtered to directories and in the same order. The difference is that an
 * entry which disappears (or stops being a directory) between being listed
 * and being read is skipped, where `expandGlob` throws and fails the whole
 * expansion. Other errors still throw.
 */
export async function expandSourceGlob(
  glob: string,
  fs: SourceGlobFs = denoFs,
): Promise<string[]> {
  const separator = SEPARATOR_PATTERN.source;
  const segments = glob
    .replace(new RegExp(`^${separator}|${separator}$`, "g"), "")
    .split(SEPARATOR_PATTERN);
  const globIsAbsolute = isAbsolute(glob);
  let winRoot: string | undefined;
  if (Deno.build.os === "windows" && globIsAbsolute) {
    winRoot = segments.shift();
  }

  let fixedRoot = globIsAbsolute ? winRoot ?? "/" : resolve(Deno.cwd());
  while (segments.length > 0 && !isGlob(segments[0])) {
    const segment = unescapeGlobSegment(segments.shift()!);
    fixedRoot = joinGlobs([fixedRoot, segment], GLOB_OPTIONS);
  }

  let currentMatches: Entry[];
  try {
    const info = await fs.stat(fixedRoot);
    currentMatches = [{ path: fixedRoot, isDirectory: info.isDirectory }];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }

  for (const segment of segments) {
    // Advancing several matches can reach the same path more than once.
    const nextMatches = new Map<string, Entry>();
    for (const match of currentMatches) {
      for (const next of await advanceMatch(fs, match, segment)) {
        nextMatches.set(next.path, next);
      }
    }
    currentMatches = [...nextMatches.values()].sort(comparePath);
  }

  return currentMatches
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.path);
}

async function advanceMatch(
  fs: SourceGlobFs,
  match: Entry,
  segment: string,
): Promise<Entry[]> {
  if (!match.isDirectory) return [];
  if (segment === "..") {
    const parent = await statEntry(
      fs,
      joinGlobs([match.path, ".."], GLOB_OPTIONS),
    );
    return parent ? [parent] : [];
  }
  const walked: Entry[] = [];
  if (segment === "**") {
    await walk(fs, match.path, Infinity, walked);
    return walked;
  }
  const pattern = globToRegExp(segment, GLOB_OPTIONS);
  await walk(fs, match.path, 1, walked);
  return walked.filter((entry) =>
    entry.path !== match.path &&
    pattern.test(entry.path.split(SEPARATOR_PATTERN).pop()!)
  );
}

// Mirrors @std/fs walk without following symlinks: a symlink found while
// listing is reported as a non-directory and never descended into.
async function walk(
  fs: SourceGlobFs,
  root: string,
  maxDepth: number,
  out: Entry[],
): Promise<void> {
  const self = await statEntry(fs, root);
  if (!self) return;
  out.push(self);
  if (maxDepth < 1) return;
  for (const entry of await listDir(fs, root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory && !entry.isSymlink) {
      await walk(fs, path, maxDepth - 1, out);
    } else {
      out.push({ path, isDirectory: false });
    }
  }
}

async function statEntry(
  fs: SourceGlobFs,
  path: string,
): Promise<Entry | null> {
  path = normalize(path);
  try {
    const info = await fs.stat(path);
    return { path, isDirectory: info.isDirectory };
  } catch (error) {
    if (!isVanished(error)) throw error;
    logger.debug`Skipping ${path}: it disappeared during source expansion`;
    return null;
  }
}

// Keeps the entries read before a listing fails part-way because the
// directory itself was removed.
async function listDir(
  fs: SourceGlobFs,
  dir: string,
): Promise<Deno.DirEntry[]> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of fs.readDir(dir)) entries.push(entry);
  } catch (error) {
    if (!isVanished(error)) throw error;
    logger
      .debug`Stopped listing ${dir}: it disappeared during source expansion`;
  }
  return entries;
}

function isVanished(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound ||
    error instanceof Deno.errors.NotADirectory;
}

function comparePath(a: Entry, b: Entry): number {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

function unescapeGlobSegment(segment: string): string {
  let result = "";
  let lastIndex = 0;
  for (let i = 0; i < segment.length; i++) {
    const next = segment[i + 1];
    if (
      segment[i] === GLOB_ESCAPE_CHAR && next && GLOB_METACHARS.includes(next)
    ) {
      result += segment.slice(lastIndex, i) + next;
      i++;
      lastIndex = i + 1;
    }
  }
  if (lastIndex === 0) return segment;
  return result + segment.slice(lastIndex);
}
