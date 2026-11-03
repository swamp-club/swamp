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
import { ensureDir, walk } from "@std/fs";
import { join, relative } from "@std/path";
import { computeChecksum } from "../src/domain/models/checksum.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { FileExtensionArchiveCache } from "../src/infrastructure/persistence/extension_archive_cache.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { extensionInstallRoots } from "../src/infrastructure/persistence/paths.ts";
import {
  installExtension,
  type InstallResult,
} from "../src/libswamp/extensions/pull.ts";

const VERSION = "2026.01.01.1";

async function tempDir(prefix: string) {
  const dir = await Deno.makeTempDir({ prefix });
  return {
    dir,
    async [Symbol.asyncDispose]() {
      await Deno.remove(dir, { recursive: true }).catch((error) => {
        if (Deno.build.os !== "windows") throw error;
      });
    },
  };
}

async function buildArchive(name: string): Promise<Uint8Array> {
  await using tmp = await tempDir("swamp_cache_int_archive_");
  const extDir = join(tmp.dir, "extension");
  await ensureDir(join(extDir, "skills", "s"));
  await Deno.writeTextFile(
    join(extDir, "manifest.yaml"),
    `manifestVersion: 1\nname: "${name}"\nversion: "${VERSION}"\nskills:\n  - s\n`,
  );
  await Deno.writeTextFile(join(extDir, "skills", "s", "SKILL.md"), name);
  const archivePath = join(tmp.dir, "extension.tar.gz");
  await createTarGz(extDir, archivePath);
  return await Deno.readFile(archivePath);
}

async function install(
  repoDir: string,
  name: string,
  archive: Uint8Array,
  cache: FileExtensionArchiveCache,
  downloads: string[],
): Promise<
  { result: InstallResult | undefined; lockfile: LockfileRepository }
> {
  const lockfile = await LockfileRepository.create(
    join(repoDir, "upstream_extensions.json"),
  );
  const checksum = await computeChecksum(archive);
  const result = await installExtension({ name, version: null }, {
    getExtension: (n) =>
      Promise.resolve({ name: n, description: "", latestVersion: VERSION }),
    downloadArchive: (n) => {
      downloads.push(n);
      return Promise.resolve(archive);
    },
    getChecksum: () => Promise.resolve(checksum),
    lockfileRepository: lockfile,
    skillsDirs: [join(repoDir, ".claude", "skills")],
    repoDir,
    alreadyPulled: new Set(),
    depth: 0,
    force: false,
    archiveCache: cache,
  });
  return { result, lockfile };
}

async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for await (const entry of walk(root, { includeDirs: false })) {
    files[relative(root, entry.path)] = await Deno.readTextFile(entry.path);
  }
  return files;
}

Deno.test("extension archive cache: a second repo on the host installs from the cache with an identical result", async () => {
  await using home = await tempDir("swamp_cache_int_home_");
  await using first = await tempDir("swamp_cache_int_repo_");
  await using second = await tempDir("swamp_cache_int_repo_");
  const name = `@t/cache-int-${crypto.randomUUID().slice(0, 8)}`;
  const archive = await buildArchive(name);
  const cache = new FileExtensionArchiveCache(home.dir);
  const downloads: string[] = [];

  const a = await install(first.dir, name, archive, cache, downloads);
  assertEquals(downloads, [name]);

  const b = await install(second.dir, name, archive, cache, downloads);
  assertEquals(downloads, [name]);

  assertEquals(b.result?.integrityStatus, "verified");
  assertEquals(
    b.lockfile.getEntry(name)?.checksum,
    a.lockfile.getEntry(name)?.checksum,
  );
  assertEquals(
    await tree(extensionInstallRoots(second.dir, name).extensionRoot),
    await tree(extensionInstallRoots(first.dir, name).extensionRoot),
  );
});

Deno.test("extension archive cache: a corrupt entry is downloaded again and repaired", async () => {
  await using home = await tempDir("swamp_cache_int_home_");
  await using first = await tempDir("swamp_cache_int_repo_");
  await using second = await tempDir("swamp_cache_int_repo_");
  await using third = await tempDir("swamp_cache_int_repo_");
  const name = `@t/cache-int-${crypto.randomUUID().slice(0, 8)}`;
  const archive = await buildArchive(name);
  const checksum = await computeChecksum(archive);
  const cache = new FileExtensionArchiveCache(home.dir);
  const downloads: string[] = [];

  await install(first.dir, name, archive, cache, downloads);
  await Deno.writeFile(
    join(home.dir, "sha256", `${checksum}.tar.gz`),
    new TextEncoder().encode("not an archive"),
  );

  const repaired = await install(second.dir, name, archive, cache, downloads);
  assertEquals(downloads, [name, name]);
  assertEquals(repaired.result?.integrityStatus, "verified");

  await install(third.dir, name, archive, cache, downloads);
  assertEquals(downloads, [name, name]);
});
