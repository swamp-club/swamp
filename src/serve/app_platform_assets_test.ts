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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import {
  readHeldPlatforms,
  serveAppPlatformRoute,
} from "./app_platform_assets.ts";

async function withDist(fn: (dist: string) => Promise<void>): Promise<void> {
  const dist = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dist, "1", "chunks"), { recursive: true });
    await Deno.writeTextFile(join(dist, "1", "react.js"), "export {}");
    await Deno.writeTextFile(join(dist, "1", "chunks", "a.js"), "export {}");
    await Deno.writeTextFile(
      join(dist, "1", "platform.json"),
      JSON.stringify({ major: 1, minor: 3 }),
    );
    await Deno.writeTextFile(join(dist, "secret.txt"), "outside");
    await fn(dist);
  } finally {
    await Deno.remove(dist, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

const get = (dist: string, path: string, init?: RequestInit) =>
  serveAppPlatformRoute(
    new Request(`http://serve.test${path}`, init),
    dist,
    new Map(),
  );

Deno.test("serveAppPlatformRoute: a module, open to a frame's opaque origin", async () => {
  await withDist(async (dist) => {
    const response = await get(dist, "/app-platform/1/chunks/a.js");
    assertEquals(response?.status, 200);
    assertEquals(
      response?.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    assertEquals(response?.headers.get("access-control-allow-origin"), "*");
    assertEquals(await response?.text(), "export {}");
  });
});

Deno.test("serveAppPlatformRoute: hashed files are immutable, fixed-name entries revalidate", async () => {
  await withDist(async (dist) => {
    await Deno.mkdir(join(dist, "1", "assets"), { recursive: true });
    await Deno.writeTextFile(join(dist, "1", "assets", "f-x.woff2"), "");
    const immutable = "public, max-age=31536000, immutable";
    const expected: Record<string, string> = {
      "chunks/a.js": immutable,
      "assets/f-x.woff2": immutable,
      "react.js": "no-cache",
      "platform.json": "no-cache",
    };
    for (const [path, cacheControl] of Object.entries(expected)) {
      const response = await get(dist, `/app-platform/1/${path}`);
      await response?.body?.cancel();
      assertEquals(response?.headers.get("cache-control"), cacheControl, path);
    }
  });
});

Deno.test("serveAppPlatformRoute: an unchanged file revalidates with 304", async () => {
  await withDist(async (dist) => {
    const first = await get(dist, "/app-platform/1/react.js");
    await first?.body?.cancel();
    const etag = first?.headers.get("etag") ?? "";
    const again = await get(dist, "/app-platform/1/react.js", {
      headers: { "if-none-match": etag },
    });
    assertEquals(again?.status, 304);
  });
});

Deno.test("serveAppPlatformRoute: a rebuilt entry gets a new etag from the same cache", async () => {
  await withDist(async (dist) => {
    const etags = new Map();
    const request = (headers?: HeadersInit) =>
      serveAppPlatformRoute(
        new Request("http://serve.test/app-platform/1/react.js", { headers }),
        dist,
        etags,
      );
    const first = await request();
    await first?.body?.cancel();
    const etag = first?.headers.get("etag") ?? "";
    const entry = join(dist, "1", "react.js");
    await Deno.writeTextFile(entry, "export const rebuilt = 1;");
    await Deno.utime(entry, new Date(2030, 0, 1), new Date(2030, 0, 1));
    const again = await request({ "if-none-match": etag });
    assertEquals(again?.status, 200);
    assertEquals(await again?.text(), "export const rebuilt = 1;");
    assertNotEquals(again?.headers.get("etag"), etag);
  });
});

Deno.test("serveAppPlatformRoute: nothing outside a platform's folder", async () => {
  await withDist(async (dist) => {
    for (
      const path of [
        "/app-platform/1/../secret.txt",
        "/app-platform/1/%2e%2e/secret.txt",
        "/app-platform/2/react.js",
        "/app-platform/1/missing.js",
      ]
    ) {
      // a URL can collapse `..` before the route sees it, and is then not ours
      const response = await get(dist, path);
      assertEquals(response?.status ?? 404, 404, path);
      await response?.body?.cancel();
    }
    assertEquals(await get(dist, "/app-files/x/index.html"), null);
    const post = await get(dist, "/app-platform/1/react.js", {
      method: "POST",
    });
    assertEquals(post?.status, 405);
    await post?.body?.cancel();
  });
});

Deno.test("readHeldPlatforms: each built major with its minor", async () => {
  await withDist(async (dist) => {
    assertEquals(await readHeldPlatforms(dist), [{ major: 1, minor: 3 }]);
  });
  assertEquals(await readHeldPlatforms("/no/such/dir"), []);
});
