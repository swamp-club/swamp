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
import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  DRAIN_WAIT_TTL_MS,
  type DrainWait,
  serializeDrainWait,
} from "../../domain/datastore/drain_wait.ts";
import {
  DRAIN_WAITS_DIR,
  DrainWaitStore,
  MAX_DRAIN_WAIT_ENTRIES,
} from "./drain_wait_store.ts";

const NOW = 1_800_000_000_000;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-drain-wait-store-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function wait(id: string, overrides: Partial<DrainWait> = {}): DrainWait {
  return {
    id,
    pid: 100,
    hostname: "host",
    startedAtMs: NOW,
    updatedAtMs: NOW,
    ttlMs: DRAIN_WAIT_TTL_MS,
    skipping: ["lock-a"],
    waitingOn: ["lock-b"],
    ...overrides,
  };
}

async function fileNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    names.push(entry.name);
  }
  return names.sort();
}

Deno.test("DrainWaitStore.list: no waits when nothing was ever published", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await new DrainWaitStore(dir).list(NOW), []);
  });
});

Deno.test("DrainWaitStore.publish: writes one marker per wait and replaces it on refresh", async () => {
  await withTempDir(async (dir) => {
    const store = new DrainWaitStore(dir);
    await store.publish(wait("drain-a"));
    await store.publish(wait("drain-b"));
    await store.publish(wait("drain-a", { updatedAtMs: NOW + 5 }));

    assertEquals(
      await fileNames(join(dir, DRAIN_WAITS_DIR)),
      ["drain-a.json", "drain-b.json"],
    );
    const listed = (await store.list(NOW + 5))
      .sort((a, b) => a.id.localeCompare(b.id));
    assertEquals(listed, [
      wait("drain-a", { updatedAtMs: NOW + 5 }),
      wait("drain-b"),
    ]);
  });
});

Deno.test("DrainWaitStore: keeps a namespace's markers under that namespace", async () => {
  await withTempDir(async (dir) => {
    await new DrainWaitStore(dir, "infra").publish(wait("drain-a"));

    assertEquals(
      await fileNames(join(dir, "infra", DRAIN_WAITS_DIR)),
      ["drain-a.json"],
    );
    assertEquals(await new DrainWaitStore(dir).list(NOW), []);
    assertEquals(await new DrainWaitStore(dir, "infra").list(NOW), [
      wait("drain-a"),
    ]);
  });
});

Deno.test("DrainWaitStore.remove: deletes the marker and tolerates one already gone", async () => {
  await withTempDir(async (dir) => {
    const store = new DrainWaitStore(dir);
    await store.publish(wait("drain-a"));

    await store.remove("drain-a");
    await store.remove("drain-a");

    assertEquals(await store.list(NOW), []);
  });
});

Deno.test("DrainWaitStore.list: skips malformed, misnamed and expired markers", async () => {
  await withTempDir(async (dir) => {
    const store = new DrainWaitStore(dir);
    const markers = join(dir, DRAIN_WAITS_DIR);
    await store.publish(wait("drain-live"));
    await store.publish(
      wait("drain-dead", { updatedAtMs: NOW - DRAIN_WAIT_TTL_MS - 1 }),
    );
    await Deno.writeTextFile(join(markers, "garbage.json"), "{not json");
    await Deno.writeTextFile(join(markers, "shape.json"), '{"id":"shape"}');
    // A marker that claims to be another drain's.
    await Deno.writeTextFile(
      join(markers, "impostor.json"),
      serializeDrainWait(wait("drain-live", { skipping: ["lock-z"] })),
    );
    await ensureDir(join(markers, "subdir.json"));

    assertEquals(await store.list(NOW), [wait("drain-live")]);
  });
});

Deno.test("DrainWaitStore.list: deletes what has not been written for a full ttl and keeps the rest", async () => {
  await withTempDir(async (dir) => {
    const store = new DrainWaitStore(dir);
    const markers = join(dir, DRAIN_WAITS_DIR);
    const expired = { updatedAtMs: NOW - DRAIN_WAIT_TTL_MS - 1 };
    await store.publish(wait("drain-live"));
    await store.publish(wait("drain-old", expired));
    await store.publish(wait("drain-recent", expired));
    await Deno.writeTextFile(join(markers, ".leftover.tmp"), "partial");

    const old = new Date(NOW - DRAIN_WAIT_TTL_MS - 1_000);
    const recent = new Date(NOW - 1_000);
    await Deno.utime(join(markers, "drain-old.json"), old, old);
    await Deno.utime(join(markers, ".leftover.tmp"), old, old);
    await Deno.utime(join(markers, "drain-recent.json"), recent, recent);
    await Deno.utime(join(markers, "drain-live.json"), old, old);

    assertEquals(await store.list(NOW), [wait("drain-live")]);
    // The live marker stays whatever its mtime; the expired one written
    // recently stays until its file is a ttl old.
    assertEquals(await fileNames(markers), [
      "drain-live.json",
      "drain-recent.json",
    ]);
  });
});

Deno.test("DrainWaitStore.list: looks at a bounded number of entries", async () => {
  await withTempDir(async (dir) => {
    const store = new DrainWaitStore(dir);
    const extra = 5;
    for (let i = 0; i < MAX_DRAIN_WAIT_ENTRIES + extra; i++) {
      await store.publish(wait(`drain-${i}`));
    }

    assertEquals((await store.list(NOW)).length, MAX_DRAIN_WAIT_ENTRIES);
  });
});
