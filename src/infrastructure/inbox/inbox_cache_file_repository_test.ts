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
import { basename, join } from "@std/path";
import fc from "fast-check";
import {
  type InboxCacheKey,
  type InboxSnapshot,
  InboxState,
  MAX_ETAG_LENGTH,
  POLL_STOP_REASONS,
} from "../../domain/inbox/inbox_state.ts";
import { InboxCacheFileRepository } from "./inbox_cache_file_repository.ts";

const FP_A = "0123456789abcdef";
const FP_B = "fedcba9876543210";
const PRODUCTION = "https://swamp-club.com";
const STAGING = "https://staging.swamp-club.com";
const KEY_A: InboxCacheKey = { origin: PRODUCTION, fingerprint: FP_A };
const KEY_B: InboxCacheKey = { origin: PRODUCTION, fingerprint: FP_B };

/** Where the repository keeps a key's file under a config dir. */
async function cachePath(dir: string, key: InboxCacheKey): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${key.origin}\0${key.fingerprint}`),
  );
  const stem = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return join(dir, "inbox-v2", `${stem}.json`);
}
const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
const ID_A = "01JBQ0000000000000000000AA";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-inbox-cache-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function snapshot(overrides: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return {
    unread: 2,
    newestId: ID_A,
    newestAt: "2026-10-27T11:00:00Z",
    pollAfterSeconds: 1800,
    etag: '"e1"',
    ...overrides,
  };
}

const fullState: InboxState = {
  snapshot: snapshot(),
  schedule: {
    lastPolledAt: T0,
    nextPollAt: T0 + 7_200_000,
    stop: { reason: "rejected", at: T0 + 1 },
  },
  announcement: { id: ID_A, at: T0 - 60_000 },
};

async function listNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

Deno.test("InboxCacheFileRepository: round-trips a full state", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    await repo.save(KEY_A, fullState);
    assertEquals(await repo.load(KEY_A), fullState);
  });
});

Deno.test("InboxCacheFileRepository: a missing file or directory loads as empty", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    assertEquals(await repo.load(KEY_A), InboxState.empty());
  });
});

Deno.test("InboxCacheFileRepository: corrupt, over-size and unrecognised files load as empty", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    await repo.save(KEY_A, fullState);
    const path = await cachePath(dir, KEY_A);
    const valid = JSON.parse(await Deno.readTextFile(path));
    const bad: string[] = [
      "not json",
      JSON.stringify({ ...valid, padding: "x".repeat(5000) }),
      // Under the limit in characters, over it in bytes.
      JSON.stringify({ ...valid, padding: "é".repeat(2100) }),
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, version: undefined }),
      JSON.stringify([valid]),
    ];
    for (const content of bad) {
      await Deno.writeTextFile(path, content);
      assertEquals(await repo.load(KEY_A), InboxState.empty(), content);
    }
  });
});

Deno.test("InboxCacheFileRepository: a field outside its bounds loads as empty", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    await repo.save(KEY_A, fullState);
    const path = await cachePath(dir, KEY_A);
    const valid = JSON.parse(await Deno.readTextFile(path));
    const variants: unknown[] = [
      { ...valid, snapshot: { ...valid.snapshot, unread: -1 } },
      { ...valid, snapshot: { ...valid.snapshot, unread: 1.5 } },
      {
        ...valid,
        snapshot: { ...valid.snapshot, newestId: "01jbq0000000000000000000aa" },
      },
      { ...valid, snapshot: { ...valid.snapshot, newestId: "x".repeat(5000) } },
      { ...valid, snapshot: { ...valid.snapshot, newestAt: "x".repeat(65) } },
      {
        ...valid,
        snapshot: { ...valid.snapshot, etag: "x".repeat(MAX_ETAG_LENGTH + 1) },
      },
      { ...valid, snapshot: { ...valid.snapshot, etag: '"a\nb"' } },
      { ...valid, snapshot: { ...valid.snapshot, pollAfterSeconds: "900" } },
      { ...valid, schedule: { ...valid.schedule, lastPolledAt: "yesterday" } },
      { ...valid, schedule: { ...valid.schedule, nextPollAt: "2026-10-27" } },
      {
        ...valid,
        schedule: {
          ...valid.schedule,
          stop: { reason: "bored", at: valid.schedule.stop.at },
        },
      },
      // A 404 no longer stops a key, so a stored one reads as never polled.
      {
        ...valid,
        schedule: {
          ...valid.schedule,
          stop: { reason: "unsupported", at: valid.schedule.stop.at },
        },
      },
      { ...valid, announcement: { id: ID_A, at: 12345 } },
    ];
    for (const variant of variants) {
      await Deno.writeTextFile(path, JSON.stringify(variant));
      assertEquals(
        await repo.load(KEY_A),
        InboxState.empty(),
        JSON.stringify(variant),
      );
    }
  });
});

Deno.test("InboxCacheFileRepository: a malformed fingerprint loads as empty, refuses to save and writes nothing", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    for (
      const fingerprint of [
        "",
        "0123456789ABCDEF",
        "0123456789abcde",
        "../0123456789abc",
        "..",
        "a/b",
        "a\\b",
      ]
    ) {
      const key = { origin: PRODUCTION, fingerprint };
      assertEquals(await repo.load(key), InboxState.empty());
      await assertRejects(() => repo.save(key, fullState));
      await repo.delete(key);
    }
    assertEquals(await listNames(dir), []);
  });
});

Deno.test("InboxCacheFileRepository: keys keep independent state", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    await repo.save(KEY_A, fullState);
    const before = await Deno.readTextFile(await cachePath(dir, KEY_A));
    const other = { ...InboxState.empty(), snapshot: snapshot({ unread: 9 }) };
    await repo.save(KEY_B, other);
    assertEquals(await repo.load(KEY_A), fullState);
    assertEquals(await repo.load(KEY_B), other);
    assertEquals(await Deno.readTextFile(await cachePath(dir, KEY_A)), before);
  });
});

Deno.test("InboxCacheFileRepository: keeps at most 8 keys, dropping the oldest and never the one just saved", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    const cacheDir = join(dir, "inbox-v2");
    const keys: InboxCacheKey[] = Array.from(
      { length: 9 },
      (_, i) => ({
        origin: PRODUCTION,
        fingerprint: i.toString(16).padStart(16, "0"),
      }),
    );
    for (const [i, key] of keys.slice(0, 8).entries()) {
      await repo.save(key, fullState);
      // The first key is the oldest; the rest are newer than the ninth.
      const at = new Date(i === 0 ? T0 - 1_000_000 : T0 + 1_000_000 + i);
      await Deno.utime(await cachePath(dir, key), at, at);
    }
    await Deno.writeTextFile(join(cacheDir, ".leftover.tmp"), "{}");
    await repo.save(keys[8], fullState);
    const names = await listNames(cacheDir);
    const kept = await Promise.all(
      keys.slice(1).map(async (k) => basename(await cachePath(dir, k))),
    );
    assertEquals(names, [".leftover.tmp", ...kept].sort());
    assertEquals(await repo.load(keys[0]), InboxState.empty());
    assertEquals(await repo.load(keys[8]), fullState);
  });
});

Deno.test("InboxCacheFileRepository: refuses a state it could not load back", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    const unstorable: InboxState[] = [
      {
        ...fullState,
        snapshot: snapshot({ etag: "x".repeat(MAX_ETAG_LENGTH + 1) }),
      },
      { ...fullState, snapshot: snapshot({ unread: -1 }) },
      { ...fullState, snapshot: snapshot({ pollAfterSeconds: NaN }) },
      { ...fullState, schedule: { ...fullState.schedule, lastPolledAt: NaN } },
      { ...fullState, announcement: { id: "not-a-ulid", at: T0 } },
    ];
    for (const state of unstorable) {
      await assertRejects(() => repo.save(KEY_A, state));
    }
    assertEquals(await listNames(dir), []);
  });
});

Deno.test("InboxCacheFileRepository: a save leaves no temp file and stores no API key", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    await repo.save(KEY_A, fullState);
    await repo.save(KEY_A, fullState);
    const path = await cachePath(dir, KEY_A);
    assertEquals(await listNames(join(dir, "inbox-v2")), [basename(path)]);
    const content = await Deno.readTextFile(path);
    assertEquals(content.includes("apiKey"), false);
    assertEquals(content.includes("swamp_"), false);
    assertEquals(content.includes(PRODUCTION), false);
    assertEquals(content.includes(FP_A), false);
  });
});

const ulid = fc.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const time = fc.integer({ min: 0, max: Date.UTC(2200, 0, 1) });

const storableState: fc.Arbitrary<InboxState> = fc.record({
  snapshot: fc.option(
    fc.record({
      unread: fc.nat(),
      newestId: fc.option(ulid),
      newestAt: fc.option(fc.string({ maxLength: 64 })),
      // JSON writes -0 as 0.
      pollAfterSeconds: fc.double({ noNaN: true, noDefaultInfinity: true })
        .map((n) => n === 0 ? 0 : n),
      etag: fc.option(
        fc.stringMatching(/^[\x20-\x7e]{1,256}$/),
      ),
      fetchedAt: fc.option(time, { nil: undefined }),
    }).map((snap) => {
      // An absent fetchedAt is left out, as a file without the field loads.
      const { fetchedAt, ...rest } = snap;
      return fetchedAt === undefined ? rest : { ...rest, fetchedAt };
    }),
  ),
  schedule: fc.record({
    lastPolledAt: fc.option(time),
    nextPollAt: fc.option(time),
    stop: fc.option(
      fc.record({ reason: fc.constantFrom(...POLL_STOP_REASONS), at: time }),
    ),
  }),
  announcement: fc.option(fc.record({ id: ulid, at: time })),
});

Deno.test("InboxCacheFileRepository (property): every storable state loads back unchanged", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    await fc.assert(
      fc.asyncProperty(storableState, async (state) => {
        await repo.save(KEY_A, state);
        assertEquals(await repo.load(KEY_A), state);
      }),
      { numRuns: 200 },
    );
  });
});

Deno.test("InboxCacheFileRepository: one fingerprint keeps separate state per server", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    const staging: InboxCacheKey = { origin: STAGING, fingerprint: FP_A };
    const stopped: InboxState = {
      ...InboxState.empty(),
      schedule: {
        lastPolledAt: T0,
        nextPollAt: null,
        stop: { reason: "rejected", at: T0 },
      },
    };
    await repo.save(staging, stopped);
    await repo.save(KEY_A, fullState);
    assertEquals(await repo.load(staging), stopped);
    assertEquals(await repo.load(KEY_A), fullState);
    assert(
      (await cachePath(dir, staging)) !== (await cachePath(dir, KEY_A)),
    );
  });
});

Deno.test("InboxCacheFileRepository: writes under inbox-v2 and never reads the first layout", async () => {
  await withTempDir(async (dir) => {
    const legacy = join(dir, "inbox", `${FP_A}.json`);
    await Deno.mkdir(join(dir, "inbox"));
    await Deno.writeTextFile(legacy, "{}");
    const repo = new InboxCacheFileRepository(dir);
    assertEquals(await repo.load(KEY_A), InboxState.empty());
    await repo.save(KEY_A, fullState);
    assertEquals(await Deno.readTextFile(legacy), "{}");
    assert((await Deno.stat(await cachePath(dir, KEY_A))).isFile);
  });
});

Deno.test({
  name:
    "InboxCacheFileRepository: cache files are readable by their owner only",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const repo = new InboxCacheFileRepository(dir);
      await repo.save(KEY_A, fullState);
      // Saved again over an existing file, too.
      await repo.save(KEY_A, fullState);
      const info = await Deno.stat(await cachePath(dir, KEY_A));
      assertEquals(info.mode! & 0o777, 0o600);
    });
  },
});

Deno.test("InboxCacheFileRepository: delete removes the key's file and its first-layout file only", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    const staging: InboxCacheKey = { origin: STAGING, fingerprint: FP_A };
    await repo.save(KEY_A, fullState);
    await repo.save(staging, fullState);
    await repo.save(KEY_B, fullState);
    await Deno.mkdir(join(dir, "inbox"));
    await Deno.writeTextFile(join(dir, "inbox", `${FP_A}.json`), "{}");
    await Deno.writeTextFile(join(dir, "inbox", `${FP_B}.json`), "{}");
    await repo.delete(KEY_A);
    assertEquals(await repo.load(KEY_A), InboxState.empty());
    assertEquals(await repo.load(staging), fullState);
    assertEquals(await repo.load(KEY_B), fullState);
    assertEquals(await listNames(join(dir, "inbox")), [`${FP_B}.json`]);
    // Nothing left to remove is not an error.
    await repo.delete(KEY_A);
  });
});

Deno.test("InboxCacheFileRepository: canWrite is true for a writable dir and leaves nothing behind", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    assertEquals(await repo.canWrite(), true);
    assertEquals(await listNames(join(dir, "inbox-v2")), []);
  });
});

Deno.test({
  name:
    "InboxCacheFileRepository: canWrite is false for a config dir that cannot be written",
  // Root writes through any mode, and Windows has no mode bits.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withTempDir(async (dir) => {
      const config = join(dir, "config");
      await Deno.mkdir(config);
      await Deno.chmod(config, 0o500);
      try {
        const repo = new InboxCacheFileRepository(config);
        assertEquals(await repo.canWrite(), false);
      } finally {
        await Deno.chmod(config, 0o700);
      }
    });
  },
});
