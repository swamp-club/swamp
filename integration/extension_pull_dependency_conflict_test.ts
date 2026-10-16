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

/**
 * `extension pull` when a dependency's files conflict (swamp-club#3313):
 * pullExtension wired as the CLI wires it — InstallExtensionService over a
 * real catalog and lockfile — against a fake registry serving real
 * archives, with the overwrite prompt answered y.
 */

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { pullExtension } from "../src/cli/commands/extension_pull.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import {
  getSwampLogger,
  initializeLogging,
} from "../src/infrastructure/logging/logger.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { EmbeddedDenoRuntime } from "../src/infrastructure/runtime/embedded_deno_runtime.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { linkSharedSwampDenoCache } from "./test_helpers.ts";

await initializeLogging({});

const PULL_VERSION = "2026.01.01.1";

// The zod swamp provides to extensions, so no npm download is needed.
function modelSource(typeId: string): string {
  return `// deno-lint-ignore no-explicit-any
const { z } = (globalThis as any).__swamp_zod;

export const model = {
  type: "${typeId}",
  version: "2026.05.05.1",
  globalArguments: z.object({}),
  resources: {
    "data": {
      description: "x",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 1,
    },
  },
  methods: {
    noop: {
      description: "noop",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;
}

/** An extension archive shipping one model file, as the registry serves it. */
async function buildArchive(
  name: string,
  modelFile: string,
  typeId: string,
  dependencies: string[],
): Promise<Uint8Array> {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_pull_arc_" });
  try {
    const extDir = join(tmp, "extension");
    await ensureDir(join(extDir, "models"));
    const lines = [
      "manifestVersion: 1",
      `name: "${name}"`,
      `version: "${PULL_VERSION}"`,
      "models:",
      `  - ${modelFile}`,
    ];
    if (dependencies.length > 0) {
      lines.push("dependencies:", ...dependencies.map((d) => `  - "${d}"`));
    }
    await Deno.writeTextFile(join(extDir, "manifest.yaml"), lines.join("\n"));
    await Deno.writeTextFile(
      join(extDir, "models", modelFile),
      modelSource(typeId),
    );
    await createTarGz(extDir, join(tmp, "a.tar.gz"));
    return await Deno.readFile(join(tmp, "a.tar.gz"));
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

Deno.test("pullExtension: answering y to a dependency's conflict installs the dependency over its files (swamp-club#3313)", async () => {
  const id = crypto.randomUUID().slice(0, 8);
  const parent = `@t/p-${id}`;
  const dep = `@t/d-${id}`;
  const archives = new Map([
    [parent, await buildArchive(parent, "p.ts", `@t/own-p-${id}`, [dep])],
    [dep, await buildArchive(dep, "d.ts", `@t/own-d-${id}`, [])],
  ]);
  const home = await Deno.makeTempDir({ prefix: "swamp_3313_home_" });
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_3313_repo_" });
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await ensureDir(join(repoDir, "extensions", "models"));
  await Deno.writeTextFile(lockfilePath, "{}");
  // The dependency's files are on disk with no lockfile entry.
  const depFile = join(
    repoDir,
    ".swamp",
    "pulled-extensions",
    dep,
    "models",
    "d.ts",
  );
  await ensureDir(dirname(depFile));
  await Deno.writeTextFile(depFile, "local\n");
  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  let asked = 0;
  try {
    await linkSharedSwampDenoCache(home);
    await withMockedEnv(
      {
        HOME: home,
        SWAMP_HOME: home,
        SWAMP_CONFIG_DIR: join(home, ".config", "swamp"),
      },
      async () => {
        const lockfileRepository = await LockfileRepository.create(
          lockfilePath,
        );
        await pullExtension({ name: parent, version: null }, {
          getExtension: (name) =>
            Promise.resolve({
              name,
              description: "",
              latestVersion: PULL_VERSION,
            }),
          downloadArchive: (name) => {
            const archive = archives.get(name);
            return archive
              ? Promise.resolve(archive)
              : Promise.reject(new Error(`cannot download ${name}`));
          },
          getChecksum: () => Promise.resolve(null),
          logger: getSwampLogger(["extension", "pull"]),
          lockfileRepository,
          skillsDirs: [],
          repoDir,
          force: false,
          outputMode: "log",
          alreadyPulled: new Set(),
          depth: 0,
          denoRuntime: {
            ensureDeno: () => Promise.resolve(Deno.execPath()),
            // The shared cache linked under SWAMP_HOME above, as the real
            // runtime picks it: never a fresh cache under the mocked HOME.
            getDenoEnv: () => new EmbeddedDenoRuntime().getDenoEnv(),
          },
          repository: new ExtensionRepository({
            catalog,
            lockfileRepository,
            repoRoot: repoDir,
          }),
          confirm: () => {
            asked++;
            return Promise.resolve(true);
          },
        });
      },
    );

    assertEquals(asked, 1);
    const lockfile = JSON.parse(await Deno.readTextFile(lockfilePath));
    assertEquals(lockfile[parent]?.version, PULL_VERSION);
    assertEquals(lockfile[dep]?.version, PULL_VERSION);
    assertEquals(
      await Deno.readTextFile(depFile),
      modelSource(`@t/own-d-${id}`),
    );
  } finally {
    catalog.close();
    for (const dir of [repoDir, home]) {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    }
  }
});
