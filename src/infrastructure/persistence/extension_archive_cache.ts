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

import { getLogger } from "@logtape/logtape";
import { join } from "@std/path";
import {
  archiveCacheKey,
  type ExtensionArchiveCache,
} from "../../domain/extensions/extension_archive_cache.ts";
import { MAX_EXTENSION_ARCHIVE_BYTES } from "../../domain/extensions/extension_archive_limits.ts";
import { computeChecksum } from "../../domain/models/checksum.ts";
import { atomicWriteFile } from "./atomic_write.ts";
import { getSwampDataDir } from "./paths.ts";

const logger = getLogger(["swamp", "extensions", "archive-cache"]);

const DAY_MS = 24 * 60 * 60 * 1000;
/** a hit refreshes the mtime, so this ages out only versions nothing installs */
export const ARCHIVE_CACHE_MAX_AGE_MS = 30 * DAY_MS;
const ORPHAN_TEMP_MAX_AGE_MS = DAY_MS;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * every failure is reported as a miss or a skipped write: the cache may only
 * make an install faster, never fail it
 */
export class FileExtensionArchiveCache implements ExtensionArchiveCache {
  readonly #dir: string;
  readonly #now: () => number;

  constructor(root: string, options: { now?: () => number } = {}) {
    this.#dir = join(root, "sha256");
    this.#now = options.now ?? Date.now;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const digest = archiveCacheKey(key);
    if (digest === null) return null;
    const path = this.#entryPath(digest);
    try {
      const entry = await Deno.lstat(path);
      if (!entry.isFile) return null;
      const archive = await readRegularFile(path);
      if (archive === null) return null;
      if (await computeChecksum(archive) !== digest) {
        logger.debug`Discarding corrupt cached archive ${path}`;
        await Deno.remove(path).catch(() => {});
        return null;
      }
      const now = new Date(this.#now());
      await Deno.utime(path, now, now).catch(() => {});
      return archive;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        logger.debug`Could not read cached archive ${path}: ${error}`;
      }
      return null;
    }
  }

  async put(key: string, archive: Uint8Array): Promise<void> {
    const digest = archiveCacheKey(key);
    if (digest === null) return;
    try {
      if (await computeChecksum(archive) !== digest) {
        logger.debug`Not caching an archive that does not hash to ${digest}`;
        return;
      }
      await Deno.mkdir(this.#dir, { recursive: true });
      await atomicWriteFile(this.#entryPath(digest), archive);
      await this.#prune();
    } catch (error) {
      logger.debug`Could not cache archive ${digest}: ${error}`;
    }
  }

  #entryPath(digest: string): string {
    return join(this.#dir, `${digest}.tar.gz`);
  }

  async #prune(): Promise<void> {
    const now = this.#now();
    for await (const entry of Deno.readDir(this.#dir)) {
      if (!entry.isFile) continue;
      const maxAge = entry.name.endsWith(".tar.gz")
        ? ARCHIVE_CACHE_MAX_AGE_MS
        : entry.name.endsWith(".tmp")
        ? ORPHAN_TEMP_MAX_AGE_MS
        : undefined;
      if (maxAge === undefined) continue;
      const path = join(this.#dir, entry.name);
      try {
        const mtime = (await Deno.lstat(path)).mtime?.getTime();
        if (mtime !== undefined && now - mtime > maxAge) {
          await Deno.remove(path);
        }
      } catch (error) {
        logger.debug`Could not prune cached archive ${path}: ${error}`;
      }
    }
  }
}

/** stats the open handle, not the path, so the size bound covers what is read */
async function readRegularFile(path: string): Promise<Uint8Array | null> {
  const file = await Deno.open(path, { read: true });
  try {
    const info = await file.stat();
    if (!info.isFile || info.size > MAX_EXTENSION_ARCHIVE_BYTES) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const chunk = new Uint8Array(READ_CHUNK_BYTES);
      const read = await file.read(chunk);
      if (read === null) break;
      total += read;
      if (total > MAX_EXTENSION_ARCHIVE_BYTES) return null;
      chunks.push(chunk.subarray(0, read));
    }
    const archive = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      archive.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return archive;
  } finally {
    file.close();
  }
}

/** undefined when no data dir resolves, so installs run uncached */
export function createDefaultExtensionArchiveCache():
  | ExtensionArchiveCache
  | undefined {
  try {
    return new FileExtensionArchiveCache(
      join(getSwampDataDir(), "cache", "extension-archives"),
    );
  } catch {
    return undefined;
  }
}
