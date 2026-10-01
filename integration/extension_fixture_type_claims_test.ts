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

// Type claims read out of test fixtures (swamp-club#2876). A source-mounted
// extension ships `_test.ts` files whose string fixtures contain
// `export const model = { type: "@acme/thing" }`. Source-mounted dirs walk
// `_test.ts` files on purpose (swamp-club#389), so the cold index used to
// read the fixture type as a claim; two fixtures naming one type then made
// every later catalog save, such as an unrelated pull, fail I-Repo-1.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { DatabaseSync } from "node:sqlite";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import { makeExtension } from "../src/domain/extensions/extension.ts";
import { makeSource } from "../src/domain/extensions/source.ts";
import { makeSourceLocation } from "../src/domain/extensions/source_location.ts";
import { makeBundleLocation } from "../src/domain/extensions/bundle_location.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { DuplicateTypeError } from "../src/infrastructure/persistence/duplicate_type_error.ts";
import { bundleNamespace } from "../src/infrastructure/persistence/paths.ts";
import {
  getExtensionLoadWarnings,
  resetExtensionLoadWarnings,
} from "../src/infrastructure/logging/extension_load_warnings.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

import "../src/domain/models/models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

const PRUNE_MARKER = "migration_applied:prune-undeclared-type-claims-v1";

interface Layout {
  repoDir: string;
  modelsDir: string;
  sourceDir: string;
  dbPath: string;
  lockfilePath: string;
  fixtures: string[];
  realModel: string;
  testNamedModel: string;
  fixtureType: string;
}

async function withLayout(fn: (layout: Layout) => Promise<void>) {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2876_" });
  const modelsDir = join(repoDir, "extensions", "models");
  const sourceDir = join(repoDir, "extensions", "test-factory");
  await ensureDir(join(repoDir, ".swamp"));
  await ensureDir(modelsDir);
  await ensureDir(sourceDir);
  const lockfilePath = join(modelsDir, "upstream_extensions.json");
  await Deno.writeTextFile(lockfilePath, "{}");

  const id = crypto.randomUUID().slice(0, 8);
  const fixtureType = `@acme/thing-${id}`;
  const realModel = join(sourceDir, "factory.ts");
  await Deno.writeTextFile(
    realModel,
    `export const model = {\n  type: "@real/factory-${id}",\n  version: "1",\n};\n`,
  );
  // A real model whose filename ends in _test.ts (swamp-club#389).
  const testNamedModel = join(sourceDir, "docker_image_test.ts");
  await Deno.writeTextFile(
    testNamedModel,
    `export const model = {\n  type: "@real/docker-${id}",\n  version: "1",\n};\n`,
  );
  const fixtures = [
    join(sourceDir, "introspect_test.ts"),
    join(sourceDir, "factory_test.ts"),
  ];
  await Deno.writeTextFile(
    fixtures[0],
    "const fixture = `export const model = {\n" +
      `  type: "${fixtureType}",\n` +
      "};`;\n" +
      'Deno.test("extracts the type", () => {\n' +
      "  if (!fixture) throw new Error();\n" +
      "});\n",
  );
  await Deno.writeTextFile(
    fixtures[1],
    `const src = "export const model = { type: '${fixtureType}' }";\n` +
      `export const registeredTypes = [src];\n`,
  );

  resetExtensionLoadWarnings();
  try {
    await fn({
      repoDir,
      modelsDir,
      sourceDir,
      dbPath: join(repoDir, ".swamp", "_extension_catalog.db"),
      lockfilePath,
      fixtures,
      realModel,
      testNamedModel,
      fixtureType,
    });
  } finally {
    resetExtensionLoadWarnings();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

async function openRepository(layout: Layout) {
  const catalog = new ExtensionCatalogStore(layout.dbPath);
  const lockfileRepository = await LockfileRepository.create(
    layout.lockfilePath,
  );
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository,
    repoRoot: layout.repoDir,
  });
  return { catalog, repository };
}

function buildIndex(layout: Layout, repository: ExtensionRepository) {
  return new ExtensionLoader(
    testDenoRuntime,
    modelKindAdapter,
    layout.repoDir,
    undefined,
    repository,
  ).buildIndex(layout.modelsDir, {
    additionalDirs: [layout.sourceDir],
    indexOnly: true,
  });
}

function fixtureBundlePath(layout: Layout, fixture: string): string {
  const name = fixture.slice(layout.sourceDir.length + 1)
    .replace(/\.ts$/, ".js");
  return join(
    layout.repoDir,
    ".swamp",
    "bundles",
    bundleNamespace(layout.sourceDir, layout.repoDir),
    name,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A pulled extension unrelated to the source-mounted one. */
function unrelatedPulledExtension(repoDir: string) {
  const extRoot = join(repoDir, ".swamp", "pulled-extensions", "@other/ext");
  const abs = join(extRoot, "models", "other.ts");
  return makeExtension({
    name: "@other/ext",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: extRoot,
    sources: [
      makeSource({
        id: makeSourceLocation(abs, extRoot),
        kind: "model",
        fingerprint: "fp-other",
        state: {
          tag: "Indexed",
          type: "@other/model",
          bundle: makeBundleLocation(join(extRoot, "other.js"), "fp-other"),
        },
        sourceMtime: "",
      }),
    ],
  });
}

Deno.test("cold buildIndex indexes the real models of a source-mounted dir and no fixture type", async () => {
  await withLayout(async (layout) => {
    const { catalog, repository } = await openRepository(layout);
    try {
      await buildIndex(layout, repository);

      const types = catalog.findByKind("model").map((r) => r.type_normalized);
      assertEquals(types.includes(layout.fixtureType), false);
      assert(
        catalog.findBySourcePath(layout.realModel)?.type_normalized
          .startsWith("@real/factory-"),
      );
      assert(
        catalog.findBySourcePath(layout.testNamedModel)?.type_normalized
          .startsWith("@real/docker-"),
        "a real model in a *_test.ts file still indexes (swamp-club#389)",
      );
      for (const fixture of layout.fixtures) {
        assertEquals(catalog.findBySourcePath(fixture), undefined);
      }
      assertEquals(
        getExtensionLoadWarnings().filter((w) =>
          w.category === "TypeExtractionFailed"
        ),
        [],
      );

      // The unrelated save the report saw refused now succeeds.
      repository.saveAll([unrelatedPulledExtension(layout.repoDir)]);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("warm buildIndex does not rebundle fixture files that have no catalog row", async () => {
  await withLayout(async (layout) => {
    const { catalog, repository } = await openRepository(layout);
    try {
      await buildIndex(layout, repository);
      for (const fixture of layout.fixtures) {
        await Deno.remove(fixtureBundlePath(layout, fixture)).catch(() => {});
      }

      await buildIndex(layout, repository);

      for (const fixture of layout.fixtures) {
        assertEquals(
          await exists(fixtureBundlePath(layout, fixture)),
          false,
          `${fixture} was bundled again on the warm pass`,
        );
        assertEquals(catalog.findBySourcePath(fixture), undefined);
      }
    } finally {
      catalog.close();
    }
  });
});

Deno.test("opening a catalog holding fixture claims prunes them so an unrelated save succeeds", async () => {
  await withLayout(async (layout) => {
    // The state a pre-fix binary left: two identity-less rows claiming the
    // fixture type, written after this catalog's prune had run.
    const seeded = await openRepository(layout);
    try {
      for (const fixture of layout.fixtures) {
        seeded.catalog.upsert({
          type_normalized: layout.fixtureType,
          kind: "model",
          bundle_path: fixtureBundlePath(layout, fixture),
          source_path: fixture,
          version: "1",
          description: "",
          extends_type: "",
          source_mtime: "",
          source_fingerprint: "fp",
        });
      }
      const thrown = assertThrows(
        () =>
          seeded.repository.saveAll([
            unrelatedPulledExtension(layout.repoDir),
          ]),
        DuplicateTypeError,
      );
      assertEquals(thrown.typeNormalized, layout.fixtureType);
      assert(!thrown.message.includes(" @ at "));
    } finally {
      seeded.catalog.close();
    }

    // A catalog last written by a pre-fix binary has no prune marker.
    const raw = new DatabaseSync(layout.dbPath);
    raw.prepare("DELETE FROM bundle_meta WHERE key = ?").run(PRUNE_MARKER);
    raw.close();

    const reopened = await openRepository(layout);
    try {
      for (const fixture of layout.fixtures) {
        assertEquals(reopened.catalog.findBySourcePath(fixture), undefined);
      }
      reopened.repository.saveAll([unrelatedPulledExtension(layout.repoDir)]);
      assertEquals(
        reopened.catalog.findAll().some((r) =>
          r.type_normalized === "@other/model"
        ),
        true,
      );
    } finally {
      reopened.catalog.close();
    }
  });
});
