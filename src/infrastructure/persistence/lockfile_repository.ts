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

import { dirname } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { lockfileAdvisoryLockPath } from "./paths.ts";
import {
  canonicalLockfileEntry,
  readUpstreamExtensions,
  type UpstreamExtensionEntry,
  type UpstreamExtensionsMap,
} from "./upstream_extensions.ts";

const LOCK_RETRY_COUNT = 10;
const LOCK_RETRY_DELAY_MS = 100;

/**
 * Windows reports PermissionDenied, not AlreadyExists, while a just-released
 * lock file awaits deletion, so that retries; one outlasting every retry is a
 * real permission problem and is rethrown
 */
export function lockAttemptOutcome(
  error: unknown,
  isLastAttempt: boolean,
  os: typeof Deno.build.os = Deno.build.os,
): "retry" | "busy" | "rethrow" {
  if (error instanceof Deno.errors.AlreadyExists) {
    return isLastAttempt ? "busy" : "retry";
  }
  if (os === "windows" && error instanceof Deno.errors.PermissionDenied) {
    return isLastAttempt ? "rethrow" : "retry";
  }
  return "rethrow";
}

interface HeldLock {
  file: Deno.FsFile;
  path: string;
}

export interface WriteEntryOptions {
  include?: string[];
  checksum?: string;
  filesChecksum?: string;
  serverUrl?: string;
  channel?: string;
  publishedChannel?: string;
  pulledAt?: string;
}

/**
 * reads serve a snapshot frozen at construction on purpose; writes lock,
 * re-read disk, merge and update the cache. For current state call refresh or
 * build a new instance, never make reads live
 */
export class LockfileRepository {
  readonly lockfilePath: string;
  private cache: UpstreamExtensionsMap;

  static async create(lockfilePath: string): Promise<LockfileRepository> {
    const cache = await readUpstreamExtensions(lockfilePath);
    return new LockfileRepository(lockfilePath, cache);
  }

  constructor(lockfilePath: string, cache: UpstreamExtensionsMap = {}) {
    this.lockfilePath = lockfilePath;
    this.cache = cache;
  }

  async refresh(): Promise<void> {
    this.cache = await readUpstreamExtensions(this.lockfilePath);
  }

  getEntry(name: string): UpstreamExtensionEntry | null {
    return this.cache[name] ?? null;
  }

  getAllEntries(): UpstreamExtensionsMap {
    return structuredClone(this.cache);
  }

  getLockedVersion(name: string): string | null {
    return this.cache[name]?.version ?? null;
  }

  async writeEntry(
    name: string,
    version: string,
    files: string[],
    options?: WriteEntryOptions,
  ): Promise<void> {
    await Deno.mkdir(dirname(this.lockfilePath), { recursive: true });
    const lockFile = await this.acquireLock();
    try {
      const current = await readUpstreamExtensions(this.lockfilePath);
      const paths = canonicalLockfileEntry({
        files,
        include: options?.include ?? [],
      });
      current[name] = {
        version,
        pulledAt: options?.pulledAt ?? new Date().toISOString(),
        files: [...paths.files].sort(),
        ...(paths.include.length > 0 ? { include: paths.include } : {}),
        ...(options?.checksum ? { checksum: options.checksum } : {}),
        ...(options?.filesChecksum
          ? { filesChecksum: options.filesChecksum }
          : {}),
        ...(options?.serverUrl ? { serverUrl: options.serverUrl } : {}),
        ...(options?.channel ? { channel: options.channel } : {}),
        ...(options?.publishedChannel
          ? { publishedChannel: options.publishedChannel }
          : {}),
      };
      await atomicWriteTextFile(
        this.lockfilePath,
        JSON.stringify(current, null, 2) + "\n",
      );
      this.cache = current;
    } finally {
      await this.releaseLock(lockFile);
    }
  }

  async removeEntry(name: string): Promise<void> {
    // mkdir mirrors writeEntry so a cleaned-up parent dir does not surface as
    // an unhelpful NotFound from acquireLock
    await Deno.mkdir(dirname(this.lockfilePath), { recursive: true });
    const lockFile = await this.acquireLock();
    try {
      const current = await readUpstreamExtensions(this.lockfilePath);
      delete current[name];
      await atomicWriteTextFile(
        this.lockfilePath,
        JSON.stringify(current, null, 2) + "\n",
      );
      this.cache = current;
    } finally {
      await this.releaseLock(lockFile);
    }
  }

  /**
   * restores entries exactly as read in one atomic write under the lock, so all
   * or none; unlike writeEntry it keeps file order, empty fields and unknown
   * keys
   */
  async restoreEntries(
    entries: Readonly<Record<string, UpstreamExtensionEntry | null>>,
  ): Promise<void> {
    await Deno.mkdir(dirname(this.lockfilePath), { recursive: true });
    const lockFile = await this.acquireLock();
    try {
      const current = await readUpstreamExtensions(this.lockfilePath);
      for (const [name, entry] of Object.entries(entries)) {
        if (entry === null) {
          delete current[name];
        } else {
          current[name] = canonicalLockfileEntry(structuredClone(entry));
        }
      }
      await atomicWriteTextFile(
        this.lockfilePath,
        JSON.stringify(current, null, 2) + "\n",
      );
      this.cache = current;
    } finally {
      await this.releaseLock(lockFile);
    }
  }

  async replaceAll(entries: UpstreamExtensionsMap): Promise<void> {
    await Deno.mkdir(dirname(this.lockfilePath), { recursive: true });
    const lockFile = await this.acquireLock();
    try {
      const canonical: UpstreamExtensionsMap = Object.fromEntries(
        Object.entries(entries).map((
          [name, entry],
        ) => [name, canonicalLockfileEntry(structuredClone(entry))]),
      );
      await atomicWriteTextFile(
        this.lockfilePath,
        JSON.stringify(canonical, null, 2) + "\n",
      );
      this.cache = canonical;
    } finally {
      await this.releaseLock(lockFile);
    }
  }

  /**
   * rewrites to canonical form (forward slashes, no bundle cache paths) so a
   * lockfile written on another OS does not show as changed; a missing or
   * canonical file is left alone
   */
  async normalize(): Promise<boolean> {
    // No lockfile, nothing to rewrite: don't create the lock's dir for it.
    try {
      await Deno.stat(this.lockfilePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
    const lockFile = await this.acquireLock();
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(await Deno.readTextFile(this.lockfilePath));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
      const current = await readUpstreamExtensions(this.lockfilePath);
      if (JSON.stringify(raw) === JSON.stringify(current)) {
        this.cache = current;
        return false;
      }
      // Sorted as writeEntry sorts them: "\" and "/" sort differently, so
      // the converted paths may be out of order.
      for (const entry of Object.values(current)) {
        const files: unknown = entry?.files;
        if (
          Array.isArray(files) && files.every((f) => typeof f === "string")
        ) {
          files.sort();
        }
      }
      await atomicWriteTextFile(
        this.lockfilePath,
        JSON.stringify(current, null, 2) + "\n",
      );
      this.cache = current;
      return true;
    } finally {
      await this.releaseLock(lockFile);
    }
  }

  private async acquireLock(): Promise<HeldLock> {
    const lockPath = lockfileAdvisoryLockPath(this.lockfilePath);
    await Deno.mkdir(dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
      try {
        return {
          path: lockPath,
          file: await Deno.open(lockPath, {
            create: true,
            createNew: true,
            write: true,
          }),
        };
      } catch (error) {
        const outcome = lockAttemptOutcome(
          error,
          attempt === LOCK_RETRY_COUNT - 1,
        );
        if (outcome === "retry") {
          await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
          continue;
        }
        if (outcome === "busy") {
          // UserError so the top-level handler renders a clean message instead
          // of a stack trace
          throw new UserError(
            "Could not acquire lock on upstream_extensions.json. Another operation may be in progress. Please retry.",
          );
        }
        throw error;
      }
    }
    throw new UserError(
      "Could not acquire lock on upstream_extensions.json.",
    );
  }

  private async releaseLock(lock: HeldLock): Promise<void> {
    lock.file.close();
    try {
      await Deno.remove(lock.path);
    } catch {
      // best-effort cleanup; the lockfile may already have been removed by a
      // concurrent process
    }
  }
}
