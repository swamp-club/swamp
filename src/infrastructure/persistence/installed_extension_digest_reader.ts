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

import { join, relative } from "@std/path";
import { computeChecksum } from "../../domain/models/checksum.ts";
import {
  computeInstalledExtensionDigest,
  type InstalledExtensionDigestEntry,
} from "../../domain/extensions/installed_extension_digest.ts";

/**
 * excludeRelDirs skips nested entries' roots; AppleDouble ._* forks are ignored
 * as the installer does; null when the root is absent, distinct from an
 * empty-set digest
 */
export async function readInstalledExtensionDigest(
  extRoot: string,
  options: { excludeRelDirs?: ReadonlyArray<string> } = {},
): Promise<string | null> {
  try {
    const stat = await Deno.stat(extRoot);
    if (!stat.isDirectory) return null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }

  const entries: InstalledExtensionDigestEntry[] = [];
  await walk(extRoot, extRoot, entries, new Set(options.excludeRelDirs ?? []));
  return await computeInstalledExtensionDigest(entries);
}

/**
 * the digest leaves out nested entries' roots, but one stored before that rule
 * covered them, so when nested dirs exist and the new digest differs the
 * whole-tree digest is also accepted until the next install
 */
export async function installedDigestMatches(
  extRoot: string,
  stored: string,
  nestedRelDirs: ReadonlyArray<string>,
): Promise<boolean | null> {
  const onDisk = await readInstalledExtensionDigest(extRoot, {
    excludeRelDirs: nestedRelDirs,
  });
  if (onDisk === null) return null;
  if (onDisk === stored) return true;
  if (nestedRelDirs.length === 0) return false;
  return await readInstalledExtensionDigest(extRoot) === stored;
}

async function walk(
  currentDir: string,
  extRoot: string,
  entries: InstalledExtensionDigestEntry[],
  excluded: ReadonlySet<string>,
): Promise<void> {
  for await (const entry of Deno.readDir(currentDir)) {
    if (isMacOsResourceFork(entry.name)) continue;

    const childPath = join(currentDir, entry.name);
    // forward slashes in the hashed relPath so the digest matches across
    // platforms
    const relPath = relative(extRoot, childPath).split("\\").join("/");
    if (entry.isDirectory) {
      if (excluded.has(relPath)) continue;
      await walk(childPath, extRoot, entries, excluded);
    } else if (entry.isFile) {
      const bytes = await Deno.readFile(childPath);
      const contentSha = await computeChecksum(bytes);
      entries.push({ relPath, contentSha });
    }
  }
}

function isMacOsResourceFork(name: string): boolean {
  return name.startsWith("._");
}
