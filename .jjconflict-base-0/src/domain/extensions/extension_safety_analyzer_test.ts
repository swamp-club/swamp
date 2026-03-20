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
import { analyzeExtensionSafety } from "./extension_safety_analyzer.ts";

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

Deno.test("analyzeExtensionSafety passes for clean .ts files", async () => {
  await withTempFiles(
    { "model.ts": "export const x = 1;\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors, []);
      assertEquals(result.warnings, []);
    },
  );
});

Deno.test("analyzeExtensionSafety errors on disallowed extension", async () => {
  await withTempFiles(
    { "script.sh": "#!/bin/bash\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors.length, 1);
      assertEquals(result.errors[0].message.includes(".sh"), true);
    },
  );
});

Deno.test("analyzeExtensionSafety errors on hidden files", async () => {
  await withTempFiles(
    { ".hidden.ts": "export const x = 1;\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors.length, 1);
      assertEquals(
        result.errors[0].message.includes("Hidden files"),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety errors on eval()", async () => {
  await withTempFiles(
    { "evil.ts": 'eval("alert(1)");\n' },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors.length, 1);
      assertEquals(
        result.errors[0].message.includes("eval()"),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety errors on new Function()", async () => {
  await withTempFiles(
    { "evil.ts": 'const fn = new Function("return 1");\n' },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors.length, 1);
      assertEquals(
        result.errors[0].message.includes("new Function()"),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety warns on Deno.Command()", async () => {
  await withTempFiles(
    { "cmd.ts": 'const c = new Deno.Command("ls");\n' },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors, []);
      assertEquals(result.warnings.length, 1);
      assertEquals(
        result.warnings[0].message.includes("Deno.Command()"),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety warns on base64 strings", async () => {
  const longBase64 = "A".repeat(120);
  await withTempFiles(
    { "data.ts": `export const encoded = "${longBase64}";\n` },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors, []);
      assertEquals(result.warnings.length >= 1, true);
      assertEquals(
        result.warnings.some((w) => w.message.includes("base64")),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety errors on symlinks", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const realFile = join(tmpDir, "real.ts");
    await Deno.writeTextFile(realFile, "export const x = 1;\n");
    const linkFile = join(tmpDir, "link.ts");
    await Deno.symlink(realFile, linkFile);

    const result = await analyzeExtensionSafety([linkFile]);
    assertEquals(result.errors.length, 1);
    assertEquals(
      result.errors[0].message.includes("Symlinks"),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("analyzeExtensionSafety errors on file count > 150", async () => {
  // Generate 151 fake paths — we don't need real files for count check
  const tmpDir = await Deno.makeTempDir();
  try {
    const paths: string[] = [];
    for (let i = 0; i < 151; i++) {
      const p = join(tmpDir, `file${i}.ts`);
      await Deno.writeTextFile(p, `export const x${i} = ${i};\n`);
      paths.push(p);
    }

    const result = await analyzeExtensionSafety(paths);
    assertEquals(
      result.errors.some((e) => e.message.includes("150")),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("analyzeExtensionSafety allows .json, .md, .yaml, .yml, .txt", async () => {
  await withTempFiles(
    {
      "config.json": '{"key": "value"}',
      "README.md": "# Hello",
      "flow.yaml": "name: test",
      "flow2.yml": "name: test2",
      "notes.txt": "Some notes",
    },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors, []);
      assertEquals(result.warnings, []);
    },
  );
});
