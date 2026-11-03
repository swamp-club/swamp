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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { ExtensionArchiveCache } from "../../domain/extensions/extension_archive_cache.ts";
import { UserError } from "../../domain/errors.ts";
import { computeChecksum } from "../../domain/models/checksum.ts";
import { MAX_EXTENSION_ARCHIVE_BYTES } from "../../domain/extensions/extension_archive_limits.ts";
import { createTarGz } from "../../infrastructure/archive/tar_archive.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { withCapturedSpans } from "../../infrastructure/tracing/span_test_helpers.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  createInstallContext,
  extensionPull,
  type ExtensionPullDeps,
  type InstallContext,
  installExtension,
  prepareInstall,
} from "./pull.ts";

const VERSION = "2026.01.01.1";

class RecordingCache implements ExtensionArchiveCache {
  readonly entries = new Map<string, Uint8Array>();
  readonly gets: string[] = [];
  readonly puts: string[] = [];
  get(key: string): Promise<Uint8Array | null> {
    this.gets.push(key);
    return Promise.resolve(this.entries.get(key) ?? null);
  }
  put(key: string, archive: Uint8Array): Promise<void> {
    this.puts.push(key);
    this.entries.set(key, archive);
    return Promise.resolve();
  }
}

function uniqueName(): string {
  return `@t/cache-${crypto.randomUUID().slice(0, 8)}`;
}

async function buildArchive(
  name: string,
  options: { dependencies?: string[]; extraFiles?: Record<string, string> } =
    {},
): Promise<Uint8Array> {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_cache_archive_" });
  try {
    const extDir = join(tmp, "extension");
    const lines = [
      "manifestVersion: 1",
      `name: "${name}"`,
      `version: "${VERSION}"`,
      "skills:",
      "  - s",
    ];
    if (options.dependencies?.length) {
      lines.push(
        "dependencies:",
        ...options.dependencies.map((d) => `  - "${d}"`),
      );
    }
    await ensureDir(join(extDir, "skills", "s"));
    await Deno.writeTextFile(join(extDir, "manifest.yaml"), lines.join("\n"));
    await Deno.writeTextFile(join(extDir, "skills", "s", "SKILL.md"), name);
    for (const [file, content] of Object.entries(options.extraFiles ?? {})) {
      await Deno.writeTextFile(join(extDir, file), content);
    }
    const archivePath = join(tmp, "extension.tar.gz");
    await createTarGz(extDir, archivePath);
    return await Deno.readFile(archivePath);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

async function tempRepo() {
  const dir = await Deno.makeTempDir({ prefix: "swamp_pull_cache_" });
  return {
    dir,
    async [Symbol.asyncDispose]() {
      await Deno.remove(dir, { recursive: true }).catch((error) => {
        if (Deno.build.os !== "windows") throw error;
      });
    },
  };
}

interface Registry {
  archives: Record<string, Uint8Array>;
  /** null makes the registry report no checksum for every archive */
  checksums: Record<string, string | null>;
  downloads: string[];
}

async function registry(
  archives: Record<string, Uint8Array>,
  options: { withChecksums?: boolean } = {},
): Promise<Registry> {
  const checksums: Record<string, string | null> = {};
  for (const [name, bytes] of Object.entries(archives)) {
    checksums[name] = options.withChecksums === false
      ? null
      : await computeChecksum(bytes);
  }
  return { archives, checksums, downloads: [] };
}

async function context(
  repoDir: string,
  reg: Registry,
  archiveCache: ExtensionArchiveCache | undefined,
): Promise<InstallContext> {
  return {
    getExtension: (name) =>
      Promise.resolve(
        reg.archives[name]
          ? { name, description: "", latestVersion: VERSION }
          : null,
      ),
    downloadArchive: (name) => {
      reg.downloads.push(name);
      return Promise.resolve(reg.archives[name]);
    },
    getChecksum: (name) => Promise.resolve(reg.checksums[name] ?? null),
    lockfileRepository: await LockfileRepository.create(
      join(repoDir, "upstream_extensions.json"),
    ),
    skillsDirs: [join(repoDir, ".claude", "skills")],
    repoDir,
    alreadyPulled: new Set(),
    depth: 0,
    force: false,
    ...(archiveCache ? { archiveCache } : {}),
  };
}

Deno.test("prepareInstall: a cache hit installs without downloading", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) });
  const cache = new RecordingCache();
  const key = reg.checksums[name]!;
  cache.entries.set(key, reg.archives[name]);

  const prepared = await prepareInstall(
    { name, version: null },
    await context(repo.dir, reg, cache),
  );
  try {
    assertEquals(reg.downloads, []);
    assertEquals(prepared.localChecksum, key);
    assertEquals(prepared.integrityStatus, "verified");
    assertEquals(cache.puts, []);
  } finally {
    await prepared.dispose();
  }
});

Deno.test("prepareInstall: a miss downloads once and stores the verified archive", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) });
  const cache = new RecordingCache();

  const prepared = await prepareInstall(
    { name, version: null },
    await context(repo.dir, reg, cache),
  );
  await prepared.dispose();

  assertEquals(reg.downloads, [name]);
  assertEquals(cache.gets, [reg.checksums[name]]);
  assertEquals(cache.puts, [reg.checksums[name]]);
});

Deno.test("prepareInstall: an archive the registry gives no checksum for never reaches the cache", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) }, {
    withChecksums: false,
  });
  const cache = new RecordingCache();

  const prepared = await prepareInstall(
    { name, version: null },
    await context(repo.dir, reg, cache),
  );
  await prepared.dispose();

  assertEquals(prepared.integrityStatus, "unverified");
  assertEquals(reg.downloads, [name]);
  assertEquals(cache.gets, []);
  assertEquals(cache.puts, []);
});

Deno.test("prepareInstall: cached bytes that do not match the registry checksum are replaced by a download", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) });
  const cache = new RecordingCache();
  const key = reg.checksums[name]!;
  cache.entries.set(key, await buildArchive(uniqueName()));

  const prepared = await prepareInstall(
    { name, version: null },
    await context(repo.dir, reg, cache),
  );
  await prepared.dispose();

  assertEquals(prepared.localChecksum, key);
  assertEquals(reg.downloads, [name]);
  assertEquals(cache.entries.get(key), reg.archives[name]);
});

Deno.test("prepareInstall: an archive the install refuses is not stored", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({
    [name]: await buildArchive(name, { extraFiles: { "manifest.yaml": ":" } }),
  });
  const cache = new RecordingCache();

  await assertRejects(async () => {
    const prepared = await prepareInstall(
      { name, version: null },
      await context(repo.dir, reg, cache),
    );
    await prepared.dispose();
  });
  assertEquals(reg.downloads, [name]);
  assertEquals(cache.puts, []);
});

Deno.test("prepareInstall: a cache hit still refuses an archive that drifted from the lockfile", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) });
  const cache = new RecordingCache();
  cache.entries.set(reg.checksums[name]!, reg.archives[name]);

  const error = await assertRejects(
    async () =>
      await prepareInstall({ name, version: VERSION }, {
        ...await context(repo.dir, reg, cache),
        expectedChecksum: "0".repeat(64),
      }),
    UserError,
  );
  assert(error.message.includes("Checksum mismatch"));
  assertEquals(reg.downloads, []);
});

Deno.test("prepareInstall: a checksum the registry refuses fails the install before the cache is read", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) });
  const cache = new RecordingCache();
  cache.entries.set(reg.checksums[name]!, reg.archives[name]);

  const error = await assertRejects(
    async () =>
      await prepareInstall({ name, version: VERSION }, {
        ...await context(repo.dir, reg, cache),
        getChecksum: () =>
          Promise.reject(
            new UserError("Version has been yanked (compromised)"),
          ),
      }),
    UserError,
  );
  assertEquals(error.message, "Version has been yanked (compromised)");
  assertEquals(cache.gets, []);
  assertEquals(reg.downloads, []);
});

Deno.test("prepareInstall: a caller the registry hides the checksum from never reads the cache", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) });
  const cache = new RecordingCache();
  cache.entries.set(reg.checksums[name]!, reg.archives[name]);

  const error = await assertRejects(
    async () =>
      await prepareInstall({ name, version: VERSION }, {
        ...await context(repo.dir, reg, cache),
        getChecksum: () => Promise.resolve(null),
        downloadArchive: (refused) => {
          reg.downloads.push(refused);
          return Promise.reject(
            new UserError(`Extension ${refused} not found in the registry.`),
          );
        },
      }),
    UserError,
  );
  assertStringIncludes(error.message, "not found in the registry");
  assertEquals(cache.gets, []);
  assertEquals(reg.downloads, [name]);
});

Deno.test("prepareInstall: every cache hit asks the registry for the checksum again", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) });
  const cache = new RecordingCache();
  cache.entries.set(reg.checksums[name]!, reg.archives[name]);
  const base = await context(repo.dir, reg, cache);
  let checksumRequests = 0;
  const ctx: InstallContext = {
    ...base,
    getChecksum: (...args) => {
      checksumRequests++;
      return base.getChecksum(...args);
    },
  };

  for (let i = 0; i < 2; i++) {
    const prepared = await prepareInstall({ name, version: VERSION }, ctx);
    await prepared.dispose();
  }

  assertEquals(checksumRequests, 2);
  assertEquals(cache.gets.length, 2);
  assertEquals(reg.downloads, []);
});

Deno.test("installExtension: dependencies share the cache, so a second repo downloads nothing", async () => {
  await using first = await tempRepo();
  await using second = await tempRepo();
  const parent = uniqueName();
  const dep = uniqueName();
  const reg = await registry({
    [parent]: await buildArchive(parent, { dependencies: [dep] }),
    [dep]: await buildArchive(dep),
  });
  const cache = new RecordingCache();

  await installExtension(
    { name: parent, version: null },
    await context(first.dir, reg, cache),
  );
  assertEquals(reg.downloads.sort(), [dep, parent].sort());
  assertEquals(cache.puts.length, 2);

  reg.downloads.length = 0;
  const result = await installExtension(
    { name: parent, version: null },
    await context(second.dir, reg, cache),
  );
  assertEquals(reg.downloads, []);
  assertEquals(result?.dependencyResults.length, 1);
});

Deno.test("prepareInstall: the archive span says whether the bytes came from the cache", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) });
  const cache = new RecordingCache();

  await withCapturedSpans(async (spans) => {
    for (let i = 0; i < 2; i++) {
      const prepared = await prepareInstall(
        { name, version: null },
        await context(repo.dir, reg, cache),
      );
      await prepared.dispose();
    }
    const archives = spans.filter((s) => s.name === "swamp.extension.archive");
    assertEquals(
      archives.map((s) => s.attributes["extension.archive.source"]),
      ["registry", "cache"],
    );
    assertEquals(archives[0].attributes["extension.name"], name);
    assertEquals(
      spans.filter((s) => s.name === "swamp.extension.extract").length,
      2,
    );
  });
});

Deno.test("extensionPull: forwards the archive cache into the install context", async () => {
  await using repo = await tempRepo();
  const cache = new RecordingCache();
  let seen: ExtensionArchiveCache | undefined;
  const deps: ExtensionPullDeps = {
    getExtension: (name) =>
      Promise.resolve({ name, description: "", latestVersion: VERSION }),
    downloadArchive: () => Promise.reject(new Error("unused")),
    getChecksum: () => Promise.resolve(null),
    lockfileRepository: await LockfileRepository.create(
      join(repo.dir, "upstream_extensions.json"),
    ),
    skillsDirs: [],
    repoDir: repo.dir,
    alreadyPulled: new Set(),
    depth: 0,
    archiveCache: cache,
    installExtensionFn: (_ref, ctx) => {
      seen = ctx.archiveCache;
      return Promise.resolve(undefined);
    },
  };
  await collect(
    extensionPull(createLibSwampContext({}), deps, {
      ref: { name: uniqueName(), version: VERSION },
      force: false,
    }),
  );
  assertEquals(seen, cache);
});

Deno.test("createInstallContext: uses no cache unless one is passed", async () => {
  await using repo = await tempRepo();
  const opts = {
    lockfilePath: join(repo.dir, "upstream_extensions.json"),
    skillsDirs: [],
    repoDir: repo.dir,
    force: false,
  };
  const cache = new RecordingCache();
  assertEquals(
    (await createInstallContext("http://127.0.0.1:1", opts)).archiveCache,
    undefined,
  );
  assertEquals(
    (await createInstallContext("http://127.0.0.1:1", {
      ...opts,
      archiveCache: cache,
    })).archiveCache,
    cache,
  );
});

Deno.test("installExtension: applies the install in its own span", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) });
  await withCapturedSpans(async (spans) => {
    await installExtension(
      { name, version: null },
      await context(repo.dir, reg, undefined),
    );
    const apply = spans.filter((s) => s.name === "swamp.extension.apply");
    assertEquals(apply.length, 1);
    assertEquals(apply[0].attributes["extension.version"], VERSION);
  });
});

class ThrowingCache implements ExtensionArchiveCache {
  get(): Promise<Uint8Array | null> {
    return Promise.reject(new Error("cache read failed"));
  }
  put(): Promise<void> {
    return Promise.reject(new Error("cache write failed"));
  }
}

Deno.test("prepareInstall: a cache that throws is a miss and a skipped store, not a failed install", async () => {
  await using repo = await tempRepo();
  await using tempRoot = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) });

  const prepared = await prepareInstall(
    { name, version: null },
    await context(repo.dir, reg, new ThrowingCache()),
    { tempRoot: tempRoot.dir },
  );
  await prepared.dispose();

  assertEquals(reg.downloads, [name]);
  assertEquals(prepared.integrityStatus, "verified");
  assertEquals([...Deno.readDirSync(tempRoot.dir)], []);
});

Deno.test("prepareInstall: a cached entry over the archive size limit is a miss", async () => {
  await using repo = await tempRepo();
  const name = uniqueName();
  const reg = await registry({ [name]: await buildArchive(name) });
  const cache = new RecordingCache();
  cache.entries.set(
    reg.checksums[name]!,
    new Uint8Array(MAX_EXTENSION_ARCHIVE_BYTES + 1),
  );

  const prepared = await prepareInstall(
    { name, version: null },
    await context(repo.dir, reg, cache),
  );
  await prepared.dispose();

  assertEquals(reg.downloads, [name]);
});
