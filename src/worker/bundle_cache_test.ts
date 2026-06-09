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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { WorkerBundleCache } from "./bundle_cache.ts";
import type { DataPlaneClient } from "./data_plane_client.ts";

// Register built-ins so the sentinel path can resolve them.
import "../domain/models/models.ts";

const FAKE_BUNDLE = `
export const model = {
  type: { normalized: "swamp/bundled-test", raw: "swamp/bundled-test" },
  version: "2026.06.09.1",
  methods: {
    run: {
      description: "bundled method",
      execute: () => Promise.resolve({ dataHandles: [] }),
    },
  },
};
`;

function stubClient(): {
  client: DataPlaneClient;
  bundleFetches: string[];
  assetFetches: string[];
  files: Map<string, string>;
} {
  const bundleFetches: string[] = [];
  const assetFetches: string[] = [];
  const files = new Map<string, string>();
  const client = {
    fetchBundle: (fingerprint: string) => {
      bundleFetches.push(fingerprint);
      return Promise.resolve(FAKE_BUNDLE);
    },
    listAssets: () => Promise.resolve([...files.keys()]),
    fetchAsset: (_fingerprint: string, relPath: string) => {
      assetFetches.push(relPath);
      const content = files.get(relPath);
      if (content === undefined) {
        return Promise.reject(new Error(`no asset ${relPath}`));
      }
      return Promise.resolve(new TextEncoder().encode(content));
    },
  } as unknown as DataPlaneClient;
  return { client, bundleFetches, assetFetches, files };
}

async function withCacheDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-bundle-cache-test" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("WorkerBundleCache: builtin sentinel resolves from the local registry", async () => {
  await withCacheDir(async (dir) => {
    const { client, bundleFetches } = stubClient();
    const cache = new WorkerBundleCache(dir, client);
    const loaded = await cache.load("builtin:swamp/worker");
    assertEquals(loaded.modelDef.type.normalized, "swamp/worker");
    assertEquals(bundleFetches.length, 0);
  });
});

Deno.test("WorkerBundleCache: unknown builtin fails with a lockstep error", async () => {
  await withCacheDir(async (dir) => {
    const { client } = stubClient();
    const cache = new WorkerBundleCache(dir, client);
    const error = await assertRejects(
      () => cache.load("builtin:swamp/not-a-model"),
      Error,
    );
    assertStringIncludes(error.message, "binaries disagree");
  });
});

Deno.test("WorkerBundleCache: fetches, persists, imports, and memoizes a bundle", async () => {
  await withCacheDir(async (dir) => {
    const { client, bundleFetches } = stubClient();
    const cache = new WorkerBundleCache(dir, client);
    const first = await cache.load("fp-abc");
    assertEquals(first.modelDef.type.normalized, "swamp/bundled-test");
    assertEquals(typeof first.modelDef.methods.run.execute, "function");
    const second = await cache.load("fp-abc");
    assertEquals(second.modelDef, first.modelDef);
    assertEquals(bundleFetches, ["fp-abc"]);
    // The fetched source landed on disk under the fingerprint.
    const onDisk = await Deno.readTextFile(join(dir, "fp-abc", "bundle.js"));
    assertEquals(onDisk, FAKE_BUNDLE);
  });
});

Deno.test("WorkerBundleCache: prefetches co-located assets beside the bundle", async () => {
  await withCacheDir(async (dir) => {
    const { client, files, assetFetches } = stubClient();
    files.set("templates/report.html", "<html>");
    files.set("data/seed.json", "{}");
    const cache = new WorkerBundleCache(dir, client);
    const loaded = await cache.load("fp-with-assets");
    assertEquals(loaded.filesDir, join(dir, "fp-with-assets", "files"));
    assertEquals(loaded.modelDef.extensionFilesRoot, loaded.filesDir);
    assertEquals(assetFetches.length, 2);
    assertEquals(
      await Deno.readTextFile(
        join(loaded.filesDir!, "templates", "report.html"),
      ),
      "<html>",
    );
  });
});
