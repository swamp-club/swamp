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

// Extension-member precedence across the real catalog, loader and model
// registry (swamp-club#2562). Two local extensions and one pulled extension
// add the same method to one type. Whatever the catalog order or attach
// path, the local extension with the smaller path wins, and a base-model
// method always beats every extension.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import {
  getExtensionMemberCollisions,
  modelKindAdapter,
  removeAttachedExtensionsForType,
} from "../src/domain/extensions/model_kind_adapter.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  ExtensionCatalogStore,
  type ExtensionTypeRow,
} from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { canonicalizePath } from "../src/infrastructure/persistence/canonicalize_path.ts";
import {
  getExtensionLoadWarnings,
  resetExtensionLoadWarnings,
} from "../src/infrastructure/logging/extension_load_warnings.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

type Source = "aa" | "zz" | "pulled";

interface Fixture {
  repoDir: string;
  type: string;
  paths: Record<Source, string>;
  bundles: Record<Source | "base", string>;
}

const baseBundle = (type: string, withProbe: boolean) =>
  `const { z } = globalThis.__swamp_zod;
export const model = {
  type: "${type}",
  version: "2026.01.01.1",
  methods: {
    get: { description: "get", arguments: z.object({}), execute: async () => ({}) },
    ${
    withProbe
      ? 'probe: { description: "probe from base", arguments: z.object({}), execute: async () => ({}) },'
      : ""
  }
  },
};
`;

const extBundle = (type: string, label: string) =>
  `const { z } = globalThis.__swamp_zod;
export const extension = {
  type: "${type}",
  methods: [{
    probe: { description: "probe from ${label}", arguments: z.object({}), execute: async () => ({}) },
  }],
};
`;

async function withFixture(
  options: { baseHasProbe?: boolean },
  fn: (f: Fixture) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2562_prec_" });
  const type = `@test/prec-${crypto.randomUUID().slice(0, 8)}`;
  const bundleDir = join(repoDir, ".swamp", "bundles");
  await ensureDir(bundleDir);
  const paths: Record<Source, string> = {
    aa: canonicalizePath(join(repoDir, "extensions", "models", "aa_ext.ts")),
    zz: canonicalizePath(join(repoDir, "extensions", "models", "zz_ext.ts")),
    pulled: canonicalizePath(
      join(
        repoDir,
        ".swamp",
        "pulled-extensions",
        "@acme",
        "pkg",
        "models",
        "probe.ts",
      ),
    ),
  };
  const bundles = {
    base: join(bundleDir, "base.js"),
    aa: join(bundleDir, "aa_ext.js"),
    zz: join(bundleDir, "zz_ext.js"),
    pulled: join(bundleDir, "pulled_probe.js"),
  };
  await Deno.writeTextFile(
    bundles.base,
    baseBundle(type, options.baseHasProbe ?? false),
  );
  for (const s of ["aa", "zz", "pulled"] as const) {
    await Deno.writeTextFile(bundles[s], extBundle(type, s));
  }
  resetExtensionLoadWarnings();
  try {
    await fn({ repoDir, type, paths, bundles });
  } finally {
    modelRegistry.invalidateType(type);
    removeAttachedExtensionsForType(type);
    resetExtensionLoadWarnings();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function extRow(f: Fixture, s: Source): ExtensionTypeRow {
  return {
    source_path: f.paths[s],
    type_normalized: f.type,
    kind: "extension",
    bundle_path: f.bundles[s],
    version: "",
    description: "",
    extends_type: f.type,
    source_mtime: "",
    source_fingerprint: `fp-${s}`,
  };
}

function openLoader(f: Fixture, dbName: string) {
  const catalog = new ExtensionCatalogStore(
    join(f.repoDir, ".swamp", dbName),
  );
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository: new LockfileRepository(
      join(f.repoDir, "upstream_extensions.json"),
    ),
    repoRoot: f.repoDir,
  });
  const loader = new ExtensionLoader(
    testDenoRuntime,
    modelKindAdapter,
    f.repoDir,
    undefined,
    repository,
  );
  return { catalog, loader };
}

function probe(type: string): string | undefined {
  return modelRegistry.get(type)?.methods["probe"]?.description;
}

async function loadBase(f: Fixture, loader: ExtensionLoader): Promise<void> {
  await loader.loadSingleType(f.type, {
    bundlePath: f.bundles.base,
    sourcePath: join(f.repoDir, "extensions", "models", "base.ts"),
  });
}

for (
  const order of [
    ["pulled", "zz", "aa"],
    ["aa", "zz", "pulled"],
    ["zz", "pulled", "aa"],
  ] as const
) {
  Deno.test(`loadSingleType: the smaller local path wins whatever the catalog order (${order.join(", ")})`, async () => {
    await withFixture({}, async (f) => {
      const { catalog, loader } = openLoader(f, `catalog-${order[0]}.db`);
      try {
        for (const s of order) catalog.upsert(extRow(f, s));
        await loadBase(f, loader);
        assertEquals(probe(f.type), "probe from aa");
        const [collision] = getExtensionMemberCollisions().filter((c) =>
          c.type === f.type
        );
        assertEquals(collision.winner, f.paths.aa);
        assertEquals(
          [...collision.losers].sort(),
          [
            f.paths.pulled,
            f.paths.zz,
          ].sort(),
        );
      } finally {
        catalog.close();
      }
    });
  });
}

Deno.test("attachPendingExtensionsForType: a local extension that arrives after the pulled one replaces it", async () => {
  await withFixture({}, async (f) => {
    const { catalog, loader } = openLoader(f, "catalog.db");
    try {
      catalog.upsert(extRow(f, "pulled"));
      await loadBase(f, loader);
      assertEquals(probe(f.type), "probe from pulled");

      // A stale rescan or auto-install indexes the local extension later.
      catalog.upsert(extRow(f, "zz"));
      await loader.attachPendingExtensionsForType(f.type);
      assertEquals(probe(f.type), "probe from zz");

      catalog.upsert(extRow(f, "aa"));
      await loader.attachPendingExtensionsForType(f.type);
      assertEquals(probe(f.type), "probe from aa");

      // Another pass changes nothing and warns about nothing new.
      const before = getExtensionLoadWarnings().length;
      await loader.attachPendingExtensionsForType(f.type);
      assertEquals(probe(f.type), "probe from aa");
      assertEquals(getExtensionLoadWarnings().length, before);

      const messages = getExtensionLoadWarnings()
        .filter((w) => w.category === "MemberCollision")
        .map((w) => `${w.file}: ${w.error}`);
      assertEquals(
        messages.some((m) =>
          m.includes(f.paths.zz) && m.includes(`from ${f.paths.pulled}`) &&
          m.includes("local beats pulled")
        ),
        true,
      );
    } finally {
      catalog.close();
    }
  });
});

Deno.test("load(): re-importing extension files, as serve reload does, keeps the local winner and never self-collides", async () => {
  await withFixture({}, async (f) => {
    // Real source files: load() walks and bundles directories.
    const localDir = join(f.repoDir, "extensions", "models");
    const pulledDir = join(
      f.repoDir,
      ".swamp",
      "pulled-extensions",
      "@acme",
      "pkg",
      "models",
    );
    await ensureDir(localDir);
    await ensureDir(pulledDir);
    const source = (label: string) =>
      `import { z } from "npm:zod@4";
export const extension = {
  type: "${f.type}",
  methods: [{
    probe: { description: "probe from ${label}", arguments: z.object({}), execute: async () => ({}) },
  }],
};
`;
    await Deno.writeTextFile(join(localDir, "aa_ext.ts"), source("aa"));
    await Deno.writeTextFile(join(pulledDir, "probe.ts"), source("pulled"));
    modelRegistry.register({
      type: ModelType.create(f.type),
      version: "2026.01.01.1",
      methods: {},
    });

    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      f.repoDir,
    );
    await loader.load(pulledDir, { skipAlreadyRegistered: true });
    assertEquals(probe(f.type), "probe from pulled");
    await loader.load(localDir, { skipAlreadyRegistered: true });
    assertEquals(probe(f.type), "probe from aa");
    // A reload walks the same directories again.
    await loader.load(pulledDir, { skipAlreadyRegistered: true });
    await loader.load(localDir, { skipAlreadyRegistered: true });
    assertEquals(probe(f.type), "probe from aa");

    for (const w of getExtensionLoadWarnings()) {
      if (w.category !== "MemberCollision") continue;
      // A file is never reported as colliding with itself.
      assertEquals(
        w.error.includes(`also provided by ${canonicalizePath(w.file)}`),
        false,
      );
    }
  });
});

Deno.test({
  name:
    "a pulled row written under the real repo path still ranks as pulled when the loader uses a symlinked path",
  // Creating a directory symlink needs extra privileges on Windows.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixture({}, async (f) => {
      const alias = `${f.repoDir}-alias`;
      await Deno.symlink(f.repoDir, alias, { type: "dir" });
      const catalog = new ExtensionCatalogStore(
        join(f.repoDir, ".swamp", "catalog-alias.db"),
      );
      try {
        const loader = new ExtensionLoader(
          testDenoRuntime,
          modelKindAdapter,
          alias,
          undefined,
          new ExtensionRepository({
            catalog,
            lockfileRepository: new LockfileRepository(
              join(f.repoDir, "upstream_extensions.json"),
            ),
            repoRoot: alias,
          }),
        );
        // Rows are written under the resolved repo path; the loader only
        // knows the alias. `.swamp/` sorts before `extensions/`, so only the
        // pulled row's tier can make the local one win.
        const realRoot = Deno.realPathSync(f.repoDir);
        catalog.upsert({
          ...extRow(f, "pulled"),
          source_path: canonicalizePath(
            join(
              realRoot,
              ".swamp",
              "pulled-extensions",
              "@a",
              "models",
              "a.ts",
            ),
          ),
        });
        catalog.upsert({
          ...extRow(f, "zz"),
          source_path: canonicalizePath(
            join(realRoot, "extensions", "models", "zz_ext.ts"),
          ),
        });
        await loader.loadSingleType(f.type, {
          bundlePath: f.bundles.base,
          sourcePath: join(alias, "extensions", "models", "base.ts"),
        });
        assertEquals(probe(f.type), "probe from zz");
      } finally {
        catalog.close();
        await Deno.remove(alias);
      }
    });
  },
});

Deno.test({
  name:
    "one file reached under two spellings of the repo root is one contributor, not a self-collision",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixture({}, async (f) => {
      const alias = `${f.repoDir}-alias`;
      await Deno.symlink(f.repoDir, alias, { type: "dir" });
      const realModels = join(
        Deno.realPathSync(f.repoDir),
        "extensions",
        "models",
      );
      await ensureDir(realModels);
      await Deno.writeTextFile(
        join(realModels, "zz_ext.ts"),
        `import { z } from "npm:zod@4";
export const extension = {
  type: "${f.type}",
  methods: [{
    probe: { description: "probe from zz", arguments: z.object({}), execute: async () => ({}) },
  }],
};
`,
      );
      const catalog = new ExtensionCatalogStore(
        join(f.repoDir, ".swamp", "catalog-spellings.db"),
      );
      try {
        const loader = new ExtensionLoader(
          testDenoRuntime,
          modelKindAdapter,
          alias,
          undefined,
          new ExtensionRepository({
            catalog,
            lockfileRepository: new LockfileRepository(
              join(f.repoDir, "upstream_extensions.json"),
            ),
            repoRoot: alias,
          }),
        );
        // The catalog spells the file through the alias...
        catalog.upsert({
          ...extRow(f, "zz"),
          source_path: canonicalizePath(
            join(alias, "extensions", "models", "zz_ext.ts"),
          ),
        });
        await loader.loadSingleType(f.type, {
          bundlePath: f.bundles.base,
          sourcePath: join(alias, "extensions", "models", "base.ts"),
        });
        // ...and a directory walk reaches it through the real path.
        await loader.load(realModels, { skipAlreadyRegistered: true });

        assertEquals(probe(f.type), "probe from zz");
        assertEquals(
          getExtensionMemberCollisions().filter((c) => c.type === f.type),
          [],
        );
        assertEquals(
          getExtensionLoadWarnings().filter((w) =>
            w.category === "MemberCollision"
          ),
          [],
        );
      } finally {
        catalog.close();
        await Deno.remove(alias);
      }
    });
  },
});

Deno.test("a base-model method beats every extension, local or pulled", async () => {
  await withFixture({ baseHasProbe: true }, async (f) => {
    const { catalog, loader } = openLoader(f, "catalog.db");
    try {
      for (const s of ["aa", "zz", "pulled"] as const) {
        catalog.upsert(extRow(f, s));
      }
      await loadBase(f, loader);
      assertEquals(probe(f.type), "probe from base");
      const [collision] = getExtensionMemberCollisions().filter((c) =>
        c.type === f.type
      );
      assertEquals(collision.winner, null);
      assertEquals(collision.losers.length, 3);
    } finally {
      catalog.close();
    }
  });
});
