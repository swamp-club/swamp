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
import { bundleExtension } from "./bundle.ts";

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
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(js)));
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

Deno.test("bundleExtension resolves npm imports without creating deno.lock", async () => {
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

    // Bundle should succeed — yaml is externalized (not inlined)
    assertEquals(js.length > 0, true);

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
