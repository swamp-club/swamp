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

import { join } from "@std/path";
import { z } from "zod";
import {
  INBOX_ID_PATTERN,
  type InboxCacheRepository,
  InboxState,
  isStorableEtag,
  MAX_NEWEST_AT_LENGTH,
  POLL_STOP_REASONS,
} from "../../domain/inbox/inbox_state.ts";
import { getSwampConfigDir } from "../persistence/paths.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";

const CACHE_DIR_NAME = "inbox";

/**
 * Version 1 changes are additive only, and every added field must be safe to
 * lose, since an older binary drops it when it saves. A breaking change moves
 * to a new directory instead, so installed versions never share a file.
 */
const FORMAT_VERSION = 1;

const MAX_FILE_BYTES = 4096;

/** How many API keys keep state; the least recently saved is dropped. */
const MAX_KEYS = 8;

const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;
const CACHE_FILE_PATTERN = /^[0-9a-f]{16}\.json$/;

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
  const { schedule, announcement } = state;
  return {
    version: FORMAT_VERSION,
    snapshot: state.snapshot,
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
  const { schedule, announcement } = file;
  return {
    snapshot: file.snapshot,
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
 * Keeps each API key's inbox state in its own file, `inbox/<fingerprint>.json`
 * under the swamp config directory, so saving one key never touches another.
 * Only the fingerprint is stored, never the key. Whether this process may write
 * the config directory is the caller's decision.
 */
export class InboxCacheFileRepository implements InboxCacheRepository {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(getSwampConfigDir(), CACHE_DIR_NAME);
  }

  async load(fingerprint: string): Promise<InboxState> {
    if (!FINGERPRINT_PATTERN.test(fingerprint)) return InboxState.empty();
    try {
      const path = this.pathFor(fingerprint);
      const info = await Deno.stat(path);
      if (!info.isFile || info.size > MAX_FILE_BYTES) {
        return InboxState.empty();
      }
      const content = await Deno.readTextFile(path);
      if (content.length > MAX_FILE_BYTES) return InboxState.empty();
      const parsed = cacheFileSchema.safeParse(JSON.parse(content));
      return parsed.success ? fromCacheFile(parsed.data) : InboxState.empty();
    } catch {
      return InboxState.empty();
    }
  }

  async save(fingerprint: string, state: InboxState): Promise<void> {
    if (!FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new Error("Inbox cache key is not an API-key fingerprint");
    }
    let content: string | undefined;
    try {
      const parsed = cacheFileSchema.safeParse(toCacheFile(state));
      if (parsed.success) content = JSON.stringify(parsed.data, null, 2);
    } catch {
      // A time outside the range a Date can hold.
    }
    if (content === undefined || content.length > MAX_FILE_BYTES) {
      throw new Error("Inbox state is outside what the cache can store");
    }
    await Deno.mkdir(this.dir, { recursive: true });
    await atomicWriteTextFile(this.pathFor(fingerprint), content);
    await this.evictBeyondCap(fingerprint);
  }

  private pathFor(fingerprint: string): string {
    return join(this.dir, `${fingerprint}.json`);
  }

  /**
   * Best effort: a key evicted by mistake, or by a concurrent process, only
   * loads as empty and costs one extra poll.
   */
  private async evictBeyondCap(saved: string): Promise<void> {
    const savedName = `${saved}.json`;
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
