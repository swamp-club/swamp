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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import {
  type InboxSnapshot,
  InboxState,
  MAX_ETAG_LENGTH,
  POLL_STOP_REASONS,
} from "../../domain/inbox/inbox_state.ts";
import { InboxCacheFileRepository } from "./inbox_cache_file_repository.ts";

const FP_A = "0123456789abcdef";
const FP_B = "fedcba9876543210";
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
    const repo = new InboxCacheFileRepository(join(dir, "inbox"));
    await repo.save(FP_A, fullState);
    assertEquals(await repo.load(FP_A), fullState);
  });
});

Deno.test("InboxCacheFileRepository: a missing file or directory loads as empty", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(join(dir, "inbox"));
    assertEquals(await repo.load(FP_A), InboxState.empty());
  });
});

Deno.test("InboxCacheFileRepository: corrupt, over-size and unrecognised files load as empty", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    await repo.save(FP_A, fullState);
    const path = join(dir, `${FP_A}.json`);
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
      assertEquals(await repo.load(FP_A), InboxState.empty(), content);
    }
  });
});

Deno.test("InboxCacheFileRepository: a field outside its bounds loads as empty", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    await repo.save(FP_A, fullState);
    const path = join(dir, `${FP_A}.json`);
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
      { ...valid, announcement: { id: ID_A, at: 12345 } },
    ];
    for (const variant of variants) {
      await Deno.writeTextFile(path, JSON.stringify(variant));
      assertEquals(
        await repo.load(FP_A),
        InboxState.empty(),
        JSON.stringify(variant),
      );
    }
  });
});

Deno.test("InboxCacheFileRepository: a malformed fingerprint loads as empty, refuses to save and writes nothing", async () => {
  await withTempDir(async (dir) => {
    const cacheDir = join(dir, "inbox");
    const repo = new InboxCacheFileRepository(cacheDir);
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
      assertEquals(await repo.load(fingerprint), InboxState.empty());
      await assertRejects(() => repo.save(fingerprint, fullState));
    }
    assertEquals(await listNames(dir), []);
  });
});

Deno.test("InboxCacheFileRepository: keys keep independent state", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    await repo.save(FP_A, fullState);
    const before = await Deno.readTextFile(join(dir, `${FP_A}.json`));
    const other = { ...InboxState.empty(), snapshot: snapshot({ unread: 9 }) };
    await repo.save(FP_B, other);
    assertEquals(await repo.load(FP_A), fullState);
    assertEquals(await repo.load(FP_B), other);
    assertEquals(await Deno.readTextFile(join(dir, `${FP_A}.json`)), before);
  });
});

Deno.test("InboxCacheFileRepository: keeps at most 8 keys, dropping the oldest and never the one just saved", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    const keys = Array.from(
      { length: 9 },
      (_, i) => i.toString(16).padStart(16, "0"),
    );
    for (const [i, key] of keys.slice(0, 8).entries()) {
      await repo.save(key, fullState);
      // The first key is the oldest; the rest are newer than the ninth.
      const at = new Date(i === 0 ? T0 - 1_000_000 : T0 + 1_000_000 + i);
      await Deno.utime(join(dir, `${key}.json`), at, at);
    }
    await Deno.writeTextFile(join(dir, ".leftover.tmp"), "{}");
    await repo.save(keys[8], fullState);
    const names = await listNames(dir);
    assertEquals(
      names,
      [".leftover.tmp", ...keys.slice(1).map((k) => `${k}.json`)].sort(),
    );
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
      await assertRejects(() => repo.save(FP_A, state));
    }
    assertEquals(await listNames(dir), []);
  });
});

Deno.test("InboxCacheFileRepository: a save leaves no temp file and stores no API key", async () => {
  await withTempDir(async (dir) => {
    const repo = new InboxCacheFileRepository(dir);
    await repo.save(FP_A, fullState);
    await repo.save(FP_A, fullState);
    assertEquals(await listNames(dir), [`${FP_A}.json`]);
    const content = await Deno.readTextFile(join(dir, `${FP_A}.json`));
    assertEquals(content.includes("apiKey"), false);
    assertEquals(content.includes("swamp_"), false);
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
        await repo.save(FP_A, state);
        assertEquals(await repo.load(FP_A), state);
      }),
      { numRuns: 200 },
    );
  });
});
