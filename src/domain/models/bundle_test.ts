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
import { bundleExtension, stopBundler } from "./bundle.ts";

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
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(js)));
  return await import(`data:application/javascript;base64,${encoded}`);
}

// esbuild WASM spawns a long-lived child process, so we disable Deno's
// resource and ops sanitizers for these tests.

Deno.test({
  name: "bundleExtension transpiles TypeScript to valid JS",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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

    // Set up globalThis shim for zod
    (globalThis as Record<string, unknown>).__swampZod = { z };

    await withTempFile(tsCode, async (path) => {
      const js = await bundleExtension(path);

      // Should not contain TypeScript syntax
      assertEquals(js.includes("interface Config"), false);
      assertEquals(js.includes(": string"), false);
      assertEquals(js.includes("<T extends"), false);

      // Should be importable
      const mod = await importBundled(js);
      assertEquals((mod.model as { type: string }).type, "test");
    });
  },
});

Deno.test({
  name: "bundleExtension replaces zod with globalThis shim",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tsCode = `
import { z } from "npm:zod@4";

export const schema = z.object({ name: z.string() });
`;

    // Set up globalThis shim for zod
    (globalThis as Record<string, unknown>).__swampZod = { z };

    await withTempFile(tsCode, async (path) => {
      const js = await bundleExtension(path);

      // Zod should not be inlined — the bundle should be small
      // because it's replaced with a globalThis shim
      assertEquals(js.length < 10_000, true);
    });
  },
});

Deno.test({
  name: "bundleExtension produces importable module with working zod instanceof",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tsCode = `
import { z } from "npm:zod@4";

export const schema = z.object({ message: z.string() });
`;

    // Set up globalThis shim so the bundled module can access swamp's zod
    (globalThis as Record<string, unknown>).__swampZod = { z };

    await withTempFile(tsCode, async (path) => {
      const js = await bundleExtension(path);
      const mod = await importBundled(js);

      // The schema from the bundled module should be a ZodType instance
      // because zod is accessed via globalThis shim sharing swamp's instance
      assertEquals(mod.schema instanceof z.ZodType, true);

      // It should also parse correctly
      const parsed = (mod.schema as z.ZodObject<{ message: z.ZodString }>)
        .parse({
          message: "hello",
        });
      assertEquals(parsed, { message: "hello" });
    });
  },
});

Deno.test({
  name: "stopBundler cleans up esbuild worker",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    // Should not throw even if called multiple times
    stopBundler();
    stopBundler();
  },
});
