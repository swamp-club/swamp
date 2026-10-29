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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { initializeLogging } from "../logging/logger.ts";
import {
  pendingPublishDir,
  readPendingPublishes,
  recordPendingPublish,
  removePendingPublishes,
} from "./pending_publish_store.ts";

await initializeLogging({});

async function withCache(fn: (cachePath: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-pending-publish-" });
  try {
    await fn(join(dir, "cache"));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const M = { modelType: "t", modelId: "m" };
const N = { modelType: "t", modelId: "n" };

Deno.test("pendingPublishDir: is beside the cache, not inside it", () => {
  const dir = pendingPublishDir(join("home", "repos", "abc"));
  assertEquals(dir, join("home", "repos", "abc.pending-publish"));
});

Deno.test("recordPendingPublish: a recorded run reads back for its behavior only", async () => {
  await withCache(async (cachePath) => {
    await recordPendingPublish(cachePath, [
      { ...M, dataName: "main", version: 3, dataId: "id-3" },
      { ...M, dataName: "report", version: 1 },
    ]);
    await recordPendingPublish(cachePath, [
      { ...N, dataName: "main", version: 1, dataId: "id-n" },
    ]);

    const forM = await readPendingPublishes(cachePath, [M]);
    assertEquals(forM.length, 1);
    assertEquals(forM[0].versions, [
      { ...M, dataName: "main", version: 3, dataId: "id-3" },
      { ...M, dataName: "report", version: 1 },
    ]);
    assertEquals((await readPendingPublishes(cachePath, [M, N])).length, 2);
  });
});

Deno.test("recordPendingPublish: nothing written records nothing", async () => {
  await withCache(async (cachePath) => {
    await recordPendingPublish(cachePath, []);
    assertEquals(await readPendingPublishes(cachePath, [M]), []);
  });
});

Deno.test("readPendingPublishes: no directory reads as none", async () => {
  await withCache(async (cachePath) => {
    assertEquals(await readPendingPublishes(cachePath, [M]), []);
  });
});

Deno.test("readPendingPublishes: an unparsable record is skipped and kept", async () => {
  await withCache(async (cachePath) => {
    await recordPendingPublish(cachePath, [{
      ...M,
      dataName: "a",
      version: 1,
    }]);
    const bad = join(pendingPublishDir(cachePath), "bad.json");
    await Deno.writeTextFile(bad, "{not json");

    const records = await readPendingPublishes(cachePath, [M]);
    assertEquals(records.length, 1);
    assert((await Deno.stat(bad)).isFile);
  });
});

Deno.test("removePendingPublishes: removes the named records, tolerating one already gone", async () => {
  await withCache(async (cachePath) => {
    await recordPendingPublish(cachePath, [{
      ...M,
      dataName: "a",
      version: 1,
    }]);
    const [record] = await readPendingPublishes(cachePath, [M]);
    await removePendingPublishes(cachePath, [record.file, "gone.json"]);
    assertEquals(await readPendingPublishes(cachePath, [M]), []);
  });
});
