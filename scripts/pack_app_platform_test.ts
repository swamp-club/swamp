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
import { exists } from "@std/fs";
import { dirname, join } from "@std/path";
import { listTarGzEntries } from "../src/infrastructure/archive/tar_archive.ts";
import { AUTHORING_ARCHIVE } from "../src/domain/apps/app_platform.ts";
import { packAppPlatform } from "./pack_app_platform.ts";

async function writeFile(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

async function withBuild(
  files: Record<string, string>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-pack-platform-" });
  try {
    for (const [path, text] of Object.entries(files)) {
      await writeFile(join(dir, ...path.split("/")), text);
    }
    await body(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const BUILD: Record<string, string> = {
  "platform.json": JSON.stringify({
    major: 1,
    minor: 4,
    files: {
      "react.js": "aa",
      "dev/react.js": "bb",
      "types/ui/index.d.ts": "cc",
    },
  }),
  "react.js": "export {};",
  "dev/react.js": "export const dev = true;",
  "dev/chunks/z-1.js": "export {};",
  "dev/chunks/a-1.js": "export {};",
  "types/ui/index.d.ts": "export {};",
  "types/node_modules/react/index.d.ts": "export {};",
};

Deno.test("packAppPlatform: the same build packs to the same bytes", async () => {
  const packed: Uint8Array[] = [];
  for (let i = 0; i < 2; i++) {
    await withBuild(BUILD, async (dir) => {
      await packAppPlatform(dir, 1);
      packed.push(await Deno.readFile(join(dir, AUTHORING_ARCHIVE)));
    });
  }
  assertEquals(packed[0], packed[1]);
});

Deno.test("packAppPlatform: lays the archive out as .swamp-platform and drops the raw folders", async () => {
  await withBuild(BUILD, async (dir) => {
    await packAppPlatform(dir, 1);
    const archive = await Deno.open(join(dir, AUTHORING_ARCHIVE));
    assertEquals(await listTarGzEntries(archive.readable), [
      "node_modules/react/index.d.ts",
      "platform/1/dev/chunks/a-1.js",
      "platform/1/dev/chunks/z-1.js",
      "platform/1/dev/react.js",
      "ui/index.d.ts",
    ]);
    assertEquals(await exists(join(dir, "dev")), false);
    assertEquals(await exists(join(dir, "types")), false);
    assertEquals(await exists(join(dir, "react.js")), true);
  });
});

Deno.test("packAppPlatform: platform.json hashes the archive instead of the packed files", async () => {
  await withBuild(BUILD, async (dir) => {
    await packAppPlatform(dir, 1);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "platform.json")),
    ) as { minor: number; files: Record<string, string> };
    assertEquals(manifest.minor, 4);
    assertEquals(Object.keys(manifest.files), [AUTHORING_ARCHIVE, "react.js"]);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await Deno.readFile(join(dir, AUTHORING_ARCHIVE)),
    );
    assertEquals(
      manifest.files[AUTHORING_ARCHIVE],
      Array.from(
        new Uint8Array(digest),
        (b) => b.toString(16).padStart(2, "0"),
      ).join(""),
    );
  });
});

Deno.test("packAppPlatform: refuses a types folder an app has no place for", async () => {
  await withBuild(
    { ...BUILD, "types/extra/x.d.ts": "export {};" },
    async (dir) => {
      await assertRejects(
        () => packAppPlatform(dir, 1),
        Error,
        "types/extra has no place in an app",
      );
    },
  );
});
