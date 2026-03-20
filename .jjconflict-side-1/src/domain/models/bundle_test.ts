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
import { z } from "zod";
import {
  bundleExtension,
  fixCjsEsmInterop,
  installZodGlobal,
  rewriteZodImports,
  sanitizeDataUrlError,
  sourceHasBareSpecifiers,
  uint8ArrayToBase64,
} from "./bundle.ts";

const DENO_PATH = Deno.execPath();

async function withTempFile(
  content: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  const path = join(dir, "test_ext.ts");
  await Deno.writeTextFile(path, content);
  try {
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function importBundled(
  js: string,
): Promise<Record<string, unknown>> {
  installZodGlobal();
  const rewritten = rewriteZodImports(js);
  const encoded = uint8ArrayToBase64(new TextEncoder().encode(rewritten));
  return await import(`data:application/javascript;base64,${encoded}`);
}

Deno.test("bundleExtension transpiles TypeScript to valid JS", async () => {
  const tsCode = `
import { z } from "npm:zod@4";

interface Config {
  name: string;
  value?: number;
}

function greet<T extends Config>(config: T): string {
  return config.name;
}

const schema = z.object({ message: z.string() });

export const model = {
  type: greet({ name: "test" }),
  schema,
};
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);

    // Should not contain TypeScript syntax
    assertEquals(js.includes("interface Config"), false);
    assertEquals(js.includes(": string"), false);
    assertEquals(js.includes("<T extends"), false);

    // Should be importable
    const mod = await importBundled(js);
    assertEquals((mod.model as { type: string }).type, "test");
  });
});

Deno.test("bundleExtension externalizes zod imports", async () => {
  const tsCode = `
import { z } from "npm:zod@4";

export const schema = z.object({ name: z.string() });
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);

    // Zod should not be inlined — the bundle should be small
    // A fully inlined zod would be hundreds of KB
    assertEquals(js.length < 10_000, true);
  });
});

Deno.test("bundleExtension inlines non-zod npm packages", async () => {
  const tsCode = `
import { z } from "npm:zod@4";
import { parse, stringify } from "npm:yaml@2.7.1";

const ConfigSchema = z.object({
  data: z.string(),
});

export const model = {
  type: "@test/yaml-model",
  version: "2026.01.01.1",
  schema: ConfigSchema,
  transform: (input: string) => {
    const parsed = parse(input);
    return stringify(parsed);
  },
};
`;

  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  const path = join(dir, "test_ext.ts");
  await Deno.writeTextFile(path, tsCode);
  try {
    const js = await bundleExtension(path, DENO_PATH);

    // Bundle should succeed — yaml is inlined into the bundle
    assertEquals(js.length > 0, true);

    // yaml package should be inlined (bundle > 10KB with yaml code included)
    assertEquals(
      js.length > 10_000,
      true,
      "yaml should be inlined into the bundle, making it larger than 10KB",
    );

    // No deno.lock should be created in the source directory
    let lockExists = true;
    try {
      await Deno.stat(join(dir, "deno.lock"));
    } catch {
      lockExists = false;
    }
    assertEquals(
      lockExists,
      false,
      "deno.lock should not be created in the source directory",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundleExtension produces importable module with working zod instanceof", async () => {
  const tsCode = `
import { z } from "npm:zod@4";

export const schema = z.object({ message: z.string() });
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);
    const mod = await importBundled(js);

    // The schema from the bundled module should be a ZodType instance
    // because zod is externalized and shares the same instance
    assertEquals(mod.schema instanceof z.ZodType, true);

    // It should also parse correctly
    const parsed = (mod.schema as z.ZodObject<{ message: z.ZodString }>).parse({
      message: "hello",
    });
    assertEquals(parsed, { message: "hello" });
  });
});

Deno.test("bundleExtension produces module where z.toJSONSchema works", async () => {
  const tsCode = `
import { z } from "npm:zod@4";

export const schema = z.object({ id: z.string(), data: z.unknown() });
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);
    const mod = await importBundled(js);

    // Should be a ZodType from swamp's Zod instance
    assertEquals(mod.schema instanceof z.ZodType, true);

    // z.toJSONSchema should work without _zod errors
    const jsonSchema = z.toJSONSchema(mod.schema as z.ZodTypeAny);
    assertEquals(jsonSchema.type, "object");
  });
});

// --- rewriteZodImports unit tests ---

Deno.test("rewriteZodImports rewrites named imports", () => {
  const input = `import { z } from "npm:zod@4";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z } = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites aliased imports", () => {
  const input = `import { z as z2 } from "npm:zod@4";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z: z2 } = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites star imports", () => {
  const input = `import * as zod from "npm:zod@4";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const zod = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites unversioned npm:zod", () => {
  const input = `import { z } from "npm:zod";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z } = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites multiple zod imports", () => {
  const input = [
    `import { z as z2 } from "npm:zod@4";`,
    `import { z } from "npm:zod@4";`,
    `console.log(z, z2);`,
  ].join("\n");
  const result = rewriteZodImports(input);
  const expected = [
    `const { z: z2 } = globalThis.__swamp_zod;`,
    `const { z } = globalThis.__swamp_zod;`,
    `console.log(z, z2);`,
  ].join("\n");
  assertEquals(result, expected);
});

Deno.test("rewriteZodImports rewrites bare zod specifier", () => {
  const input = `import { z } from "zod";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z } = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites bare zod star import", () => {
  const input = `import * as zod from "zod";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const zod = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites bare aliased zod specifier", () => {
  const input = `import { z as z2 } from "zod";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z: z2 } = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports leaves non-zod imports untouched", () => {
  const input = `import { parse } from "npm:yaml@2";`;
  const result = rewriteZodImports(input);
  assertEquals(result, input);
});

Deno.test("rewriteZodImports is idempotent", () => {
  const input = `import { z } from "npm:zod@4";`;
  const first = rewriteZodImports(input);
  const second = rewriteZodImports(first);
  assertEquals(first, second);
});

Deno.test("rewriteZodImports handles single-quoted specifiers", () => {
  const input = `import { z } from 'npm:zod@4';`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z } = globalThis.__swamp_zod;`);
});

// --- uint8ArrayToBase64 unit tests ---

Deno.test("uint8ArrayToBase64 matches btoa for small input", () => {
  const text = "hello world";
  const bytes = new TextEncoder().encode(text);
  const expected = btoa(text);
  assertEquals(uint8ArrayToBase64(bytes), expected);
});

Deno.test("uint8ArrayToBase64 handles empty input", () => {
  assertEquals(uint8ArrayToBase64(new Uint8Array(0)), btoa(""));
});

// --- fixCjsEsmInterop unit tests ---

Deno.test("fixCjsEsmInterop rewrites __toESM to always set default", () => {
  // Use the exact single-line format esbuild generates
  const input =
    `var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(\n  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,\n  mod\n));`;
  const result = fixCjsEsmInterop(input);
  // The condition should be removed — always sets .default
  assertEquals(result.includes("isNodeMode ||"), false);
  assertEquals(result.includes("__esModule"), false);
  assertEquals(
    result.includes(
      `__defProp(target, "default", { value: mod, enumerable: true })`,
    ),
    true,
  );
  // Should not contain `: target,` fallback (only `target,` at the end remains from `__copyProps(... , target,` being removed)
  assertEquals(result.includes(": target,"), false);
});

Deno.test("fixCjsEsmInterop is idempotent", () => {
  const input =
    `var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(\n  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,\n  mod\n));`;
  const first = fixCjsEsmInterop(input);
  const second = fixCjsEsmInterop(first);
  assertEquals(first, second);
});

Deno.test("fixCjsEsmInterop leaves non-matching code untouched", () => {
  const input = `const x = 42; console.log("hello");`;
  assertEquals(fixCjsEsmInterop(input), input);
});

// --- sanitizeDataUrlError unit tests ---

Deno.test("sanitizeDataUrlError truncates base64 data URLs", () => {
  const longBase64 = "A".repeat(200);
  const error =
    `Error: The argument 'filename' must be a file URL. Received data:application/javascript;base64,${longBase64}`;
  const result = sanitizeDataUrlError(error);
  assertEquals(
    result,
    `Error: The argument 'filename' must be a file URL. Received data:application/javascript;base64,[truncated]`,
  );
});

Deno.test("sanitizeDataUrlError leaves short errors untouched", () => {
  const error = "Error: something went wrong";
  assertEquals(sanitizeDataUrlError(error), error);
});

Deno.test("bundleExtension uses deno.json config when denoConfigPath provided", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  const tsPath = join(dir, "test_ext.ts");
  const denoJsonPath = join(dir, "deno.json");

  // Write a minimal deno.json with an import map for zod
  await Deno.writeTextFile(
    denoJsonPath,
    JSON.stringify({
      imports: {
        "zod": "npm:zod@4",
      },
    }),
  );

  // Use bare "zod" specifier (resolved via import map, not npm: prefix)
  await Deno.writeTextFile(
    tsPath,
    'import { z } from "zod";\n\nexport const schema = z.object({ name: z.string() });\n',
  );

  try {
    const js = await bundleExtension(tsPath, DENO_PATH, {
      denoConfigPath: denoJsonPath,
    });
    assertEquals(js.length > 0, true);

    // Should be importable and working
    const mod = await importBundled(js);
    assertEquals(mod.schema instanceof z.ZodType, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- sourceHasBareSpecifiers unit tests ---

Deno.test("sourceHasBareSpecifiers returns true for bare zod import", () => {
  assertEquals(sourceHasBareSpecifiers('import { z } from "zod";'), true);
});

Deno.test("sourceHasBareSpecifiers returns true for bare scoped import", () => {
  assertEquals(
    sourceHasBareSpecifiers(
      'import { Client } from "@aws-sdk/client-secrets-manager";',
    ),
    true,
  );
});

Deno.test("sourceHasBareSpecifiers returns false for npm: prefixed import", () => {
  assertEquals(
    sourceHasBareSpecifiers('import { z } from "npm:zod@4";'),
    false,
  );
});

Deno.test("sourceHasBareSpecifiers returns false for relative import", () => {
  assertEquals(
    sourceHasBareSpecifiers('import { helper } from "./helpers.ts";'),
    false,
  );
});

Deno.test("sourceHasBareSpecifiers returns false for jsr: import", () => {
  assertEquals(
    sourceHasBareSpecifiers('import { assert } from "jsr:@std/assert";'),
    false,
  );
});

Deno.test("sourceHasBareSpecifiers returns false for node: import", () => {
  assertEquals(
    sourceHasBareSpecifiers('import { readFile } from "node:fs";'),
    false,
  );
});

Deno.test("sourceHasBareSpecifiers returns false when only relative and npm imports", () => {
  const source = `
import { z } from "npm:zod@4";
import { helper } from "./helpers.ts";
export { foo } from "../shared.ts";
`;
  assertEquals(sourceHasBareSpecifiers(source), false);
});

Deno.test("uint8ArrayToBase64 handles large input without stack overflow", () => {
  // 1MB of data — would blow the stack with String.fromCharCode(...bytes)
  const size = 1_000_000;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = i % 256;
  }
  // Should not throw RangeError: Maximum call stack size exceeded
  const result = uint8ArrayToBase64(bytes);
  assertEquals(typeof result, "string");
  assertEquals(result.length > 0, true);
});

Deno.test("bundleExtension returns minimal module for type-only files", async () => {
  const tsCode = `
// A type-only file — all declarations are erased at compile time.
export interface Config {
  name: string;
  value?: number;
}

export type Status = "running" | "stopped";
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);

    // Should return a minimal module instead of throwing
    assertEquals(js, "export {};\n");
  });
});
