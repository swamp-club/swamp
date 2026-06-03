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
import type { ExtensionListEntry } from "../../libswamp/mod.ts";
import type {
  ExtensionUpdateCheckMap,
  ExtensionUpdateCheckRepository,
} from "../../domain/extensions/extension_update_check_cache.ts";
import { enrichExtensionList } from "./extension_list_freshness.ts";

class InMemoryCacheRepo implements ExtensionUpdateCheckRepository {
  data: ExtensionUpdateCheckMap;
  writes = 0;

  constructor(initial: ExtensionUpdateCheckMap = {}) {
    this.data = { ...initial };
  }

  read(): Promise<ExtensionUpdateCheckMap> {
    return Promise.resolve({ ...this.data });
  }

  write(data: ExtensionUpdateCheckMap): Promise<void> {
    this.data = { ...data };
    this.writes++;
    return Promise.resolve();
  }
}

const baseEntry = (
  name: string,
  version: string,
): ExtensionListEntry => ({
  name,
  version,
  pulledAt: "2026-01-01T00:00:00.000Z",
  files: [],
});

Deno.test("enrichExtensionList: empty input returns empty result", async () => {
  const cache = new InMemoryCacheRepo();
  let calls = 0;
  const result = await enrichExtensionList([], {
    getLatestVersion: () => {
      calls++;
      return Promise.resolve(null);
    },
    cacheRepository: cache,
    now: () => new Date("2026-05-01T00:00:00.000Z"),
    concurrency: 4,
  });
  assertEquals(result, []);
  assertEquals(calls, 0);
  assertEquals(cache.writes, 0);
});

Deno.test("enrichExtensionList: cache hit makes no registry calls", async () => {
  const cache = new InMemoryCacheRepo({
    "@ns/foo": {
      checkedAt: "2026-05-01T00:00:00.000Z",
      latestVersion: "2026.04.01.1",
    },
  });
  let calls = 0;
  const result = await enrichExtensionList(
    [baseEntry("@ns/foo", "2026.04.01.1")],
    {
      getLatestVersion: () => {
        calls++;
        return Promise.resolve("should-not-be-called");
      },
      cacheRepository: cache,
      now: () => new Date("2026-05-01T00:00:01.000Z"), // 1s later, fresh
      concurrency: 4,
    },
  );
  assertEquals(calls, 0);
  assertEquals(cache.writes, 0);
  assertEquals(result[0].latestVersion, "2026.04.01.1");
  assertEquals(result[0].updateStatus, "up_to_date");
});

Deno.test("enrichExtensionList: stale cache triggers fetch and ONE aggregate write", async () => {
  const cache = new InMemoryCacheRepo({
    "@ns/foo": {
      checkedAt: "2026-04-01T00:00:00.000Z", // 30 days old → stale
      latestVersion: "2026.03.01.1",
    },
  });
  let calls = 0;
  const result = await enrichExtensionList(
    [
      baseEntry("@ns/foo", "2026.03.01.1"),
      baseEntry("@ns/bar", "2026.04.01.1"),
    ],
    {
      getLatestVersion: (name) => {
        calls++;
        if (name === "@ns/foo") return Promise.resolve("2026.05.01.1");
        if (name === "@ns/bar") return Promise.resolve("2026.04.01.1");
        return Promise.resolve(null);
      },
      cacheRepository: cache,
      now: () => new Date("2026-05-01T00:00:00.000Z"),
      concurrency: 4,
    },
  );
  assertEquals(calls, 2);
  assertEquals(cache.writes, 1, "exactly one aggregate cache write");
  assertEquals(result[0].latestVersion, "2026.05.01.1");
  assertEquals(result[0].updateStatus, "update_available");
  assertEquals(result[1].latestVersion, "2026.04.01.1");
  assertEquals(result[1].updateStatus, "up_to_date");
});

Deno.test("enrichExtensionList: registry failure stamps cache and marks unknown_offline", async () => {
  const cache = new InMemoryCacheRepo({});
  const result = await enrichExtensionList(
    [baseEntry("@ns/foo", "2026.03.01.1")],
    {
      getLatestVersion: () => Promise.resolve(null),
      cacheRepository: cache,
      now: () => new Date("2026-05-01T00:00:00.000Z"),
      concurrency: 4,
    },
  );
  assertEquals(cache.writes, 1);
  // Cache stamped with installedVersion to suppress 24h retry
  assertEquals(cache.data["@ns/foo"].latestVersion, "2026.03.01.1");
  // In-memory entry distinguishes "tried and failed" from cache-fresh
  assertEquals(result[0].latestVersion, null);
  assertEquals(result[0].updateStatus, "unknown_offline");
});

Deno.test("enrichExtensionList: worker-throws degrades to unknown_offline (does not blow up the composer)", async () => {
  const cache = new InMemoryCacheRepo({});
  const result = await enrichExtensionList(
    [baseEntry("@ns/throws", "2026.03.01.1")],
    {
      // Production wires a try/catch and returns null on failure. This test
      // simulates a worker that escapes its own try/catch — the runBounded
      // helper must still record SOMETHING and the composer must degrade
      // gracefully rather than rejecting the whole list.
      getLatestVersion: () => {
        throw new Error("simulated unexpected throw");
      },
      cacheRepository: cache,
      now: () => new Date("2026-05-01T00:00:00.000Z"),
      concurrency: 4,
    },
  );
  // Composer treats undefined fetch result like a registry failure:
  // unknown_offline status, cache stamped to suppress 24h retry.
  assertEquals(result.length, 1);
  assertEquals(result[0].updateStatus, "unknown_offline");
  assertEquals(result[0].latestVersion, null);
  assertEquals(cache.data["@ns/throws"]?.latestVersion, "2026.03.01.1");
});

Deno.test("enrichExtensionList: concurrency cap respects bound", async () => {
  // Track concurrent in-flight calls; assert the max never exceeds the cap.
  const cap = 2;
  let inFlight = 0;
  let maxInFlight = 0;
  const entries = Array.from(
    { length: 8 },
    (_, i) => baseEntry(`@ns/ext-${i}`, "2026.01.01.1"),
  );
  const cache = new InMemoryCacheRepo({}); // all stale → all fetched
  await enrichExtensionList(entries, {
    getLatestVersion: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Release the event loop a few times to let other callers race in.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return "2026.01.01.1";
    },
    cacheRepository: cache,
    now: () => new Date("2026-05-01T00:00:00.000Z"),
    concurrency: cap,
  });
  assertEquals(
    maxInFlight <= cap,
    true,
    `maxInFlight=${maxInFlight} should be <= ${cap}`,
  );
});
