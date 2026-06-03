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
import { resolveLocalImports } from "./extension_import_resolver.ts";

Deno.test("resolveLocalImports resolves entry point with no imports", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const entryFile = join(modelsDir, "entry.ts");
    await Deno.writeTextFile(entryFile, "export const x = 1;\n");

    const result = await resolveLocalImports([entryFile], modelsDir);
    assertEquals(result.resolvedFiles, [entryFile]);
    assertEquals(result.skippedImports, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveLocalImports resolves relative imports", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const helperFile = join(modelsDir, "helper.ts");
    await Deno.writeTextFile(helperFile, "export const y = 2;\n");
    const entryFile = join(modelsDir, "entry.ts");
    await Deno.writeTextFile(
      entryFile,
      'import { y } from "./helper.ts";\nexport const x = y;\n',
    );

    const result = await resolveLocalImports([entryFile], modelsDir);
    assertEquals(result.resolvedFiles.sort(), [entryFile, helperFile].sort());
    assertEquals(result.skippedImports, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveLocalImports appends .ts when import has no extension", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const helperFile = join(modelsDir, "helper.ts");
    await Deno.writeTextFile(helperFile, "export const y = 2;\n");
    const entryFile = join(modelsDir, "entry.ts");
    await Deno.writeTextFile(
      entryFile,
      'import { y } from "./helper";\nexport const x = y;\n',
    );

    const result = await resolveLocalImports([entryFile], modelsDir);
    assertEquals(result.resolvedFiles.sort(), [entryFile, helperFile].sort());
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveLocalImports handles circular imports", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const fileA = join(modelsDir, "a.ts");
    const fileB = join(modelsDir, "b.ts");
    await Deno.writeTextFile(
      fileA,
      'import { y } from "./b.ts";\nexport const x = y;\n',
    );
    await Deno.writeTextFile(
      fileB,
      'import { x } from "./a.ts";\nexport const y = x;\n',
    );

    const result = await resolveLocalImports([fileA], modelsDir);
    assertEquals(result.resolvedFiles.sort(), [fileA, fileB].sort());
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveLocalImports skips imports outside models dir", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const entryFile = join(modelsDir, "entry.ts");
    await Deno.writeTextFile(
      entryFile,
      'import { x } from "../outside.ts";\nexport const y = x;\n',
    );

    const result = await resolveLocalImports([entryFile], modelsDir);
    assertEquals(result.resolvedFiles, [entryFile]);
    assertEquals(result.skippedImports, ["../outside.ts"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveLocalImports handles subdirectories", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    const subDir = join(modelsDir, "utils");
    await Deno.mkdir(subDir, { recursive: true });
    const utilFile = join(subDir, "types.ts");
    await Deno.writeTextFile(utilFile, "export type Foo = string;\n");
    const entryFile = join(modelsDir, "entry.ts");
    await Deno.writeTextFile(
      entryFile,
      'import type { Foo } from "./utils/types.ts";\nexport const x: Foo = "hello";\n',
    );

    const result = await resolveLocalImports([entryFile], modelsDir);
    assertEquals(result.resolvedFiles.sort(), [entryFile, utilFile].sort());
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveLocalImports resolves multi-line imports", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    const libDir = join(modelsDir, "_lib");
    await Deno.mkdir(libDir, { recursive: true });
    const libFile = join(libDir, "aws.ts");
    await Deno.writeTextFile(
      libFile,
      "export function createResource() {}\nexport function deleteResource() {}\n",
    );
    const entryFile = join(modelsDir, "entry.ts");
    await Deno.writeTextFile(
      entryFile,
      `import {\n  createResource,\n  deleteResource,\n} from "./_lib/aws.ts";\nexport const x = createResource;\n`,
    );

    const result = await resolveLocalImports([entryFile], modelsDir);
    assertEquals(result.resolvedFiles.sort(), [entryFile, libFile].sort());
    assertEquals(result.skippedImports, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("resolveLocalImports handles export from statements", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const helperFile = join(modelsDir, "helper.ts");
    await Deno.writeTextFile(helperFile, "export const y = 2;\n");
    const entryFile = join(modelsDir, "entry.ts");
    await Deno.writeTextFile(
      entryFile,
      'export { y } from "./helper.ts";\n',
    );

    const result = await resolveLocalImports([entryFile], modelsDir);
    assertEquals(result.resolvedFiles.sort(), [entryFile, helperFile].sort());
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
