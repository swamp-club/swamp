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

import "../src/domain/models/models.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { ensureDir, exists } from "@std/fs";
import { join } from "@std/path";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { EmbeddedDenoRuntime } from "../src/infrastructure/runtime/embedded_deno_runtime.ts";
import { InstallExtensionService } from "../src/libswamp/extensions/install_extension_service.ts";
import {
  ConflictError,
  type InstallContext,
} from "../src/libswamp/extensions/pull.ts";
import { RemoveExtensionService } from "../src/libswamp/extensions/remove_extension_service.ts";
import { UpgradeExtensionService } from "../src/libswamp/extensions/upgrade_extension_service.ts";
import { linkSharedSwampDenoCache } from "./test_helpers.ts";

await initializeLogging({});

const V1 = "2026.01.01.1";
const V2 = "2026.01.02.1";
const OWNER_SKILL =
  "---\nname: myskill\ndescription: from-owner\n---\nfrom-owner\n";

async function buildArchive(
  name: string,
  version: string,
  skill: { name: string; body: string } | null,
  dependencies: string[] = [],
): Promise<Uint8Array> {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_upd_skill_arc_" });
  try {
    const extDir = join(tmp, "extension");
    const lines = [
      "manifestVersion: 1",
      `name: "${name}"`,
      `version: "${version}"`,
    ];
    if (skill) {
      await ensureDir(join(extDir, "skills", skill.name));
      await Deno.writeTextFile(
        join(extDir, "skills", skill.name, "SKILL.md"),
        `---\nname: ${skill.name}\ndescription: ${skill.body}\n---\n${skill.body}\n`,
      );
      lines.push("skills:", `  - ${skill.name}`);
    } else {
      await ensureDir(join(extDir, "workflows"));
      await Deno.writeTextFile(join(extDir, "workflows", "w.yaml"), "x: 1\n");
      lines.push("workflows:", "  - w.yaml");
    }
    if (dependencies.length > 0) {
      lines.push("dependencies:", ...dependencies.map((d) => `  - "${d}"`));
    }
    await Deno.writeTextFile(join(extDir, "manifest.yaml"), lines.join("\n"));
    await createTarGz(extDir, join(tmp, "a.tar.gz"));
    return await Deno.readFile(join(tmp, "a.tar.gz"));
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

interface Fixture {
  skillsDir: string;
  install(name: string, version: string, force: boolean): Promise<void>;
  upgrade(name: string, version: string): Promise<void>;
  rm(name: string): Promise<void>;
  lockfile(): Promise<Record<string, { version: string; files?: string[] }>>;
}

/** archives are keyed name@version; a dependency resolves to its newest */
async function withFixture(
  archives: Map<string, Uint8Array>,
  fn: (f: Fixture) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "swamp_upd_skill_home_" });
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_upd_skill_repo_" });
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await ensureDir(join(repoDir, "extensions", "models"));
  await Deno.writeTextFile(lockfilePath, "{}");
  const skillsDir = join(repoDir, ".claude", "skills");
  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  const denoRuntime = {
    ensureDeno: () => Promise.resolve(Deno.execPath()),
    getDenoEnv: () => new EmbeddedDenoRuntime().getDenoEnv(),
  };
  const latest = (name: string) =>
    [...archives.keys()].filter((k) => k.startsWith(`${name}@`))
      .map((k) => k.slice(name.length + 1)).sort().at(-1) ?? null;
  // a fresh lockfile snapshot per operation, as both update paths build it
  const context = async (force: boolean): Promise<InstallContext> => ({
    getExtension: (name) =>
      Promise.resolve({ name, description: "", latestVersion: latest(name) }),
    downloadArchive: (name, version) => {
      const archive = archives.get(`${name}@${version}`);
      return archive
        ? Promise.resolve(archive)
        : Promise.reject(new Error(`cannot download ${name}@${version}`));
    },
    getChecksum: () => Promise.resolve(null),
    lockfileRepository: await LockfileRepository.create(lockfilePath),
    skillsDirs: [skillsDir],
    repoDir,
    force,
    alreadyPulled: new Set(),
    depth: 0,
  });
  const repositoryFor = (lockfileRepository: LockfileRepository) =>
    new ExtensionRepository({ catalog, lockfileRepository, repoRoot: repoDir });
  const fixture: Fixture = {
    skillsDir,
    install: async (name, version, force) => {
      const ctx = await context(force);
      await new InstallExtensionService({
        denoRuntime,
        repository: repositoryFor(ctx.lockfileRepository),
      }).execute({ name, version }, ctx);
    },
    upgrade: async (name, version) => {
      const ctx = await context(true);
      await new UpgradeExtensionService({
        denoRuntime,
        repository: repositoryFor(ctx.lockfileRepository),
      }).execute(name, version, ctx);
    },
    rm: async (name) => {
      const lockfileRepository = await LockfileRepository.create(lockfilePath);
      await new RemoveExtensionService({
        repository: repositoryFor(lockfileRepository),
        lockfileRepository,
        repoDir,
      }).execute(name);
    },
    lockfile: async () => JSON.parse(await Deno.readTextFile(lockfilePath)),
  };
  try {
    await linkSharedSwampDenoCache(home);
    await withMockedEnv(
      {
        HOME: home,
        SWAMP_HOME: home,
        SWAMP_CONFIG_DIR: join(home, ".config", "swamp"),
      },
      () => fn(fixture),
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
}

async function ownerAndUpgraded(id: string) {
  const owner = `@t/owner-${id}`;
  const upgraded = `@t/upgraded-${id}`;
  const archives = new Map([
    [
      `${owner}@${V1}`,
      await buildArchive(owner, V1, { name: "myskill", body: "from-owner" }),
    ],
    [`${upgraded}@${V1}`, await buildArchive(upgraded, V1, null)],
    [
      `${upgraded}@${V2}`,
      await buildArchive(upgraded, V2, { name: "myskill", body: "from-up" }),
    ],
  ]);
  return { owner, upgraded, archives };
}

Deno.test("UpgradeExtensionService: an upgrade shipping a skill another extension owns is refused under force, and rm of the upgraded extension leaves that skill", async () => {
  const { owner, upgraded, archives } = await ownerAndUpgraded(
    crypto.randomUUID().slice(0, 8),
  );
  await withFixture(archives, async (f) => {
    const skillMd = join(f.skillsDir, "myskill", "SKILL.md");
    await f.install(owner, V1, false);
    await f.install(upgraded, V1, false);

    const error = await assertRejects(
      () => f.upgrade(upgraded, V2),
      ConflictError,
    );
    assertEquals(error.skillDirs, [".claude/skills/myskill"]);
    assertEquals(await Deno.readTextFile(skillMd), OWNER_SKILL);
    assertEquals((await f.lockfile())[upgraded]?.version, V1);

    await f.rm(upgraded);
    assertEquals(await Deno.readTextFile(skillMd), OWNER_SKILL);
    const after = await f.lockfile();
    assertEquals(after[upgraded], undefined);
    assertEquals(after[owner]?.files?.includes(".claude/skills/myskill"), true);
  });
});

Deno.test("RemoveExtensionService: after a confirmed pull merges into another extension's skill dir, rm keeps that dir and its files", async () => {
  const { owner, upgraded, archives } = await ownerAndUpgraded(
    crypto.randomUUID().slice(0, 8),
  );
  await withFixture(archives, async (f) => {
    const skillMd = join(f.skillsDir, "myskill", "SKILL.md");
    await f.install(owner, V1, false);
    await f.install(upgraded, V1, false);
    // what pull does after the user confirms the conflict prompt
    await f.install(upgraded, V2, true);
    assertEquals(
      (await f.lockfile())[upgraded]?.files?.includes(
        ".claude/skills/myskill/SKILL.md",
      ),
      true,
    );

    await f.rm(upgraded);
    assertEquals(await exists(skillMd), true);
    assertEquals(
      (await f.lockfile())[owner]?.files?.includes(".claude/skills/myskill"),
      true,
    );
  });
});

Deno.test("UpgradeExtensionService: a dependency the upgrade adds merges into another extension's skill dir, and rm of the dependency keeps that dir", async () => {
  const id = crypto.randomUUID().slice(0, 8);
  const owner = `@t/owner-${id}`;
  const parent = `@t/parent-${id}`;
  const dep = `@t/dep-${id}`;
  const archives = new Map([
    [
      `${owner}@${V1}`,
      await buildArchive(owner, V1, { name: "depskill", body: "from-owner" }),
    ],
    [`${parent}@${V1}`, await buildArchive(parent, V1, null)],
    [`${parent}@${V2}`, await buildArchive(parent, V2, null, [dep])],
    [
      `${dep}@${V1}`,
      await buildArchive(dep, V1, { name: "depskill", body: "from-dep" }),
    ],
  ]);
  await withFixture(archives, async (f) => {
    const skillDir = join(f.skillsDir, "depskill");
    await f.install(owner, V1, false);
    await f.install(parent, V1, false);

    await f.upgrade(parent, V2);
    const lockfile = await f.lockfile();
    assertEquals(lockfile[parent]?.version, V2);
    assertEquals(
      lockfile[dep]?.files?.includes(".claude/skills/depskill/SKILL.md"),
      true,
    );

    await f.rm(dep);
    assertEquals(await exists(join(skillDir, "SKILL.md")), true);
    assertEquals(
      (await f.lockfile())[owner]?.files?.includes(".claude/skills/depskill"),
      true,
    );
  });
});
