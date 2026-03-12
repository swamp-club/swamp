// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "./resolve_extension_files.ts";
import { UserError } from "../domain/errors.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";

const logger = getLogger(["test"]);

async function withTempRepo(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-resolve-ext-test-" });
  try {
    // Create a minimal .swamp.yaml marker so RepoMarkerRepository.read works
    await Deno.writeTextFile(
      join(dir, ".swamp.yaml"),
      stringifyYaml({ swampVersion: "0.1.0" }),
    );
    // Create the default models dir
    await Deno.mkdir(join(dir, "extensions", "models"), { recursive: true });
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// Stub RepositoryContext — only workflowRepo/definitionRepo are used,
// and only when the manifest has workflows.
const stubRepoContext = {} as unknown as RepositoryContext;

Deno.test("resolveExtensionFiles resolves valid manifest with model files", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "my_model.ts"),
      'export const name = "my_model";',
    );

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["my_model.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.manifest.name, "@test/myext");
    assertEquals(result.manifest.version, "2026.03.03.1");
    assertEquals(result.absoluteManifestPath, manifestPath);
    assertEquals(result.modelsDir, modelsDir);
    assertEquals(result.modelEntryPoints, [join(modelsDir, "my_model.ts")]);
    assertEquals(result.allModelFiles.length >= 1, true);
    assertEquals(result.workflowFiles, []);
    assertEquals(result.vaultEntryPoints, []);
    assertEquals(result.allVaultFiles, []);
    assertEquals(result.additionalFilePaths, []);
  });
});

Deno.test("resolveExtensionFiles throws UserError for missing manifest", async () => {
  await withTempRepo(async (dir) => {
    const manifestPath = join(dir, "nonexistent.yaml");

    await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubRepoContext,
          logger,
        }),
      UserError,
      "Manifest file not found",
    );
  });
});

Deno.test("resolveExtensionFiles throws UserError for missing model file", async () => {
  await withTempRepo(async (dir) => {
    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["does_not_exist.ts"],
      }),
    );

    await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubRepoContext,
          logger,
        }),
      UserError,
      "Model file not found",
    );
  });
});

Deno.test("resolveExtensionFiles throws UserError for missing additional file", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "my_model.ts"),
      'export const name = "my_model";',
    );

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["my_model.ts"],
        additionalFiles: ["missing_readme.md"],
      }),
    );

    await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubRepoContext,
          logger,
        }),
      UserError,
      "Additional file not found",
    );
  });
});

Deno.test("resolveExtensionFiles resolves additional files when present", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "my_model.ts"),
      'export const name = "my_model";',
    );

    // Additional file lives relative to the manifest
    const readmePath = join(dir, "README.md");
    await Deno.writeTextFile(readmePath, "# My Extension");

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["my_model.ts"],
        additionalFiles: ["README.md"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.additionalFilePaths, [readmePath]);
  });
});

Deno.test("resolveExtensionFiles resolves vault files from manifest", async () => {
  await withTempRepo(async (dir) => {
    // Create vaults dir and vault file
    const vaultsDir = join(dir, "extensions", "vaults");
    await Deno.mkdir(vaultsDir, { recursive: true });
    await Deno.writeTextFile(
      join(vaultsDir, "my_vault.ts"),
      'export const vault = { type: "@test/my-vault" };',
    );

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        vaults: ["my_vault.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.vaultEntryPoints, [join(vaultsDir, "my_vault.ts")]);
    assertEquals(result.allVaultFiles.length >= 1, true);
    assertEquals(result.vaultsDir, vaultsDir);
  });
});

Deno.test("resolveExtensionFiles throws UserError for missing vault file", async () => {
  await withTempRepo(async (dir) => {
    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        vaults: ["nonexistent_vault.ts"],
      }),
    );

    await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubRepoContext,
          logger,
        }),
      UserError,
      "Vault file not found",
    );
  });
});

Deno.test("resolveExtensionFiles returns empty vault arrays when no vaults in manifest", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "my_model.ts"),
      'export const name = "my_model";',
    );

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["my_model.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.vaultEntryPoints, []);
    assertEquals(result.allVaultFiles, []);
  });
});
