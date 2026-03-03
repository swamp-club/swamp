// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { checkExtensionQuality } from "./extension_quality_checker.ts";

const DENO_PATH = Deno.execPath();

async function withTempFiles(
  files: Record<string, string>,
  fn: (dir: string, paths: string[]) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const paths: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const filePath = join(tmpDir, name);
      await Deno.writeTextFile(filePath, content);
      paths.push(filePath);
    }
    await fn(tmpDir, paths);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("checkExtensionQuality passes for well-formatted, lint-clean file", async () => {
  await withTempFiles(
    { "model.ts": 'export const x = 1;\nexport const y = "hello";\n' },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(result.passed, true);
      assertEquals(result.issues, []);
    },
  );
});

Deno.test("checkExtensionQuality detects formatting issues", async () => {
  await withTempFiles(
    // Missing trailing newline and inconsistent spacing
    { "model.ts": "export const x=1;" },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(result.passed, false);
      assertEquals(result.issues.some((i) => i.check === "fmt"), true);
    },
  );
});

Deno.test("checkExtensionQuality detects lint issues", async () => {
  await withTempFiles(
    // no-explicit-any and ban-unused-ignore are default lint rules
    {
      "model.ts": "// deno-lint-ignore no-explicit-any\nexport const x = 1;\n",
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(result.passed, false);
      assertEquals(result.issues.some((i) => i.check === "lint"), true);
    },
  );
});

Deno.test("checkExtensionQuality reports both fmt and lint issues together", async () => {
  await withTempFiles(
    {
      "model.ts": "// deno-lint-ignore no-explicit-any\nexport const x=1;",
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(result.passed, false);
      const checks = result.issues.map((i) => i.check);
      assertEquals(checks.includes("fmt"), true);
      assertEquals(checks.includes("lint"), true);
    },
  );
});

Deno.test("checkExtensionQuality skips non-TypeScript files", async () => {
  await withTempFiles(
    {
      "README.md": "# not formatted\n",
      "config.json": "{bad json",
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(result.passed, true);
      assertEquals(result.issues, []);
    },
  );
});

Deno.test("checkExtensionQuality passes when file list is empty", async () => {
  const result = await checkExtensionQuality([], DENO_PATH);
  assertEquals(result.passed, true);
  assertEquals(result.issues, []);
});
