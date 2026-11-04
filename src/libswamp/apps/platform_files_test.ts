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
import { exists } from "@std/fs";
import { dirname, join } from "@std/path";
import { TarStream, type TarStreamInput } from "@std/tar/tar-stream";
import { AUTHORING_ARCHIVE } from "../../domain/apps/app_platform.ts";
import {
  APP_PLATFORM_DIR,
  SDK_FILES,
  writeAppPlatform,
} from "./platform_files.ts";

interface Fixture extends AsyncDisposable {
  readonly packages: string;
  readonly app: string;
}

async function fixture(): Promise<Fixture> {
  const root = await Deno.makeTempDir();
  const packages = join(root, "packages");
  for (const [pkg, files] of Object.entries(SDK_FILES)) {
    for (const file of files) {
      await Deno.mkdir(join(packages, pkg), { recursive: true });
      await Deno.writeTextFile(join(packages, pkg, file), `// ${file}`);
    }
  }
  const app = join(root, "app");
  await Deno.mkdir(app);
  return {
    packages,
    app,
    async [Symbol.asyncDispose]() {
      if (Deno.build.os === "windows") {
        await Deno.remove(root, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(root, { recursive: true });
      }
    },
  };
}

async function writeFile(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

type Entry =
  | { readonly path: string; readonly text: string }
  | { readonly path: string; readonly linkname: string };

async function writeArchive(path: string, entries: readonly Entry[]) {
  const inputs: TarStreamInput[] = entries.map((entry) => {
    if ("linkname" in entry) {
      return { type: "symlink", path: entry.path, linkname: entry.linkname };
    }
    const bytes = new TextEncoder().encode(entry.text);
    return {
      type: "file",
      path: entry.path,
      size: bytes.byteLength,
      readable: ReadableStream.from([bytes]),
    };
  });
  const file = await Deno.open(path, {
    write: true,
    create: true,
    truncate: true,
  });
  await ReadableStream.from(inputs)
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"))
    .pipeTo(file.writable);
}

const AUTHORING: readonly Entry[] = [
  { path: "ui/index.d.ts", text: "export {};" },
  { path: "node_modules/react/index.d.ts", text: "export {};" },
  { path: "platform/1/dev/ui.js", text: "export {};" },
];

async function writeBuild(
  packages: string,
  manifest: unknown,
  entries: readonly Entry[] = AUTHORING,
): Promise<void> {
  const built = join(packages, "app-platform", "dist", "1");
  await writeFile(join(built, "platform.json"), JSON.stringify(manifest));
  await writeArchive(join(built, AUTHORING_ARCHIVE), entries);
}

Deno.test("writeAppPlatform: replaces a stale .swamp-platform", async () => {
  await using dirs = await fixture();
  const stale = join(dirs.app, APP_PLATFORM_DIR, "app-sdk", "removed.ts");
  await writeFile(stale, "// left from an older swamp");
  await writeFile(join(dirs.app, APP_PLATFORM_DIR, "app-sdk", "mod.ts"), "old");

  await writeAppPlatform(dirs.app, 1, dirs.packages);

  assertEquals(await exists(stale), false);
  assertEquals(
    await Deno.readTextFile(
      join(dirs.app, APP_PLATFORM_DIR, "app-sdk", "mod.ts"),
    ),
    "// mod.ts",
  );
  assert(await exists(join(dirs.app, APP_PLATFORM_DIR, "client", "client.ts")));
});

Deno.test("writeAppPlatform: a swamp with no platform build returns only the major", async () => {
  await using dirs = await fixture();

  const held = await writeAppPlatform(dirs.app, 1, dirs.packages);

  assertEquals(held, { major: 1 });
  assertEquals("minor" in held, false);
  assertEquals(
    await exists(join(dirs.app, APP_PLATFORM_DIR, "platform.json")),
    false,
  );
});

Deno.test("writeAppPlatform: reads the minor from the build's platform.json", async () => {
  await using dirs = await fixture();
  await writeBuild(dirs.packages, { major: 1, minor: 7 });

  const held = await writeAppPlatform(dirs.app, 1, dirs.packages);

  assertEquals(held, { major: 1, minor: 7 });
  const target = join(dirs.app, APP_PLATFORM_DIR);
  assertEquals(
    JSON.parse(await Deno.readTextFile(join(target, "platform.json"))),
    { major: 1, minor: 7 },
  );
  assert(await exists(join(target, "ui", "index.d.ts")));
  assert(await exists(join(target, "node_modules", "react", "index.d.ts")));
  assert(await exists(join(target, "platform", "1", "dev", "ui.js")));
});

Deno.test("writeAppPlatform: a platform.json without a numeric minor returns only the major", async () => {
  await using dirs = await fixture();
  await writeBuild(dirs.packages, { major: 1, minor: "7" });

  assertEquals(await writeAppPlatform(dirs.app, 1, dirs.packages), {
    major: 1,
  });
});

for (
  const [label, entry] of [
    ["a traversal", {
      path: "platform/1/dev/../../../app-sdk/mod.ts",
      text: "x",
    }],
    ["an escape from the folder", { path: "ui/../../outside.ts", text: "x" }],
    ["a path outside its folders", { path: "app-sdk/mod.ts", text: "x" }],
    ["a symlink", { path: "ui/link.d.ts", linkname: "../app-sdk/mod.ts" }],
  ] as const
) {
  Deno.test(`writeAppPlatform: refuses ${label} in the authoring archive`, async () => {
    await using dirs = await fixture();
    await writeBuild(dirs.packages, { major: 1, minor: 7 }, [
      ...AUTHORING,
      entry,
    ]);

    await assertRejects(
      () => writeAppPlatform(dirs.app, 1, dirs.packages),
      Error,
      entry.path,
    );

    const target = join(dirs.app, APP_PLATFORM_DIR);
    assertEquals(
      await Deno.readTextFile(join(target, "app-sdk", "mod.ts")),
      "// mod.ts",
    );
    assertEquals(await exists(join(dirs.app, "outside.ts")), false);
    assertEquals(await exists(join(target, "ui", "link.d.ts")), false);
  });
}

Deno.test("writeAppPlatform: names the rebuild when a build has no authoring archive", async () => {
  await using dirs = await fixture();
  const built = join(dirs.packages, "app-platform", "dist", "1");
  await writeFile(join(built, "platform.json"), "{}");

  await assertRejects(
    () => writeAppPlatform(dirs.app, 1, dirs.packages),
    Error,
    "deno run build-app-platform",
  );
});
