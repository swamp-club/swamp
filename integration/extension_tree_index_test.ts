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

// The collective check at push and install loads every source of an
// extension tree with the real loader, bundler and probe host
// (swamp-club#3456). These tests run that wiring end to end over a tree on
// disk and over a push archive, with no fakes in between.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir, walk } from "@std/fs";
import { dirname, join } from "@std/path";
import { createExtensionTreeIndexer } from "../src/libswamp/extensions/extension_tree_index.ts";
import { createExtensionPushPrepareDeps } from "../src/libswamp/extensions/push.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const denoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

const model = (typeExpr: string, prelude = "") =>
  `// deno-lint-ignore no-explicit-any
const { z } = (globalThis as any).__swamp_zod;
${prelude}
export const model = {
  type: ${typeExpr},
  version: "2026.05.05.1",
  globalArguments: z.object({}),
  resources: {},
  methods: {
    noop: {
      description: "noop",
      arguments: z.object({}),
      execute: () => Promise.resolve({ dataHandles: [] }),
    },
  },
};
`;

/** A tree of every source shape the collective check has to judge. */
const TREE: Record<string, string> = {
  "models/literal.ts": model('"@acme/literal"'),
  "models/constant.ts": model("TYPE", 'const TYPE = "@acme/constant";'),
  "models/imported.ts": model(
    "SHARED_TYPE",
    'import { SHARED_TYPE } from "./shared/type.ts";',
  ),
  "models/shared/type.ts": 'export const SHARED_TYPE = "@acme/imported";\n',
  "models/spread.ts":
    `// deno-lint-ignore no-explicit-any\nconst { z } = (globalThis as any).__swamp_zod;\n` +
    'const base = { type: "@other/spread" };\n' +
    "export const model = {\n" +
    '  type: "@acme/written",\n  ...base,\n  version: "2026.05.05.1",\n' +
    "  globalArguments: z.object({}),\n  resources: {},\n" +
    '  methods: { noop: { description: "noop", arguments: z.object({}),\n' +
    "    execute: () => Promise.resolve({ dataHandles: [] }) } },\n};\n",
  "models/lib/helper.ts": model('"@other/helper"'),
  "models/_private/skipped.ts": model('"@other/private"'),
  "models/broken.ts": model('"@acme/broken"', 'throw new Error("boom");'),
  "models/plain.ts": "export const notAModel = 1;\n",
  // npm CommonJS interop and path helpers read import.meta.url at import:
  // it must be a file URL, as it is when the loader imports the bundle.
  "models/meta.ts": model(
    '"@acme/meta"',
    'import { fileURLToPath } from "node:url";\nfileURLToPath(import.meta.url);\n',
  ),
};

async function writeTree(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await ensureDir(dirname(join(root, path)));
    await Deno.writeTextFile(join(root, path), content);
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp_3456_" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function typesByFile(
  index: Awaited<ReturnType<ReturnType<typeof createExtensionTreeIndexer>>>,
): Record<string, string | null> {
  return Object.fromEntries(
    index.sources.map((s) => [s.fileName, s.indexed?.typeNormalized ?? null]),
  );
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of walk(dir, { includeDirs: false })) {
    out.push(entry.path);
  }
  return out.sort();
}

Deno.test("createExtensionTreeIndexer: reports the type each source registers when loaded, whatever its spelling (swamp-club#3456)", async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, "extension");
    await writeTree(root, TREE);
    const before = await filesUnder(root);
    const index = await createExtensionTreeIndexer({
      denoRuntime,
      repoDir: dir,
    })(root);

    assertEquals(typesByFile(index), {
      "constant.ts": "@acme/constant",
      "imported.ts": "@acme/imported",
      "lib/helper.ts": "@other/helper",
      "literal.ts": "@acme/literal",
      "meta.ts": "@acme/meta",
      "plain.ts": null,
      "shared/type.ts": null,
      "spread.ts": "@other/spread",
    });
    assertEquals(index.failures.map((f) => f.fileName), ["broken.ts"]);
    assertStringIncludes(index.failures[0].reason, "boom");
    // Bundles go under repoDir's .swamp, never into the tree itself.
    assertEquals(await filesUnder(root), before);
  });
});

Deno.test("createExtensionPushPrepareDeps: indexArchive loads the sources a push archive carries (swamp-club#3456)", async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, "extension");
    await writeTree(root, {
      "manifest.yaml": 'manifestVersion: 1\nname: "@acme/ext"\n',
      "models/constant.ts": TREE["models/constant.ts"],
      "models/lib/helper.ts": TREE["models/lib/helper.ts"],
    });
    const archivePath = join(dir, "ext.tar.gz");
    await createTarGz(root, archivePath);

    const index = await createExtensionPushPrepareDeps().indexArchive(
      await Deno.readFile(archivePath),
      "@acme/ext",
    );

    assertEquals(typesByFile(index), {
      "constant.ts": "@acme/constant",
      "lib/helper.ts": "@other/helper",
    });
    assertEquals(index.failures, []);
  });
});

Deno.test("createExtensionPushPrepareDeps: indexArchive loads the bundles push shipped rather than bundling each source again (swamp-club#3456)", async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, "extension");
    // The shipped bundle registers a different type from its source, so
    // the result shows which one was loaded.
    await writeTree(root, {
      "manifest.yaml": 'manifestVersion: 1\nname: "@acme/ext"\n',
      "models/a.ts": model('"@acme/from-source"'),
      "bundles/a.js": "const { z } = globalThis.__swamp_zod;\n" +
        'export const model = { type: "@acme/from-bundle", ' +
        'version: "2026.05.05.1", globalArguments: z.object({}), ' +
        'resources: {}, methods: { noop: { description: "noop", ' +
        "arguments: z.object({}), " +
        "execute: () => Promise.resolve({ dataHandles: [] }) } } };\n",
    });
    const archivePath = join(dir, "ext.tar.gz");
    await createTarGz(root, archivePath);

    const index = await createExtensionPushPrepareDeps().indexArchive(
      await Deno.readFile(archivePath),
      "@acme/ext",
    );

    assertEquals(typesByFile(index), { "a.ts": "@acme/from-bundle" });
  });
});
