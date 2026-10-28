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

import { basename, join } from "@std/path";
import { z } from "zod";
import {
  INBOX_ID_PATTERN,
  type InboxCacheKey,
  type InboxCacheRepository,
  InboxState,
  isStorableEtag,
  MAX_NEWEST_AT_LENGTH,
  POLL_STOP_REASONS,
} from "../../domain/inbox/inbox_state.ts";
import { getSwampConfigDir } from "../persistence/paths.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";

/**
 * `inbox/` held one file per fingerprint, shared by every server. Files here
 * are named per server and fingerprint, a breaking layout change, so older
 * swamps keep `inbox/` to themselves.
 */
const CACHE_DIR_NAME = "inbox-v2";

/** The first layout's directory: only ever removed from, on logout. */
const LEGACY_CACHE_DIR_NAME = "inbox";

/**
 * Version 1 changes are additive only, and every added field must be safe to
 * lose, since an older binary drops it when it saves. A breaking change moves
 * to a new directory instead, so installed versions never share a file.
 */
const FORMAT_VERSION = 1;

/** Owner read and write only, as `auth.json` is. */
const CACHE_FILE_MODE = 0o600;

const MAX_FILE_BYTES = 4096;

/** How many API keys keep state; the least recently saved is dropped. */
const MAX_KEYS = 8;

const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;
const CACHE_FILE_PATTERN = /^[0-9a-f]{32}\.json$/;

/**
 * The file name stem for a key: a hash of the origin and the fingerprint,
 * so the name holds neither the server's URL nor anything of the key.
 */
async function cacheFileStem(key: InboxCacheKey): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${key.origin}\0${key.fingerprint}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** An ISO 8601 time exactly as `Date.prototype.toISOString` writes it. */
const isoTime = z.string().refine((s) => {
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString() === s;
});

const inboxId = z.string().regex(INBOX_ID_PATTERN);

const cacheFileSchema = z.object({
  version: z.literal(FORMAT_VERSION),
  snapshot: z.object({
    unread: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    newestId: inboxId.nullable(),
    newestAt: z.string().max(MAX_NEWEST_AT_LENGTH).nullable(),
    pollAfterSeconds: z.number(),
    etag: z.string().refine(isStorableEtag).nullable(),
    fetchedAt: isoTime.optional(),
  }).nullable(),
  schedule: z.object({
    lastPolledAt: isoTime.nullable(),
    nextPollAt: isoTime.nullable(),
    stop: z.object({ reason: z.enum(POLL_STOP_REASONS), at: isoTime })
      .nullable(),
  }),
  announcement: z.object({ id: inboxId, at: isoTime }).nullable(),
});

type CacheFile = z.infer<typeof cacheFileSchema>;

function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function fromIso(iso: string | null): number | null {
  return iso === null ? null : Date.parse(iso);
}

function toCacheFile(state: InboxState): CacheFile {
  const { snapshot, schedule, announcement } = state;
  return {
    version: FORMAT_VERSION,
    snapshot: snapshot === null ? null : {
      unread: snapshot.unread,
      newestId: snapshot.newestId,
      newestAt: snapshot.newestAt,
      pollAfterSeconds: snapshot.pollAfterSeconds,
      etag: snapshot.etag,
      ...(snapshot.fetchedAt !== undefined
        ? { fetchedAt: new Date(snapshot.fetchedAt).toISOString() }
        : {}),
    },
    schedule: {
      lastPolledAt: toIso(schedule.lastPolledAt),
      nextPollAt: toIso(schedule.nextPollAt),
      stop: schedule.stop === null ? null : {
        reason: schedule.stop.reason,
        at: new Date(schedule.stop.at).toISOString(),
      },
    },
    announcement: announcement === null
      ? null
      : { id: announcement.id, at: new Date(announcement.at).toISOString() },
  };
}

function fromCacheFile(file: CacheFile): InboxState {
  const { snapshot, schedule, announcement } = file;
  return {
    snapshot: snapshot === null ? null : {
      unread: snapshot.unread,
      newestId: snapshot.newestId,
      newestAt: snapshot.newestAt,
      pollAfterSeconds: snapshot.pollAfterSeconds,
      etag: snapshot.etag,
      ...(snapshot.fetchedAt !== undefined
        ? { fetchedAt: Date.parse(snapshot.fetchedAt) }
        : {}),
    },
    schedule: {
      lastPolledAt: fromIso(schedule.lastPolledAt),
      nextPollAt: fromIso(schedule.nextPollAt),
      stop: schedule.stop === null
        ? null
        : { reason: schedule.stop.reason, at: Date.parse(schedule.stop.at) },
    },
    announcement: announcement === null
      ? null
      : { id: announcement.id, at: Date.parse(announcement.at) },
  };
}

/**
 * Keeps each API key's inbox state per server in its own file,
 * `inbox-v2/<hash>.json` under the swamp config directory, so saving one key
 * never touches another. Neither the key nor the server's URL is stored, and
 * files are readable by their owner only. Whether this process may write the
 * config directory is the caller's decision.
 */
export class InboxCacheFileRepository implements InboxCacheRepository {
  private readonly dir: string;
  private readonly legacyDir: string;

  /** `configDir` defaults to the swamp config directory. */
  constructor(configDir?: string) {
    const base = configDir ?? getSwampConfigDir();
    this.dir = join(base, CACHE_DIR_NAME);
    this.legacyDir = join(base, LEGACY_CACHE_DIR_NAME);
  }

  async load(key: InboxCacheKey): Promise<InboxState> {
    if (!FINGERPRINT_PATTERN.test(key.fingerprint)) return InboxState.empty();
    try {
      const path = await this.pathFor(key);
      const info = await Deno.stat(path);
      if (!info.isFile || info.size > MAX_FILE_BYTES) {
        return InboxState.empty();
      }
      const bytes = await Deno.readFile(path);
      if (bytes.length > MAX_FILE_BYTES) return InboxState.empty();
      const content = new TextDecoder().decode(bytes);
      const parsed = cacheFileSchema.safeParse(JSON.parse(content));
      return parsed.success ? fromCacheFile(parsed.data) : InboxState.empty();
    } catch {
      return InboxState.empty();
    }
  }

  async save(key: InboxCacheKey, state: InboxState): Promise<void> {
    if (!FINGERPRINT_PATTERN.test(key.fingerprint)) {
      throw new Error("Inbox cache key is not an API-key fingerprint");
    }
    let content: string | undefined;
    try {
      const parsed = cacheFileSchema.safeParse(toCacheFile(state));
      if (parsed.success) content = JSON.stringify(parsed.data, null, 2);
    } catch {
      // A time outside the range a Date can hold.
    }
    // Measured in bytes, as load measures the file, so whatever saves loads.
    if (
      content === undefined ||
      new TextEncoder().encode(content).length > MAX_FILE_BYTES
    ) {
      throw new Error("Inbox state is outside what the cache can store");
    }
    await Deno.mkdir(this.dir, { recursive: true });
    const path = await this.pathFor(key);
    await atomicWriteTextFile(path, content, { mode: CACHE_FILE_MODE });
    await this.evictBeyondCap(basename(path));
  }

  /**
   * Removes the key's file, and the first layout's file for its
   * fingerprint, which held the same key's state for every server.
   */
  async delete(key: InboxCacheKey): Promise<void> {
    // Never a path built from anything but a fingerprint.
    if (!FINGERPRINT_PATTERN.test(key.fingerprint)) return;
    const paths = [
      await this.pathFor(key),
      join(this.legacyDir, `${key.fingerprint}.json`),
    ];
    for (const path of paths) {
      try {
        await Deno.remove(path);
      } catch (error: unknown) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }

  /**
   * Whether this process can write the cache: creates the directory if it
   * is missing, then creates and removes a file there. The file's name never
   * matches a cache file, so eviction never counts it. Never throws.
   */
  async canWrite(): Promise<boolean> {
    try {
      await Deno.mkdir(this.dir, { recursive: true });
      const probe = await Deno.makeTempFile({
        dir: this.dir,
        prefix: ".probe-",
      });
      await Deno.remove(probe);
      return true;
    } catch {
      return false;
    }
  }

  private async pathFor(key: InboxCacheKey): Promise<string> {
    return join(this.dir, `${await cacheFileStem(key)}.json`);
  }

  /**
   * Best effort: a key evicted by mistake, or by a concurrent process, only
   * loads as empty and costs one extra poll.
   */
  private async evictBeyondCap(savedName: string): Promise<void> {
    const others: { name: string; modifiedAt: number }[] = [];
    try {
      for await (const entry of Deno.readDir(this.dir)) {
        if (
          !entry.isFile || entry.name === savedName ||
          !CACHE_FILE_PATTERN.test(entry.name)
        ) continue;
        try {
          const info = await Deno.stat(join(this.dir, entry.name));
          others.push({
            name: entry.name,
            modifiedAt: info.mtime?.getTime() ?? 0,
          });
        } catch {
          // Removed by another process since the listing.
        }
      }
    } catch {
      return;
    }
    const excess = others.length + 1 - MAX_KEYS;
    if (excess <= 0) return;
    others.sort((a, b) => a.modifiedAt - b.modifiedAt);
    for (const { name } of others.slice(0, excess)) {
      try {
        await Deno.remove(join(this.dir, name));
      } catch {
        // Already gone, or held open on Windows; the next save tries again.
      }
    }
  }
}
