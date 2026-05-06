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
import {
  isPulledExtensionManifest,
  resolveExtensionFiles,
} from "./resolve_extension_files.ts";
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
