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

import { assert, assertEquals } from "@std/assert";
import { ensureDir, walk } from "@std/fs";
import { join, relative } from "@std/path";
import "../src/domain/models/models.ts";
import { DuplicateTypeUserError } from "../src/domain/extensions/duplicate_type_user_error.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { readManifestIdentityAt } from "../src/infrastructure/persistence/local_manifest_reader.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { PulledExtensionsLock } from "../src/infrastructure/persistence/pulled_extensions_lock.ts";
import { readUpstreamExtensions } from "../src/infrastructure/persistence/upstream_extensions.ts";
import { InstallExtensionService } from "../src/libswamp/extensions/install_extension_service.ts";
import {
  type InstallContext,
  installExtension,
} from "../src/libswamp/extensions/pull.ts";
import { RemoveExtensionService } from "../src/libswamp/extensions/remove_extension_service.ts";

// swamp-club#2709: installs and removals racing on one checkout. Each
// "process" gets its own catalog connection and lockfile repository, as
// separate swamp processes would. Whatever order the pulled-extensions
// lock lets them run in, the pulled tree, the lockfile entry and the
// catalog rows must agree afterwards.

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

const V1 = "2026.01.01.1";
const V2 = "2026.01.02.1";

function modelSource(type: string, version: string): string {
  return `// deno-lint-ignore no-explicit-any
const { z } = (globalThis as any).__swamp_zod;
export const model = {
  type: "${type}",
  version: "${version}",
  methods: {
    get: { description: "get", arguments: z.object({}), execute: async () => ({}) },
  },
};
`;
}

/** v1 ships models a and b; v2 ships a and c, so upgrading prunes b. */
async function buildArchive(
  name: string,
  version: string,
  models: string[],
  typeScope = name,
): Promise<Uint8Array> {
  const archiveDir = await Deno.makeTempDir({ prefix: "swamp_2709_arc_" });
  try {
    const extDir = join(archiveDir, "extension");
    await ensureDir(join(extDir, "models"));
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      `manifestVersion: 1\nname: "${name}"\nversion: "${version}"\n` +
        `models:\n${models.map((m) => `  - ${m}.ts\n`).join("")}`,
    );
    for (const m of models) {
      await Deno.writeTextFile(
        join(extDir, "models", `${m}.ts`),
        modelSource(`${typeScope}/${m}`, version),
      );
    }
    await createTarGz(extDir, join(archiveDir, "a.tar.gz"));
    return await Deno.readFile(join(archiveDir, "a.tar.gz"));
  } finally {
    await Deno.remove(archiveDir, { recursive: true }).catch(() => {});
  }
}

interface Fixture {
  repoDir: string;
  name: string;
  lockfilePath: string;
  archives: Record<string, Uint8Array>;
  /** Stand-in for one swamp process: its own catalog connection. */
  process(): Promise<Process>;
}

interface Process {
  install(version: string, hooks?: InstallHooks): Promise<unknown>;
  remove(): Promise<unknown>;
  close(): void;
}

interface InstallHooks {
  onDownload?: () => void;
  underLock?: () => Promise<void>;
  /** Installs this extension and archive instead of the fixture's. */
  other?: { name: string; archive: Uint8Array };
  /** Runs when the install removes a lockfile entry (its rollback). */
  onRemoveEntry?: () => Promise<void>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2709_" });
  const name = `@test/race-${crypto.randomUUID().slice(0, 8)}`;
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await ensureDir(join(repoDir, "extensions", "models"));
  await ensureDir(swampPath(repoDir));
  const archives: Record<string, Uint8Array> = {
    [V1]: await buildArchive(name, V1, ["a", "b"]),
    [V2]: await buildArchive(name, V2, ["a", "c"]),
  };
  const open: Process[] = [];

  const process = async (): Promise<Process> => {
    const catalog = new ExtensionCatalogStore(
      swampPath(repoDir, "_extension_catalog.db"),
    );
    const lockfileRepository = await LockfileRepository.create(lockfilePath);
    const repository = new ExtensionRepository({
      catalog,
      lockfileRepository,
      repoRoot: repoDir,
    });
    const p: Process = {
      install: (version, hooks) => {
        const target = hooks?.other?.name ?? name;
        if (hooks?.onRemoveEntry) {
          const removeEntry = lockfileRepository.removeEntry.bind(
            lockfileRepository,
          );
          const onRemoveEntry = hooks.onRemoveEntry;
          lockfileRepository.removeEntry = async (n) => {
            await onRemoveEntry();
            await removeEntry(n);
          };
        }
        const ctx: InstallContext = {
          getExtension: () =>
            Promise.resolve({
              name: target,
              description: "",
              latestVersion: V2,
            }),
          downloadArchive: (_n, v) => {
            hooks?.onDownload?.();
            return Promise.resolve(hooks?.other?.archive ?? archives[v]);
          },
          getChecksum: () => Promise.resolve(null),
          lockfileRepository,
          skillsDirs: [join(repoDir, ".claude", "skills")],
          repoDir,
          force: true,
          alreadyPulled: new Set(),
          depth: 0,
        };
        return new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: (ref, c, options) =>
            installExtension(ref, c, {
              underLock: async (applied) => {
                await hooks?.underLock?.();
                await options?.underLock?.(applied);
              },
            }),
        }).execute({ name: target, version }, ctx);
      },
      remove: () =>
        new RemoveExtensionService({ repository, lockfileRepository, repoDir })
          .execute(name),
      close: () => catalog.close(),
    };
    open.push(p);
    return p;
  };

  try {
    await fn({ repoDir, name, lockfilePath, archives, process });
  } finally {
    for (const p of open) p.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/** Files under the extension's own subtree, repo-relative with "/". */
async function filesUnder(repoDir: string, name: string): Promise<string[]> {
  const root = swampPath(repoDir, "pulled-extensions", name);
  const out: string[] = [];
  try {
    for await (const e of walk(root, { includeDirs: false })) {
      out.push(relative(repoDir, e.path).replaceAll("\\", "/"));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out.sort();
}

/**
 * The tree, the lockfile entry and the catalog agree: either the
 * extension is gone from all three, or all three describe one version.
 */
async function assertConsistent(f: Fixture): Promise<string | null> {
  const entry = (await readUpstreamExtensions(f.lockfilePath))[f.name];
  const onDisk = await filesUnder(f.repoDir, f.name);
  const catalog = new ExtensionCatalogStore(
    swampPath(f.repoDir, "_extension_catalog.db"),
  );
  try {
    const extensions = new ExtensionRepository({
      catalog,
      lockfileRepository: await LockfileRepository.create(f.lockfilePath),
      repoRoot: f.repoDir,
    }).loadByName(f.name);

    if (!entry) {
      assertEquals(onDisk, [], "no entry, but files remain");
      assertEquals(extensions.length, 0, "no entry, but catalog rows remain");
      return null;
    }
    const prefix = `.swamp/pulled-extensions/${f.name}/`;
    const tracked = (entry.files ?? [])
      .map((p) => p.replaceAll("\\", "/"))
      .filter((p) => p.startsWith(prefix))
      .sort();
    assertEquals(onDisk, tracked, "files on disk differ from the entry");
    assertEquals(
      readManifestIdentityAt(
        swampPath(f.repoDir, "pulled-extensions", f.name, "manifest.yaml"),
      )?.version,
      entry.version,
    );
    assert(extensions.length > 0, "entry present, but no catalog rows");
    for (const ext of extensions) assertEquals(ext.version, entry.version);
    return entry.version;
  } finally {
    catalog.close();
  }
}

Deno.test("integration: an install and a remove racing on one checkout leave it consistent", async () => {
  await withFixture(async (f) => {
    await (await f.process()).install(V1);

    const [installer, remover] = [await f.process(), await f.process()];
    const settled = await Promise.allSettled([
      installer.install(V2),
      remover.remove(),
    ]);
    // Whichever ran second either removes v2, or reinstalls over nothing.
    assertEquals(settled.map((s) => s.status), ["fulfilled", "fulfilled"]);
    const version = await assertConsistent(f);
    assert(version === null || version === V2, `unexpected ${version}`);
  });
});

Deno.test("integration: two installs of different versions racing on one checkout leave one version, no orphans", async () => {
  await withFixture(async (f) => {
    await (await f.process()).install(V2);

    const [p1, p2] = [await f.process(), await f.process()];
    await Promise.all([p1.install(V1), p2.install(V2)]);
    const version = await assertConsistent(f);
    assert(version === V1 || version === V2, `unexpected ${version}`);
  });
});

Deno.test("integration: an install's catalog save holds the lock while another install prepares outside it", async () => {
  await withFixture(async (f) => {
    const otherProcess = new PulledExtensionsLock();
    const events: string[] = [];
    const firstInHook = Promise.withResolvers<void>();
    const secondDownloaded = Promise.withResolvers<void>();
    let busyDuringHook: boolean | undefined;

    const [p1, p2] = [await f.process(), await f.process()];
    const first = p1.install(V1, {
      underLock: async () => {
        events.push("first:save");
        firstInHook.resolve();
        // The second install downloads while this section is held, so
        // its prepare is not waiting on the lock.
        await secondDownloaded.promise;
        busyDuringHook = !(await otherProcess.tryWithLock(
          f.repoDir,
          () => Promise.resolve(),
        )).acquired;
        events.push("first:saved");
      },
    });
    await firstInHook.promise;
    const second = p2.install(V2, {
      onDownload: () => {
        events.push("second:download");
        secondDownloaded.resolve();
      },
      underLock: () => {
        events.push("second:save");
        return Promise.resolve();
      },
    });
    await Promise.all([first, second]);

    assertEquals(busyDuringHook, true);
    assertEquals(events, [
      "first:save",
      "second:download",
      "first:saved",
      "second:save",
    ]);
    assertEquals(await assertConsistent(f), V2);
  });
});

Deno.test("integration: a DuplicateTypeError rollback runs under the lock", async () => {
  await withFixture(async (f) => {
    await (await f.process()).install(V1);
    // A second extension providing the fixture's type "a" collides in
    // the catalog save, and the install rolls back its files and entry.
    const intruder = `@test/intruder-${crypto.randomUUID().slice(0, 8)}`;
    const archive = await buildArchive(intruder, V1, ["a"], f.name);
    const otherProcess = new PulledExtensionsLock();
    const busyDuringRollback: boolean[] = [];

    const failed = await Promise.allSettled([
      (await f.process()).install(V1, {
        other: { name: intruder, archive },
        onRemoveEntry: async () => {
          busyDuringRollback.push(
            !(await otherProcess.tryWithLock(
              f.repoDir,
              () => Promise.resolve(),
            )).acquired,
          );
        },
      }),
    ]);
    assert(failed[0].status === "rejected");
    assert(
      failed[0].reason instanceof DuplicateTypeUserError,
      `expected a type collision, got ${failed[0].reason}`,
    );
    assertEquals(busyDuringRollback, [true]);
    assertEquals(
      (await readUpstreamExtensions(f.lockfilePath))[intruder],
      undefined,
    );
    assertEquals(await assertConsistent(f), V1);
  });
});

Deno.test("integration: an install whose locked section throws releases the lock", async () => {
  await withFixture(async (f) => {
    const p = await f.process();
    const failed = await Promise.allSettled([
      p.install(V1, { underLock: () => Promise.reject(new Error("boom")) }),
    ]);
    assertEquals(failed[0].status, "rejected");
    assertEquals(
      await new PulledExtensionsLock().tryWithLock(
        f.repoDir,
        () => Promise.resolve(),
      ),
      { acquired: true, value: undefined },
    );
  });
});
