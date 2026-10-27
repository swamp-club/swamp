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
import { join, resolve } from "@std/path";
import { assertPathEquals } from "../../../infrastructure/persistence/path_test_helpers.ts";
import {
  configuredLockPath,
  detectExtensionProject,
  extensionProjectMode,
  findDenoConfig,
  findLoaderDenoConfig,
  findPackageJsonDir,
  frozenLockPath,
  projectConfigBoundary,
} from "./extension_project.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-extension-project-" }),
  );
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't released a handle yet.
      // Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("projectConfigBoundary: the root or repo dir that contains the manifest, else the manifest dir", () => {
  // resolve, not join: the boundary is absolute, so on Windows it carries the
  // current drive letter.
  const repo = resolve("/", "repo");
  const root = resolve("/", "elsewhere", "ext");
  assertPathEquals(
    projectConfigBoundary(join(repo, "ext", "sub"), root, repo),
    repo,
  );
  assertPathEquals(projectConfigBoundary(join(root, "sub"), root, repo), root);
  assertPathEquals(projectConfigBoundary(repo, root, repo), repo);
  // A monorepo sub-directory root inside the repo: the repo's own deno.json
  // still applies, so the walk goes up to the repo dir.
  const inRepoRoot = join(repo, "packages", "foo");
  assertPathEquals(
    projectConfigBoundary(join(inRepoRoot, "src"), inRepoRoot, repo),
    repo,
  );
  assertPathEquals(
    projectConfigBoundary(resolve("/", "nowhere", "m"), root, repo),
    resolve("/", "nowhere", "m"),
  );
});

Deno.test("findDenoConfig: the nearest deno.json walking up to the boundary, inclusive", async () => {
  await withTempDir(async (dir) => {
    const ext = join(dir, "extensions", "models", "ext");
    const upTo = (boundary: string) =>
      findDenoConfig(ext, { dir: boundary, inclusive: true });
    await Deno.mkdir(ext, { recursive: true });
    assertEquals(upTo(dir), undefined);

    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    assertPathEquals(upTo(dir)!, join(dir, "deno.json"));

    await Deno.writeTextFile(join(ext, "deno.json"), "{}");
    assertPathEquals(upTo(dir)!, join(ext, "deno.json"));

    // A deno.json above the boundary is never used.
    await Deno.remove(join(ext, "deno.json"));
    assertEquals(upTo(join(dir, "extensions")), undefined);
  });
});

Deno.test("findDenoConfig: finds a deno.jsonc, and deno.json wins in the same directory (swamp-club#3612)", async () => {
  await withTempDir(async (dir) => {
    const ext = join(dir, "extensions", "models");
    const upTo = (boundary: string) =>
      findDenoConfig(ext, { dir: boundary, inclusive: true });
    await Deno.mkdir(ext, { recursive: true });
    await Deno.writeTextFile(join(dir, "deno.jsonc"), "// comment\n{}");
    assertPathEquals(upTo(dir)!, join(dir, "deno.jsonc"));

    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    assertPathEquals(upTo(dir)!, join(dir, "deno.json"));

    // The nearer directory wins over the file name.
    await Deno.writeTextFile(join(ext, "deno.jsonc"), "{}");
    assertPathEquals(upTo(dir)!, join(ext, "deno.jsonc"));
  });
});

Deno.test("findDenoConfig: a directory named deno.json is not a config", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "deno.json"));
    assertEquals(findDenoConfig(dir, { dir, inclusive: true }), undefined);
  });
});

Deno.test("findPackageJsonDir: the directory holding the nearest package.json", async () => {
  await withTempDir(async (dir) => {
    const ext = join(dir, "extensions", "models");
    assertEquals(findPackageJsonDir(ext, dir), undefined);
    await Deno.writeTextFile(join(dir, "package.json"), "{}");
    assertPathEquals(findPackageJsonDir(ext, dir)!, dir);
  });
});

Deno.test("findLoaderDenoConfig: the nearest config above a source, stopping below the repository", async () => {
  await withTempDir(async (dir) => {
    const models = join(dir, "extensions", "models");
    await Deno.mkdir(models, { recursive: true });
    const source = join(models, "m.ts");
    // A config in the repository directory itself is not the loader's.
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    assertEquals(findLoaderDenoConfig(source, dir), undefined);

    await Deno.writeTextFile(join(dir, "extensions", "deno.jsonc"), "{}");
    assertPathEquals(
      findLoaderDenoConfig(source, dir)!,
      join(dir, "extensions", "deno.jsonc"),
    );

    // Without a repository the walk goes on up.
    await Deno.remove(join(dir, "extensions", "deno.jsonc"));
    assertPathEquals(
      findLoaderDenoConfig(source, null)!,
      join(dir, "deno.json"),
    );
  });
});

Deno.test("findLoaderDenoConfig: any entry named deno.json counts, as the loader has always read it", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "ext", "deno.json"), { recursive: true });
    assertPathEquals(
      findLoaderDenoConfig(join(dir, "ext", "m.ts"), dir)!,
      join(dir, "ext", "deno.json"),
    );
  });
});

Deno.test("detectExtensionProject: a Deno config wins over a package.json", async () => {
  await withTempDir(async (dir) => {
    const entry = join(dir, "extensions", "models", "m.ts");
    await Deno.mkdir(join(dir, "extensions", "models"), { recursive: true });
    await Deno.writeTextFile(entry, 'import ms from "ms";\n');
    await Deno.writeTextFile(join(dir, "package.json"), "{}");
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    const project = await detectExtensionProject({
      manifestDir: dir,
      extensionsRoot: join(dir, "extensions"),
      repoDir: dir,
      entryPoints: [entry],
    });
    assertEquals(project, { denoConfigPath: join(dir, "deno.json") });
    assertEquals(extensionProjectMode(project), "deno-config");
  });
});

Deno.test("detectExtensionProject: a package.json is the project only when an entry point imports a bare name", async () => {
  await withTempDir(async (dir) => {
    const entry = join(dir, "extensions", "models", "m.ts");
    await Deno.mkdir(join(dir, "extensions", "models"), { recursive: true });
    await Deno.writeTextFile(join(dir, "package.json"), "{}");
    const detect = (skip?: Set<string>) =>
      detectExtensionProject({
        manifestDir: dir,
        extensionsRoot: join(dir, "extensions"),
        repoDir: dir,
        entryPoints: [entry],
        ...(skip ? { skip } : {}),
      });

    await Deno.writeTextFile(entry, 'import ms from "npm:ms@2.1.3";\n');
    assertEquals(await detect(), {});
    assertEquals(extensionProjectMode({}), "none");

    // Every import form counts: side-effect, dynamic and `from`
    // (swamp-club#3983).
    await Deno.writeTextFile(entry, 'import "ms";\n');
    assertEquals(await detect(), { packageJsonDir: dir });
    await Deno.writeTextFile(entry, 'export const m = () => import("ms");\n');
    assertEquals(await detect(), { packageJsonDir: dir });
    // A bare name only in a comment or string is not an import.
    await Deno.writeTextFile(
      entry,
      '// import ms from "ms";\nconst s = "ms";\n',
    );
    assertEquals(await detect(), {});
    await Deno.writeTextFile(entry, 'import ms from "ms";\n');
    const project = await detect();
    assertEquals(project, { packageJsonDir: dir });
    assertEquals(extensionProjectMode(project), "package-json");

    // An entry point reached through a symlink is not read.
    assertEquals(await detect(new Set([entry])), {});
  });
});

Deno.test("configuredLockPath: a deno.json without a lock setting uses the deno.lock beside it", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, JSON.stringify({ imports: {} }));
    assertPathEquals(
      await configuredLockPath({ denoConfigPath: config }),
      join(dir, "deno.lock"),
    );
  });
});

Deno.test("configuredLockPath: honours the lock setting of a config with comments, as a deno.jsonc (swamp-club#3612)", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "deno.jsonc");
    await Deno.writeTextFile(config, '{ // comment\n "lock": false, }');
    assertEquals(
      await configuredLockPath({ denoConfigPath: config }),
      undefined,
    );

    await Deno.writeTextFile(config, '// comment\n{ "lock": "locks/a.lock" }');
    assertPathEquals(
      await configuredLockPath({ denoConfigPath: config }),
      join(dir, "locks", "a.lock"),
    );

    await Deno.writeTextFile(config, "/* no lock setting */ {}");
    assertPathEquals(
      await configuredLockPath({ denoConfigPath: config }),
      join(dir, "deno.lock"),
    );
  });
});

Deno.test("configuredLockPath: a config that cannot be parsed reads no lock", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, '{ "lock": false');
    assertEquals(
      await configuredLockPath({ denoConfigPath: config }),
      undefined,
    );
  });
});

Deno.test("configuredLockPath: honours the deno.json lock setting", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, JSON.stringify({ lock: false }));
    assertEquals(
      await configuredLockPath({ denoConfigPath: config }),
      undefined,
    );

    await Deno.writeTextFile(config, JSON.stringify({ lock: "locks/a.lock" }));
    assertPathEquals(
      await configuredLockPath({ denoConfigPath: config }),
      join(dir, "locks", "a.lock"),
    );

    await Deno.writeTextFile(
      config,
      JSON.stringify({ lock: { path: "b.lock", frozen: true } }),
    );
    assertPathEquals(
      await configuredLockPath({ denoConfigPath: config }),
      join(dir, "b.lock"),
    );
  });
});

Deno.test("configuredLockPath: package.json mode uses the deno.lock in its directory", async () => {
  assertPathEquals(
    await configuredLockPath({ packageJsonDir: join("a", "b") }),
    join("a", "b", "deno.lock"),
  );
});

Deno.test("configuredLockPath: no project means no lock, as the bundler runs with --no-lock", async () => {
  assertEquals(await configuredLockPath({}), undefined);
});

Deno.test("frozenLockPath: the configured lock when it is on disk, or the one beside a config that cannot be parsed", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, "{}");
    assertEquals(await frozenLockPath({ denoConfigPath: config }), undefined);
    await Deno.writeTextFile(join(dir, "deno.lock"), "{}");
    assertPathEquals(
      (await frozenLockPath({ denoConfigPath: config }))!,
      join(dir, "deno.lock"),
    );
    await Deno.writeTextFile(config, "{ not json");
    assertPathEquals(
      (await frozenLockPath({ denoConfigPath: config }))!,
      join(dir, "deno.lock"),
    );
    assertEquals(
      await configuredLockPath({ denoConfigPath: config }),
      undefined,
    );
  });
});
