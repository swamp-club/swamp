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

// The behaviors: manifest key (swamp-club#3338): its entries resolve from
// extensions/behaviors/ while the models directory is the default, from the
// configured models directory otherwise, and next to the manifest under
// paths.base: manifest.

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "./resolve_extension_files.ts";
import { regexModuleGraphReader } from "./resolve_extension_files_test_helpers.ts";
import { UserError } from "../domain/errors.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";

const logger = getLogger(["test"]);
const stubRepoContext = {} as unknown as RepositoryContext;

async function withRepo(
  marker: Record<string, unknown>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-resolve-behaviors-" }),
  );
  try {
    await Deno.writeTextFile(
      join(dir, ".swamp.yaml"),
      stringifyYaml({ swampVersion: "0.1.0", ...marker }),
    );
    await withMockedEnv({
      SWAMP_MODELS_DIR: undefined,
      SWAMP_BEHAVIORS_DIR: undefined,
    }, () => fn(dir));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function write(path: string, content: string): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, content);
}

async function writeManifest(
  path: string,
  fields: Record<string, unknown>,
): Promise<string> {
  await write(
    path,
    stringifyYaml({
      manifestVersion: 1,
      name: "@test/spelled",
      version: "2026.10.13.1",
      ...fields,
    }),
  );
  return path;
}

const resolveAt = (repoDir: string, manifestPath: string) =>
  resolveExtensionFiles({
    repoDir,
    manifestPath,
    repoContext: stubRepoContext,
    logger,
    moduleGraphReader: regexModuleGraphReader,
  });

Deno.test("resolveExtensionFiles: behaviors: entries, their imports and includes resolve from extensions/behaviors/", async () => {
  await withRepo({}, async (dir) => {
    const behaviorsDir = join(dir, "extensions", "behaviors");
    await write(
      join(behaviorsDir, "aws", "ec2.ts"),
      'import { x } from "./lib.ts";\nexport const behavior = { x };\n',
    );
    await write(join(behaviorsDir, "aws", "lib.ts"), "export const x = 1;\n");
    await write(join(behaviorsDir, "aws", "data.json"), "{}");
    const manifestPath = await writeManifest(join(dir, "manifest.yaml"), {
      behaviors: ["aws/ec2.ts"],
      include: ["aws/data.json"],
    });
    const result = await resolveAt(dir, manifestPath);
    assertEquals(result.modelsDir, join(dir, "extensions", "models"));
    assertEquals(result.behaviorsDir, behaviorsDir);
    assertEquals(result.manifest.models, ["aws/ec2.ts"]);
    assertEquals(result.modelEntryPoints, [
      join(behaviorsDir, "aws", "ec2.ts"),
    ]);
    assertEquals(result.allModelFiles, [
      join(behaviorsDir, "aws", "ec2.ts"),
      join(behaviorsDir, "aws", "lib.ts"),
    ]);
    assertEquals(result.includeFilePaths, [
      join(behaviorsDir, "aws", "data.json"),
    ]);
  });
});

Deno.test("resolveExtensionFiles: a models: manifest has no behaviors dir and never reads extensions/behaviors/", async () => {
  await withRepo({}, async (dir) => {
    await write(
      join(dir, "extensions", "behaviors", "only.ts"),
      "export const behavior = {};\n",
    );
    const manifestPath = await writeManifest(join(dir, "manifest.yaml"), {
      models: ["only.ts"],
    });
    await assertRejects(
      () => resolveAt(dir, manifestPath),
      UserError,
      "Model file not found: only.ts",
    );
  });
});

Deno.test("resolveExtensionFiles: a missing behaviors: entry names the behaviors directory", async () => {
  await withRepo({}, async (dir) => {
    const manifestPath = await writeManifest(join(dir, "manifest.yaml"), {
      behaviors: ["missing.ts"],
    });
    await assertRejects(
      () => resolveAt(dir, manifestPath),
      UserError,
      `Behavior file not found: missing.ts (looked in ${
        join(dir, "extensions", "behaviors", "missing.ts")
      })`,
    );
  });
});

Deno.test("resolveExtensionFiles: behaviors: entries resolve from a configured models directory", async () => {
  await withRepo({ modelsDir: "src/models" }, async (dir) => {
    const modelsDir = join(dir, "src", "models");
    await write(join(modelsDir, "thing.ts"), "export const behavior = {};\n");
    const manifestPath = await writeManifest(join(dir, "manifest.yaml"), {
      behaviors: ["thing.ts"],
    });
    const result = await resolveAt(dir, manifestPath);
    assertEquals(result.behaviorsDir, modelsDir);
    assertEquals(result.modelEntryPoints, [join(modelsDir, "thing.ts")]);
  });
});

Deno.test("resolveExtensionFiles: under paths.base: manifest, behaviors: entries resolve next to the manifest and may not start with behaviors/ or models/", async () => {
  await withRepo({}, async (dir) => {
    const extDir = join(dir, "extensions", "behaviors", "pkg");
    await write(join(extDir, "thing.ts"), "export const behavior = {};\n");
    const manifestPath = await writeManifest(join(extDir, "manifest.yaml"), {
      paths: { base: "manifest" },
      behaviors: ["thing.ts"],
    });
    const result = await resolveAt(dir, manifestPath);
    assertEquals(result.behaviorsDir, extDir);
    assertEquals(result.modelEntryPoints, [join(extDir, "thing.ts")]);

    for (const prefix of ["behaviors", "models"]) {
      await write(
        join(extDir, prefix, "x.ts"),
        "export const behavior = {};\n",
      );
      const doubled = await writeManifest(join(extDir, "manifest.yaml"), {
        paths: { base: "manifest" },
        behaviors: [`${prefix}/x.ts`],
      });
      await assertRejects(
        () => resolveAt(dir, doubled),
        UserError,
        `Manifest field 'behaviors' entry '${prefix}/x.ts' starts with '${prefix}/'`,
      );
    }
  });
});
