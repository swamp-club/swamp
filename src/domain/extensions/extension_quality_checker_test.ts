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
import {
  checkExtensionQuality,
  stripCommentsAndStrings,
} from "./extension_quality_checker.ts";

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

Deno.test("checkExtensionQuality rejects await import()", async () => {
  await withTempFiles(
    {
      "model.ts":
        'const mod = await import("npm:@aws-sdk/client-s3@3");\nexport const x = mod;\n',
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(result.passed, false);
      assertEquals(
        result.issues.some((i) => i.check === "dynamic-import"),
        true,
      );
    },
  );
});

Deno.test("checkExtensionQuality rejects bare import()", async () => {
  await withTempFiles(
    {
      "model.ts":
        'const mod = import("npm:some-pkg@1.0.0");\nexport const x = mod;\n',
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(result.passed, false);
      assertEquals(
        result.issues.some((i) => i.check === "dynamic-import"),
        true,
      );
    },
  );
});

Deno.test("checkExtensionQuality allows static import from", async () => {
  await withTempFiles(
    {
      "model.ts":
        'import { z } from "npm:zod@4";\nexport const schema = z.string();\n',
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(result.passed, true);
      assertEquals(
        result.issues.some((i) => i.check === "dynamic-import"),
        false,
      );
    },
  );
});

Deno.test("checkExtensionQuality allows static import * as", async () => {
  await withTempFiles(
    {
      "helpers.ts": "export const SEP = '/';\n",
      "model.ts":
        'import * as helpers from "./helpers.ts";\nexport const sep = helpers.SEP;\n',
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(
        result.issues.some((i) => i.check === "dynamic-import"),
        false,
      );
    },
  );
});

Deno.test("checkExtensionQuality allows export from", async () => {
  await withTempFiles(
    {
      "model.ts": 'export { z } from "npm:zod@4";\n',
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(result.passed, true);
      assertEquals(
        result.issues.some((i) => i.check === "dynamic-import"),
        false,
      );
    },
  );
});

Deno.test("checkExtensionQuality ignores import() in comments", async () => {
  await withTempFiles(
    {
      "model.ts": '// do not use import("npm:pkg")\nexport const x = 1;\n',
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(
        result.issues.some((i) => i.check === "dynamic-import"),
        false,
      );
    },
  );
});

Deno.test("checkExtensionQuality ignores import() in string literals", async () => {
  await withTempFiles(
    {
      "model.ts": 'export const msg = "use import() for dynamic loading";\n',
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(
        result.issues.some((i) => i.check === "dynamic-import"),
        false,
      );
    },
  );
});

Deno.test("checkExtensionQuality ignores import() in block comments", async () => {
  await withTempFiles(
    {
      "model.ts": '/* import("npm:pkg") */\nexport const x = 1;\n',
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(
        result.issues.some((i) => i.check === "dynamic-import"),
        false,
      );
    },
  );
});

Deno.test("stripCommentsAndStrings removes single-line comments", () => {
  assertEquals(
    stripCommentsAndStrings('code(); // import("pkg")'),
    "code(); ",
  );
});

Deno.test("stripCommentsAndStrings removes string contents", () => {
  assertEquals(
    stripCommentsAndStrings('const s = "import(pkg)";'),
    "const s = ;",
  );
});

Deno.test("stripCommentsAndStrings removes block comments", () => {
  assertEquals(
    stripCommentsAndStrings("code /* import(x) */ more"),
    "code  more",
  );
});

Deno.test("stripCommentsAndStrings preserves bare code", () => {
  assertEquals(
    stripCommentsAndStrings("await import(url)"),
    "await import(url)",
  );
});
