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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { InboxCacheKey } from "../../domain/inbox/inbox_state.ts";
import { AccountNoticeState } from "../../domain/account_notices/account_notice_state.ts";
import { AccountNoticeCacheFileRepository } from "./account_notice_cache_file_repository.ts";

const FP_A = "0123456789abcdef";
const FP_B = "fedcba9876543210";
const PRODUCTION = "https://swamp-club.com";
const STAGING = "https://staging.swamp-club.com";
const KEY_A: InboxCacheKey = { origin: PRODUCTION, fingerprint: FP_A };
const KEY_B: InboxCacheKey = { origin: PRODUCTION, fingerprint: FP_B };
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

async function cachePath(dir: string, key: InboxCacheKey): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${key.origin}\0${key.fingerprint}`),
  );
  const stem = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return join(dir, "account-notices-v1", `${stem}.json`);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-notice-cache-" });
  try {
    await fn(dir);
  } finally {
    const cleanup = Deno.remove(dir, { recursive: true });
    await (Deno.build.os === "windows" ? cleanup.catch(() => {}) : cleanup);
  }
}

const fullState: AccountNoticeState = {
  snapshot: {
    notices: [
      {
        kind: "trial-ended",
        collective: { slug: "keeb", name: "keeb", personal: true },
        billingPath: "/billing",
      },
      {
        kind: "trial-ending",
        collective: { slug: "acme", name: "Acme Crew", personal: false },
        billingPath: null,
        endsAt: T0 + 3 * 86_400_000,
        daysRemaining: 3,
      },
    ],
    fetchedAt: T0,
  },
  schedule: {
    lastPolledAt: T0,
    nextPollAt: T0 + 60_000,
    stop: { reason: "rejected", at: T0 },
  },
  shown: { "trial-ended:keeb": T0 - 1000 },
};

Deno.test("AccountNoticeCacheFileRepository: round-trips a full state", async () => {
  await withTempDir(async (dir) => {
    const repo = new AccountNoticeCacheFileRepository(dir);
    await repo.save(KEY_A, fullState);
    assertEquals(await repo.load(KEY_A), fullState);
  });
});

Deno.test("AccountNoticeCacheFileRepository: a key never saved loads empty", async () => {
  await withTempDir(async (dir) => {
    const repo = new AccountNoticeCacheFileRepository(dir);
    assertEquals(await repo.load(KEY_A), AccountNoticeState.empty());
  });
});

Deno.test("AccountNoticeCacheFileRepository: keys and servers keep separate state", async () => {
  await withTempDir(async (dir) => {
    const repo = new AccountNoticeCacheFileRepository(dir);
    await repo.save(KEY_A, fullState);
    assertEquals(await repo.load(KEY_B), AccountNoticeState.empty());
    assertEquals(
      await repo.load({ origin: STAGING, fingerprint: FP_A }),
      AccountNoticeState.empty(),
    );
  });
});

Deno.test("AccountNoticeCacheFileRepository: the file holds neither the key nor the server", async () => {
  await withTempDir(async (dir) => {
    const repo = new AccountNoticeCacheFileRepository(dir);
    await repo.save(KEY_A, fullState);
    const path = await cachePath(dir, KEY_A);
    const text = await Deno.readTextFile(path);
    assert(!text.includes(FP_A));
    assert(!text.includes("swamp-club.com"));
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    }
  });
});

Deno.test("AccountNoticeCacheFileRepository: a corrupt or tampered file loads empty", async () => {
  await withTempDir(async (dir) => {
    const repo = new AccountNoticeCacheFileRepository(dir);
    await repo.save(KEY_A, fullState);
    const path = await cachePath(dir, KEY_A);
    const valid = JSON.parse(await Deno.readTextFile(path));
    const tampered = [
      "not json",
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({
        ...valid,
        snapshot: {
          ...valid.snapshot,
          notices: [{
            ...valid.snapshot.notices[0],
            billingPath: "https://evil.example",
          }],
        },
      }),
      JSON.stringify({
        ...valid,
        snapshot: {
          ...valid.snapshot,
          notices: [{ ...valid.snapshot.notices[1], endsAt: undefined }],
        },
      }),
      JSON.stringify({
        ...valid,
        shown: { "../x": valid.shown["trial-ended:keeb"] },
      }),
      JSON.stringify({
        ...valid,
        snapshot: {
          ...valid.snapshot,
          notices: [{ ...valid.snapshot.notices[0], name: "\u001b[31mkeeb" }],
        },
      }),
      " ".repeat(40 * 1024),
    ];
    for (const content of tampered) {
      await Deno.writeTextFile(path, content);
      assertEquals(
        await repo.load(KEY_A),
        AccountNoticeState.empty(),
        content.slice(0, 40),
      );
    }
  });
});

Deno.test("AccountNoticeCacheFileRepository: refuses a key that is not a fingerprint", async () => {
  await withTempDir(async (dir) => {
    const repo = new AccountNoticeCacheFileRepository(dir);
    const bad = { origin: PRODUCTION, fingerprint: "../../etc" };
    await assertRejects(() => repo.save(bad, fullState));
    assertEquals(await repo.load(bad), AccountNoticeState.empty());
    await repo.delete(bad);
  });
});

Deno.test("AccountNoticeCacheFileRepository: refuses to save state it could not load back", async () => {
  await withTempDir(async (dir) => {
    const repo = new AccountNoticeCacheFileRepository(dir);
    await assertRejects(() =>
      repo.save(KEY_A, {
        ...fullState,
        schedule: { ...fullState.schedule, lastPolledAt: 8.64e15 + 1 },
      })
    );
  });
});

Deno.test("AccountNoticeCacheFileRepository: delete forgets the key and tolerates no file", async () => {
  await withTempDir(async (dir) => {
    const repo = new AccountNoticeCacheFileRepository(dir);
    await repo.save(KEY_A, fullState);
    await repo.delete(KEY_A);
    assertEquals(await repo.load(KEY_A), AccountNoticeState.empty());
    await repo.delete(KEY_A);
  });
});

Deno.test("AccountNoticeCacheFileRepository: keeps at most eight keys, dropping the oldest", async () => {
  await withTempDir(async (dir) => {
    const repo = new AccountNoticeCacheFileRepository(dir);
    const keys = Array.from({ length: 9 }, (_, i) => ({
      origin: PRODUCTION,
      fingerprint: i.toString(16).padStart(16, "0"),
    }));
    for (const [i, key] of keys.entries()) {
      await repo.save(key, fullState);
      const seconds = (T0 + i * 1000) / 1000;
      await Deno.utime(await cachePath(dir, key), seconds, seconds);
    }
    assertEquals(await repo.load(keys[0]), AccountNoticeState.empty());
    assertEquals(await repo.load(keys[8]), fullState);
  });
});

Deno.test("AccountNoticeCacheFileRepository: canWrite reports a writable directory", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await new AccountNoticeCacheFileRepository(dir).canWrite(),
      true,
    );
  });
});
