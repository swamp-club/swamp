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

Deno.test("checkExtensionQuality ignores import() in single-line block comments", async () => {
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

Deno.test("checkExtensionQuality ignores import() in multi-line block comments", async () => {
  await withTempFiles(
    {
      "model.ts":
        '/*\n * Do not use import("npm:pkg") dynamically\n */\nexport const x = 1;\n',
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

Deno.test("checkExtensionQuality catches import() inside template expression", async () => {
  await withTempFiles(
    {
      "model.ts": 'export const x = `result: ${await import("npm:pkg")}`;\n',
    },
    async (_dir, paths) => {
      const result = await checkExtensionQuality(paths, DENO_PATH);
      assertEquals(
        result.issues.some((i) => i.check === "dynamic-import"),
        true,
      );
    },
  );
});

Deno.test("checkExtensionQuality ignores import() in template literal text", async () => {
  await withTempFiles(
    {
      "model.ts": "export const docs = `use import() for dynamic loading`;\n",
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

Deno.test("checkExtensionQuality ignores import() in multi-line template literal text", async () => {
  await withTempFiles(
    {
      "model.ts":
        'export const docs = `\n  Example: await import("npm:pkg")\n`;\n',
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

Deno.test("checkExtensionQuality uses deno.json config when denoConfigPath provided", async () => {
  await withTempFiles(
    {
      "model.ts": 'export const x = 1;\nexport const y = "hello";\n',
      "deno.json": "{}",
    },
    async (dir, paths) => {
      const tsPaths = paths.filter((p) => p.endsWith(".ts"));
      const denoConfigPath = join(dir, "deno.json");
      const result = await checkExtensionQuality(
        tsPaths,
        DENO_PATH,
        denoConfigPath,
      );
      assertEquals(result.passed, true);
      assertEquals(result.issues, []);
    },
  );
});

Deno.test("stripCommentsAndStrings removes single-line comments", () => {
  const result = stripCommentsAndStrings('code(); // import("pkg")');
  assertEquals(result.includes("import"), false);
  assertEquals(result.startsWith("code();"), true);
});

Deno.test("stripCommentsAndStrings removes string contents", () => {
  const result = stripCommentsAndStrings('const s = "import(pkg)";');
  assertEquals(result.includes("import"), false);
  assertEquals(result.includes("const s"), true);
});

Deno.test("stripCommentsAndStrings removes block comments", () => {
  const result = stripCommentsAndStrings("code /* import(x) */ more");
  assertEquals(result.includes("import"), false);
  assertEquals(result.includes("code"), true);
  assertEquals(result.includes("more"), true);
});

Deno.test("stripCommentsAndStrings preserves bare code", () => {
  const result = stripCommentsAndStrings("await import(url)");
  assertEquals(result.includes("import"), true);
  assertEquals(result.includes("await"), true);
});

Deno.test("stripCommentsAndStrings handles multi-line block comments", () => {
  const source = '/*\n * import("pkg")\n */\nreal code';
  const result = stripCommentsAndStrings(source);
  const lines = result.split("\n");
  // Line with import() inside comment should be blanked
  assertEquals(lines[1].includes("import"), false);
  // Line with real code should be preserved
  assertEquals(lines[3], "real code");
});

Deno.test("stripCommentsAndStrings preserves code inside template expressions", () => {
  const source = 'const x = `${import("pkg")}`;';
  const result = stripCommentsAndStrings(source);
  assertEquals(result.includes("import"), true);
});

Deno.test("stripCommentsAndStrings blanks template literal text", () => {
  const source = "const x = `import(pkg)`;\n";
  const result = stripCommentsAndStrings(source);
  assertEquals(result.includes("import"), false);
  assertEquals(result.includes("const x"), true);
});
