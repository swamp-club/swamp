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

// Integration coverage for issue-146: archives built by extensionPushPrepare
// preserve the manifest's additionalFiles directory structure, and the
// ctx.extensionFile() helper resolves correctly against the extracted layout.
// Hermetic — no registry calls, no auth, no mocked tar magic beyond what the
// real prepare pipeline writes.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createLibSwampContext } from "../context.ts";
import {
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
} from "./push.ts";
import type { ExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { resolveExtensionFile } from "../../domain/extensions/extension_file_resolver.ts";

function makeManifest(
  overrides?: Partial<ExtensionManifest>,
): ExtensionManifest {
  return {
    manifestVersion: 1,
    name: "@testuser/roundtrip",
    version: "2026.04.22.1",
    description: "Round-trip fixture",
    repository: undefined,
    workflows: [],
    models: ["echo.ts"],
    vaults: [],
    drivers: [],
    datastores: [],
    reports: [],
    skills: [],
    include: [],
    additionalFiles: [],
    platforms: [],
    labels: [],
    releaseNotes: undefined,
    dependencies: [],
    ...overrides,
  };
}

function makePrepareDeps(
  overrides?: Partial<ExtensionPushPrepareDeps>,
): ExtensionPushPrepareDeps {
  return {
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.swamp.club",
        apiKey: "swamp_test",
        username: "testuser",
      }),
    fetchCollectives: () => Promise.resolve(["testuser"]),
    extractContentMetadata: () =>
      Promise.resolve({
        models: [],
        workflows: [],
        vaults: [],
        drivers: [],
        datastores: [],
        reports: [],
        skills: [],
      }),
    analyzeExtensionSafety: () => Promise.resolve({ errors: [], warnings: [] }),
    checkExtensionQuality: () => Promise.resolve({ passed: true, issues: [] }),
    bundleEntryPoint: () => Promise.resolve("/* bundled */"),
    ensureDenoPath: () => Promise.resolve("/usr/bin/deno"),
    getLatestVersion: () => Promise.resolve(null),
    ...overrides,
  };
}

async function untarArchiveTo(
  archive: Uint8Array,
  destDir: string,
): Promise<void> {
  const tarPath = join(destDir, "archive.tar.gz");
  await Deno.writeFile(tarPath, archive);
  const cmd = new Deno.Command("tar", {
    args: ["-xzf", tarPath, "-C", destDir],
  });
  const out = await cmd.output();
  if (!out.success) {
    throw new Error(
      `tar -xzf failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  await Deno.remove(tarPath);
}

Deno.test(
  "round-trip: nested additionalFiles survive push → extract with paths preserved",
  async () => {
    const src = await Deno.makeTempDir({ prefix: "rt-src-" });
    const dst = await Deno.makeTempDir({ prefix: "rt-dst-" });
    try {
      // Stage a fixture extension with nested additionalFiles.
      const modelsDir = join(src, "extensions", "models");
      await Deno.mkdir(modelsDir, { recursive: true });
      await Deno.writeTextFile(
        join(modelsDir, "echo.ts"),
        'export const model = { type: "@t/e", version: "1.0.0" };',
      );
      await Deno.mkdir(join(src, "prompts", "nested"), { recursive: true });
      await Deno.writeTextFile(
        join(src, "prompts", "review.md"),
        "# PROMPT prompt",
      );
      await Deno.writeTextFile(
        join(src, "prompts", "nested", "deep.md"),
        "# DEEP deep",
      );
      await Deno.mkdir(join(src, "templates"), { recursive: true });
      await Deno.writeTextFile(
        join(src, "templates", "review.md"),
        "# TEMPLATE template",
      );
      await Deno.writeTextFile(join(src, "README.md"), "# README");

      const manifest = makeManifest({
        additionalFiles: [
          "prompts/review.md",
          "prompts/nested/deep.md",
          "templates/review.md",
          "README.md",
        ],
      });
      const input: ExtensionPushPrepareInput = {
        manifest,
        repoDir: src,
        modelsDir,
        allModelFiles: [join(modelsDir, "echo.ts")],
        modelEntryPoints: [join(modelsDir, "echo.ts")],
        vaultsDir: join(src, "vaults"),
        allVaultFiles: [],
        vaultEntryPoints: [],
        driversDir: join(src, "drivers"),
        allDriverFiles: [],
        driverEntryPoints: [],
        datastoresDir: join(src, "datastores"),
        allDatastoreFiles: [],
        datastoreEntryPoints: [],
        reportsDir: join(src, "reports"),
        allReportFiles: [],
        reportEntryPoints: [],
        workflowFiles: [],
        skillDirs: [],
        allSkillFiles: [],
        includeFilePaths: [],
        additionalFilePaths: [
          join(src, "prompts", "review.md"),
          join(src, "prompts", "nested", "deep.md"),
          join(src, "templates", "review.md"),
          join(src, "README.md"),
        ],
        dryRun: true,
      };

      const ctx = createLibSwampContext();
      const prepared = await extensionPushPrepare(
        ctx,
        makePrepareDeps(),
        input,
      );

      await untarArchiveTo(prepared.archiveBytes, dst);

      // Verify layout under extension/files/ mirrors the manifest.
      const extFilesDir = join(dst, "extension", "files");
      const stat = async (p: string) => await Deno.stat(p);
      await stat(join(extFilesDir, "prompts", "review.md"));
      await stat(join(extFilesDir, "prompts", "nested", "deep.md"));
      await stat(join(extFilesDir, "templates", "review.md"));
      await stat(join(extFilesDir, "README.md"));

      // Content check: no basename collision clobbered content.
      const promptContent = await Deno.readTextFile(
        join(extFilesDir, "prompts", "review.md"),
      );
      const templateContent = await Deno.readTextFile(
        join(extFilesDir, "templates", "review.md"),
      );
      assertEquals(promptContent.split("\n")[0], "# PROMPT prompt");
      assertEquals(templateContent.split("\n")[0], "# TEMPLATE template");

      // resolveExtensionFile against the extracted layout (simulating what
      // a pulled extension would see at .swamp/pulled-extensions/<name>/files).
      const resolved = resolveExtensionFile(
        extFilesDir,
        "prompts/nested/deep.md",
      );
      assertEquals(
        resolved,
        join(extFilesDir, "prompts", "nested", "deep.md"),
      );
    } finally {
      await Deno.remove(src, { recursive: true });
      await Deno.remove(dst, { recursive: true });
    }
  },
);
