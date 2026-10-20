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

/**
 * Push and quality treat the extension's lockfile as read-only
 * (swamp-club#3613): the module graph read and the bundle run with
 * `--frozen` when the project has a lock and `--no-lock` when it has none,
 * so a stale lock is refused rather than rewritten and no lock is created.
 * Wires the real Deno, module graph reader and bundler as push does, offline:
 * the shared cache supplies esbuild and the npm registry is unreachable.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../src/domain/errors.ts";
import { bundleExtension } from "../src/domain/models/bundle.ts";
import { DenoInfoModuleGraphReader } from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";
import {
  type ExtensionProject,
  readOnlyLockFor,
} from "../src/infrastructure/runtime/deno_lockfile_reader.ts";
import { SHARED_SWAMP_DENO_CACHE } from "./test_helpers.ts";

const ENV = {
  DENO_DIR: SHARED_SWAMP_DENO_CACHE,
  NPM_CONFIG_REGISTRY: "http://127.0.0.1:1/",
};

// The issue's repro: the lock records npm:ms@^2.0.0 at 2.0.0, and deno.json
// has since moved the specifier past it.
const MS_LOCK = JSON.stringify(
  {
    version: "5",
    specifiers: { "npm:ms@2": "2.0.0" },
    npm: {
      "ms@2.0.0": {
        integrity:
          "sha512-Tpp60P6IUJDTuOq/5Z8cdskzJujfwqfOTkrwIwj7IRISpnkJnT6SyJ4PCPnGMoFjC9ddhal5KVIYtAt97ix05A==",
      },
    },
    workspace: { dependencies: ["npm:ms@^2.0.0"] },
  },
  null,
  2,
) + "\n";

async function withProject(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-lock-read-only-" }),
  );
  try {
    await Deno.writeTextFile(join(dir, "mod.ts"), "export const x = 1;\n");
    for (const [name, text] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, name), text);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

/** Reads the module graph and bundles `mod.ts` the way push and quality do. */
async function readAndBundle(
  dir: string,
  project: ExtensionProject,
): Promise<void> {
  const entry = join(dir, "mod.ts");
  await new DenoInfoModuleGraphReader(Deno.execPath(), ENV, {
    readOnlyLock: true,
  }).read(entry, project);
  await bundleExtension(entry, Deno.execPath(), {
    ...project,
    readOnlyLock: await readOnlyLockFor(project),
    env: ENV,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("push lockfile: a stale deno.lock is refused, not rewritten, by the graph read and the bundle", async () => {
  await withProject({
    "deno.json": JSON.stringify({ imports: { ms: "npm:ms@^2.1.0" } }),
    "deno.lock": MS_LOCK,
  }, async (dir) => {
    const project = { denoConfigPath: join(dir, "deno.json") };
    const lockPath = join(dir, "deno.lock");
    const entry = join(dir, "mod.ts");

    const graphError = await assertRejects(
      () =>
        new DenoInfoModuleGraphReader(Deno.execPath(), ENV, {
          readOnlyLock: true,
        }).read(entry, project),
      UserError,
    );
    assertStringIncludes(
      graphError.message,
      `${lockPath} is out of date with ${project.denoConfigPath}`,
    );
    assertStringIncludes(
      graphError.message,
      `deno install --entrypoint ${entry}`,
    );
    assertEquals(await Deno.readTextFile(lockPath), MS_LOCK);

    const readOnlyLock = await readOnlyLockFor(project);
    await assertRejects(
      () =>
        bundleExtension(entry, Deno.execPath(), {
          ...project,
          readOnlyLock,
          env: ENV,
        }),
      UserError,
      `${lockPath} is out of date`,
    );
    assertEquals(await Deno.readTextFile(lockPath), MS_LOCK);
  });
});

Deno.test("push lockfile: a current deno.lock bundles under --frozen and is unchanged", async () => {
  await withProject({
    "deno.json": JSON.stringify({ imports: { ms: "npm:ms@^2.0.0" } }),
    "deno.lock": MS_LOCK,
  }, async (dir) => {
    await readAndBundle(dir, { denoConfigPath: join(dir, "deno.json") });
    assertEquals(await Deno.readTextFile(join(dir, "deno.lock")), MS_LOCK);
  });
});

Deno.test("push lockfile: a deno.json project without a lock gets none", async () => {
  await withProject({
    "deno.json": JSON.stringify({ imports: { ms: "npm:ms@^2.0.0" } }),
  }, async (dir) => {
    await readAndBundle(dir, { denoConfigPath: join(dir, "deno.json") });
    assertEquals(await exists(join(dir, "deno.lock")), false);
  });
});

Deno.test("push lockfile: a package.json project without a lock gets none", async () => {
  await withProject({ "package.json": "{}" }, async (dir) => {
    await Deno.mkdir(join(dir, "node_modules"));
    await readAndBundle(dir, { packageJsonDir: dir });
    assertEquals(await exists(join(dir, "deno.lock")), false);
  });
});
