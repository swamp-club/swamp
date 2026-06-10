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
import {
  readUpstreamExtensions,
  type UpstreamExtensionEntry,
  type UpstreamExtensionsMap,
} from "./upstream_extensions.ts";

const LOCK_RETRY_COUNT = 10;
const LOCK_RETRY_DELAY_MS = 100;

/** Options accepted by {@link LockfileRepository.writeEntry}. */
export interface WriteEntryOptions {
  include?: string[];
  checksum?: string;
  filesChecksum?: string;
  serverUrl?: string;
  channel?: string;
}

/**
 * Sole gateway for read+write of `upstream_extensions.json` (the lockfile).
 *
 * **Asymmetric semantics — read carefully.**
 *
 * The repository captures a snapshot of the lockfile at construction time.
 * The intent is to preserve the W1b "snapshot frozen at construction"
 * contract that {@link ExtensionRepository} relies on (see its JSDoc) — the
 * snapshot now lives one layer out, but the contract is identical: two
 * repository instances constructed at different wall-clock times can see
 * different states. To refresh, construct a new instance.
 *
 * - **Reads** ({@link getEntry}, {@link getAllEntries},
 *   {@link getLockedVersion}) serve from the construction-time cache. They
 *   do NOT hit disk; subsequent disk mutations by sibling processes /
 *   instances are NOT reflected.
 *
 * - **Writes** ({@link writeEntry}, {@link removeEntry}) acquire the
 *   advisory file lock, re-read the CURRENT disk state, merge the new
 *   entry, atomic-write the merged result, release the lock, and update
 *   this instance's local cache to match. This preserves the
 *   pre-LockfileRepository concurrency semantic: two concurrent writers
 *   don't clobber each other; each sees the other's prior commits via the
 *   re-read step. The local cache update means the writer can read its
 *   own write back from this same instance.
 *
 * Future contributors: do NOT "fix" the cached read to be live. The
 * snapshot semantics are deliberate. If a caller needs current disk state,
 * they construct a new {@link LockfileRepository}.
 *
 * Filed as the W2 prequel for swamp-club#231.
 */
export class LockfileRepository {
  readonly lockfilePath: string;
  private cache: UpstreamExtensionsMap;

  /**
   * Captures a snapshot of the lockfile at this moment. A missing file
   * yields an empty cache (matches {@link readUpstreamExtensions}'s
   * NotFound semantics).
   */
  static async create(lockfilePath: string): Promise<LockfileRepository> {
    const cache = await readUpstreamExtensions(lockfilePath);
    return new LockfileRepository(lockfilePath, cache);
  }

  /**
   * Constructs an instance with an explicit cache. Prefer
   * {@link LockfileRepository.create} for production code; this constructor
   * is the test seam for fixtures that need a known starting state without
   * touching disk.
   */
  constructor(lockfilePath: string, cache: UpstreamExtensionsMap = {}) {
    this.lockfilePath = lockfilePath;
    this.cache = cache;
  }

  /** Returns the cached entry for `name`, or null if absent. */
  getEntry(name: string): UpstreamExtensionEntry | null {
    return this.cache[name] ?? null;
  }

  /**
   * Returns the cached entry map. Callers receive a defensive deep copy
   * so external mutation — including pushing into nested `files[]` /
   * `include[]` arrays — cannot corrupt the cache. `structuredClone`
   * (in scope on Deno via the global) covers every value shape the
   * lockfile carries today (strings, arrays of strings, booleans).
   */
  getAllEntries(): UpstreamExtensionsMap {
    return structuredClone(this.cache);
  }

  /**
   * Returns the version string for `name`, or null if absent. Sugar over
   * `getEntry(name)?.version ?? null`. Replaces the W1b
   * `getLockedVersion` closure injected into {@link ExtensionRepository}.
   */
  getLockedVersion(name: string): string | null {
    return this.cache[name]?.version ?? null;
  }

  /**
   * Writes a new lockfile entry. Acquires the advisory lock, re-reads
   * disk under the lock (so concurrent writes by siblings are not
   * clobbered), merges, atomic-writes, releases the lock, and updates
   * this instance's cache to match.
   */
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
      current[name] = {
        version,
        pulledAt: new Date().toISOString(),
        files,
        ...(options?.include && options.include.length > 0
          ? { include: options.include }
          : {}),
        ...(options?.checksum ? { checksum: options.checksum } : {}),
        ...(options?.filesChecksum
          ? { filesChecksum: options.filesChecksum }
          : {}),
        ...(options?.serverUrl ? { serverUrl: options.serverUrl } : {}),
        ...(options?.channel ? { channel: options.channel } : {}),
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

  /**
   * Removes an entry by name. No-op if absent. Acquires the advisory
   * lock, re-reads disk under the lock, deletes the key, atomic-writes
   * the result, releases the lock, and updates this instance's cache.
   */
  async removeEntry(name: string): Promise<void> {
    // Symmetric with writeEntry — defensive against callers who removed
    // an extension in this process and the parent dir was cleaned up
    // between then and now. In practice unreachable today (rm.ts only
    // calls this after extensionRmPreview confirmed the entry exists,
    // which read the lockfile successfully) but the asymmetry would
    // surface as an unhelpful NotFound from acquireLock if it ever did.
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

  private async acquireLock(): Promise<Deno.FsFile> {
    const lockPath = `${this.lockfilePath}.lock`;
    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
      try {
        return await Deno.open(lockPath, {
          create: true,
          createNew: true,
          write: true,
        });
      } catch (error) {
        if (error instanceof Deno.errors.AlreadyExists) {
          if (attempt < LOCK_RETRY_COUNT - 1) {
            await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
            continue;
          }
          // UserError so the top-level handler renders the clean
          // message instead of a stack trace — matches the pre-W2-prequel
          // behavior in pull.ts (rm.ts threw plain Error; this
          // consolidates on the better UX).
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

  private async releaseLock(lockFile: Deno.FsFile): Promise<void> {
    lockFile.close();
    try {
      await Deno.remove(`${this.lockfilePath}.lock`);
    } catch {
      // Best-effort cleanup; the lockfile may have been removed by a
      // concurrent process or never created in the unhappy case.
    }
  }
}
