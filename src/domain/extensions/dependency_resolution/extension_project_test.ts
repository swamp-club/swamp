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
  type ExtensionProject,
  extensionProjectMode,
  findAncestorConfigs,
  findDenoConfig,
  findLoaderDenoConfig,
  findPackageJsonDir,
  findWorkspaceRoot,
  frozenLockPath,
  ignoredMemberLockPath,
  projectConfigBoundary,
  workspaceListsMember,
} from "./extension_project.ts";

/** A project without what Deno would find above the temp dir. */
function withinTemp(project: ExtensionProject): ExtensionProject {
  const { ancestorConfigs: _, ...rest } = project;
  return rest;
}

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

    // Without a Deno config push reads none (swamp-club#3971).
    const none = { noConfig: true };
    const pkg = { packageJsonDir: dir, noConfig: true };
    await Deno.writeTextFile(entry, 'import ms from "npm:ms@2.1.3";\n');
    assertEquals(withinTemp(await detect()), none);
    assertEquals(extensionProjectMode(none), "none");

    // Every import form counts: side-effect, dynamic and `from`
    // (swamp-club#3983).
    await Deno.writeTextFile(entry, 'import "ms";\n');
    assertEquals(withinTemp(await detect()), pkg);
    await Deno.writeTextFile(entry, 'export const m = () => import("ms");\n');
    assertEquals(withinTemp(await detect()), pkg);
    // A bare name only in a comment or string is not an import.
    await Deno.writeTextFile(
      entry,
      '// import ms from "ms";\nconst s = "ms";\n',
    );
    assertEquals(withinTemp(await detect()), none);
    await Deno.writeTextFile(entry, 'import ms from "ms";\n');
    const project = await detect();
    assertEquals(withinTemp(project), pkg);
    assertEquals(extensionProjectMode(project), "package-json");

    // An entry point reached through a symlink is not read.
    assertEquals(withinTemp(await detect(new Set([entry]))), none);
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

Deno.test("workspaceListsMember: matches a member path as Deno does, with or without ./ and a trailing slash, or a glob", () => {
  const root = resolve("/", "w");
  const member = join(root, "packages", "ext");
  for (const pattern of ["./packages/ext", "packages/ext", "./packages/ext/"]) {
    assertEquals(workspaceListsMember(root, pattern, member), true, pattern);
  }
  assertEquals(workspaceListsMember(root, "./packages/*", member), true);
  assertEquals(workspaceListsMember(root, "./packages/other", member), false);
  assertEquals(workspaceListsMember(root, "./other/*", member), false);
});

Deno.test("findWorkspaceRoot: the config above a member whose workspace lists it (swamp-club#3971)", async () => {
  await withTempDir(async (dir) => {
    const ext = join(dir, "packages", "ext");
    await Deno.mkdir(ext, { recursive: true });
    await Deno.writeTextFile(join(ext, "deno.json"), "{}");
    const member = join(ext, "deno.json");
    // A config above that does not list the member is not its root.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ workspace: ["./packages/other"] }),
    );
    assertEquals(await findWorkspaceRoot(member), undefined);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ workspace: ["./packages/*"] }),
    );
    assertPathEquals(
      (await findWorkspaceRoot(member))!,
      join(dir, "deno.json"),
    );
    // The object form, with members.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ workspace: { members: ["packages/ext/"] } }),
    );
    assertPathEquals(
      (await findWorkspaceRoot(member))!,
      join(dir, "deno.json"),
    );
    // The nearest workspace decides, as for Deno: one between that does not
    // list the member hides the root above it.
    await Deno.writeTextFile(
      join(dir, "packages", "deno.json"),
      JSON.stringify({ workspace: ["./other"] }),
    );
    assertEquals(await findWorkspaceRoot(member), undefined);
    // A config between without a workspace field is not a workspace.
    await Deno.writeTextFile(join(dir, "packages", "deno.json"), "{}");
    assertPathEquals(
      (await findWorkspaceRoot(member))!,
      join(dir, "deno.json"),
    );
  });
});

Deno.test("detectExtensionProject: a workspace member reads the root, inside the repository or refused above it (swamp-club#3971)", async () => {
  await withTempDir(async (dir) => {
    const repo = join(dir, "repo");
    const ext = join(repo, "ext");
    const entry = join(ext, "extensions", "models", "m.ts");
    await Deno.mkdir(join(ext, "extensions", "models"), { recursive: true });
    await Deno.writeTextFile(entry, 'import ms from "ms";\n');
    await Deno.writeTextFile(join(ext, "deno.json"), "{}");
    const detect = () =>
      detectExtensionProject({
        manifestDir: ext,
        extensionsRoot: join(ext, "extensions"),
        repoDir: repo,
        entryPoints: [entry],
      });
    await Deno.writeTextFile(
      join(repo, "deno.json"),
      JSON.stringify({ workspace: ["./ext"] }),
    );
    assertEquals(await detect(), {
      denoConfigPath: join(ext, "deno.json"),
      workspaceRootConfigPath: join(repo, "deno.json"),
    });
    // A root above the repository is an ancestor config.
    await Deno.remove(join(repo, "deno.json"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ workspace: ["./repo/ext"] }),
    );
    assertEquals(await detect(), {
      denoConfigPath: join(ext, "deno.json"),
      ancestorConfigs: [{
        path: join(dir, "deno.json"),
        kind: "workspace-root",
      }],
    });
  });
});

Deno.test("findAncestorConfigs: the nearest Deno config and package.json above the boundary (swamp-club#3971)", async () => {
  await withTempDir(async (dir) => {
    const repo = join(dir, "a", "repo");
    await Deno.mkdir(repo, { recursive: true });
    // The boundary itself is not above it.
    await Deno.writeTextFile(join(repo, "deno.json"), "{}");
    const found = (withPackageJson: boolean) =>
      findAncestorConfigs(repo, withPackageJson).filter((c) =>
        c.path.startsWith(dir)
      );
    assertEquals(found(true), []);
    await Deno.writeTextFile(join(dir, "deno.jsonc"), "{}");
    await Deno.writeTextFile(join(dir, "a", "package.json"), "{}");
    assertEquals(found(true), [
      { path: join(dir, "deno.jsonc"), kind: "deno-config" },
      { path: join(dir, "a", "package.json"), kind: "package-json" },
    ]);
    assertEquals(found(false), [
      { path: join(dir, "deno.jsonc"), kind: "deno-config" },
    ]);
  });
});

Deno.test("configuredLockPath: a workspace member reads the root's lock; its own is ignored (swamp-club#3971)", async () => {
  await withTempDir(async (dir) => {
    const ext = join(dir, "ext");
    await Deno.mkdir(ext);
    await Deno.writeTextFile(join(ext, "deno.json"), "{}");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ workspace: ["./ext"] }),
    );
    const project = {
      denoConfigPath: join(ext, "deno.json"),
      workspaceRootConfigPath: join(dir, "deno.json"),
    };
    assertPathEquals(
      (await configuredLockPath(project))!,
      join(dir, "deno.lock"),
    );
    assertEquals(await frozenLockPath(project), undefined);
    await Deno.writeTextFile(join(dir, "deno.lock"), "{}");
    assertPathEquals((await frozenLockPath(project))!, join(dir, "deno.lock"));
    assertEquals(await ignoredMemberLockPath(project), undefined);

    // The member's own deno.lock, or its lock setting, is what Deno ignores.
    await Deno.writeTextFile(join(ext, "deno.lock"), "{}");
    assertPathEquals(
      (await ignoredMemberLockPath(project))!,
      join(ext, "deno.lock"),
    );
    await Deno.writeTextFile(
      join(ext, "deno.json"),
      JSON.stringify({ lock: "./own.lock" }),
    );
    assertPathEquals(
      (await ignoredMemberLockPath(project))!,
      join(ext, "own.lock"),
    );
    assertPathEquals(
      (await configuredLockPath(project))!,
      join(dir, "deno.lock"),
    );

    // The root's lock setting applies, from the root's directory.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ workspace: ["./ext"], lock: "./locks/ws.lock" }),
    );
    assertPathEquals(
      (await configuredLockPath(project))!,
      join(dir, "locks", "ws.lock"),
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ workspace: ["./ext"], lock: false }),
    );
    assertEquals(await configuredLockPath(project), undefined);
    // Outside a workspace there is no member lock to ignore.
    assertEquals(
      await ignoredMemberLockPath({ denoConfigPath: join(ext, "deno.json") }),
      undefined,
    );
  });
});
