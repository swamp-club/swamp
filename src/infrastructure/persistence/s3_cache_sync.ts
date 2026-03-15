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

/**
 * S3 cache sync service for the S3 datastore.
 *
 * Maintains a local cache directory and syncs with S3:
 * - On startup: pulls metadata index (lightweight manifest)
 * - On read (cache miss): fetches specific file from S3
 * - On write: writes locally first, then pushes to S3 async
 * - `sync()`: full bidirectional sync
 */

import { dirname, join, normalize, relative } from "@std/path";
import { ensureDir, walk } from "@std/fs";
import type { S3Client } from "./s3_client.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";

/**
 * Validates that a relative path resolves within the cache directory.
 * Prevents path traversal attacks from malicious S3 keys.
 */
function assertSafePath(cachePath: string, relativePath: string): string {
  const resolved = normalize(join(cachePath, relativePath));
  const normalizedCache = normalize(cachePath);
  if (
    !resolved.startsWith(normalizedCache + "/") && resolved !== normalizedCache
  ) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  return resolved;
}

/**
 * Metadata index entry for a file in S3.
 */
interface IndexEntry {
  key: string;
  size: number;
  lastModified: string;
  localMtime?: string;
}

/**
 * Metadata index tracking all files in the S3 datastore.
 */
interface DatastoreIndex {
  version: 1;
  lastPulled: string;
  entries: Record<string, IndexEntry>;
}

/**
 * Push queue entry for files pending upload to S3.
 */
interface PushQueueEntry {
  relativePath: string;
  addedAt: string;
}

/**
 * Push queue tracking files pending upload.
 */
interface PushQueue {
  entries: PushQueueEntry[];
}

export interface SyncResult {
  filesPulled: number;
  filesPushed: number;
  errors: string[];
}

/**
 * S3 cache sync service.
 */
/** TTL in ms for using the local index cache instead of fetching from S3. */
const INDEX_CACHE_TTL_MS = 60_000;

/** Maximum number of concurrent S3 downloads/uploads. */
const MAX_CONCURRENCY = 10;

export class S3CacheSyncService {
  private readonly s3: S3Client;
  private readonly cachePath: string;
  private readonly indexPath: string;
  private readonly pushQueuePath: string;
  private index: DatastoreIndex | null = null;

  constructor(
    s3: S3Client,
    cachePath: string,
  ) {
    this.s3 = s3;
    this.cachePath = cachePath;
    this.indexPath = join(cachePath, ".datastore-index.json");
    this.pushQueuePath = join(cachePath, ".push-queue.json");
  }

  /**
   * Pulls the metadata index from S3 (lightweight, single GET).
   * Uses a local cache with a 60-second TTL to avoid redundant fetches
   * during rapid command sequences.
   */
  async pullIndex(): Promise<void> {
    // Check local cache freshness
    try {
      const stat = await Deno.stat(this.indexPath);
      const ageMs = Date.now() - (stat.mtime?.getTime() ?? 0);
      if (ageMs < INDEX_CACHE_TTL_MS && this.index === null) {
        const content = await Deno.readTextFile(this.indexPath);
        this.index = JSON.parse(content) as DatastoreIndex;
        return; // Fresh enough — skip S3
      }
    } catch {
      // No local index — fetch from S3
    }

    try {
      const data = await this.s3.getObject(".datastore-index.json");
      const text = new TextDecoder().decode(data);
      this.index = JSON.parse(text) as DatastoreIndex;
      await ensureDir(this.cachePath);
      await atomicWriteTextFile(this.indexPath, text);
    } catch {
      // No index exists yet - start fresh
      this.index = {
        version: 1,
        lastPulled: new Date().toISOString(),
        entries: {},
      };
    }
  }

  /**
   * Fetches a single file from S3 to the local cache.
   */
  async pullFile(relativePath: string): Promise<void> {
    const localPath = assertSafePath(this.cachePath, relativePath);
    const data = await this.s3.getObject(relativePath);
    await ensureDir(dirname(localPath));
    await Deno.writeFile(localPath, data);
  }

  /**
   * Pulls only new or modified files from S3 to the local cache.
   * Fetches the remote index, compares against local files, and only
   * downloads files that are missing locally or have a different size.
   */
  async pullChanged(): Promise<number> {
    await this.pullIndex();

    // Build list of files that need pulling
    const toPull: string[] = [];
    for (const [rel, entry] of Object.entries(this.index?.entries ?? {})) {
      const localPath = assertSafePath(this.cachePath, rel);
      try {
        const stat = await Deno.stat(localPath);
        if (stat.size === entry.size) {
          continue; // Unchanged
        }
      } catch {
        // File doesn't exist locally — needs pull
      }
      toPull.push(rel);
    }

    // Download concurrently in batches
    let pulled = 0;
    for (let i = 0; i < toPull.length; i += MAX_CONCURRENCY) {
      const batch = toPull.slice(i, i + MAX_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (rel) => {
          await this.pullFile(rel);
          // Store the pulled file's local mtime so subsequent pushes have a baseline
          try {
            const localPath = join(this.cachePath, rel);
            const stat = await Deno.stat(localPath);
            if (stat.mtime && this.index) {
              this.index.entries[rel].localMtime = stat.mtime.toISOString();
            }
          } catch {
            // Non-fatal: mtime recording is best-effort
          }
        }),
      );
      pulled += results.filter((r) => r.status === "fulfilled").length;
    }

    return pulled;
  }

  /**
   * Pulls only new or modified files from S3 for a specific model.
   *
   * Filters the index to entries whose key starts with the model prefix
   * (`data/{modelType}/{modelId}/`), then downloads only those that are
   * missing locally or have a different size.
   *
   * Used by per-model locking to avoid pulling the entire datastore.
   */
  async pullChangedForModel(
    modelType: string,
    modelId: string,
  ): Promise<number> {
    await this.pullIndex();

    const prefix = `data/${modelType}/${modelId}/`;

    // Build list of files that need pulling (model-scoped only)
    const toPull: string[] = [];
    for (const [rel, entry] of Object.entries(this.index?.entries ?? {})) {
      if (!rel.startsWith(prefix)) continue;

      const localPath = assertSafePath(this.cachePath, rel);
      try {
        const stat = await Deno.stat(localPath);
        if (stat.size === entry.size) {
          continue; // Unchanged
        }
      } catch {
        // File doesn't exist locally — needs pull
      }
      toPull.push(rel);
    }

    // Download concurrently in batches
    let pulled = 0;
    for (let i = 0; i < toPull.length; i += MAX_CONCURRENCY) {
      const batch = toPull.slice(i, i + MAX_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (rel) => {
          await this.pullFile(rel);
          // Store the pulled file's local mtime so subsequent pushes have a baseline
          try {
            const localPath = join(this.cachePath, rel);
            const stat = await Deno.stat(localPath);
            if (stat.mtime && this.index) {
              this.index.entries[rel].localMtime = stat.mtime.toISOString();
            }
          } catch {
            // Non-fatal: mtime recording is best-effort
          }
        }),
      );
      pulled += results.filter((r) => r.status === "fulfilled").length;
    }

    return pulled;
  }

  /**
   * Downloads all files from S3 to the local cache.
   */
  async pullAll(): Promise<number> {
    const keys = (await this.s3.listAllObjects()).filter(
      (key) => key !== ".datastore-index.json" && key !== ".push-queue.json",
    );

    let count = 0;
    for (let i = 0; i < keys.length; i += MAX_CONCURRENCY) {
      const batch = keys.slice(i, i + MAX_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((key) => this.pullFile(key)),
      );
      count += results.filter((r) => r.status === "fulfilled").length;
    }
    return count;
  }

  /**
   * Pushes a single file from the local cache to S3.
   */
  async pushFile(relativePath: string): Promise<void> {
    const localPath = assertSafePath(this.cachePath, relativePath);
    const data = await Deno.readFile(localPath);
    await this.s3.putObject(relativePath, data);

    // Update index with size and local mtime
    if (this.index) {
      const stat = await Deno.stat(localPath);
      this.index.entries[relativePath] = {
        key: relativePath,
        size: data.length,
        lastModified: new Date().toISOString(),
        localMtime: stat.mtime?.toISOString(),
      };
    }
  }

  /**
   * Adds a file to the push queue for async upload.
   */
  async enqueuePush(relativePath: string): Promise<void> {
    const queue = await this.loadPushQueue();
    // Avoid duplicates
    if (!queue.entries.some((e) => e.relativePath === relativePath)) {
      queue.entries.push({
        relativePath,
        addedAt: new Date().toISOString(),
      });
      await this.savePushQueue(queue);
    }
  }

  /**
   * Flushes all pending pushes to S3.
   */
  async pushPending(): Promise<number> {
    const queue = await this.loadPushQueue();
    let pushed = 0;
    const remaining: PushQueueEntry[] = [];

    // Upload concurrently in batches
    for (let i = 0; i < queue.entries.length; i += MAX_CONCURRENCY) {
      const batch = queue.entries.slice(i, i + MAX_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((entry) => this.pushFile(entry.relativePath)),
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "fulfilled") {
          pushed++;
        } else {
          remaining.push(batch[j]);
        }
      }
    }

    queue.entries = remaining;
    await this.savePushQueue(queue);

    // Push updated index (both remote and local cache)
    if (this.index) {
      this.index.lastPulled = new Date().toISOString();
      const indexJson = JSON.stringify(this.index, null, 2);
      const indexData = new TextEncoder().encode(indexJson);
      await this.s3.putObject(".datastore-index.json", indexData);
      await atomicWriteTextFile(this.indexPath, indexJson);
    }

    return pushed;
  }

  /**
   * Pushes only new or modified files from the local cache to S3.
   * Compares each file's size against the index to detect changes.
   * Returns the number of files pushed.
   */
  async pushChanged(): Promise<number> {
    await this.loadIndex();

    // Build list of files that need pushing
    const toPush: string[] = [];
    try {
      for await (
        const entry of walk(this.cachePath, {
          includeDirs: false,
        })
      ) {
        const rel = relative(this.cachePath, entry.path);
        // Skip internal metadata files
        if (
          rel === ".datastore-index.json" || rel === ".push-queue.json" ||
          rel === ".datastore.lock"
        ) {
          continue;
        }

        // Check if file is new or has changed (size + mtime comparison)
        const stat = await Deno.stat(entry.path);
        const existing = this.index?.entries[rel];
        if (existing && existing.size === stat.size) {
          // Size matches — also check mtime if available
          if (
            existing.localMtime && stat.mtime &&
            existing.localMtime === stat.mtime.toISOString()
          ) {
            continue; // Both size and mtime match — unchanged
          }
          // If no localMtime recorded (old index format), fall back to size-only
          if (!stat.mtime || existing.localMtime === undefined) {
            continue;
          }
        }

        toPush.push(rel);
      }
    } catch {
      // Cache directory may not exist yet
    }

    // Upload concurrently in batches
    let pushed = 0;
    for (let i = 0; i < toPush.length; i += MAX_CONCURRENCY) {
      const batch = toPush.slice(i, i + MAX_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((rel) => this.pushFile(rel)),
      );
      pushed += results.filter((r) => r.status === "fulfilled").length;
    }

    // Push updated index if anything changed.
    // The global distributed lock guarantees no concurrent writers,
    // so we upload the local index directly — no remote merge needed.
    if (pushed > 0 && this.index) {
      this.index.lastPulled = new Date().toISOString();
      const indexJson = JSON.stringify(this.index, null, 2);
      const indexData = new TextEncoder().encode(indexJson);
      await this.s3.putObject(".datastore-index.json", indexData);
      // Also update the local cache
      await atomicWriteTextFile(this.indexPath, indexJson);
    }

    return pushed;
  }

  /**
   * Pushes all files from the local cache directory to S3.
   * Used for initial migration when setting up an S3 datastore.
   */
  async pushAll(): Promise<number> {
    await this.pullIndex();

    // Build list of files to push
    const toPush: string[] = [];
    try {
      for await (
        const entry of walk(this.cachePath, {
          includeDirs: false,
        })
      ) {
        const rel = relative(this.cachePath, entry.path);
        // Skip internal metadata files
        if (
          rel === ".datastore-index.json" || rel === ".push-queue.json" ||
          rel === ".datastore.lock"
        ) {
          continue;
        }
        toPush.push(rel);
      }
    } catch {
      // Cache directory may not exist yet
    }

    // Upload concurrently in batches
    let pushed = 0;
    for (let i = 0; i < toPush.length; i += MAX_CONCURRENCY) {
      const batch = toPush.slice(i, i + MAX_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((rel) => this.pushFile(rel)),
      );
      pushed += results.filter((r) => r.status === "fulfilled").length;
    }

    // Push updated index (both remote and local cache)
    if (this.index) {
      this.index.lastPulled = new Date().toISOString();
      const indexJson = JSON.stringify(this.index, null, 2);
      const indexData = new TextEncoder().encode(indexJson);
      await this.s3.putObject(".datastore-index.json", indexData);
      await atomicWriteTextFile(this.indexPath, indexJson);
    }

    return pushed;
  }

  /**
   * Full bidirectional sync: pull all + push pending.
   */
  async sync(): Promise<SyncResult> {
    const errors: string[] = [];
    let filesPulled = 0;
    let filesPushed = 0;

    try {
      await this.pullIndex();
    } catch (error) {
      errors.push(
        `Failed to pull index: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      filesPulled = await this.pullAll();
    } catch (error) {
      errors.push(
        `Failed to pull files: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      filesPushed = await this.pushPending();
    } catch (error) {
      errors.push(
        `Failed to push pending: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return { filesPulled, filesPushed, errors };
  }

  /**
   * Returns the local cache path for a given relative path.
   * Used by the write observer to determine the cache file path.
   */
  getCachePath(relativePath: string): string {
    return assertSafePath(this.cachePath, relativePath);
  }

  /**
   * Computes the relative path from the cache directory.
   */
  getRelativePath(absolutePath: string): string {
    return relative(this.cachePath, absolutePath);
  }

  private async loadIndex(): Promise<void> {
    if (this.index) return;
    try {
      const content = await Deno.readTextFile(this.indexPath);
      this.index = JSON.parse(content) as DatastoreIndex;
    } catch {
      this.index = {
        version: 1,
        lastPulled: new Date().toISOString(),
        entries: {},
      };
    }
  }

  private async loadPushQueue(): Promise<PushQueue> {
    try {
      const content = await Deno.readTextFile(this.pushQueuePath);
      return JSON.parse(content) as PushQueue;
    } catch {
      return { entries: [] };
    }
  }

  private async savePushQueue(queue: PushQueue): Promise<void> {
    await ensureDir(this.cachePath);
    await atomicWriteTextFile(
      this.pushQueuePath,
      JSON.stringify(queue, null, 2),
    );
  }
}
