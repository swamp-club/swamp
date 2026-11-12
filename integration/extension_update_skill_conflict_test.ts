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
import { ensureDir } from "@std/fs";
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

async function buildArchive(
  name: string,
  version: string,
  skill: { name: string; body: string } | null,
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
    await Deno.writeTextFile(join(extDir, "manifest.yaml"), lines.join("\n"));
    await createTarGz(extDir, join(tmp, "a.tar.gz"));
    return await Deno.readFile(join(tmp, "a.tar.gz"));
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

Deno.test("UpgradeExtensionService: an upgrade shipping a skill another extension owns is refused under force, and rm of the upgraded extension leaves that skill", async () => {
  const id = crypto.randomUUID().slice(0, 8);
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
  const skillMd = join(skillsDir, "myskill", "SKILL.md");
  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  const denoRuntime = {
    ensureDeno: () => Promise.resolve(Deno.execPath()),
    getDenoEnv: () => new EmbeddedDenoRuntime().getDenoEnv(),
  };
  // a fresh lockfile snapshot per operation, as both update paths build it
  const context = async (force: boolean): Promise<InstallContext> => ({
    getExtension: (name) =>
      Promise.resolve({ name, description: "", latestVersion: V2 }),
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
  const repositoryFor = (ctx: InstallContext) =>
    new ExtensionRepository({
      catalog,
      lockfileRepository: ctx.lockfileRepository,
      repoRoot: repoDir,
    });
  try {
    await linkSharedSwampDenoCache(home);
    await withMockedEnv(
      {
        HOME: home,
        SWAMP_HOME: home,
        SWAMP_CONFIG_DIR: join(home, ".config", "swamp"),
      },
      async () => {
        for (const name of [owner, upgraded]) {
          const ctx = await context(false);
          await new InstallExtensionService({
            denoRuntime,
            repository: repositoryFor(ctx),
          }).execute({ name, version: V1 }, ctx);
        }

        const upgradeCtx = await context(true);
        const error = await assertRejects(
          () =>
            new UpgradeExtensionService({
              denoRuntime,
              repository: repositoryFor(upgradeCtx),
            }).execute(upgraded, V2, upgradeCtx),
          ConflictError,
        );
        assertEquals(error.skillDirs, [".claude/skills/myskill"]);
        assertEquals(
          await Deno.readTextFile(skillMd),
          "---\nname: myskill\ndescription: from-owner\n---\nfrom-owner\n",
        );
        const lockfile = JSON.parse(await Deno.readTextFile(lockfilePath));
        assertEquals(lockfile[upgraded]?.version, V1);

        const rmLockfile = await LockfileRepository.create(lockfilePath);
        await new RemoveExtensionService({
          repository: new ExtensionRepository({
            catalog,
            lockfileRepository: rmLockfile,
            repoRoot: repoDir,
          }),
          lockfileRepository: rmLockfile,
          repoDir,
        }).execute(upgraded);
        assertEquals(
          await Deno.readTextFile(skillMd),
          "---\nname: myskill\ndescription: from-owner\n---\nfrom-owner\n",
        );
        const after = JSON.parse(await Deno.readTextFile(lockfilePath));
        assertEquals(after[upgraded], undefined);
        assertEquals(
          after[owner]?.files?.includes(".claude/skills/myskill"),
          true,
        );
      },
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
