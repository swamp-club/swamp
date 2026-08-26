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
import { join } from "@std/path";
import { resolveLocalImports } from "./local_import_resolver.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("resolveLocalImports: appends .ts to extensionless imports", async () => {
  await withTempDir(async (dir) => {
    const entry = join(dir, "entry.ts");
    const utils = join(dir, "utils.ts");
    await Deno.writeTextFile(entry, `import { foo } from "./utils";`);
    await Deno.writeTextFile(utils, "export const foo = 1;");

    const result = await resolveLocalImports([entry], dir);
    assertEquals(result.resolvedFiles.includes(utils), true);
  });
});

Deno.test("resolveLocalImports: preserves explicit .ts extension", async () => {
  await withTempDir(async (dir) => {
    const entry = join(dir, "entry.ts");
    const helper = join(dir, "helper.ts");
    await Deno.writeTextFile(entry, `import { bar } from "./helper.ts";`);
    await Deno.writeTextFile(helper, "export const bar = 2;");

    const result = await resolveLocalImports([entry], dir);
    assertEquals(result.resolvedFiles.includes(helper), true);
  });
});

Deno.test("resolveLocalImports: preserves explicit .js extension", async () => {
  await withTempDir(async (dir) => {
    const entry = join(dir, "entry.ts");
    const lib = join(dir, "lib.js");
    await Deno.writeTextFile(entry, `import { baz } from "./lib.js";`);
    await Deno.writeTextFile(lib, "export const baz = 3;");

    const result = await resolveLocalImports([entry], dir);
    assertEquals(result.resolvedFiles.includes(lib), true);
  });
});

Deno.test("resolveLocalImports: preserves explicit .json extension", async () => {
  await withTempDir(async (dir) => {
    const entry = join(dir, "entry.ts");
    const pkg = join(dir, "package-lock.json");
    await Deno.writeTextFile(
      entry,
      `import lock from "./package-lock.json" with { type: "json" };`,
    );
    await Deno.writeTextFile(pkg, "{}");

    const result = await resolveLocalImports([entry], dir);
    assertEquals(result.resolvedFiles.includes(pkg), true);
  });
});

Deno.test("resolveLocalImports: preserves explicit .wasm extension", async () => {
  await withTempDir(async (dir) => {
    const entry = join(dir, "entry.ts");
    const wasm = join(dir, "compute.wasm");
    await Deno.writeTextFile(entry, `import mod from "./compute.wasm";`);
    await Deno.writeTextFile(wasm, "");

    const result = await resolveLocalImports([entry], dir);
    assertEquals(result.resolvedFiles.includes(wasm), true);
  });
});

Deno.test("resolveLocalImports: does not resolve json import as .json.ts", async () => {
  await withTempDir(async (dir) => {
    const entry = join(dir, "entry.ts");
    const jsonTs = join(dir, "data.json.ts");
    await Deno.writeTextFile(
      entry,
      `import data from "./data.json" with { type: "json" };`,
    );
    await Deno.writeTextFile(jsonTs, "export default {};");

    const result = await resolveLocalImports([entry], dir);
    assertEquals(result.resolvedFiles.includes(jsonTs), false);
  });
});
