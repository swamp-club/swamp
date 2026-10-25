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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { createAutoResolveInstallerAdapter } from "../src/cli/auto_resolver_adapters.ts";
import {
  type AutoResolveOutputPort,
  ExtensionAutoResolver,
} from "../src/domain/extensions/extension_auto_resolver.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { withExtensionMutation } from "../src/serve/extension_reload.ts";
import { refreshLocalModelsForRun } from "../src/serve/local_model_refresh.ts";

// swamp-club#3911: in swamp serve, requests that need the same uninstalled
// type at once share one auto-install, and a run's refresh of local models
// waits for that install instead of rebundling the half-installed extension
// beside it. Wired as serve wires it: the resolver's install scheduler is
// serve's extension-mutation turn.

await initializeLogging({});

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

const VERSION = "2026.01.01.1";

async function buildArchive(name: string, type: string): Promise<Uint8Array> {
  const archiveDir = await Deno.makeTempDir({ prefix: "swamp_3911_arc_" });
  try {
    const extDir = join(archiveDir, "extension");
    await ensureDir(join(extDir, "models"));
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      `manifestVersion: 1\nname: "${name}"\nversion: "${VERSION}"\n` +
        `models:\n  - probe.ts\n`,
    );
    await Deno.writeTextFile(
      join(extDir, "models", "probe.ts"),
      `// deno-lint-ignore no-explicit-any
const { z } = (globalThis as any).__swamp_zod;
export const model = {
  type: "${type}",
  version: "${VERSION}",
  methods: {
    get: { description: "get", arguments: z.object({}), execute: async () => ({}) },
  },
};
`,
    );
    await createTarGz(extDir, join(archiveDir, "a.tar.gz"));
    return await Deno.readFile(join(archiveDir, "a.tar.gz"));
  } finally {
    await Deno.remove(archiveDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("integration: serve requests for one uninstalled type share an install that a run's refresh waits for", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_3911_" });
  const id = crypto.randomUUID().slice(0, 8);
  const name = `@test/serve-race-${id}`;
  const type = `${name}/probe`;
  const events: string[] = [];
  const installed: number[] = [];
  let catalog: ExtensionCatalogStore | undefined;
  try {
    const archive = await buildArchive(name, type);
    const lockfilePath = join(
      repoDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    await ensureDir(join(repoDir, "extensions", "models"));

    catalog = new ExtensionCatalogStore(
      swampPath(repoDir, "_extension_catalog.db"),
      { openOnFirstUse: true },
    );
    const info = { name, description: "Race fixture", latestVersion: VERSION };
    const getExtension = (n: string) =>
      Promise.resolve(n === name ? info : null);
    const download = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let downloads = 0;
    const output = {
      searching: () => {},
      installing: () => {},
      installed: (_e: string, _v: string, count: number) => {
        installed.push(count);
      },
    } as unknown as AutoResolveOutputPort;
    const resolver = new ExtensionAutoResolver({
      allowedCollectives: ["test"],
      extensionLookup: {
        getExtension,
        searchExtensions: () => Promise.resolve({ extensions: [] }),
      },
      extensionInstaller: createAutoResolveInstallerAdapter({
        getExtension,
        downloadArchive: async () => {
          downloads++;
          download.resolve();
          await gate.promise;
          return archive;
        },
        getChecksum: () => Promise.resolve(null),
        lockfilePath,
        repoDir,
        denoRuntime: testDenoRuntime,
        // As serve's resolver is configured (src/cli/mod.ts).
        repository: new ExtensionRepository({
          catalog,
          lockfileRepository: new LockfileRepository(lockfilePath, {}),
          repoRoot: repoDir,
        }),
      }),
      output,
    });
    resolver.setInstallScheduler(withExtensionMutation);
    modelRegistry.setSourceRefresher(() => {
      events.push(modelRegistry.has(type) ? "refresh:loaded" : "refresh");
      return Promise.resolve();
    });

    const first = resolver.resolve(`@${type.slice(1)}`);
    await download.promise;
    const second = resolver.resolve(type);
    const bare = resolver.resolve(type.slice(1));
    // A run that needs no new extension checks local models meanwhile.
    const run = refreshLocalModelsForRun();
    await Promise.resolve();
    assertEquals(events, []);

    gate.resolve();
    assertEquals(await Promise.all([first, second, bare]), [true, true, true]);
    await run;
    await waitFor(() => events.length === 1, "the run's refresh");

    assertEquals(downloads, 1);
    assertEquals(events, ["refresh:loaded"]);
    assertEquals(installed, [1]);
    await modelRegistry.ensureTypeLoaded(type);
    assertEquals(modelRegistry.get(type)?.type.normalized, type);
  } finally {
    modelRegistry.setSourceRefresher(null);
    modelRegistry.invalidateType(type);
    catalog?.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});
