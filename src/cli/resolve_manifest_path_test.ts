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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../domain/errors.ts";
import { assertPathEquals } from "../infrastructure/persistence/path_test_helpers.ts";
import { resolveManifestArgument } from "./resolve_manifest_path.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-manifest-arg-" });
  try {
    await fn(await Deno.realPath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function writeManifest(dir: string, name = "manifest.yaml") {
  await Deno.mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await Deno.writeTextFile(path, "manifestVersion: 1\n");
  return path;
}

Deno.test("resolveManifestArgument: an absolute file path is used as given", async () => {
  await withTempDir(async (dir) => {
    const manifest = await writeManifest(join(dir, "ext"));
    const result = await resolveManifestArgument({
      argument: manifest,
      cwd: join(dir, "elsewhere"),
      repoDir: join(dir, "repo"),
    });
    assertPathEquals(result.absoluteManifestPath, manifest);
    assertEquals(result.base, "absolute");
  });
});

Deno.test("resolveManifestArgument: a relative path resolves against cwd before the repo dir", async () => {
  await withTempDir(async (dir) => {
    const fromCwd = await writeManifest(join(dir, "cwd", "ext"));
    await writeManifest(join(dir, "repo", "ext"));
    const result = await resolveManifestArgument({
      argument: join("ext", "manifest.yaml"),
      cwd: join(dir, "cwd"),
      repoDir: join(dir, "repo"),
    });
    assertPathEquals(result.absoluteManifestPath, fromCwd);
    assertEquals(result.base, "cwd");
  });
});

Deno.test("resolveManifestArgument: falls back to --extensions-dir, then the repo dir", async () => {
  await withTempDir(async (dir) => {
    const inExtensions = await writeManifest(join(dir, "exts", "ext"));
    const inRepo = await writeManifest(join(dir, "repo", "ext"));
    const viaExtensions = await resolveManifestArgument({
      argument: "ext",
      cwd: join(dir, "cwd"),
      repoDir: join(dir, "repo"),
      extensionsDir: join(dir, "exts"),
    });
    assertPathEquals(viaExtensions.absoluteManifestPath, inExtensions);
    assertEquals(viaExtensions.base, "extensionsDir");

    const viaRepo = await resolveManifestArgument({
      argument: "ext",
      cwd: join(dir, "cwd"),
      repoDir: join(dir, "repo"),
    });
    assertPathEquals(viaRepo.absoluteManifestPath, inRepo);
    assertEquals(viaRepo.base, "repoDir");
  });
});

Deno.test("resolveManifestArgument: a directory argument means <dir>/manifest.yaml", async () => {
  await withTempDir(async (dir) => {
    const manifest = await writeManifest(join(dir, "ext", "sub"));
    const relative = await resolveManifestArgument({
      argument: join("ext", "sub"),
      cwd: dir,
      repoDir: dir,
    });
    assertPathEquals(relative.absoluteManifestPath, manifest);
    const absolute = await resolveManifestArgument({
      argument: join(dir, "ext", "sub"),
      cwd: join(dir, "elsewhere"),
      repoDir: join(dir, "elsewhere"),
    });
    assertPathEquals(absolute.absoluteManifestPath, manifest);
  });
});

Deno.test("resolveManifestArgument: a directory argument accepts manifest.yml and manifest.json", async () => {
  await withTempDir(async (dir) => {
    const yml = await writeManifest(join(dir, "yml"), "manifest.yml");
    const json = await writeManifest(join(dir, "json"), "manifest.json");
    assertPathEquals(
      (await resolveManifestArgument({
        argument: "yml",
        cwd: dir,
        repoDir: dir,
      }))
        .absoluteManifestPath,
      yml,
    );
    assertPathEquals(
      (await resolveManifestArgument({
        argument: "json",
        cwd: dir,
        repoDir: dir,
      }))
        .absoluteManifestPath,
      json,
    );
  });
});

Deno.test("resolveManifestArgument: a directory without a manifest fails naming the directory", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "ext", "empty"), { recursive: true });
    const err = await assertRejects(
      () =>
        resolveManifestArgument({
          argument: join("ext", "empty"),
          cwd: dir,
          repoDir: dir,
        }),
      UserError,
    );
    assertStringIncludes(
      err.message,
      `No manifest.yaml found in ${join(dir, "ext", "empty")}`,
    );
    assertStringIncludes(err.message, "Pass the extension directory");
  });
});

Deno.test("resolveManifestArgument: a directory without a manifest under cwd does not hide a manifest under the repo dir", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "cwd", "ext"), { recursive: true });
    const inRepo = await writeManifest(join(dir, "repo", "ext"));
    const result = await resolveManifestArgument({
      argument: "ext",
      cwd: join(dir, "cwd"),
      repoDir: join(dir, "repo"),
    });
    assertPathEquals(result.absoluteManifestPath, inRepo);
    assertEquals(result.base, "repoDir");
  });
});

Deno.test("resolveManifestArgument: a missing path is reported as typed with every candidate", async () => {
  await withTempDir(async (dir) => {
    const err = await assertRejects(
      () =>
        resolveManifestArgument({
          argument: join("ext", "nope"),
          cwd: join(dir, "cwd"),
          repoDir: join(dir, "repo"),
          extensionsDir: join(dir, "exts"),
        }),
      UserError,
    );
    assertStringIncludes(
      err.message,
      `Manifest file not found: ${join("ext", "nope")} (looked in `,
    );
    assertStringIncludes(err.message, join(dir, "cwd", "ext", "nope"));
    assertStringIncludes(err.message, join(dir, "exts", "ext", "nope"));
    assertStringIncludes(err.message, join(dir, "repo", "ext", "nope"));
  });
});

Deno.test("resolveManifestArgument: a missing absolute path is reported as typed", async () => {
  await withTempDir(async (dir) => {
    const missing = join(dir, "nope", "manifest.yaml");
    const err = await assertRejects(
      () =>
        resolveManifestArgument({ argument: missing, cwd: dir, repoDir: dir }),
      UserError,
    );
    assertStringIncludes(err.message, `Manifest file not found: ${missing}`);
  });
});

Deno.test("resolveManifestArgument: rejects a TypeScript or JavaScript file", async () => {
  await withTempDir(async (dir) => {
    for (const name of ["model.ts", "model.js"]) {
      const err = await assertRejects(
        () =>
          resolveManifestArgument({ argument: name, cwd: dir, repoDir: dir }),
        UserError,
      );
      assertStringIncludes(err.message, "Expected a manifest path but got");
    }
  });
});
