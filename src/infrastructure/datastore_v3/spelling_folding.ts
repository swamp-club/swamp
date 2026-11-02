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

/**
 * on a case- or normalisation-insensitive filesystem a key nothing owns can
 * reach another key's file (VPC/1/raw reaches vpc/1/raw); where nothing folds
 * the guard is skipped, so the read model probes once
 */

import { basename, dirname, join } from "@std/path";

export type SpellingFolding = "off" | "canonical" | "list";

export const SPELLING_PROBE_FILE = "spelling-probe-é";

/**
 * the probe name is fixed, so run one probe of a directory at a time; a crash
 * leaves at most one file, which the next probe overwrites. Any failure gives
 * `list`, which is always correct, only slower
 */
export async function probeSpellingFolding(
  dir: string,
): Promise<SpellingFolding> {
  const path = join(dir, SPELLING_PROBE_FILE);
  try {
    await Deno.writeFile(path, new Uint8Array());
  } catch {
    return "list";
  }
  try {
    const spellings = [
      // ASCII alone, for a filesystem that folds only ASCII case.
      SPELLING_PROBE_FILE.replace(/[a-z]/g, (c) => c.toUpperCase()),
      SPELLING_PROBE_FILE.toUpperCase(),
      SPELLING_PROBE_FILE.normalize("NFD"),
    ];
    let folds = false;
    for (const spelling of spellings) {
      const alias = join(dir, spelling);
      try {
        await Deno.lstat(alias);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      folds = true;
      if (basename(await Deno.realPath(alias)) !== SPELLING_PROBE_FILE) {
        return "list";
      }
    }
    return folds ? "canonical" : "off";
  } catch {
    return "list";
  } finally {
    try {
      await Deno.remove(path);
    } catch {
      // A probe file left behind is written over by the next probe.
    }
  }
}

/**
 * the probed mode holds when the root is on the probe directory's device, else
 * `list`, as also when either cannot be stat'd; a root not yet existing is
 * judged by its nearest existing ancestor
 */
export async function spellingFoldingOf(
  root: string,
  probeDir: string,
  probed: SpellingFolding,
  stat: (path: string) => Promise<Deno.FileInfo> = Deno.stat,
): Promise<SpellingFolding> {
  if (probed === "list") return "list";
  try {
    const [rootDevice, probeDevice] = await Promise.all([
      deviceOf(root, stat),
      deviceOf(probeDir, stat),
    ]);
    return rootDevice === probeDevice ? probed : "list";
  } catch {
    return "list";
  }
}

async function deviceOf(
  path: string,
  stat: (path: string) => Promise<Deno.FileInfo>,
): Promise<number> {
  for (let at = path;; at = dirname(at)) {
    try {
      return (await stat(at)).dev;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) || dirname(at) === at) {
        throw error;
      }
    }
  }
}

/**
 * toLowerCase differs from APFS's and NTFS's own folding for a few characters
 * (final sigma, ß); a name the read model fails to match is skipped, which
 * leaves a file unwritten but never overwrites one
 */
export function foldSpelling(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
