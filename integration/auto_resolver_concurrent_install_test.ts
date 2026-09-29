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
import {
  createAutoResolveInstallerAdapter,
  createAutoResolveOutputAdapter,
} from "../src/cli/auto_resolver_adapters.ts";
import { ExtensionAutoResolver } from "../src/domain/extensions/extension_auto_resolver.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { readUpstreamExtensions } from "../src/infrastructure/persistence/upstream_extensions.ts";

// swamp-club#2571: concurrent auto-resolves of one uninstalled extension in
// one repo. Each resolver gets its own installer adapter, standing in for a
// separate process. The install lock must let exactly one of them install;
// the other waits, then loads the installed extension instead of failing
// with a file conflict.

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

const VERSION = "2026.01.01.1";

async function buildArchive(name: string, type: string): Promise<Uint8Array> {
  const archiveDir = await Deno.makeTempDir({ prefix: "swamp_2571_arc_" });
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

Deno.test("integration: concurrent auto-resolves of one extension install it once and both register the type", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2571_" });
  const id = crypto.randomUUID().slice(0, 8);
  const name = `@test/race-${id}`;
  const type = `${name}/probe`;
  try {
    const archive = await buildArchive(name, type);
    const lockfilePath = join(
      repoDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    await ensureDir(join(repoDir, "extensions", "models"));

    const info = { name, description: "Race fixture", latestVersion: VERSION };
    let downloads = 0;
    const makeResolver = () => {
      const getExtension = (n: string) =>
        Promise.resolve(n === name ? info : null);
      return new ExtensionAutoResolver({
        allowedCollectives: ["test"],
        extensionLookup: {
          getExtension,
          searchExtensions: () => Promise.resolve({ extensions: [] }),
        },
        extensionInstaller: createAutoResolveInstallerAdapter({
          getExtension,
          downloadArchive: () => {
            downloads++;
            return Promise.resolve(archive);
          },
          getChecksum: () => Promise.resolve(null),
          lockfilePath,
          repoDir,
          denoRuntime: testDenoRuntime,
        }),
        output: createAutoResolveOutputAdapter("json"),
      });
    };

    const results = await Promise.all([
      makeResolver().resolve(type),
      makeResolver().resolve(type),
    ]);

    assertEquals(results, [true, true]);
    assertEquals(downloads, 1);
    assertEquals(Object.keys(await readUpstreamExtensions(lockfilePath)), [
      name,
    ]);
    await modelRegistry.ensureTypeLoaded(type);
    assertEquals(modelRegistry.get(type)?.type.normalized, type);
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});
