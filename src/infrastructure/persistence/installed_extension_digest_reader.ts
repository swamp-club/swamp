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

import { join, relative } from "@std/path";
import { computeChecksum } from "../../domain/models/checksum.ts";
import {
  computeInstalledExtensionDigest,
  type InstalledExtensionDigestEntry,
} from "../../domain/extensions/installed_extension_digest.ts";

/**
 * Walks a per-extension root (e.g. `.swamp/pulled-extensions/<name>/`) and
 * produces the rolled-up digest over every file found. Used by the auto-
 * update service to detect whether the user has modified any files since
 * install.
 *
 * Ignores macOS AppleDouble resource forks (`._*`) — matches the installer's
 * behavior in `isMacOsResourceFork`, so forks created by a Finder copy of
 * the extension tree do not change the digest.
 *
 * Returns `null` if the extension root does not exist (a caller-visible
 * signal distinct from "exists but empty" → empty-set digest).
 */
export async function readInstalledExtensionDigest(
  extRoot: string,
): Promise<string | null> {
  try {
    const stat = await Deno.stat(extRoot);
    if (!stat.isDirectory) return null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }

  const entries: InstalledExtensionDigestEntry[] = [];
  await walk(extRoot, extRoot, entries);
  return await computeInstalledExtensionDigest(entries);
}

async function walk(
  currentDir: string,
  extRoot: string,
  entries: InstalledExtensionDigestEntry[],
): Promise<void> {
  for await (const entry of Deno.readDir(currentDir)) {
    if (isMacOsResourceFork(entry.name)) continue;

    const childPath = join(currentDir, entry.name);
    if (entry.isDirectory) {
      await walk(childPath, extRoot, entries);
    } else if (entry.isFile) {
      const bytes = await Deno.readFile(childPath);
      const contentSha = await computeChecksum(bytes);
      // Use forward slashes in the hashed relPath so the digest matches
      // across platforms (Windows back-slashes would otherwise diverge).
      const relPath = relative(extRoot, childPath).split("\\").join("/");
      entries.push({ relPath, contentSha });
    }
  }
}

function isMacOsResourceFork(name: string): boolean {
  return name.startsWith("._");
}
