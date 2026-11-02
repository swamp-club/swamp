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
  ACCOUNT_NOTICE_KINDS,
  type AccountNotice,
  MAX_ACCOUNT_NOTICES,
} from "../../domain/account_notices/account_notice.ts";
import {
  type AccountNoticeCacheRepository,
  AccountNoticeState,
} from "../../domain/account_notices/account_notice_state.ts";
import {
  type InboxCacheKey,
  POLL_STOP_REASONS,
} from "../../domain/inbox/inbox_state.ts";
import {
  isBlankName,
  MAX_NOTICE_NAME_LENGTH,
  SLUG_RE,
  trustedBillingPath,
} from "../http/account_notice_schemas.ts";
import { PROSE_INVISIBLE_RE, sanitizeLine } from "../http/inbox_schemas.ts";
import { getSwampConfigDir } from "../persistence/paths.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";

const CACHE_DIR_NAME = "account-notices-v1";

// additive only; a breaking change moves to a new directory
const FORMAT_VERSION = 1;

const CACHE_FILE_MODE = 0o600;

const MAX_FILE_BYTES = 32 * 1024;

const MAX_KEYS = 8;

const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;
const CACHE_FILE_PATTERN = /^[0-9a-f]{32}\.json$/;
const SHOWN_KEY_PATTERN = /^(trial-ended|trial-ending):[a-z0-9_-]{1,64}$/;

// the name holds neither the server's URL nor anything of the key
async function cacheFileStem(key: InboxCacheKey): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${key.origin}\0${key.fingerprint}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const isoTime = z.string().refine((s) => {
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString() === s;
});

// the file is the user's to edit, so it is held to the server answer's rules
const storedNotice = z.object({
  kind: z.enum(ACCOUNT_NOTICE_KINDS),
  slug: z.string().regex(SLUG_RE),
  name: z.string().refine((n) =>
    !isBlankName(n) &&
    sanitizeLine(n, MAX_NOTICE_NAME_LENGTH, PROSE_INVISIBLE_RE) === n
  ),
  personal: z.boolean(),
  billingPath: z.string().refine((p) => trustedBillingPath(p) === p)
    .nullable(),
  endsAt: isoTime.optional(),
  daysRemaining: z.number().int().nonnegative().max(3650).optional(),
}).refine((n) =>
  n.kind === "trial-ended" ||
  (n.endsAt !== undefined && n.daysRemaining !== undefined)
);

const cacheFileSchema = z.object({
  version: z.literal(FORMAT_VERSION),
  snapshot: z.object({
    notices: z.array(storedNotice).max(MAX_ACCOUNT_NOTICES),
    fetchedAt: isoTime,
  }).nullable(),
  schedule: z.object({
    lastPolledAt: isoTime.nullable(),
    nextPollAt: isoTime.nullable(),
    stop: z.object({ reason: z.enum(POLL_STOP_REASONS), at: isoTime })
      .nullable(),
  }),
  shown: z.record(z.string().regex(SHOWN_KEY_PATTERN), isoTime),
});

type CacheFile = z.infer<typeof cacheFileSchema>;
type StoredNotice = z.infer<typeof storedNotice>;

function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function fromIso(iso: string | null): number | null {
  return iso === null ? null : Date.parse(iso);
}

function toStored(notice: AccountNotice): StoredNotice {
  const { collective, billingPath } = notice;
  return {
    kind: notice.kind,
    slug: collective.slug,
    name: collective.name,
    personal: collective.personal,
    billingPath,
    ...(notice.kind === "trial-ending"
      ? {
        endsAt: new Date(notice.endsAt).toISOString(),
        daysRemaining: notice.daysRemaining,
      }
      : {}),
  };
}

function fromStored(stored: StoredNotice): AccountNotice {
  const collective = {
    slug: stored.slug,
    name: stored.name,
    personal: stored.personal,
  };
  return stored.kind === "trial-ending"
    ? {
      kind: "trial-ending",
      collective,
      billingPath: stored.billingPath,
      endsAt: Date.parse(stored.endsAt!),
      daysRemaining: stored.daysRemaining!,
    }
    : { kind: "trial-ended", collective, billingPath: stored.billingPath };
}

function toCacheFile(state: AccountNoticeState): CacheFile {
  const { snapshot, schedule, shown } = state;
  return {
    version: FORMAT_VERSION,
    snapshot: snapshot === null ? null : {
      notices: snapshot.notices.map(toStored),
      fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
    },
    schedule: {
      lastPolledAt: toIso(schedule.lastPolledAt),
      nextPollAt: toIso(schedule.nextPollAt),
      stop: schedule.stop === null ? null : {
        reason: schedule.stop.reason,
        at: new Date(schedule.stop.at).toISOString(),
      },
    },
    shown: Object.fromEntries(
      Object.entries(shown).map((
        [key, at],
      ) => [key, new Date(at).toISOString()]),
    ),
  };
}

function fromCacheFile(file: CacheFile): AccountNoticeState {
  const { snapshot, schedule, shown } = file;
  return {
    snapshot: snapshot === null ? null : {
      notices: snapshot.notices.map(fromStored),
      fetchedAt: Date.parse(snapshot.fetchedAt),
    },
    schedule: {
      lastPolledAt: fromIso(schedule.lastPolledAt),
      nextPollAt: fromIso(schedule.nextPollAt),
      stop: schedule.stop === null
        ? null
        : { reason: schedule.stop.reason, at: Date.parse(schedule.stop.at) },
    },
    shown: Object.fromEntries(
      Object.entries(shown).map(([key, at]) => [key, Date.parse(at)]),
    ),
  };
}

export class AccountNoticeCacheFileRepository
  implements AccountNoticeCacheRepository {
  private readonly dir: string;

  constructor(configDir?: string) {
    this.dir = join(configDir ?? getSwampConfigDir(), CACHE_DIR_NAME);
  }

  async load(key: InboxCacheKey): Promise<AccountNoticeState> {
    if (!FINGERPRINT_PATTERN.test(key.fingerprint)) {
      return AccountNoticeState.empty();
    }
    try {
      const path = await this.pathFor(key);
      const info = await Deno.stat(path);
      if (!info.isFile || info.size > MAX_FILE_BYTES) {
        return AccountNoticeState.empty();
      }
      const bytes = await Deno.readFile(path);
      if (bytes.length > MAX_FILE_BYTES) return AccountNoticeState.empty();
      const parsed = cacheFileSchema.safeParse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      return parsed.success
        ? fromCacheFile(parsed.data)
        : AccountNoticeState.empty();
    } catch {
      return AccountNoticeState.empty();
    }
  }

  async save(key: InboxCacheKey, state: AccountNoticeState): Promise<void> {
    if (!FINGERPRINT_PATTERN.test(key.fingerprint)) {
      throw new Error("Account notice cache key is not an API-key fingerprint");
    }
    let content: string | undefined;
    try {
      const parsed = cacheFileSchema.safeParse(toCacheFile(state));
      if (parsed.success) content = JSON.stringify(parsed.data, null, 2);
    } catch {
      // a time outside the range a Date can hold
    }
    // measured in bytes, as load measures it, so whatever saves loads
    if (
      content === undefined ||
      new TextEncoder().encode(content).length > MAX_FILE_BYTES
    ) {
      throw new Error(
        "Account notice state is outside what the cache can store",
      );
    }
    await Deno.mkdir(this.dir, { recursive: true });
    const path = await this.pathFor(key);
    await atomicWriteTextFile(path, content, { mode: CACHE_FILE_MODE });
    await this.evictBeyondCap(basename(path));
  }

  async delete(key: InboxCacheKey): Promise<void> {
    // never a path built from anything but a fingerprint
    if (!FINGERPRINT_PATTERN.test(key.fingerprint)) return;
    try {
      await Deno.remove(await this.pathFor(key));
    } catch (error: unknown) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  // never throws
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

  // best effort: a key evicted by mistake only costs one extra poll
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
          // removed by another process since the listing
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
        // already gone, or held open on Windows; the next save tries again
      }
    }
  }
}
