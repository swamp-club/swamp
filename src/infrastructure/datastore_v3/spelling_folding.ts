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
 * Whether a filesystem folds spellings, for the read model's guard against
 * aliased keys (swamp-club#3939). On a case- or normalisation-insensitive
 * filesystem (APFS, NTFS) a key nothing owns can reach another key's file:
 * `VPC/1/raw` reaches `vpc/1/raw`. Where nothing folds the guard has nothing
 * to do, so the read model probes once and skips it there.
 *
 * @module
 */

import { basename, dirname, join } from "@std/path";

/**
 * How the read model checks a key's spelling under one cache root:
 *
 * - `off`: the filesystem folds neither case nor normalisation, so no other
 *   spelling reaches a file.
 * - `canonical`: it folds, and `realPath` gives a file's spelling on disk,
 *   so a path whose real spelling is its own needs no listing.
 * - `list`: it folds, or may, and `realPath` cannot be trusted to give the
 *   spelling on disk, so every segment is checked against its directory's
 *   listing.
 */
export type SpellingFolding = "off" | "canonical" | "list";

/**
 * The probe's file name: lower case and precomposed (NFC), so an upper-case
 * or decomposed spelling of it differs.
 */
export const SPELLING_PROBE_FILE = "spelling-probe-é";

/**
 * Probes `dir` by writing {@link SPELLING_PROBE_FILE} there, looking it up
 * under other spellings, and removing it. Its name is fixed, so a caller
 * runs one probe of a directory at a time, and a crash leaves at most one
 * file, which the next probe writes over. Any failure gives `list`, which
 * is always correct and only slower.
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
 * The mode for a cache root, given `probed`, the mode the probe of
 * `probeDir` found: the same when the root is on the probed directory's
 * device, and `list` otherwise, or when either cannot be stat'd. A root
 * that does not exist yet is judged by its nearest existing ancestor.
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
