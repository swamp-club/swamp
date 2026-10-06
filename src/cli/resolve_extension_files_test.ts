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

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import {
  inferExtensionsRoot,
  isPulledExtensionManifest,
  planWorkflowArchiveNames,
  projectConfigBoundary,
  resolveExtensionFiles,
} from "./resolve_extension_files.ts";
import { UserError } from "../domain/errors.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  assertPathEquals,
  withMockedEnv,
} from "../infrastructure/persistence/path_test_helpers.ts";

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

Deno.test("resolveExtensionFiles rejects path traversal in models", async () => {
  await withTempRepo(async (dir) => {
    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["../../other/model.ts"],
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
      "must not contain '..'",
    );
  });
});

Deno.test("resolveExtensionFiles rejects absolute path in workflows", async () => {
  await withTempRepo(async (dir) => {
    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        workflows: ["/etc/passwd"],
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
      "must not contain '..'",
    );
  });
});

Deno.test("resolveExtensionFiles preserves additionalFiles paths (absolute)", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "m.ts"),
      'export const name = "m";',
    );
    await Deno.mkdir(join(dir, "prompts", "nested"), { recursive: true });
    await Deno.writeTextFile(join(dir, "prompts", "review.md"), "p");
    await Deno.writeTextFile(join(dir, "prompts", "nested", "deep.md"), "n");
    await Deno.writeTextFile(join(dir, "README.md"), "r");

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["m.ts"],
        additionalFiles: [
          "prompts/review.md",
          "prompts/nested/deep.md",
          "README.md",
        ],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.additionalFilePaths.length, 3);
    assertEquals(
      result.additionalFilePaths[0],
      join(dir, "prompts", "review.md"),
    );
    assertEquals(
      result.additionalFilePaths[1],
      join(dir, "prompts", "nested", "deep.md"),
    );
    assertEquals(result.additionalFilePaths[2], join(dir, "README.md"));
    assertEquals(result.manifest.additionalFiles.length, 3);
  });
});

Deno.test("resolveExtensionFiles rejects duplicate additionalFiles entries", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "m.ts"),
      'export const name = "m";',
    );
    await Deno.mkdir(join(dir, "prompts"), { recursive: true });
    await Deno.writeTextFile(join(dir, "prompts", "review.md"), "p");

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["m.ts"],
        additionalFiles: ["prompts/review.md", "./prompts/review.md"],
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
      "Duplicate additionalFiles",
    );
  });
});

Deno.test("resolveExtensionFiles rejects case-folded duplicate additionalFiles", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "m.ts"),
      'export const name = "m";',
    );
    await Deno.mkdir(join(dir, "prompts"), { recursive: true });
    await Deno.writeTextFile(join(dir, "prompts", "review.md"), "p");

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["m.ts"],
        additionalFiles: ["prompts/review.md", "prompts/REVIEW.md"],
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
      "Duplicate additionalFiles",
    );
  });
});

Deno.test("resolveExtensionFiles rejects NFC/NFD unicode collisions", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "m.ts"),
      'export const name = "m";',
    );
    await Deno.mkdir(join(dir, "prompts"), { recursive: true });
    // "café" in NFC (1-char é) + NFD (e + combining acute)
    const nfc = "café.md".normalize("NFC");
    const nfd = "café.md".normalize("NFD");
    await Deno.writeTextFile(join(dir, "prompts", nfc), "p");

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["m.ts"],
        additionalFiles: [`prompts/${nfc}`, `prompts/${nfd}`],
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
      "Duplicate additionalFiles",
    );
  });
});

Deno.test("resolveExtensionFiles rejects symlinks in additionalFiles", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "m.ts"),
      'export const name = "m";',
    );
    await Deno.mkdir(join(dir, "prompts"), { recursive: true });
    const target = join(dir, "target.md");
    await Deno.writeTextFile(target, "real");
    const link = join(dir, "prompts", "review.md");
    await Deno.symlink(target, link, { type: "file" });

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["m.ts"],
        additionalFiles: ["prompts/review.md"],
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
      "symlink",
    );
  });
});

Deno.test("resolveExtensionFiles accepts zero-byte additionalFiles", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "m.ts"),
      'export const name = "m";',
    );
    await Deno.writeTextFile(join(dir, "empty.md"), "");

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["m.ts"],
        additionalFiles: ["empty.md"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });
    assertEquals(result.additionalFilePaths.length, 1);
  });
});

Deno.test("resolveExtensionFiles errors clearly when additionalFile missing", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "m.ts"),
      'export const name = "m";',
    );

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.03.03.1",
        models: ["m.ts"],
        additionalFiles: ["missing.md"],
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
      "not found",
    );
  });
});

// ── paths.base behavior ──────────────────────────────────────────────────

Deno.test("resolveExtensionFiles default paths.base resolves models from typedDir", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "foo.ts"),
      'export const name = "foo";',
    );
    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/typeddir",
        version: "2026.04.29.1",
        models: ["foo.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.manifest.paths.base, "typedDir");
    assertEquals(result.modelsDir, modelsDir);
    assertEquals(result.modelEntryPoints, [join(modelsDir, "foo.ts")]);
  });
});

Deno.test("resolveExtensionFiles paths.base=manifest resolves models from manifest dir", async () => {
  await withTempRepo(async (dir) => {
    const subdir = join(dir, "extensions", "models", "myext");
    await Deno.mkdir(subdir, { recursive: true });
    await Deno.writeTextFile(
      join(subdir, "foo.ts"),
      'export const name = "foo";',
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/manifestbase",
        version: "2026.04.29.1",
        paths: { base: "manifest" },
        models: ["foo.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.manifest.paths.base, "manifest");
    assertEquals(result.modelsDir, subdir);
    assertEquals(result.modelEntryPoints, [join(subdir, "foo.ts")]);
  });
});

Deno.test("resolveExtensionFiles paths.base=manifest fails clearly when entry not in manifest dir", async () => {
  await withTempRepo(async (dir) => {
    const subdir = join(dir, "extensions", "models", "myext");
    await Deno.mkdir(subdir, { recursive: true });
    // File exists at the typedDir base but NOT under manifest dir.
    const modelsDir = join(dir, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "stray.ts"),
      'export const name = "stray";',
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/strict",
        version: "2026.04.29.1",
        paths: { base: "manifest" },
        models: ["stray.ts"],
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
      "stray.ts",
    );
  });
});

Deno.test("resolveExtensionFiles paths.base=manifest applies to vaults", async () => {
  await withTempRepo(async (dir) => {
    const subdir = join(dir, "extensions", "vaults", "myvault");
    await Deno.mkdir(subdir, { recursive: true });
    await Deno.writeTextFile(
      join(subdir, "vault.ts"),
      'export const name = "vault";',
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/vault",
        version: "2026.04.29.1",
        paths: { base: "manifest" },
        vaults: ["vault.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.vaultsDir, subdir);
    assertEquals(result.vaultEntryPoints, [join(subdir, "vault.ts")]);
  });
});

Deno.test("resolveExtensionFiles paths.base=manifest applies to include", async () => {
  await withTempRepo(async (dir) => {
    const subdir = join(dir, "extensions", "models", "myext");
    await Deno.mkdir(subdir, { recursive: true });
    await Deno.writeTextFile(
      join(subdir, "model.ts"),
      'export const name = "model";',
    );
    await Deno.writeTextFile(
      join(subdir, "helper.ts"),
      "export const helper = true;",
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/inc",
        version: "2026.04.29.1",
        paths: { base: "manifest" },
        models: ["model.ts"],
        include: ["helper.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.includeFilePaths, [join(subdir, "helper.ts")]);
  });
});

Deno.test("resolveExtensionFiles paths.base=manifest resolves transitive imports", async () => {
  await withTempRepo(async (dir) => {
    const subdir = join(dir, "extensions", "models", "myext");
    await Deno.mkdir(subdir, { recursive: true });
    await Deno.writeTextFile(
      join(subdir, "entry.ts"),
      "import { x } from './helper.ts';\nexport const value = x;",
    );
    await Deno.writeTextFile(
      join(subdir, "helper.ts"),
      "export const x = 1;",
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/imp",
        version: "2026.04.29.1",
        paths: { base: "manifest" },
        models: ["entry.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    // Both entry and helper should be in the resolved set, sorted.
    assertEquals(result.allModelFiles.length, 2);
    assertEquals(
      result.allModelFiles.includes(join(subdir, "entry.ts")),
      true,
    );
    assertEquals(
      result.allModelFiles.includes(join(subdir, "helper.ts")),
      true,
    );
  });
});

Deno.test("resolveExtensionFiles default paths.base preserves swamp-extensions per-extension-subtree shape", async () => {
  // Reproduces the swamp-extensions layout: manifest at repo root,
  // model code under `./extensions/models/`. Bare basenames in
  // `models:` resolve via the configured modelsDir (typedDir mode).
  await withTempRepo(async (extRoot) => {
    const modelsDir = join(extRoot, "extensions", "models");
    await Deno.writeTextFile(
      join(modelsDir, "backups.ts"),
      'export const name = "backups";',
    );
    const manifestPath = join(extRoot, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@swamp/extension-shape",
        version: "2026.04.29.1",
        models: ["backups.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: extRoot,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.modelsDir, modelsDir);
    assertEquals(result.modelEntryPoints, [join(modelsDir, "backups.ts")]);
  });
});

// ── isPulledExtensionManifest ──────────────────────────────────────────

Deno.test("isPulledExtensionManifest: returns true for absolute path under .swamp/pulled-extensions", () => {
  const repoDir = "/repo";
  const manifestPath =
    "/repo/.swamp/pulled-extensions/@bixu/wheelshop/manifest.yaml";
  assertEquals(isPulledExtensionManifest(repoDir, manifestPath), true);
});

Deno.test("isPulledExtensionManifest: returns true for relative path under .swamp/pulled-extensions", () => {
  const repoDir = "/repo";
  const manifestPath = ".swamp/pulled-extensions/@bixu/wheelshop/manifest.yaml";
  assertEquals(isPulledExtensionManifest(repoDir, manifestPath), true);
});

Deno.test("isPulledExtensionManifest: returns false for local extension manifest", () => {
  const repoDir = "/repo";
  const manifestPath = "extensions/models/my-model/manifest.yaml";
  assertEquals(isPulledExtensionManifest(repoDir, manifestPath), false);
});

Deno.test("isPulledExtensionManifest: returns false for absolute local extension manifest", () => {
  const repoDir = "/repo";
  const manifestPath = "/repo/extensions/models/my-model/manifest.yaml";
  assertEquals(isPulledExtensionManifest(repoDir, manifestPath), false);
});

Deno.test("isPulledExtensionManifest: returns false for path containing pulled-extensions outside .swamp", () => {
  const repoDir = "/repo";
  const manifestPath = "/repo/pulled-extensions/manifest.yaml";
  assertEquals(isPulledExtensionManifest(repoDir, manifestPath), false);
});

Deno.test("isPulledExtensionManifest: returns true for managed config absolute path", () => {
  const repoDir = "/repo";
  const manifestPath =
    "/repo/.swamp/config/pulled-extensions/@scope/ext/manifest.yaml";
  assertEquals(isPulledExtensionManifest(repoDir, manifestPath), true);
});

Deno.test("isPulledExtensionManifest: returns true for managed config relative path", () => {
  const repoDir = "/repo";
  const manifestPath =
    ".swamp/config/pulled-extensions/@scope/ext/manifest.yaml";
  assertEquals(isPulledExtensionManifest(repoDir, manifestPath), true);
});

Deno.test("isPulledExtensionManifest: returns false for path containing config but not pulled-extensions", () => {
  const repoDir = "/repo";
  const manifestPath = "/repo/.swamp/config/models/manifest.yaml";
  assertEquals(isPulledExtensionManifest(repoDir, manifestPath), false);
});

// ── .ts/.js file rejection ──────────────────────────────────────────────

Deno.test("resolveExtensionFiles: rejects .ts file with UserError", async () => {
  await withTempRepo(async (dir) => {
    await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath: "extensions/models/my_model.ts",
          repoContext: stubRepoContext,
          logger,
        }),
      UserError,
      "Expected a manifest path but got a TypeScript/JavaScript file",
    );
  });
});

Deno.test("resolveExtensionFiles: rejects .js file with UserError", async () => {
  await withTempRepo(async (dir) => {
    await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath: "extensions/models/my_model.js",
          repoContext: stubRepoContext,
          logger,
        }),
      UserError,
      "Expected a manifest path but got a TypeScript/JavaScript file",
    );
  });
});

// ── skill resolution with paths.base and multi-tool ──────────────────────

async function withTempRepoWithTools(
  tools: string[],
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-resolve-ext-test-" });
  try {
    await Deno.writeTextFile(
      join(dir, ".swamp.yaml"),
      stringifyYaml({ swampVersion: "0.1.0", tools }),
    );
    await Deno.mkdir(join(dir, "extensions", "models"), { recursive: true });
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const MINIMAL_SKILL_MD = `---
name: demo-skill
description: A demo skill for testing
---

Demo skill content.
`;

async function createSkillDir(
  baseDir: string,
  skillName: string,
): Promise<void> {
  const skillDir = join(baseDir, skillName);
  await Deno.mkdir(skillDir, { recursive: true });
  await Deno.writeTextFile(
    join(skillDir, "SKILL.md"),
    MINIMAL_SKILL_MD.replace("demo-skill", skillName),
  );
}

Deno.test("resolveExtensionFiles paths.base=manifest resolves skills from manifest-relative dir", async () => {
  await withTempRepoWithTools(["claude"], async (dir) => {
    const subdir = join(dir, "sub");
    await Deno.mkdir(subdir, { recursive: true });

    await createSkillDir(join(subdir, ".claude", "skills"), "my-skill");

    await Deno.writeTextFile(
      join(subdir, "model.ts"),
      'export const name = "model";',
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/skill-manifest-base",
        version: "2026.05.28.1",
        paths: { base: "manifest" },
        models: ["model.ts"],
        skills: ["my-skill"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.skillDirs.length, 1);
    assertEquals(result.skillDirs[0].name, "my-skill");
    assertEquals(
      result.skillDirs[0].absolutePath,
      join(subdir, ".claude", "skills", "my-skill"),
    );
  });
});

Deno.test("resolveExtensionFiles default paths.base resolves skills from repo root", async () => {
  await withTempRepoWithTools(["claude"], async (dir) => {
    await createSkillDir(join(dir, ".claude", "skills"), "root-skill");

    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/skill-typeddir",
        version: "2026.05.28.1",
        models: ["dummy.ts"],
        skills: ["root-skill"],
      }),
    );
    await Deno.writeTextFile(
      join(dir, "extensions", "models", "dummy.ts"),
      'export const name = "dummy";',
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.skillDirs.length, 1);
    assertEquals(result.skillDirs[0].name, "root-skill");
    assertEquals(
      result.skillDirs[0].absolutePath,
      join(dir, ".claude", "skills", "root-skill"),
    );
  });
});

Deno.test("resolveExtensionFiles paths.base=manifest prefers manifest-relative over repo root", async () => {
  await withTempRepoWithTools(["claude"], async (dir) => {
    const subdir = join(dir, "sub");
    await Deno.mkdir(subdir, { recursive: true });

    // Skill exists in both locations
    await createSkillDir(join(dir, ".claude", "skills"), "shared-skill");
    await createSkillDir(join(subdir, ".claude", "skills"), "shared-skill");

    await Deno.writeTextFile(
      join(subdir, "model.ts"),
      'export const name = "model";',
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/skill-precedence",
        version: "2026.05.28.1",
        paths: { base: "manifest" },
        models: ["model.ts"],
        skills: ["shared-skill"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.skillDirs.length, 1);
    assertEquals(
      result.skillDirs[0].absolutePath,
      join(subdir, ".claude", "skills", "shared-skill"),
    );
  });
});

Deno.test("resolveExtensionFiles multi-tool repo finds skill in secondary tool dir", async () => {
  await withTempRepoWithTools(["claude", "cursor"], async (dir) => {
    // Skill only exists in .cursor/skills, not .claude/skills
    await createSkillDir(join(dir, ".cursor", "skills"), "cursor-skill");

    await Deno.writeTextFile(
      join(dir, "extensions", "models", "dummy.ts"),
      'export const name = "dummy";',
    );
    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/skill-multitool",
        version: "2026.05.28.1",
        skills: ["cursor-skill"],
        models: ["dummy.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.skillDirs.length, 1);
    assertEquals(result.skillDirs[0].name, "cursor-skill");
    assertEquals(
      result.skillDirs[0].absolutePath,
      join(dir, ".cursor", "skills", "cursor-skill"),
    );
  });
});

Deno.test("resolveExtensionFiles multi-tool deduplicates shared SKILL_DIRS paths", async () => {
  // opencode and codex both map to .agents/skills
  await withTempRepoWithTools(["opencode", "codex"], async (dir) => {
    await createSkillDir(join(dir, ".agents", "skills"), "agent-skill");

    await Deno.writeTextFile(
      join(dir, "extensions", "models", "dummy.ts"),
      'export const name = "dummy";',
    );
    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/skill-dedup",
        version: "2026.05.28.1",
        skills: ["agent-skill"],
        models: ["dummy.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.skillDirs.length, 1);
    assertEquals(result.skillDirs[0].name, "agent-skill");
    assertEquals(
      result.skillDirs[0].absolutePath,
      join(dir, ".agents", "skills", "agent-skill"),
    );
  });
});

const stubWorkflowRepoContext = {
  workflowRepo: { findByName: () => Promise.resolve(null) },
  definitionRepo: { findByNameGlobal: () => Promise.resolve(null) },
} as unknown as RepositoryContext;

Deno.test("resolveExtensionFiles paths.base=manifest resolves workflows from manifest dir", async () => {
  await withTempRepo(async (dir) => {
    const subdir = join(dir, "sub");
    await Deno.mkdir(join(subdir, "extensions", "workflows"), {
      recursive: true,
    });
    await Deno.mkdir(join(subdir, "extensions", "models"), { recursive: true });
    await Deno.writeTextFile(
      join(subdir, "extensions", "models", "dummy.ts"),
      'export const name = "dummy";',
    );
    await Deno.writeTextFile(
      join(subdir, "extensions", "workflows", "test-wf.yaml"),
      "name: test-wf\njobs: {}",
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/wf-manifest-base",
        version: "2026.06.03.1",
        paths: { base: "manifest" },
        models: ["extensions/models/dummy.ts"],
        workflows: ["extensions/workflows/test-wf.yaml"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubWorkflowRepoContext,
      logger,
    });

    assertEquals(result.workflowFiles.length, 1);
    const wfRealPath = await Deno.realPath(
      join(subdir, "extensions", "workflows", "test-wf.yaml"),
    );
    assertEquals(result.workflowFiles[0].sourcePath, wfRealPath);
  });
});

Deno.test("resolveExtensionFiles paths.base=manifest prefers manifest-relative for workflows", async () => {
  await withTempRepo(async (dir) => {
    const subdir = join(dir, "sub");
    await Deno.mkdir(join(subdir, "extensions", "models"), { recursive: true });
    await Deno.writeTextFile(
      join(subdir, "extensions", "models", "dummy.ts"),
      'export const name = "dummy";',
    );
    // Workflow in manifest-relative location
    await Deno.mkdir(join(subdir, "extensions", "workflows"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(subdir, "extensions", "workflows", "shared.yaml"),
      "name: manifest-relative\njobs: {}",
    );
    // Workflow with same name at repo root
    await Deno.mkdir(join(dir, "extensions", "workflows"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "extensions", "workflows", "shared.yaml"),
      "name: repo-root\njobs: {}",
    );

    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/wf-priority",
        version: "2026.06.03.1",
        paths: { base: "manifest" },
        models: ["extensions/models/dummy.ts"],
        workflows: ["extensions/workflows/shared.yaml"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubWorkflowRepoContext,
      logger,
    });

    assertEquals(result.workflowFiles.length, 1);
    const manifestRelativePath = await Deno.realPath(
      join(subdir, "extensions", "workflows", "shared.yaml"),
    );
    assertEquals(result.workflowFiles[0].sourcePath, manifestRelativePath);
  });
});

Deno.test("resolveExtensionFiles paths.base=manifest rejects models entry starting with models/", async () => {
  await withTempRepo(async (dir) => {
    const subdir = join(dir, "extensions", "models", "myext");
    await Deno.mkdir(join(subdir, "models"), { recursive: true });
    await Deno.writeTextFile(
      join(subdir, "models", "project.ts"),
      'export const name = "project";',
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/nested-model",
        version: "2026.08.27.1",
        paths: { base: "manifest" },
        models: ["models/project.ts"],
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
      "starts with 'models/'",
    );
  });
});

Deno.test("resolveExtensionFiles paths.base=manifest rejects vaults entry starting with vaults/", async () => {
  await withTempRepo(async (dir) => {
    const subdir = join(dir, "extensions", "vaults", "myvault");
    await Deno.mkdir(join(subdir, "vaults"), { recursive: true });
    await Deno.writeTextFile(
      join(subdir, "vaults", "secret.ts"),
      'export const name = "secret";',
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/nested-vault",
        version: "2026.08.27.1",
        paths: { base: "manifest" },
        vaults: ["vaults/secret.ts"],
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
      "starts with 'vaults/'",
    );
  });
});

Deno.test("resolveExtensionFiles paths.base=manifest rejects include entry starting with models/", async () => {
  await withTempRepo(async (dir) => {
    const subdir = join(dir, "extensions", "models", "myext");
    await Deno.mkdir(join(subdir, "models"), { recursive: true });
    await Deno.writeTextFile(
      join(subdir, "models", "helper.sh"),
      "#!/bin/sh\necho hello",
    );
    await Deno.writeTextFile(
      join(subdir, "entry.ts"),
      'export const name = "entry";',
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/nested-include",
        version: "2026.08.27.1",
        paths: { base: "manifest" },
        models: ["entry.ts"],
        include: ["models/helper.sh"],
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
      "starts with 'models/'",
    );
  });
});

Deno.test("resolveExtensionFiles paths.base=manifest allows unrelated subdirectory in models entry", async () => {
  await withTempRepo(async (dir) => {
    const subdir = join(dir, "extensions", "models", "myext");
    await Deno.mkdir(join(subdir, "aws"), { recursive: true });
    await Deno.writeTextFile(
      join(subdir, "aws", "ec2.ts"),
      'export const name = "ec2";',
    );
    const manifestPath = join(subdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/aws-subdir",
        version: "2026.08.27.1",
        paths: { base: "manifest" },
        models: ["aws/ec2.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.modelEntryPoints, [join(subdir, "aws", "ec2.ts")]);
  });
});

Deno.test("resolveExtensionFiles paths.base=typedDir allows models/ prefix in entry", async () => {
  await withTempRepo(async (dir) => {
    const modelsDir = join(dir, "extensions", "models");
    await Deno.mkdir(join(modelsDir, "models"), { recursive: true });
    await Deno.writeTextFile(
      join(modelsDir, "models", "project.ts"),
      'export const name = "project";',
    );
    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/typeddir-nested",
        version: "2026.08.27.1",
        models: ["models/project.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });

    assertEquals(result.modelEntryPoints, [
      join(modelsDir, "models", "project.ts"),
    ]);
  });
});

// ── extensionsDir override (monorepo support) ────────────────────────────

Deno.test("resolveExtensionFiles extensionsDir overrides repo root for typed-key resolution", async () => {
  await withTempRepo(async (dir) => {
    // Simulate monorepo: extension lives in a subdirectory with its own
    // extensions/<type>/ tree, separate from the repo root's tree.
    const extSubdir = join(dir, "my-datastore-ext");
    const datastoresDir = join(extSubdir, "extensions", "datastores");
    await Deno.mkdir(datastoresDir, { recursive: true });
    await Deno.writeTextFile(
      join(datastoresDir, "my_store.ts"),
      'export const type = "my_store";',
    );

    const manifestPath = join(extSubdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/monorepo-ds",
        version: "2026.08.31.1",
        datastores: ["my_store.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
      extensionsDir: extSubdir,
    });

    assertEquals(result.datastoresDir, datastoresDir);
    assertEquals(result.datastoreEntryPoints, [
      join(datastoresDir, "my_store.ts"),
    ]);
  });
});

Deno.test("resolveExtensionFiles without extensionsDir infers the extensions root for a monorepo datastore (swamp-club#3018)", async () => {
  await withTempRepo(async (dir) => {
    const extSubdir = join(dir, "my-datastore-ext");
    const datastoresDir = join(extSubdir, "extensions", "datastores");
    await Deno.mkdir(datastoresDir, { recursive: true });
    await Deno.writeTextFile(
      join(datastoresDir, "my_store.ts"),
      'export const type = "my_store";',
    );

    const manifestPath = join(extSubdir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/monorepo-ds-fail",
        version: "2026.08.31.1",
        datastores: ["my_store.ts"],
      }),
    );

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });
    assertEquals(result.extensionsRoot, extSubdir);
    assertEquals(result.datastoresDir, datastoresDir);
    assertEquals(result.datastoreEntryPoints, [
      join(datastoresDir, "my_store.ts"),
    ]);
  });
});

// --- Workflow archive names (swamp-club#2613) ---------------------------------
//
// Push writes each workflow to extension/workflows/<archiveName>. Several
// manifest entries under one directory used to collapse to a single
// <directory>.yaml, so the archive kept only the last file.

function recordingWorkflowRepoContext(asked: string[]): RepositoryContext {
  return {
    workflowRepo: {
      findByName: (name: string) => {
        asked.push(name);
        return Promise.resolve(null);
      },
    },
    definitionRepo: { findByNameGlobal: () => Promise.resolve(null) },
  } as unknown as RepositoryContext;
}

async function writeWorkflowFixture(
  dir: string,
  relPath: string,
  name: string,
): Promise<void> {
  await Deno.mkdir(dirname(join(dir, relPath)), { recursive: true });
  await Deno.writeTextFile(
    join(dir, relPath),
    `name: ${name}\njobs: {}\n`,
  );
}

async function writeWorkflowManifest(
  dir: string,
  workflows: string[],
): Promise<string> {
  await Deno.writeTextFile(
    join(dir, "extensions", "models", "noop.ts"),
    'export const model = { type: "@test/noop" };',
  );
  const manifestPath = join(dir, "manifest.yaml");
  await Deno.writeTextFile(
    manifestPath,
    stringifyYaml({
      manifestVersion: 1,
      name: "@test/wf-names",
      version: "2026.10.05.1",
      paths: { base: "manifest" },
      models: ["extensions/models/noop.ts"],
      workflows,
    }),
  );
  return manifestPath;
}

Deno.test("resolveExtensionFiles: several workflows under one directory keep their file names (swamp-club#2613)", async () => {
  await withTempRepo(async (dir) => {
    for (const n of ["alpha", "beta", "gamma"]) {
      await writeWorkflowFixture(
        dir,
        join("workflows", `workflow-repro-${n}.yaml`),
        `@test/repro-${n}`,
      );
    }
    const manifestPath = await writeWorkflowManifest(dir, [
      "workflows/workflow-repro-alpha.yaml",
      "workflows/workflow-repro-beta.yaml",
      "workflows/workflow-repro-gamma.yaml",
    ]);
    const asked: string[] = [];

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: recordingWorkflowRepoContext(asked),
      logger,
    });

    assertEquals(result.workflowFiles.map((wf) => wf.archiveName), [
      "workflow-repro-alpha.yaml",
      "workflow-repro-beta.yaml",
      "workflow-repro-gamma.yaml",
    ]);
    assertEquals(
      new Set(result.workflowFiles.map((wf) => wf.archiveName)).size,
      3,
    );
    // Dependency resolution asks for each file, not for a workflow named
    // after the shared directory.
    assertEquals(asked, [
      "workflow-repro-alpha",
      "workflow-repro-beta",
      "workflow-repro-gamma",
    ]);
  });
});

Deno.test("resolveExtensionFiles: bare workflow entries keep their file names", async () => {
  await withTempRepo(async (dir) => {
    for (const n of ["alpha", "beta", "gamma"]) {
      await writeWorkflowFixture(
        dir,
        `workflow-repro-${n}.yaml`,
        `@test/repro-${n}`,
      );
    }
    const manifestPath = await writeWorkflowManifest(dir, [
      "workflow-repro-alpha.yaml",
      "workflow-repro-beta.yaml",
      "workflow-repro-gamma.yaml",
    ]);
    const asked: string[] = [];

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: recordingWorkflowRepoContext(asked),
      logger,
    });

    assertEquals(result.workflowFiles.map((wf) => wf.archiveName), [
      "workflow-repro-alpha.yaml",
      "workflow-repro-beta.yaml",
      "workflow-repro-gamma.yaml",
    ]);
    assertEquals(asked, [
      "workflow-repro-alpha",
      "workflow-repro-beta",
      "workflow-repro-gamma",
    ]);
  });
});

Deno.test("resolveExtensionFiles: a directory's only workflow is named after the directory", async () => {
  // The one-workflow-per-folder layout (@swamp/kubernetes): every file is
  // workflow.yaml, so the directory name is the only distinct part. These
  // names must not change, or republished archives would be renamed.
  await withTempRepo(async (dir) => {
    await writeWorkflowFixture(
      dir,
      join("namespace-debug", "workflow.yaml"),
      "@test/namespace-debug",
    );
    await writeWorkflowFixture(
      dir,
      join("cluster_health", "workflow.yaml"),
      "@test/cluster-health",
    );
    const manifestPath = await writeWorkflowManifest(dir, [
      "namespace-debug/workflow.yaml",
      "cluster_health/workflow.yaml",
    ]);
    const asked: string[] = [];

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: recordingWorkflowRepoContext(asked),
      logger,
    });

    assertEquals(result.workflowFiles.map((wf) => wf.archiveName), [
      "namespace-debug.yaml",
      "cluster_health.yaml",
    ]);
    assertEquals(asked, ["namespace-debug", "cluster-health"]);
  });
});

Deno.test("resolveExtensionFiles: mixed layouts name each workflow by its own rule", async () => {
  await withTempRepo(async (dir) => {
    await writeWorkflowFixture(dir, join("sub", "a.yaml"), "@test/a");
    await writeWorkflowFixture(dir, join("sub", "b.yaml"), "@test/b");
    await writeWorkflowFixture(
      dir,
      join("other", "workflow.yaml"),
      "@test/other",
    );
    await writeWorkflowFixture(dir, "root.yaml", "@test/root");
    const manifestPath = await writeWorkflowManifest(dir, [
      "sub/a.yaml",
      "sub/b.yaml",
      "other/workflow.yaml",
      "root.yaml",
    ]);

    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubWorkflowRepoContext,
      logger,
    });

    assertEquals(result.workflowFiles.map((wf) => wf.archiveName), [
      "a.yaml",
      "b.yaml",
      "other.yaml",
      "root.yaml",
    ]);
  });
});

Deno.test("resolveExtensionFiles: rejects two workflows that would share an archive name", async () => {
  await withTempRepo(async (dir) => {
    await writeWorkflowFixture(dir, "deploy.yaml", "@test/deploy-root");
    await writeWorkflowFixture(
      dir,
      join("deploy", "workflow.yaml"),
      "@test/deploy-dir",
    );
    const manifestPath = await writeWorkflowManifest(dir, [
      "deploy.yaml",
      "deploy/workflow.yaml",
    ]);

    const err = await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubWorkflowRepoContext,
          logger,
        }),
      UserError,
    );
    assertStringIncludes(err.message, "deploy.yaml");
    assertStringIncludes(err.message, "deploy/workflow.yaml");
    assertStringIncludes(err.message, "overwrite");
  });
});

Deno.test("resolveExtensionFiles: rejects a dependency-resolved workflow that would share an archive name", async () => {
  await withTempRepo(async (dir) => {
    await writeWorkflowFixture(dir, "deploy.yaml", "@test/deploy");
    // A second deploy.yaml that a workflow step references; it is not in
    // the manifest, so the dependency resolver pulls it in.
    await writeWorkflowFixture(
      dir,
      join("elsewhere", "deploy.yaml"),
      "@test/deploy-dep",
    );
    const depPath = join(dir, "elsewhere", "deploy.yaml");
    const manifestPath = await writeWorkflowManifest(dir, ["deploy.yaml"]);
    const repoContext = {
      workflowRepo: {
        findByName: (name: string) =>
          Promise.resolve(
            name === "deploy" ? { id: "dep-wf", jobs: [] } : null,
          ),
        getPath: () => depPath,
      },
      definitionRepo: { findByNameGlobal: () => Promise.resolve(null) },
    } as unknown as RepositoryContext;

    const err = await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext,
          logger,
        }),
      UserError,
    );
    assertStringIncludes(err.message, "referenced by a workflow step");
    assertStringIncludes(err.message, "deploy.yaml");
  });
});

Deno.test("planWorkflowArchiveNames: clashes are detected case-insensitively", () => {
  const err = assertThrows(
    () =>
      planWorkflowArchiveNames([
        { ref: "sub/Deploy.yaml", realPath: "/repo/sub/Deploy.yaml" },
        { ref: "sub/deploy.yaml", realPath: "/repo/sub/deploy.yaml" },
      ]),
    UserError,
  );
  assertStringIncludes(err.message, "sub/Deploy.yaml");
  assertStringIncludes(err.message, "sub/deploy.yaml");
});

Deno.test("planWorkflowArchiveNames: directory grouping ignores ./ prefixes", () => {
  const planned = planWorkflowArchiveNames([
    { ref: "./workflows/a.yaml", realPath: "/repo/workflows/a.yaml" },
    { ref: "workflows/b.yaml", realPath: "/repo/workflows/b.yaml" },
  ]);
  assertEquals(planned.map((p) => p.archiveName), ["a.yaml", "b.yaml"]);
  assertEquals(planned.map((p) => p.lookupName), ["a", "b"]);
});

Deno.test("planWorkflowArchiveNames: a .yml entry is looked up without its extension", () => {
  const [planned] = planWorkflowArchiveNames([
    { ref: "deploy_stack.yml", realPath: "/repo/deploy_stack.yml" },
  ]);
  assertEquals(planned.archiveName, "deploy_stack.yml");
  assertEquals(planned.lookupName, "deploy-stack");
});

Deno.test("planWorkflowArchiveNames: a file listed twice is a duplicate entry, not a clash", () => {
  const err = assertThrows(
    () =>
      planWorkflowArchiveNames([
        { ref: "deploy.yaml", realPath: "/repo/deploy.yaml" },
        { ref: "./deploy.yaml", realPath: "/repo/deploy.yaml" },
      ]),
    UserError,
  );
  assertStringIncludes(err.message, "listed twice");
  assertStringIncludes(err.message, "./deploy.yaml");
  assertStringIncludes(err.message, "deploy.yaml");
});

// ── extensions root selection, flag coverage and error wording (swamp-club#3018) ──

/**
 * Stage an extension in the swamp-extensions layout under `root`: a model
 * at extensions/models/hello.ts, a workflow at
 * extensions/workflows/hello-wf/workflow.yaml and a skill at
 * .claude/skills/hello-skill. Returns the manifest path.
 */
async function stageSubDirectoryExtension(
  root: string,
  name: string,
  options: { workflow?: boolean; skill?: boolean; model?: boolean } = {},
): Promise<string> {
  const { workflow = true, skill = true, model = true } = options;
  await Deno.mkdir(join(root, "extensions", "models"), { recursive: true });
  if (model) {
    await Deno.writeTextFile(
      join(root, "extensions", "models", "hello.ts"),
      'export const name = "hello";',
    );
  }
  if (workflow) {
    await Deno.mkdir(join(root, "extensions", "workflows", "hello-wf"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(root, "extensions", "workflows", "hello-wf", "workflow.yaml"),
      "name: hello-wf\njobs: {}",
    );
  }
  if (skill) {
    await createSkillDir(join(root, ".claude", "skills"), "hello-skill");
  }
  const manifestPath = join(root, "manifest.yaml");
  await Deno.writeTextFile(
    manifestPath,
    stringifyYaml({
      manifestVersion: 1,
      name,
      version: "2026.10.06.1",
      models: ["hello.ts"],
      ...(workflow ? { workflows: ["hello-wf/workflow.yaml"] } : {}),
      ...(skill ? { skills: ["hello-skill"] } : {}),
    }),
  );
  return manifestPath;
}

function assertPackagedWholeExtension(
  result: Awaited<ReturnType<typeof resolveExtensionFiles>>,
  root: string,
): void {
  assertPathEquals(result.extensionsRoot, root);
  assertEquals(result.modelEntryPoints, [
    join(root, "extensions", "models", "hello.ts"),
  ]);
  assertEquals(result.workflowFiles.length, 1);
  assertStringIncludes(
    result.workflowFiles[0].sourcePath,
    join("hello-wf", "workflow.yaml"),
  );
  assertEquals(result.skillDirs.length, 1);
  assertPathEquals(
    result.skillDirs[0].absolutePath,
    join(root, ".claude", "skills", "hello-skill"),
  );
}

Deno.test("resolveExtensionFiles: --extensions-dir covers workflows and skills as it does models (swamp-club#3031)", async () => {
  await withTempRepoWithTools(["claude"], async (dir) => {
    const ext = join(dir, "ext", "sub");
    const manifestPath = await stageSubDirectoryExtension(ext, "@test/flag");
    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubWorkflowRepoContext,
      logger,
      extensionsDir: ext,
    });
    assertPackagedWholeExtension(result, ext);
  });
});

Deno.test("resolveExtensionFiles: an in-repo sub-directory extension resolves without the flag", async () => {
  await withTempRepoWithTools(["claude"], async (dir) => {
    const ext = join(dir, "ext", "sub");
    const manifestPath = await stageSubDirectoryExtension(ext, "@test/inrepo");
    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubWorkflowRepoContext,
      logger,
    });
    assertPackagedWholeExtension(result, ext);
  });
});

Deno.test("resolveExtensionFiles: a sibling-checkout extension resolves without the flag", async () => {
  await withTempRepoWithTools(["claude"], async (dir) => {
    const sibling = await Deno.makeTempDir({ prefix: "swamp-sibling-ext-" });
    try {
      const manifestPath = await stageSubDirectoryExtension(
        sibling,
        "@test/sibling",
      );
      const result = await resolveExtensionFiles({
        repoDir: dir,
        manifestPath,
        repoContext: stubWorkflowRepoContext,
        logger,
      });
      assertPackagedWholeExtension(result, sibling);
    } finally {
      await Deno.remove(sibling, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("resolveExtensionFiles: a sub-directory manifest whose model lives under the repo dir keeps the repo dir as root", async () => {
  await withTempRepo(async (dir) => {
    // The sub-directory looks like an extension root (it has extensions/),
    // but the model only exists under the repo dir: today's resolution
    // must win so the packaged set is unchanged.
    const ext = join(dir, "ext", "sub");
    await stageSubDirectoryExtension(ext, "@test/repo-wins", {
      workflow: false,
      skill: false,
      model: false,
    });
    await Deno.writeTextFile(
      join(dir, "extensions", "models", "hello.ts"),
      'export const name = "hello";',
    );
    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath: join(ext, "manifest.yaml"),
      repoContext: stubRepoContext,
      logger,
    });
    assertPathEquals(result.extensionsRoot, dir);
    assertEquals(result.modelEntryPoints, [
      join(dir, "extensions", "models", "hello.ts"),
    ]);
  });
});

Deno.test("resolveExtensionFiles: a model present under both the repo dir and the inferred root is an ambiguity error", async () => {
  await withTempRepo(async (dir) => {
    const ext = join(dir, "ext", "sub");
    await stageSubDirectoryExtension(ext, "@test/ambiguous", {
      workflow: false,
      skill: false,
    });
    await Deno.writeTextFile(
      join(dir, "extensions", "models", "hello.ts"),
      'export const name = "hello-at-root";',
    );
    const err = await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath: join(ext, "manifest.yaml"),
          repoContext: stubRepoContext,
          logger,
        }),
      UserError,
    );
    assertStringIncludes(
      err.message,
      "Model file hello.ts exists under two roots",
    );
    assertStringIncludes(
      err.message,
      join(dir, "extensions", "models", "hello.ts"),
    );
    assertStringIncludes(
      err.message,
      join(ext, "extensions", "models", "hello.ts"),
    );
    assertStringIncludes(err.message, "--extensions-dir");
    assertStringIncludes(err.message, "paths.base: manifest");
  });
});

Deno.test("resolveExtensionFiles: with --extensions-dir a workflow present under both roots comes from the flag's root (worktree layout)", async () => {
  await withTempRepo(async (dir) => {
    const ext = join(dir, "ext", "sub");
    const manifestPath = await stageSubDirectoryExtension(
      ext,
      "@test/wf-both",
      {
        skill: false,
      },
    );
    await Deno.mkdir(join(dir, "extensions", "workflows", "hello-wf"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(dir, "extensions", "workflows", "hello-wf", "workflow.yaml"),
      "name: hello-wf-at-root\njobs: {}",
    );
    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubWorkflowRepoContext,
      logger,
      extensionsDir: ext,
    });
    assertEquals(result.workflowFiles.length, 1);
    assertPathEquals(
      result.workflowFiles[0].sourcePath,
      await Deno.realPath(
        join(ext, "extensions", "workflows", "hello-wf", "workflow.yaml"),
      ),
    );
  });
});

Deno.test("resolveExtensionFiles: without the flag a workflow present under both the inferred root and the repo dir is an ambiguity error", async () => {
  await withTempRepo(async (dir) => {
    const ext = join(dir, "ext", "sub");
    const manifestPath = await stageSubDirectoryExtension(
      ext,
      "@test/wf-both",
      {
        skill: false,
      },
    );
    await Deno.mkdir(join(dir, "extensions", "workflows", "hello-wf"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(dir, "extensions", "workflows", "hello-wf", "workflow.yaml"),
      "name: hello-wf-at-root\njobs: {}",
    );
    const err = await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubWorkflowRepoContext,
          logger,
        }),
      UserError,
    );
    assertStringIncludes(
      err.message,
      `Workflow file ${
        join("hello-wf", "workflow.yaml")
      } exists under two roots`,
    );
  });
});

Deno.test("resolveExtensionFiles: under paths.base manifest the manifest-dir copy wins and no ambiguity is raised", async () => {
  await withTempRepo(async (dir) => {
    const ext = join(dir, "ext", "sub");
    await stageSubDirectoryExtension(ext, "@test/wf-manifest-copy", {
      skill: false,
    });
    // The manifest-dir copy, the inferred-root copy and the repo copy all
    // exist; only the manifest-dir one is packaged, so the other two must
    // not be reported as contested.
    await Deno.mkdir(join(ext, "hello-wf"), { recursive: true });
    await Deno.writeTextFile(
      join(ext, "hello-wf", "workflow.yaml"),
      "name: hello-wf-next-to-manifest\njobs: {}",
    );
    await Deno.mkdir(join(dir, "extensions", "workflows", "hello-wf"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(dir, "extensions", "workflows", "hello-wf", "workflow.yaml"),
      "name: hello-wf-at-root\njobs: {}",
    );
    const manifestPath = join(ext, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/wf-manifest-copy",
        version: "2026.10.06.1",
        paths: { base: "manifest" },
        models: ["extensions/models/hello.ts"],
        workflows: ["hello-wf/workflow.yaml"],
      }),
    );
    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubWorkflowRepoContext,
      logger,
    });
    assertPathEquals(
      result.workflowFiles[0].sourcePath,
      await Deno.realPath(join(ext, "hello-wf", "workflow.yaml")),
    );
  });
});

Deno.test("resolveExtensionFiles: with --extensions-dir a skill present under both roots comes from the flag's root", async () => {
  await withTempRepoWithTools(["claude"], async (dir) => {
    const ext = join(dir, "ext", "sub");
    const manifestPath = await stageSubDirectoryExtension(
      ext,
      "@test/skill-both",
      {
        workflow: false,
      },
    );
    await createSkillDir(join(dir, ".claude", "skills"), "hello-skill");
    const result = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
      extensionsDir: ext,
    });
    assertPathEquals(
      result.skillDirs[0].absolutePath,
      join(ext, ".claude", "skills", "hello-skill"),
    );
  });
});

Deno.test("resolveExtensionFiles: without the flag a skill present under both the inferred root and the repo dir is an ambiguity error", async () => {
  await withTempRepoWithTools(["claude"], async (dir) => {
    const ext = join(dir, "ext", "sub");
    const manifestPath = await stageSubDirectoryExtension(
      ext,
      "@test/skill-both",
      {
        workflow: false,
      },
    );
    await createSkillDir(join(dir, ".claude", "skills"), "hello-skill");
    const err = await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubRepoContext,
          logger,
        }),
      UserError,
    );
    assertStringIncludes(
      err.message,
      "Skill directory hello-skill exists under two roots",
    );
  });
});

Deno.test("projectConfigBoundary: the root or repo dir that contains the manifest, else the manifest dir", () => {
  const repo = join("/", "repo");
  const root = join("/", "elsewhere", "ext");
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
    projectConfigBoundary(join("/", "nowhere", "m"), root, repo),
    join("/", "nowhere", "m"),
  );
});

Deno.test("resolveExtensionFiles: default in-repo search order for workflows and skills is unchanged", async () => {
  await withTempRepoWithTools(["claude"], async (dir) => {
    const manifestPath = join(dir, "manifest.yaml");
    await Deno.writeTextFile(
      join(dir, "extensions", "models", "dummy.ts"),
      'export const name = "dummy";',
    );
    const write = (extra: Record<string, unknown>) =>
      Deno.writeTextFile(
        manifestPath,
        stringifyYaml({
          manifestVersion: 1,
          name: "@test/order",
          version: "2026.10.06.1",
          models: ["dummy.ts"],
          ...extra,
        }),
      );
    await write({ workflows: ["missing.yaml"] });
    const wfErr = await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubWorkflowRepoContext,
          logger,
        }),
      UserError,
    );
    assertStringIncludes(
      wfErr.message,
      `Workflow file not found: missing.yaml (looked in ${
        join(dir, "workflows")
      }, ${join(dir, "extensions", "workflows")})`,
    );
    await write({ skills: ["missing-skill"] });
    const skillErr = await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubRepoContext,
          logger,
        }),
      UserError,
    );
    assertStringIncludes(
      skillErr.message,
      `Skill directory not found: missing-skill (looked in ${
        join(dir, ".claude", "skills")
      })`,
    );
    assertStringIncludes(
      skillErr.message,
      `Place the skill under ${
        join(dir, ".claude", "skills", "missing-skill")
      }`,
    );
  });
});

Deno.test("resolveExtensionFiles: a skill present only under the home directory no longer resolves", async () => {
  await withTempRepoWithTools(["claude"], async (dir) => {
    const home = await Deno.makeTempDir({ prefix: "swamp-home-skills-" });
    try {
      await createSkillDir(join(home, ".claude", "skills"), "home-only");
      await Deno.writeTextFile(
        join(dir, "extensions", "models", "dummy.ts"),
        'export const name = "dummy";',
      );
      const manifestPath = join(dir, "manifest.yaml");
      await Deno.writeTextFile(
        manifestPath,
        stringifyYaml({
          manifestVersion: 1,
          name: "@test/home-skill",
          version: "2026.10.06.1",
          models: ["dummy.ts"],
          skills: ["home-only"],
        }),
      );
      const err = await withMockedEnv(
        { HOME: home, USERPROFILE: home },
        () =>
          assertRejects(
            () =>
              resolveExtensionFiles({
                repoDir: dir,
                manifestPath,
                repoContext: stubRepoContext,
                logger,
              }),
            UserError,
          ),
      );
      assertStringIncludes(err.message, "Skill directory not found: home-only");
      assertStringIncludes(
        err.message,
        "does not package a skill from your home directory",
      );
      assertEquals(err.message.includes(home), false);
    } finally {
      await Deno.remove(home, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("resolveExtensionFiles: a typed-key miss names the looked-in path, the flag and the setting", async () => {
  await withTempRepo(async (dir) => {
    // The appended-path mistake: --extensions-dir pointing at <ext>/extensions.
    const ext = join(dir, "ext", "sub");
    const manifestPath = await stageSubDirectoryExtension(ext, "@test/miss", {
      workflow: false,
      skill: false,
    });
    const err = await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubRepoContext,
          logger,
          extensionsDir: join(ext, "extensions"),
        }),
      UserError,
    );
    assertStringIncludes(
      err.message,
      `Model file not found: hello.ts (looked in ${
        join(ext, "extensions", "extensions", "models", "hello.ts")
      })`,
    );
    assertStringIncludes(
      err.message,
      `Entries under models resolve from ${
        join(ext, "extensions", "extensions", "models")
      }.`,
    );
    assertStringIncludes(err.message, "--extensions-dir");
    assertStringIncludes(err.message, "paths.base: manifest");
    assertEquals(err.message.includes("exists next to the manifest"), false);
  });
});

Deno.test("resolveExtensionFiles: a typed-key miss points at a copy next to the manifest", async () => {
  await withTempRepo(async (dir) => {
    const ext = join(dir, "bare");
    await Deno.mkdir(ext, { recursive: true });
    await Deno.writeTextFile(
      join(ext, "hello.ts"),
      'export const name = "hello";',
    );
    const manifestPath = join(ext, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/bare",
        version: "2026.10.06.1",
        models: ["hello.ts"],
      }),
    );
    const err = await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubRepoContext,
          logger,
        }),
      UserError,
    );
    assertStringIncludes(err.message, "Model file not found: hello.ts");
    assertStringIncludes(
      err.message,
      `hello.ts exists next to the manifest at ${
        join(ext, "hello.ts")
      }; add paths.base: manifest`,
    );
  });
});

Deno.test("resolveExtensionFiles: a directory argument and an absolute manifest path resolve the same files", async () => {
  await withTempRepo(async (dir) => {
    const ext = join(dir, "ext", "sub");
    const manifestPath = await stageSubDirectoryExtension(
      ext,
      "@test/dir-arg",
      {
        workflow: false,
        skill: false,
      },
    );
    const viaDir = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath: ext,
      repoContext: stubRepoContext,
      logger,
    });
    const viaFile = await resolveExtensionFiles({
      repoDir: dir,
      manifestPath,
      repoContext: stubRepoContext,
      logger,
    });
    assertPathEquals(viaDir.absoluteManifestPath, manifestPath);
    assertEquals(viaDir.modelEntryPoints, viaFile.modelEntryPoints);
  });
});

Deno.test("inferExtensionsRoot: stops at the repo dir for a manifest under extensions/models", async () => {
  await withTempRepo(async (dir) => {
    const manifestDir = join(dir, "extensions", "models", "x");
    await Deno.mkdir(manifestDir, { recursive: true });
    assertPathEquals(await inferExtensionsRoot(manifestDir, dir), dir);
  });
});

Deno.test("inferExtensionsRoot: picks the nearest ancestor holding extensions/ or .swamp.yaml", async () => {
  await withTempRepo(async (dir) => {
    const ext = join(dir, "ext", "sub");
    await Deno.mkdir(join(ext, "extensions"), { recursive: true });
    assertPathEquals(await inferExtensionsRoot(ext, dir), ext);
    assertPathEquals(await inferExtensionsRoot(join(ext, "nested"), dir), ext);

    const marked = join(dir, "marked", "deep");
    await Deno.mkdir(marked, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "marked", ".swamp.yaml"),
      "swampVersion: 0.1.0\n",
    );
    assertPathEquals(
      await inferExtensionsRoot(marked, dir),
      join(dir, "marked"),
    );
  });
});

Deno.test("inferExtensionsRoot: falls back to the manifest directory outside the repo", async () => {
  const outside = await Deno.makeTempDir({ prefix: "swamp-outside-" });
  const repo = await Deno.makeTempDir({ prefix: "swamp-repo-" });
  try {
    const bare = join(outside, "bare");
    await Deno.mkdir(bare, { recursive: true });
    const root = await inferExtensionsRoot(bare, repo);
    // Either the bare directory itself, or an ancestor that happens to be
    // an extension root on this host; never the repo dir.
    assertEquals(bare.startsWith(root), true);
    assertEquals(root === repo, false);
  } finally {
    await Deno.remove(outside, { recursive: true }).catch(() => {});
    await Deno.remove(repo, { recursive: true }).catch(() => {});
  }
});

Deno.test("inferExtensionsRoot: never returns the home directory", async () => {
  const home = await Deno.makeTempDir({ prefix: "swamp-home-root-" });
  const repo = await Deno.makeTempDir({ prefix: "swamp-repo-" });
  try {
    await Deno.mkdir(join(home, "extensions"), { recursive: true });
    const manifestDir = join(home, "work", "myext");
    await Deno.mkdir(manifestDir, { recursive: true });
    const root = await withMockedEnv(
      { HOME: home, USERPROFILE: home },
      () => inferExtensionsRoot(manifestDir, repo),
    );
    assertPathEquals(root, manifestDir);
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
    await Deno.remove(repo, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolveExtensionFiles: a skills-only manifest under the home directory never packages a home skill", async () => {
  await withTempRepoWithTools(["claude"], async (dir) => {
    const home = await Deno.makeTempDir({ prefix: "swamp-home-skills-" });
    try {
      // ~/extensions exists, so the upward walk would otherwise pick ~ as
      // the root and ~/.claude/skills as a candidate.
      await Deno.mkdir(join(home, "extensions"), { recursive: true });
      await createSkillDir(join(home, ".claude", "skills"), "home-only");
      const manifestDir = join(home, "work", "myext");
      await Deno.mkdir(manifestDir, { recursive: true });
      const manifestPath = join(manifestDir, "manifest.yaml");
      await Deno.writeTextFile(
        manifestPath,
        stringifyYaml({
          manifestVersion: 1,
          name: "@test/home-skill-only",
          version: "2026.10.06.1",
          skills: ["home-only"],
        }),
      );
      const err = await withMockedEnv(
        { HOME: home, USERPROFILE: home },
        () =>
          assertRejects(
            () =>
              resolveExtensionFiles({
                repoDir: dir,
                manifestPath,
                repoContext: stubRepoContext,
                logger,
              }),
            UserError,
          ),
      );
      assertStringIncludes(err.message, "Skill directory not found: home-only");
      assertEquals(
        err.message.includes(join(home, ".claude", "skills")),
        false,
      );
    } finally {
      await Deno.remove(home, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("resolveExtensionFiles: under paths.base manifest a root copy that is not next to the manifest is still checked against the repo dir", async () => {
  await withTempRepo(async (dir) => {
    // The inferred root is the manifest dir itself (it holds extensions/),
    // so <root>/extensions/workflows is under the manifest dir, but it is
    // not the manifest-relative candidate: a repo copy still conflicts.
    const ext = join(dir, "ext", "sub");
    await stageSubDirectoryExtension(ext, "@test/wf-root-vs-repo", {
      skill: false,
      workflow: false,
    });
    await Deno.mkdir(join(ext, "extensions", "workflows"), { recursive: true });
    await Deno.writeTextFile(
      join(ext, "extensions", "workflows", "shared.yaml"),
      "name: shared-at-root\njobs: {}",
    );
    await Deno.mkdir(join(dir, "extensions", "workflows"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "extensions", "workflows", "shared.yaml"),
      "name: shared-at-repo\njobs: {}",
    );
    const manifestPath = join(ext, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/wf-root-vs-repo",
        version: "2026.10.06.1",
        paths: { base: "manifest" },
        models: ["extensions/models/hello.ts"],
        workflows: ["shared.yaml"],
      }),
    );
    const err = await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: dir,
          manifestPath,
          repoContext: stubWorkflowRepoContext,
          logger,
        }),
      UserError,
    );
    assertStringIncludes(
      err.message,
      "Workflow file shared.yaml exists under two roots",
    );
  });
});
