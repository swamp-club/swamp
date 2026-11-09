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
import { walk } from "@std/fs";
import { waitFor } from "@swamp-club/swamp-testing";
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

function stubClient(bundle = FAKE_BUNDLE): {
  client: DataPlaneClient;
  bundleFetches: string[];
  assetFetches: string[];
  files: Map<string, string>;
  executables: string[];
} {
  const bundleFetches: string[] = [];
  const assetFetches: string[] = [];
  const files = new Map<string, string>();
  const executables: string[] = [];
  const client = {
    fetchBundle: (fingerprint: string) => {
      bundleFetches.push(fingerprint);
      return Promise.resolve(bundle);
    },
    listAssets: () =>
      Promise.resolve({ files: [...files.keys()], executables, withheld: [] }),
    fetchAsset: (_fingerprint: string, relPath: string) => {
      assetFetches.push(relPath);
      const content = files.get(relPath);
      if (content === undefined) {
        return Promise.reject(new Error(`no asset ${relPath}`));
      }
      return Promise.resolve(new TextEncoder().encode(content));
    },
  } as unknown as DataPlaneClient;
  return { client, bundleFetches, assetFetches, files, executables };
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

Deno.test({
  name:
    "WorkerBundleCache: writes a binaries asset executable and leaves an additional file as written",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withCacheDir(async (dir) => {
      const { client, files, executables } = stubClient();
      files.set("bin/tool", "#!/bin/sh");
      files.set("layouts/swamp.json", "{}");
      executables.push("bin/tool");
      const loaded = await new WorkerBundleCache(dir, client).load("fp-bin");
      const tool = await Deno.stat(join(loaded.filesDir!, "bin", "tool"));
      assertEquals(tool.mode! & 0o777, 0o755);
      const json = await Deno.stat(
        join(loaded.filesDir!, "layouts", "swamp.json"),
      );
      assertEquals(json.mode! & 0o111, 0);
    });
  },
});

Deno.test({
  name:
    "WorkerBundleCache: a second dispatch that also missed the cache replaces the binary rather than rewriting the file a first dispatch may be running",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withCacheDir(async (dir) => {
      const gates = [
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>(),
      ];
      let started = 0;
      const cacheFor = (index: number) => {
        const { client, files, executables } = stubClient();
        files.set("bin/tool", `#!/bin/sh\necho ${index}\n`);
        executables.push("bin/tool");
        const fetchAsset = client.fetchAsset.bind(client);
        client.fetchAsset = async (...args) => {
          started++;
          await gates[index].promise;
          return await fetchAsset(...args);
        };
        return new WorkerBundleCache(dir, client);
      };
      const first = cacheFor(0).load("fp-twice");
      const second = cacheFor(1).load("fp-twice");
      await waitFor(() => started === 2, "both dispatches to miss the cache");

      const target = join(dir, "fp-twice", "files", "bin", "tool");
      gates[0].resolve();
      await first;
      const running = await Deno.open(target);
      try {
        gates[1].resolve();
        await second;
        const held = new Uint8Array(64);
        const read = await running.read(held);
        assertEquals(
          new TextDecoder().decode(held.subarray(0, read ?? 0)),
          "#!/bin/sh\necho 0\n",
        );
      } finally {
        running.close();
      }
      assertEquals((await Deno.stat(target)).mode! & 0o777, 0o755);
    });
  },
});

Deno.test("WorkerBundleCache: concurrent dispatches loading one fingerprint through their own caches all get complete files and leave no temp files", async () => {
  await withCacheDir(async (dir) => {
    const { client, files, executables } = stubClient();
    files.set("bin/tool", "#!/bin/sh\n".repeat(4096));
    files.set("layouts/swamp.json", "{}");
    executables.push("bin/tool");
    const loads = await Promise.all(
      Array.from(
        { length: 6 },
        () => new WorkerBundleCache(dir, client).load("fp-race"),
      ),
    );
    const tool = join(dir, "fp-race", "files", "bin", "tool");
    assertEquals(await Deno.readTextFile(tool), "#!/bin/sh\n".repeat(4096));
    for (const loaded of loads) {
      assertEquals(loaded.modelDef.type.normalized, "swamp/bundled-test");
    }
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(tool)).mode! & 0o777, 0o755);
    }
    const leftovers: string[] = [];
    for await (const entry of walk(dir)) {
      if (entry.name.endsWith(".tmp")) leftovers.push(entry.path);
    }
    assertEquals(leftovers, []);
  });
});

Deno.test("WorkerBundleCache: a temp file a crashed write left behind is not taken for the cached asset", async () => {
  await withCacheDir(async (dir) => {
    const { client, files, assetFetches } = stubClient();
    files.set("layouts/swamp.json", '{"complete":true}');
    const filesDir = join(dir, "fp-crash", "files", "layouts");
    await Deno.mkdir(filesDir, { recursive: true });
    await Deno.writeTextFile(
      join(filesDir, `swamp.json.${crypto.randomUUID()}.tmp`),
      '{"compl',
    );
    await new WorkerBundleCache(dir, client).load("fp-crash");
    assertEquals(assetFetches, ["layouts/swamp.json"]);
    assertEquals(
      await Deno.readTextFile(join(filesDir, "swamp.json")),
      '{"complete":true}',
    );
  });
});

Deno.test({
  name:
    "WorkerBundleCache: an executables entry that is not among the listed files is never touched",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withCacheDir(async (dir) => {
      const { client, files, executables } = stubClient();
      files.set("layouts/swamp.json", "{}");
      executables.push("../outside");
      const outside = join(dir, "fp-stray", "outside");
      await Deno.mkdir(join(dir, "fp-stray"), { recursive: true });
      await Deno.writeTextFile(outside, "x");
      await Deno.chmod(outside, 0o644);
      await new WorkerBundleCache(dir, client).load("fp-stray");
      assertEquals((await Deno.stat(outside)).mode! & 0o777, 0o644);
    });
  },
});

Deno.test("WorkerBundleCache: loads a bundle that exports behavior, the other spelling of model", async () => {
  await withCacheDir(async (dir) => {
    const { client } = stubClient(
      FAKE_BUNDLE.replace("export const model", "export const behavior"),
    );
    const cache = new WorkerBundleCache(dir, client);
    const loaded = await cache.load(`fp-behavior-${crypto.randomUUID()}`);
    assertEquals(loaded.modelDef.type.normalized, "swamp/bundled-test");
    assertEquals(typeof loaded.modelDef.methods.run.execute, "function");
  });
});

Deno.test("WorkerBundleCache: refuses a bundle that exports both model and behavior", async () => {
  await withCacheDir(async (dir) => {
    const { client } = stubClient(
      FAKE_BUNDLE + "\nexport const behavior = model;\n",
    );
    const cache = new WorkerBundleCache(dir, client);
    const error = await assertRejects(
      () => cache.load(`fp-both-${crypto.randomUUID()}`),
      Error,
    );
    assertStringIncludes(error.message, "both 'model' and 'behavior'");
  });
});
