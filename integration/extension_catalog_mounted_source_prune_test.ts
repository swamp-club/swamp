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

// Partial extension catalog saves and sources mounted from outside the repo
// (swamp-club#2563). `extension pull` and `extension rm` save only the
// extension they change, and each save pruned every catalog row whose source
// is outside the repo root, so a source mounted through .swamp-sources.yaml
// lost its rows until something re-indexed it. These tests wire the real
// loader, install and remove services, repository and catalog together on a
// temp filesystem, building each repository the way the CLI does.

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import "../src/domain/models/models.ts";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { canonicalizePath } from "../src/infrastructure/persistence/canonicalize_path.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { resolveMountedSourceDirs } from "../src/infrastructure/persistence/swamp_sources_repository.ts";
import { InstallExtensionService } from "../src/libswamp/extensions/install_extension_service.ts";
import type { InstallContext } from "../src/libswamp/extensions/pull.ts";
import { RemoveExtensionService } from "../src/libswamp/extensions/remove_extension_service.ts";

await initializeLogging({});

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

const VERSION = "2026.01.01.1";

function modelSource(type: string): string {
  return `// deno-lint-ignore no-explicit-any
const { z } = (globalThis as any).__swamp_zod;
export const model = {
  type: "${type}",
  version: "${VERSION}",
  methods: {
    get: { description: "get", arguments: z.object({}), execute: async () => ({}) },
  },
};
`;
}

async function writeModel(path: string, type: string): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, modelSource(type));
}

async function buildArchive(name: string, type: string): Promise<Uint8Array> {
  const archiveDir = await Deno.makeTempDir({ prefix: "swamp_2563_arc_" });
  try {
    const extDir = join(archiveDir, "extension");
    await ensureDir(join(extDir, "models"));
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      `manifestVersion: 1\nname: "${name}"\nversion: "${VERSION}"\n` +
        `models:\n  - pulled.ts\n`,
    );
    await Deno.writeTextFile(
      join(extDir, "models", "pulled.ts"),
      modelSource(type),
    );
    await createTarGz(extDir, join(archiveDir, "a.tar.gz"));
    return await Deno.readFile(join(archiveDir, "a.tar.gz"));
  } finally {
    await Deno.remove(archiveDir, { recursive: true }).catch(() => {});
  }
}

interface Fixture {
  repoDir: string;
  catalog: ExtensionCatalogStore;
  /** The mounted source file, outside the repo root. */
  mountedSource: string;
  mountedType: string;
  pulledName: string;
  pulledType: string;
  /** A repository built as the CLI builds one, or without mount dirs. */
  repository(
    lockfileRepository: LockfileRepository,
    withMounts?: boolean,
  ): Promise<ExtensionRepository>;
  /** Indexes the repo's local and mounted model dirs with the loader. */
  index(withMounts?: boolean): Promise<void>;
  install(withMounts?: boolean): Promise<void>;
  remove(): Promise<void>;
  typeOf(sourcePath: string): string | undefined;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "swamp_2563_int_" });
  const repoDir = join(root, "repo");
  // Sorts before "repo", so the path tie-break older binaries used for
  // local-vs-mounted favours the mounted source.
  const sharedDir = join(root, "a-shared");
  const modelsDir = join(repoDir, "extensions", "models");
  const lockfilePath = join(modelsDir, "upstream_extensions.json");
  await ensureDir(modelsDir);
  await ensureDir(swampPath(repoDir));
  await Deno.writeTextFile(
    join(repoDir, ".swamp-sources.yaml"),
    `sources:\n  - path: ${JSON.stringify(sharedDir)}\n`,
  );

  const id = crypto.randomUUID().slice(0, 8);
  const mountedType = `@test/mounted-${id}`;
  const pulledName = `@test/pulled-${id}`;
  const pulledType = `${pulledName}/model`;
  const mountedSource = join(sharedDir, "extensions", "models", "probe.ts");
  await writeModel(mountedSource, mountedType);
  const archive = await buildArchive(pulledName, pulledType);

  const catalog = new ExtensionCatalogStore(
    swampPath(repoDir, "_extension_catalog.db"),
  );
  const repository = async (
    lockfileRepository: LockfileRepository,
    withMounts = true,
  ) =>
    new ExtensionRepository({
      catalog,
      lockfileRepository,
      repoRoot: repoDir,
      mountedSourceDirs: withMounts
        ? await resolveMountedSourceDirs(repoDir)
        : [],
    });
  const installContext = async (): Promise<InstallContext> => ({
    getExtension: (n) =>
      Promise.resolve({ name: n, description: "", latestVersion: VERSION }),
    downloadArchive: () => Promise.resolve(archive),
    getChecksum: () => Promise.resolve(null),
    lockfileRepository: await LockfileRepository.create(lockfilePath),
    skillsDirs: [join(repoDir, ".claude", "skills")],
    repoDir,
    force: true,
    alreadyPulled: new Set(),
    depth: 0,
  });

  try {
    await fn({
      repoDir,
      catalog,
      mountedSource,
      mountedType,
      pulledName,
      pulledType,
      repository,
      index: async (withMounts = true) => {
        const repo = await repository(
          await LockfileRepository.create(lockfilePath),
          withMounts,
        );
        await new ExtensionLoader(
          testDenoRuntime,
          modelKindAdapter,
          repoDir,
          undefined,
          repo,
        ).buildIndex(modelsDir, {
          additionalDirs: await resolveMountedSourceDirs(repoDir),
          indexOnly: true,
        });
      },
      install: async (withMounts = true) => {
        const ctx = await installContext();
        await new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository: await repository(ctx.lockfileRepository, withMounts),
        }).execute({ name: pulledName, version: VERSION }, ctx);
      },
      remove: async () => {
        const lockfileRepository = await LockfileRepository.create(
          lockfilePath,
        );
        await new RemoveExtensionService({
          repository: await repository(lockfileRepository),
          lockfileRepository,
          repoDir,
        }).execute(pulledName);
      },
      typeOf: (sourcePath) =>
        catalog.findBySourcePath(canonicalizePath(sourcePath))
          ?.type_normalized,
    });
  } finally {
    catalog.close();
    modelRegistry.invalidateType(mountedType);
    modelRegistry.invalidateType(pulledType);
    if (Deno.build.os === "windows") {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(root, { recursive: true });
    }
  }
}

Deno.test("integration: extension pull and rm keep the catalog rows of a source mounted from outside the repo (swamp-club#2563)", async () => {
  await withFixture(async (f) => {
    await f.index();
    assertEquals(f.typeOf(f.mountedSource), f.mountedType);

    await f.install();
    assertEquals(f.typeOf(f.mountedSource), f.mountedType, "after pull");

    await f.remove();
    assertEquals(f.typeOf(f.mountedSource), f.mountedType, "after rm");
  });
});

Deno.test("integration: a repository built without mount dirs still prunes a mounted source's rows on pull", async () => {
  await withFixture(async (f) => {
    await f.index();
    await f.install(false);
    assertEquals(f.typeOf(f.mountedSource), undefined);
  });
});

Deno.test("integration: extension pull succeeds when a local model overrides a mounted type (swamp-club#2563)", async () => {
  await withFixture(async (f) => {
    const local = join(f.repoDir, "extensions", "models", "local_probe.ts");
    await writeModel(local, f.mountedType);
    await f.index();
    assertEquals(f.typeOf(local), f.mountedType);
    // Older binaries left both rows typed, which I-Repo-1 rejects unless
    // the save settles it.
    // setTypeNormalized takes the stored (canonical) path, as the loader
    // passes it.
    f.catalog.setTypeNormalized(
      canonicalizePath(f.mountedSource),
      f.mountedType,
    );
    assertEquals(f.typeOf(f.mountedSource), f.mountedType);

    await f.install();

    assertEquals(f.typeOf(local), f.mountedType);
    assertEquals(f.typeOf(f.mountedSource), "");
  });
});

Deno.test("integration: rows a copied repo kept for its old location are still pruned and leave the pulled type alone", async () => {
  await withFixture(async (f) => {
    await f.index();
    // The catalog of a repo copied from old-repo still holds the original
    // location's local row, claiming the type the pulled extension provides.
    // The original still exists, so the row's source file does too.
    const oldRepo = join(dirname(f.repoDir), "old-repo");
    const stale = join(oldRepo, "extensions", "models", "pulled.ts");
    await writeModel(stale, f.pulledType);
    f.catalog.upsertWithIdentity({
      source_path: stale,
      type_normalized: f.pulledType,
      kind: "model",
      bundle_path: join(oldRepo, ".swamp", "bundles", "pulled.js"),
      version: VERSION,
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: "fp",
      state: "Indexed",
      extension_name: "@local/repo",
      extension_version: "0.0.0",
    });

    await f.install();

    assertEquals(f.typeOf(stale), undefined);
    assertEquals(
      f.catalog.findAllByType(f.pulledType, "model").length,
      1,
      "the pulled row keeps its type",
    );
    assertEquals(f.typeOf(f.mountedSource), f.mountedType);
  });
});

Deno.test("integration: a local model added after a mounted one takes its type on the next index (swamp-club#2563)", async () => {
  await withFixture(async (f) => {
    await f.index();
    const local = join(f.repoDir, "extensions", "models", "local_probe.ts");
    await writeModel(local, f.mountedType);
    await f.index();
    assertEquals(f.typeOf(local), f.mountedType);
    assertEquals(f.typeOf(f.mountedSource), "");

    await f.install();
    await f.remove();
    await f.index();
    assertEquals(f.typeOf(local), f.mountedType);
    assertEquals(f.typeOf(f.mountedSource), "");

    // Removing the override hands the type back to the mounted source.
    await Deno.remove(local);
    await f.index();
    assertEquals(f.typeOf(f.mountedSource), f.mountedType);
  });
});

Deno.test("integration: the heal gives a local override back the type an older binary left on a mounted row", async () => {
  await withFixture(async (f) => {
    // An older binary ranked a mounted source as local and broke the tie by
    // path, so the override was indexed typeless behind the mounted row.
    await f.index(false);
    const local = join(f.repoDir, "extensions", "models", "local_probe.ts");
    await writeModel(local, f.mountedType);
    await f.index(false);
    assertEquals(f.typeOf(local), "");
    assertEquals(f.typeOf(f.mountedSource), f.mountedType);

    // Upgrading leaves the new heal marker unset. Deleting a row that claims
    // a type clears it the same way.
    const dummy = join(f.repoDir, "extensions", "models", "dummy.ts");
    f.catalog.upsertWithIdentity({
      source_path: dummy,
      type_normalized: `${f.mountedType}-dummy`,
      kind: "model",
      bundle_path: `${dummy}.js`,
      version: VERSION,
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: "fp",
      state: "Indexed",
      extension_name: "@local/repo",
      extension_version: "0.0.0",
    });
    f.catalog.removeBySourcePath(dummy);
    assertEquals(f.catalog.isTypelessHealDone("model"), false);

    await f.index();
    assertEquals(f.typeOf(local), f.mountedType);
    assertEquals(f.typeOf(f.mountedSource), "");
  });
});
