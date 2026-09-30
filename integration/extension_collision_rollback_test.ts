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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir, walk } from "@std/fs";
import { dirname, join, relative } from "@std/path";
import "../src/domain/models/models.ts";
import type { ExtensionUpdateStatus } from "../src/domain/extensions/extension_update_service.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import {
  extensionInstallRoots,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { InstallExtensionService } from "../src/libswamp/extensions/install_extension_service.ts";
import type { InstallContext } from "../src/libswamp/extensions/pull.ts";
import {
  extensionUpdate,
  type ExtensionUpdateDeps,
  type ExtensionUpdateEvent,
} from "../src/libswamp/extensions/update.ts";
import { UpgradeExtensionService } from "../src/libswamp/extensions/upgrade_extension_service.ts";

// swamp-club#2724: an `extension update` whose new version collides with
// a type another extension already claims must leave the repo exactly as
// it was: the previous version's files, bundles, skills, lockfile entry
// and catalog rows. The real install, catalog, repository and lockfile
// are wired together on a temp repo; only the registry is faked.

await initializeLogging({});

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

async function buildArchive(
  name: string,
  version: string,
  files: Record<string, string>,
): Promise<Uint8Array> {
  const archiveDir = await Deno.makeTempDir({ prefix: "swamp_2724_arc_" });
  try {
    const extDir = join(archiveDir, "extension");
    const models = Object.keys(files)
      .filter((f) => f.startsWith("models/"))
      .map((f) => f.slice("models/".length));
    await ensureDir(extDir);
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      `manifestVersion: 1\nname: "${name}"\nversion: "${version}"\n` +
        `models:\n${models.map((m) => `  - ${m}\n`).join("")}`,
    );
    for (const [rel, content] of Object.entries(files)) {
      await ensureDir(dirname(join(extDir, rel)));
      await Deno.writeTextFile(join(extDir, rel), content);
    }
    await createTarGz(extDir, join(archiveDir, "a.tar.gz"));
    return await Deno.readFile(join(archiveDir, "a.tar.gz"));
  } finally {
    await Deno.remove(archiveDir, { recursive: true }).catch(() => {});
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

/**
 * Every entry under `dir`, keyed by its `/`-separated relative path:
 * a directory as `<dir>`, a symlink as its target, a file as its text.
 */
async function tree(dir: string): Promise<Record<string, string> | null> {
  if (!(await exists(dir))) return null;
  const out: Record<string, string> = {};
  for await (const e of walk(dir, { followSymlinks: false })) {
    const rel = relative(dir, e.path).replaceAll("\\", "/");
    if (e.isDirectory) out[rel] = "<dir>";
    else if (e.isSymlink) out[rel] = `<link ${await Deno.readLink(e.path)}>`;
    else out[rel] = await Deno.readTextFile(e.path);
  }
  return out;
}

interface RepoSnapshot {
  pulledExtensions: Record<string, string> | null;
  bundleRoots: Record<string, Record<string, string> | null>;
  lockfile: unknown;
  catalog: unknown;
  skills: Record<string, string> | null;
}

interface Fixture {
  repoDir: string;
  lockfilePath: string;
  skillsDir: string;
  catalog: ExtensionCatalogStore;
  nameA: string;
  nameB: string;
  sharedType: string;
  aOnlyType: string;
  /** Installs `name@version` the way `extension pull` does. */
  install(name: string, version: string): Promise<unknown>;
  /** Runs `extension update` for every installed extension. */
  update(latest: Record<string, string>): Promise<ExtensionUpdateEvent[]>;
  snapshot(): Promise<RepoSnapshot>;
}

async function withFixture(
  archivesFor: (f: {
    nameA: string;
    nameB: string;
    sharedType: string;
    aOnlyType: string;
  }) => Promise<Record<string, Uint8Array>>,
  fn: (f: Fixture) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2724_int_" });
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await ensureDir(dirname(lockfilePath));
  await ensureDir(swampPath(repoDir));
  const skillsDir = join(repoDir, ".claude", "skills");
  const catalog = new ExtensionCatalogStore(
    swampPath(repoDir, "_extension_catalog.db"),
  );
  try {
    const id = crypto.randomUUID().slice(0, 8);
    const names = {
      nameA: `@test/a-${id}`,
      nameB: `@test/b-${id}`,
      sharedType: `@test/shared-${id}`,
      aOnlyType: `@test/a-only-${id}`,
    };
    const archives = await archivesFor(names);

    const installContext = async (
      version: string,
    ): Promise<InstallContext> => ({
      getExtension: (n) =>
        Promise.resolve({ name: n, description: "", latestVersion: version }),
      downloadArchive: (n, v) => {
        const archive = archives[`${n}@${v}`];
        return archive
          ? Promise.resolve(archive)
          : Promise.reject(new Error(`no archive ${n}@${v}`));
      },
      getChecksum: () => Promise.resolve(null),
      // A fresh lockfile repository per command, as the CLI does.
      lockfileRepository: await LockfileRepository.create(lockfilePath),
      skillsDirs: [skillsDir],
      repoDir,
      force: true,
      alreadyPulled: new Set(),
      depth: 0,
    });
    const repositoryFor = (ctx: InstallContext) =>
      new ExtensionRepository({
        catalog,
        lockfileRepository: ctx.lockfileRepository,
        repoRoot: repoDir,
      });

    const install = async (name: string, version: string) => {
      const ctx = await installContext(version);
      return await new InstallExtensionService({
        denoRuntime: testDenoRuntime,
        repository: repositoryFor(ctx),
      }).execute({ name, version }, ctx);
    };

    // Wired as the serve `extension.update` handler wires it.
    const update = async (latest: Record<string, string>) => {
      const deps: ExtensionUpdateDeps = {
        lockfileRepository: await LockfileRepository.create(lockfilePath),
        getExtension: (name) =>
          Promise.resolve({ latestVersion: latest[name] ?? null }),
        installExtension: async (name, version) => {
          const ctx = await installContext(version);
          return await new UpgradeExtensionService({
            denoRuntime: testDenoRuntime,
            repository: repositoryFor(ctx),
          }).execute(name, version, ctx);
        },
      };
      const events: ExtensionUpdateEvent[] = [];
      for await (
        const event of extensionUpdate(createLibSwampContext(), deps, {
          checkOnly: false,
        })
      ) {
        events.push(event);
      }
      return events;
    };

    const snapshot = async (): Promise<RepoSnapshot> => {
      const bundleRoots: Record<string, Record<string, string> | null> = {};
      for (const r of extensionInstallRoots(repoDir, names.nameA).bundleRoots) {
        bundleRoots[relative(repoDir, r.live).replaceAll("\\", "/")] =
          await tree(r.live);
      }
      return {
        pulledExtensions: await tree(swampPath(repoDir, "pulled-extensions")),
        bundleRoots,
        lockfile: JSON.parse(await Deno.readTextFile(lockfilePath)),
        catalog: catalog.findAll(),
        skills: await tree(skillsDir),
      };
    };

    await fn({
      repoDir,
      lockfilePath,
      skillsDir,
      catalog,
      ...names,
      install,
      update,
      snapshot,
    });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function completedStatus(
  events: ExtensionUpdateEvent[],
  name: string,
): ExtensionUpdateStatus {
  const completed = events.at(-1);
  assert(completed?.kind === "completed", `last event: ${completed?.kind}`);
  const status = completed.data.extensions.find((s) => s.name === name);
  assert(status, `no update status for ${name}`);
  return status;
}

Deno.test("extensionUpdate: a type collision leaves the previous version installed exactly", async () => {
  await withFixture(
    async ({ nameA, nameB, sharedType, aOnlyType }) => ({
      [`${nameB}@${V1}`]: await buildArchive(nameB, V1, {
        "models/b_model.ts": modelSource(sharedType, V1),
      }),
      [`${nameA}@${V1}`]: await buildArchive(nameA, V1, {
        "models/a_v1_model.ts": modelSource(aOnlyType, V1),
        "skills/a-skill/SKILL.md": "# a-skill v1\n",
      }),
      // v2 claims B's type and ships a new skill file. Skill dirs are not
      // swapped: a file v2 overwrites in one keeps v2's content after a
      // rollback (see design/primitives/extensions.md), so v2 ships the
      // same SKILL.md here and only adds a file, which the rollback
      // removes.
      [`${nameA}@${V2}`]: await buildArchive(nameA, V2, {
        "models/a_v2_model.ts": modelSource(sharedType, V2),
        "skills/a-skill/SKILL.md": "# a-skill v1\n",
        "skills/a-skill/reference.md": "v2 only\n",
      }),
    }),
    async (f) => {
      await f.install(f.nameB, V1);
      await f.install(f.nameA, V1);

      const before = await f.snapshot();
      // The fixture covers what it claims to: A v1's files, bundle,
      // skill, lockfile entry and catalog rows are all there.
      assert(before.pulledExtensions, "pulled-extensions missing");
      assertEquals(
        before.pulledExtensions[`${f.nameA}/models/a_v1_model.ts`],
        modelSource(f.aOnlyType, V1),
      );
      assert(
        Object.values(before.bundleRoots).some((t) =>
          t !== null && Object.keys(t).length > 0
        ),
        "A v1 has no bundles",
      );
      assertEquals(before.skills?.["a-skill/SKILL.md"], "# a-skill v1\n");
      assertEquals(
        (before.lockfile as Record<string, { version: string }>)[f.nameA]
          .version,
        V1,
      );
      assert(
        f.catalog.findAll().some((r) => r.type_normalized === f.aOnlyType),
        "A v1's type is not in the catalog",
      );

      const events = await f.update({ [f.nameA]: V2, [f.nameB]: V1 });

      assert(
        events.some((e) =>
          e.kind === "updating" && e.name === f.nameA && e.from === V1 &&
          e.to === V2
        ),
        "update did not attempt A v1 -> v2",
      );
      const status = completedStatus(events, f.nameA);
      assertEquals(status.status, "failed");
      if (status.status === "failed") {
        assertEquals(status.installedVersion, V1);
        assertStringIncludes(status.error, "Update failed:");
        assertStringIncludes(status.error, f.sharedType);
        assertStringIncludes(status.error, "rolled back");
      }
      assertEquals(completedStatus(events, f.nameB).status, "up_to_date");
      const completed = events.at(-1);
      if (completed?.kind === "completed") {
        assertEquals(completed.data.summary.failed, 1);
        assertEquals(completed.data.summary.updated, 0);
      }

      const after = await f.snapshot();
      assertEquals(after.pulledExtensions, before.pulledExtensions);
      assertEquals(after.bundleRoots, before.bundleRoots);
      assertEquals(after.lockfile, before.lockfile);
      assertEquals(after.catalog, before.catalog);
      assertEquals(after.skills, before.skills);
    },
  );
});

Deno.test("extensionUpdate: an update with no collision installs the new version and drops the old", async () => {
  await withFixture(
    async ({ nameA, nameB, sharedType, aOnlyType }) => ({
      [`${nameB}@${V1}`]: await buildArchive(nameB, V1, {
        "models/b_model.ts": modelSource(sharedType, V1),
      }),
      [`${nameA}@${V1}`]: await buildArchive(nameA, V1, {
        "models/a_v1_model.ts": modelSource(aOnlyType, V1),
        "skills/a-skill/SKILL.md": "# a-skill v1\n",
      }),
      [`${nameA}@${V2}`]: await buildArchive(nameA, V2, {
        "models/a_v2_model.ts": modelSource(`${aOnlyType}-v2`, V2),
        "skills/a-skill/SKILL.md": "# a-skill v2\n",
      }),
    }),
    async (f) => {
      await f.install(f.nameB, V1);
      await f.install(f.nameA, V1);
      const before = await f.snapshot();

      const events = await f.update({ [f.nameA]: V2, [f.nameB]: V1 });

      const status = completedStatus(events, f.nameA);
      assertEquals(status.status, "updated");
      if (status.status === "updated") {
        assertEquals(status.previousVersion, V1);
        assertEquals(status.newVersion, V2);
      }

      const after = await f.snapshot();
      assertEquals(
        (after.lockfile as Record<string, { version: string }>)[f.nameA]
          .version,
        V2,
      );
      assertEquals(
        (after.lockfile as Record<string, unknown>)[f.nameB],
        (before.lockfile as Record<string, unknown>)[f.nameB],
      );
      assert(after.pulledExtensions, "pulled-extensions missing");
      assertEquals(
        after.pulledExtensions[`${f.nameA}/models/a_v2_model.ts`],
        modelSource(`${f.aOnlyType}-v2`, V2),
      );
      assertEquals(
        after.pulledExtensions[`${f.nameA}/models/a_v1_model.ts`],
        undefined,
      );
      assertEquals(after.skills?.["a-skill/SKILL.md"], "# a-skill v2\n");
      assertEquals(
        Object.values(after.bundleRoots).some((t) =>
          t !== null && Object.keys(t).some((p) => p.includes("a_v1_model"))
        ),
        false,
        "A v1's bundle survived the update",
      );

      const live = f.catalog.findAll().filter((r) => r.state !== "Tombstoned");
      const types = live.map((r) => r.type_normalized);
      assert(types.includes(`${f.aOnlyType}-v2`), "A v2's type missing");
      assertEquals(types.includes(f.aOnlyType), false);
      assert(types.includes(f.sharedType), "B's type missing");
    },
  );
});
