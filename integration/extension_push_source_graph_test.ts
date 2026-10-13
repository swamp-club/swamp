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
 * The archive's source copy holds every local module the bundle was built
 * from (swamp-club#3376): push resolves files from each entry point's
 * module graph, places modules outside the kind directory where their
 * relative imports still resolve, and rewrites the imports of the archived
 * copies only when no mirrored path can hold a module. Wires the real
 * resolver, graph reader, planner and archive assembly; registry and
 * quality gates are stubbed.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import { requireInitializedRepoReadOnly } from "../src/cli/repo_context.ts";
import { UserError } from "../src/domain/errors.ts";
import { DenoInfoModuleGraphReader } from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";
import { extractTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
} from "../src/libswamp/extensions/push.ts";

const graphReader = new DenoInfoModuleGraphReader(Deno.execPath());
const logger = getLogger(["test"]);

const stubDeps: ExtensionPushPrepareDeps = {
  loadCredentials: () => Promise.resolve(null),
  fetchCollectives: () =>
    Promise.resolve({ collectives: ["test"], entitlements: undefined }),
  findPublishedVersion: () => Promise.resolve(null),
  extractContentMetadata: () =>
    Promise.resolve({
      models: [],
      extensions: [],
      workflows: [],
      vaults: [],
      datastores: [],
      reports: [],
      webhooks: [],
      skills: [],
    }),
  analyzeExtensionSafety: () => Promise.resolve({ errors: [], warnings: [] }),
  checkExtensionQuality: () => Promise.resolve({ passed: true, issues: [] }),
  extractDependencySpecifiers: () => Promise.resolve([]),
  checkDependencyTrust: () =>
    Promise.resolve({ errors: [], warnings: [], audited: [], passed: true }),
  checkReviewRules: () =>
    Promise.resolve({ errors: [], warnings: [], passed: true }),
  bundleEntryPoint: () => Promise.resolve("export {};\n"),
  ensureDenoPath: () => Promise.resolve("unused-deno"),
  getDenoEnv: () => ({}),
  getLatestVersionDetail: () => Promise.resolve(null),
};

async function initRepo(path: string): Promise<void> {
  const version = "20260101.120000.0";
  const events = await collect(
    repoInit(createLibSwampContext(), createRepoInitDeps(version), {
      path,
      force: false,
      version,
      tools: [],
    }),
  );
  assertEquals(events.some((event) => event.kind === "error"), false);
}

async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-source-graph-" }),
  );
  try {
    await initRepo(repo);
    await fn(repo);
  } finally {
    await Deno.remove(repo, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

/** Resolves and packages the extension as push does; returns the archive's files by path. */
async function pushDryRun(
  repo: string,
  manifestPath: string,
): Promise<Map<string, string>> {
  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir: repo,
    outputMode: "log",
  });
  const resolved = await resolveExtensionFiles({
    repoDir: repo,
    manifestPath,
    repoContext,
    logger,
    moduleGraphReader: graphReader,
  });
  const prepared = await extensionPushPrepare(
    createLibSwampContext(),
    stubDeps,
    {
      manifest: resolved.manifest,
      repoDir: repo,
      manifestDir: dirname(manifestPath),
      modelsDir: resolved.modelsDir,
      allModelFiles: resolved.allModelFiles,
      modelEntryPoints: resolved.modelEntryPoints,
      vaultsDir: resolved.vaultsDir,
      allVaultFiles: resolved.allVaultFiles,
      vaultEntryPoints: resolved.vaultEntryPoints,
      datastoresDir: resolved.datastoresDir,
      allDatastoreFiles: resolved.allDatastoreFiles,
      datastoreEntryPoints: resolved.datastoreEntryPoints,
      reportsDir: resolved.reportsDir,
      allReportFiles: resolved.allReportFiles,
      reportEntryPoints: resolved.reportEntryPoints,
      webhooksDir: resolved.webhooksDir,
      allWebhookFiles: resolved.allWebhookFiles,
      webhookEntryPoints: resolved.webhookEntryPoints,
      workflowFiles: resolved.workflowFiles,
      skillDirs: resolved.skillDirs,
      allSkillFiles: resolved.allSkillFiles,
      includeFilePaths: resolved.includeFilePaths,
      additionalFilePaths: resolved.additionalFilePaths,
      binaryFilePaths: resolved.binaryFilePaths,
      dataFilesByKind: resolved.dataFilesByKind,
      sourcePlan: resolved.sourcePlan,
      dryRun: true,
      registryChecks: "skip",
    },
  );
  const out = await Deno.makeTempDir({ prefix: "swamp-source-graph-out-" });
  try {
    await extractTarGz(
      ReadableStream.from([prepared.archiveBytes]),
      out,
    );
    const files = new Map<string, string>();
    const walk = async (dir: string, prefix: string) => {
      for await (const entry of Deno.readDir(dir)) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory) await walk(join(dir, entry.name), rel);
        else files.set(rel, await Deno.readTextFile(join(dir, entry.name)));
      }
    };
    await walk(join(out, "extension"), "");
    return files;
  } finally {
    await Deno.remove(out, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

const sources = (files: Map<string, string>) =>
  [...files.keys()].filter((p) =>
    p !== "manifest.yaml" && !p.includes("bundles/")
  ).sort();

Deno.test("extension push: the source copy holds modules imported from outside the models directory (swamp-club#3376)", async () => {
  await withRepo(async (repo) => {
    const models = join(repo, "extensions", "models");
    await write(
      join(repo, "extensions", "lib", "cmp.ts"),
      "export const c = 1;\n",
    );
    await write(join(repo, "extensions", "lib", "side.ts"), "export {};\n");
    await write(join(repo, "shared", "util.ts"), "export const u = 1;\n");
    await write(join(models, "_lib", "types.ts"), "export type T = number;\n");
    await write(join(models, "data", "d.json"), "{}\n");
    await write(join(models, "lazy.ts"), "export const l = 1;\n");
    await write(
      join(models, "rel.ts"),
      'import "../lib/side.ts";\n' +
        'import { c } from "../lib/cmp.ts";\n' +
        'import { u } from "../../shared/util.ts";\n' +
        'import type { T } from "./_lib/types.ts";\n' +
        'import d from "./data/d.json" with { type: "json" };\n' +
        "const t: T = c + u;\n" +
        'export const m = { t, d, l: () => import("./lazy.ts") };\n',
    );
    await write(
      join(repo, "extensions", "vaults", "v.ts"),
      'import { c } from "../lib/cmp.ts";\nexport const v = c;\n',
    );
    const manifestPath = join(repo, "manifest.yaml");
    await write(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/source-graph",
        version: "2026.10.13.1",
        models: ["rel.ts"],
        vaults: ["v.ts"],
      }),
    );

    const files = await pushDryRun(repo, manifestPath);

    assertEquals(sources(files), [
      "_shared/shared/util.ts",
      "lib/cmp.ts",
      "lib/side.ts",
      "models/_lib/types.ts",
      "models/data/d.json",
      "models/lazy.ts",
      "models/rel.ts",
      "vaults/v.ts",
    ]);
    // Only the import no mirrored path can hold is rewritten.
    assertEquals(
      files.get("models/rel.ts"),
      'import "../lib/side.ts";\n' +
        'import { c } from "../lib/cmp.ts";\n' +
        'import { u } from "../_shared/shared/util.ts";\n' +
        'import type { T } from "./_lib/types.ts";\n' +
        'import d from "./data/d.json" with { type: "json" };\n' +
        "const t: T = c + u;\n" +
        'export const m = { t, d, l: () => import("./lazy.ts") };\n',
    );
    assertEquals(
      files.get("vaults/v.ts"),
      'import { c } from "../lib/cmp.ts";\nexport const v = c;\n',
    );
  });
});

Deno.test("extension push: a paths.base manifest model in a sub-directory keeps ../_lib resolving (swamp-club#3376)", async () => {
  await withRepo(async (repo) => {
    const models = join(repo, "extensions", "models");
    await write(join(models, "_lib", "schemas.ts"), "export const s = 1;\n");
    await write(
      join(models, "keygen", "keygen.ts"),
      'import { s } from "../_lib/schemas.ts";\nexport const k = s;\n',
    );
    const manifestPath = join(models, "keygen", "manifest.yaml");
    await write(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/keygen",
        version: "2026.10.13.1",
        paths: { base: "manifest" },
        models: ["keygen.ts"],
      }),
    );

    const files = await pushDryRun(repo, manifestPath);

    assertEquals(sources(files), ["_lib/schemas.ts", "models/keygen.ts"]);
    assertEquals(
      files.get("models/keygen.ts"),
      'import { s } from "../_lib/schemas.ts";\nexport const k = s;\n',
    );
  });
});

Deno.test("extension push: a missing local module fails resolution, naming it and its importer", async () => {
  await withRepo(async (repo) => {
    const model = join(repo, "extensions", "models", "m.ts");
    await write(model, 'import "../lib/gone.ts";\nexport const m = 1;\n');
    const manifestPath = join(repo, "manifest.yaml");
    await write(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/missing",
        version: "2026.10.13.1",
        models: ["m.ts"],
      }),
    );
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: repo,
      outputMode: "log",
    });
    const error = await assertRejects(
      () =>
        resolveExtensionFiles({
          repoDir: repo,
          manifestPath,
          repoContext,
          logger,
          moduleGraphReader: graphReader,
        }),
      UserError,
    );
    assertStringIncludes(
      error.message,
      join(repo, "extensions", "lib", "gone.ts"),
    );
    assertStringIncludes(error.message, `imported from ${model}`);
  });
});

Deno.test({
  name:
    "extension push: a module whose real path leaves the repository is refused",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repo) => {
      const outside = await Deno.realPath(
        await Deno.makeTempDir({ prefix: "swamp-source-graph-outside-" }),
      );
      try {
        await write(join(outside, "x.ts"), "export const x = 1;\n");
        const models = join(repo, "extensions", "models");
        await Deno.mkdir(models, { recursive: true });
        await Deno.symlink(join(outside, "x.ts"), join(models, "x.ts"), {
          type: "file",
        });
        await write(
          join(models, "m.ts"),
          'import { x } from "./x.ts";\nexport const m = x;\n',
        );
        const manifestPath = join(repo, "manifest.yaml");
        await write(
          manifestPath,
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/escape",
            version: "2026.10.13.1",
            models: ["m.ts"],
          }),
        );
        const { repoContext } = await requireInitializedRepoReadOnly({
          repoDir: repo,
          outputMode: "log",
        });
        await assertRejects(
          () =>
            resolveExtensionFiles({
              repoDir: repo,
              manifestPath,
              repoContext,
              logger,
              moduleGraphReader: graphReader,
            }),
          UserError,
          "outside the repository",
        );
      } finally {
        await Deno.remove(outside, { recursive: true });
      }
    });
  },
});

Deno.test("extension push: a rewritten source listed in include keeps its rewritten imports, after non-ASCII text", async () => {
  await withRepo(async (repo) => {
    await write(join(repo, "shared", "util.ts"), "export const u = 1;\n");
    await write(
      join(repo, "extensions", "models", "m.ts"),
      'const label = "é😀"; import { u } from "../../shared/util.ts";\n' +
        "export const m = { label, u };\n",
    );
    const manifestPath = join(repo, "manifest.yaml");
    await write(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/include-rewrite",
        version: "2026.10.13.1",
        models: ["m.ts"],
        include: ["m.ts"],
      }),
    );

    const files = await pushDryRun(repo, manifestPath);

    assertEquals(
      files.get("models/m.ts"),
      'const label = "é😀"; import { u } from "../_shared/shared/util.ts";\n' +
        "export const m = { label, u };\n",
    );
  });
});

Deno.test("extension fmt: lenient resolution tolerates a missing local module and plans no archive", async () => {
  await withRepo(async (repo) => {
    const model = join(repo, "extensions", "models", "m.ts");
    await write(join(repo, "extensions", "lib", "here.ts"), "export {};\n");
    await write(
      model,
      'import "../lib/here.ts";\nimport "../lib/gone.ts";\nexport const m = 1;\n',
    );
    const manifestPath = join(repo, "manifest.yaml");
    await write(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/lenient",
        version: "2026.10.13.1",
        models: ["m.ts"],
      }),
    );
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: repo,
      outputMode: "log",
    });
    const resolved = await resolveExtensionFiles({
      repoDir: repo,
      manifestPath,
      repoContext,
      logger,
      moduleGraphReader: graphReader,
      lenientSources: true,
    });
    assertEquals(resolved.allModelFiles, [
      join(repo, "extensions", "lib", "here.ts"),
      model,
    ]);
    assertEquals(resolved.sourcePlan.entries, []);
  });
});
