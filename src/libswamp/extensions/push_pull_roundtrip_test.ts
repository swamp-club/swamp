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
    paths: { base: "typedDir" },
    workflows: [],
    models: ["echo.ts"],
    vaults: [],
    drivers: [],
    datastores: [],
    reports: [],
    skills: [],
    include: [],
    additionalFiles: [],
    binaries: [],
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
        serverUrl: "https://test.swamp-club.com",
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
    extractDependencySpecifiers: () => Promise.resolve([]),
    checkDependencyTrust: () =>
      Promise.resolve({ errors: [], warnings: [], audited: [], passed: true }),
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
        binaryFilePaths: [],
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

Deno.test(
  "round-trip: paths.base=manifest aligns archive layout, manifest entries, and scorer entrypoint discovery",
  async () => {
    const { parse: parseYaml } = await import("@std/yaml");
    const { collectEntrypoints, findManifestRoot } = await import(
      "../../domain/extensions/extension_rubric_scorer.ts"
    );
    const src = await Deno.makeTempDir({ prefix: "rt-pb-src-" });
    const dst = await Deno.makeTempDir({ prefix: "rt-pb-dst-" });
    try {
      // Per-extension-subdir layout: manifest sits beside its source.
      // No `extensions/models/` indirection — the model file is right
      // next to manifest.yaml. paths.base=manifest is what makes this
      // shape work end-to-end.
      const extDir = join(src, "extensions", "models", "scorer-aligned");
      await Deno.mkdir(extDir, { recursive: true });
      await Deno.writeTextFile(
        join(extDir, "echo.ts"),
        'export const model = { type: "@t/aligned", version: "1.0.0" };',
      );
      await Deno.writeTextFile(join(extDir, "README.md"), "# README");

      const manifest = makeManifest({
        paths: { base: "manifest" },
        models: ["echo.ts"],
        additionalFiles: ["README.md"],
      });

      const input: ExtensionPushPrepareInput = {
        manifest,
        repoDir: src,
        // Resolver under paths.base=manifest sets these to the manifest dir;
        // the test fixture mirrors that contract directly.
        modelsDir: extDir,
        allModelFiles: [join(extDir, "echo.ts")],
        modelEntryPoints: [join(extDir, "echo.ts")],
        vaultsDir: extDir,
        allVaultFiles: [],
        vaultEntryPoints: [],
        driversDir: extDir,
        allDriverFiles: [],
        driverEntryPoints: [],
        datastoresDir: extDir,
        allDatastoreFiles: [],
        datastoreEntryPoints: [],
        reportsDir: extDir,
        allReportFiles: [],
        reportEntryPoints: [],
        workflowFiles: [],
        skillDirs: [],
        allSkillFiles: [],
        includeFilePaths: [],
        additionalFilePaths: [join(extDir, "README.md")],
        binaryFilePaths: [],
        dryRun: true,
      };

      const ctx = createLibSwampContext();
      const prepared = await extensionPushPrepare(
        ctx,
        makePrepareDeps(),
        input,
      );

      await untarArchiveTo(prepared.archiveBytes, dst);

      // 1) Archive sub-paths mirror the manifest entries verbatim:
      // bare basenames in `models:` resolve to bare basenames under
      // `extension/models/`, not nested any deeper.
      const extRoot = await findManifestRoot(dst);
      await Deno.stat(join(extRoot, "models", "echo.ts"));
      await Deno.stat(join(extRoot, "files", "README.md"));

      // 2) On-wire manifest preserves WYSIWYG: paths.base round-trips,
      // path string arrays are byte-equivalent to the source manifest.
      const onWire = parseYaml(
        await Deno.readTextFile(join(extRoot, "manifest.yaml")),
      ) as Record<string, unknown>;
      assertEquals(onWire.paths, { base: "manifest" });
      assertEquals(onWire.models, ["echo.ts"]);
      assertEquals(onWire.additionalFiles, ["README.md"]);

      // 3) Scorer's collectEntrypoints finds every typed-key entry at
      // the path it expects. This is the hard contract that broke
      // under the v1 dual-base proposal — locking it here prevents
      // any future divergence between manifest entries and archive
      // sub-paths.
      const entrypoints = collectEntrypoints(extRoot, extRoot, manifest);
      assertEquals(entrypoints, [join(extRoot, "models", "echo.ts")]);
      // Every entrypoint actually exists in the extracted archive.
      for (const ep of entrypoints) {
        await Deno.stat(ep);
      }
    } finally {
      await Deno.remove(src, { recursive: true });
      await Deno.remove(dst, { recursive: true });
    }
  },
);

Deno.test(
  "round-trip: paths.base=manifest bundles skills from manifest-relative dir",
  async () => {
    const src = await Deno.makeTempDir({ prefix: "rt-skill-src-" });
    const dst = await Deno.makeTempDir({ prefix: "rt-skill-dst-" });
    try {
      // Per-extension-subdir layout with a skill next to the manifest.
      const extDir = join(src, "sub");
      await Deno.mkdir(extDir, { recursive: true });
      await Deno.writeTextFile(
        join(extDir, "echo.ts"),
        'export const model = { type: "@t/skill-rt", version: "1.0.0" };',
      );

      // Skill lives at sub/.claude/skills/my-skill/
      const skillDir = join(extDir, ".claude", "skills", "my-skill");
      await Deno.mkdir(skillDir, { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, "SKILL.md"),
        "---\nname: my-skill\ndescription: test skill\n---\n\nSkill body.\n",
      );
      const refDir = join(skillDir, "references");
      await Deno.mkdir(refDir, { recursive: true });
      await Deno.writeTextFile(join(refDir, "detail.md"), "# Detail");

      const manifest = makeManifest({
        paths: { base: "manifest" },
        models: ["echo.ts"],
        skills: ["my-skill"],
      });

      const input: ExtensionPushPrepareInput = {
        manifest,
        repoDir: src,
        modelsDir: extDir,
        allModelFiles: [join(extDir, "echo.ts")],
        modelEntryPoints: [join(extDir, "echo.ts")],
        vaultsDir: extDir,
        allVaultFiles: [],
        vaultEntryPoints: [],
        driversDir: extDir,
        allDriverFiles: [],
        driverEntryPoints: [],
        datastoresDir: extDir,
        allDatastoreFiles: [],
        datastoreEntryPoints: [],
        reportsDir: extDir,
        allReportFiles: [],
        reportEntryPoints: [],
        workflowFiles: [],
        skillDirs: [{ name: "my-skill", absolutePath: skillDir }],
        allSkillFiles: [
          join(skillDir, "SKILL.md"),
          join(refDir, "detail.md"),
        ],
        includeFilePaths: [],
        additionalFilePaths: [],
        binaryFilePaths: [],
        dryRun: true,
      };

      const ctx = createLibSwampContext();
      const prepared = await extensionPushPrepare(
        ctx,
        makePrepareDeps(),
        input,
      );

      await untarArchiveTo(prepared.archiveBytes, dst);

      // Skill files land under extension/skills/<name>/ with structure preserved.
      const archiveSkillDir = join(dst, "extension", "skills", "my-skill");
      await Deno.stat(join(archiveSkillDir, "SKILL.md"));
      await Deno.stat(join(archiveSkillDir, "references", "detail.md"));

      const skillContent = await Deno.readTextFile(
        join(archiveSkillDir, "SKILL.md"),
      );
      assertEquals(skillContent.includes("name: my-skill"), true);

      const refContent = await Deno.readTextFile(
        join(archiveSkillDir, "references", "detail.md"),
      );
      assertEquals(refContent, "# Detail");
    } finally {
      await Deno.remove(src, { recursive: true }).catch(() => {});
      await Deno.remove(dst, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "round-trip: binaries field survives push → extract in archive manifest",
  async () => {
    const { parse: parseYaml } = await import("@std/yaml");
    const src = await Deno.makeTempDir({ prefix: "rt-bin-src-" });
    const dst = await Deno.makeTempDir({ prefix: "rt-bin-dst-" });
    try {
      const modelsDir = join(src, "extensions", "models");
      await Deno.mkdir(modelsDir, { recursive: true });
      await Deno.writeTextFile(
        join(modelsDir, "echo.ts"),
        'export const model = { type: "@t/e", version: "1.0.0" };',
      );
      await Deno.mkdir(join(src, "bin"), { recursive: true });
      await Deno.writeTextFile(join(src, "bin", "helper"), "#!/bin/sh\nexit 0");

      const manifest = makeManifest({
        binaries: ["bin/helper"],
        additionalFiles: [],
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
        additionalFilePaths: [],
        binaryFilePaths: [join(src, "bin", "helper")],
        dryRun: true,
      };

      const ctx = createLibSwampContext();
      const prepared = await extensionPushPrepare(
        ctx,
        makePrepareDeps(),
        input,
      );

      await untarArchiveTo(prepared.archiveBytes, dst);

      const onWire = parseYaml(
        await Deno.readTextFile(join(dst, "extension", "manifest.yaml")),
      ) as Record<string, unknown>;
      assertEquals(onWire.binaries, ["bin/helper"]);

      await Deno.stat(join(dst, "extension", "files", "bin", "helper"));
    } finally {
      await Deno.remove(src, { recursive: true });
      await Deno.remove(dst, { recursive: true });
    }
  },
);
