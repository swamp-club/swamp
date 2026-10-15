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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import { requireInitializedRepoReadOnly } from "../src/cli/repo_context.ts";
import { DenoInfoModuleGraphReader } from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";
import { extractTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
} from "../src/libswamp/extensions/push.ts";
import { analyzeExtensionSafety } from "../src/domain/extensions/extension_safety_analyzer.ts";
import { extractContentMetadata } from "../src/domain/extensions/extension_content_extractor.ts";
import { bundleExtension } from "../src/domain/models/bundle.ts";
import { emptyArchiveIndex } from "../src/libswamp/extensions/extension_tree_index_test_helpers.ts";

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
  indexArchive: emptyArchiveIndex,
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

/** Resolves the extension as push does and runs the prepare phase. */
async function prepare(
  repo: string,
  manifestPath: string,
  deps: ExtensionPushPrepareDeps,
  localGates: "enforce" | "collect" = "enforce",
) {
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
  return await extensionPushPrepare(
    createLibSwampContext(),
    deps,
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
      missingModules: resolved.missingModules,
      entryPointsReachingSymlinks: resolved.entryPointsReachingSymlinks,
      symlinkedPaths: resolved.symlinkedPaths,
      dryRun: true,
      registryChecks: "skip",
      localGates,
    },
  );
}

/** Resolves and packages the extension as push does; returns the archive's files by path. */
async function pushDryRun(
  repo: string,
  manifestPath: string,
  deps: ExtensionPushPrepareDeps = stubDeps,
): Promise<Map<string, string>> {
  const prepared = await prepare(repo, manifestPath, deps);
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

Deno.test("extension push: a missing local module is a compilation error naming it and its importer, as the bundler reported it", async () => {
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
    let failure: unknown;
    try {
      await pushDryRun(repo, manifestPath);
    } catch (error) {
      failure = error;
    }
    const swampError = failure as {
      code: string;
      details: { compilationErrors: Array<{ file: string; error: string }> };
    };
    assertEquals(swampError.code, "validation_failed");
    assertEquals(swampError.details.compilationErrors.length, 1);
    assertEquals(swampError.details.compilationErrors[0].file, model);
    assertStringIncludes(
      swampError.details.compilationErrors[0].error,
      "gone.ts",
    );
    assertStringIncludes(
      swampError.details.compilationErrors[0].error,
      "Module not found",
    );
  });
});

Deno.test({
  name:
    "extension push: a module behind a symlinked directory leaving the repository is refused by the symlink rule (swamp-club#3421)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repo) => {
      await withOutside(async (outside) => {
        await write(join(outside, "x.ts"), `export const x = "${SECRET}";\n`);
        const models = join(repo, "extensions", "models");
        await Deno.mkdir(models, { recursive: true });
        const linkDir = join(models, "lib");
        await Deno.symlink(outside, linkDir, { type: "dir" });
        await write(
          join(models, "m.ts"),
          'import { x } from "./lib/x.ts";\nexport const m = x;\n',
        );

        const errors = await symlinkRefusal(
          repo,
          await writeManifest(repo, "escape"),
        );

        assertEquals(errors.map((e) => [e.file, e.ruleId, e.message]), [
          [
            join(linkDir, "x.ts"),
            "symlink",
            `Symlinks are not allowed in extensions: ${linkDir} is a symlink. Copy the file into the extension tree instead.`,
          ],
        ]);
      });
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

Deno.test("extension push: a shared module two kinds reach is listed with one of them, so each gate sees it once", async () => {
  await withRepo(async (repo) => {
    const lib = join(repo, "extensions", "lib", "cmp.ts");
    await write(lib, "export const c = 1;\n");
    await write(
      join(repo, "extensions", "models", "m.ts"),
      'import { c } from "../lib/cmp.ts";\nexport const m = c;\n',
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
        name: "@test/shared-once",
        version: "2026.10.13.1",
        models: ["m.ts"],
        vaults: ["v.ts"],
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
    });
    assertEquals(resolved.allModelFiles.includes(lib), true);
    assertEquals(resolved.allVaultFiles.includes(lib), false);
    assertEquals(
      resolved.sourcePlan.entries.filter((e) => e.sourcePath === lib)
        .map((e) => e.archivePath),
      ["lib/cmp.ts"],
    );
  });
});

// --- Symlinks in the module graph (swamp-club#3420) ---

const SECRET = "SECRET-3420";

/**
 * Pushes with the real safety analyzer and returns the refusal, after
 * checking that nothing in it — message or details — quotes the target.
 */
async function symlinkRefusal(
  repo: string,
  manifestPath: string,
): Promise<{ file: string; ruleId: string; message: string }[]> {
  let failure: unknown;
  try {
    await pushDryRun(repo, manifestPath, {
      ...stubDeps,
      analyzeExtensionSafety,
      extractContentMetadata,
    });
  } catch (error) {
    failure = error;
  }
  const refusal = failure as {
    code: string;
    message: string;
    details: {
      safetyErrors?: { file: string; ruleId: string; message: string }[];
    };
  };
  assertEquals(refusal?.code, "validation_failed", String(failure));
  assertEquals(
    `${refusal.message}${JSON.stringify(refusal.details)}`.includes(SECRET),
    false,
  );
  return refusal.details.safetyErrors ?? [];
}

async function withOutside(
  fn: (outside: string) => Promise<void>,
): Promise<void> {
  const outside = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-3420-outside-" }),
  );
  try {
    await fn(outside);
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
}

async function writeManifest(repo: string, name: string): Promise<string> {
  const manifestPath = join(repo, "manifest.yaml");
  await write(
    manifestPath,
    stringifyYaml({
      manifestVersion: 1,
      name: `@test/${name}`,
      version: "2026.10.13.1",
      models: ["m.ts"],
    }),
  );
  return manifestPath;
}

Deno.test({
  name:
    "extension push: a model symlinked to a file that does not parse is refused by the symlink rule, quoting none of it (swamp-club#3420)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repo) => {
      await withOutside(async (outside) => {
        await write(
          join(outside, "passwd"),
          `${SECRET}:x:0:0::/root:/bin/sh\n`,
        );
        const model = join(repo, "extensions", "models", "m.ts");
        await Deno.mkdir(dirname(model), { recursive: true });
        await Deno.symlink(join(outside, "passwd"), model, { type: "file" });

        const errors = await symlinkRefusal(
          repo,
          await writeManifest(repo, "linked-model"),
        );

        assertEquals(errors.map((e) => [e.file, e.ruleId]), [
          [model, "symlink"],
        ]);
      });
    });
  },
});

Deno.test({
  name:
    "extension push: a symlinked shared module outside the models directory is refused by the symlink rule, quoting none of it (swamp-club#3420)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repo) => {
      await withOutside(async (outside) => {
        await write(join(outside, "shared"), `${SECRET} is not code\n`);
        const shared = join(repo, "extensions", "lib", "shared.ts");
        await Deno.mkdir(dirname(shared), { recursive: true });
        await Deno.symlink(join(outside, "shared"), shared, { type: "file" });
        await write(
          join(repo, "extensions", "models", "m.ts"),
          'import "../lib/shared.ts";\nexport const m = 1;\n',
        );

        const errors = await symlinkRefusal(
          repo,
          await writeManifest(repo, "linked-shared"),
        );

        assertEquals(errors.map((e) => [e.file, e.ruleId]), [
          [shared, "symlink"],
        ]);
      });
    });
  },
});

Deno.test({
  name:
    "extension push: a model symlinked to a valid module outside the repository is refused by the symlink rule, not packaged (swamp-club#3420)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repo) => {
      await withOutside(async (outside) => {
        // A type in another collective would fail the content-collective
        // check, which runs before safety, quoting it.
        await write(
          join(outside, "real.ts"),
          `export const model = { type: "@other/${SECRET}", version: "2026.10.13.1" };\n`,
        );
        const model = join(repo, "extensions", "models", "m.ts");
        await Deno.mkdir(dirname(model), { recursive: true });
        await Deno.symlink(join(outside, "real.ts"), model, { type: "file" });

        const errors = await symlinkRefusal(
          repo,
          await writeManifest(repo, "linked-valid"),
        );

        assertEquals(errors.map((e) => [e.file, e.ruleId]), [
          [model, "symlink"],
        ]);
      });
    });
  },
});

Deno.test({
  name:
    "extension quality: a model importing a rejected symlink is never bundled, so the bundler quotes none of the target (swamp-club#3420)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repo) => {
      await withOutside(async (outside) => {
        await write(
          join(outside, "passwd"),
          `${SECRET}:x:0:0::/root:/bin/sh\n`,
        );
        const link = join(repo, "extensions", "models", "lib", "link.ts");
        await Deno.mkdir(dirname(link), { recursive: true });
        await Deno.symlink(join(outside, "passwd"), link, { type: "file" });
        await write(
          join(repo, "extensions", "models", "m.ts"),
          'import "./lib/link.ts";\nexport const m = 1;\n',
        );

        let outcome: unknown;
        try {
          outcome = await prepare(
            repo,
            await writeManifest(repo, "linked-collect"),
            {
              ...stubDeps,
              analyzeExtensionSafety,
              extractContentMetadata,
              bundleEntryPoint: bundleExtension,
              ensureDenoPath: () => Promise.resolve(Deno.execPath()),
            },
            "collect",
          );
        } catch (error) {
          outcome = error;
        }

        const { archiveBytes: _bytes, ...shown } = (outcome ?? {}) as Record<
          string,
          unknown
        >;
        assertEquals(JSON.stringify(shown).includes(SECRET), false);
        const failures = (shown.gateFailures ?? []) as { gate: string }[];
        assertEquals(failures.map((f) => f.gate).includes("safety"), true);
      });
    });
  },
});

Deno.test({
  name:
    "extension push: a module that does not load behind a symlinked directory is refused by the symlink rule, quoting none of it (swamp-club#3420, swamp-club#3421)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repo) => {
      await withOutside(async (outside) => {
        await write(join(outside, "x.ts"), `${SECRET}:x:0:0::/root:/bin/sh\n`);
        const models = join(repo, "extensions", "models");
        await Deno.mkdir(models, { recursive: true });
        const linkDir = join(models, "d");
        await Deno.symlink(outside, linkDir, { type: "dir" });
        await write(
          join(models, "m.ts"),
          'import "./d/x.ts";\nexport const m = 1;\n',
        );

        const errors = await symlinkRefusal(
          repo,
          await writeManifest(repo, "linked-dir"),
        );

        assertEquals(errors.map((e) => [e.file, e.ruleId]), [
          [join(linkDir, "x.ts"), "symlink"],
        ]);
      });
    });
  },
});

Deno.test({
  name:
    "extension push: a missing import in a repository reached through a symlinked parent is still a compilation error, not a containment refusal (swamp-club#3420)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repo) => {
      await withOutside(async (aliases) => {
        // The repository as a user reaches it through a symlinked parent,
        // as macOS reaches /private/tmp through /tmp.
        const alias = join(aliases, "repo");
        await Deno.symlink(repo, alias, { type: "dir" });
        await write(
          join(alias, "extensions", "models", "m.ts"),
          'import "./typo.ts";\nexport const m = 1;\n',
        );
        const manifestPath = join(alias, "manifest.yaml");
        await write(
          manifestPath,
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/aliased",
            version: "2026.10.13.1",
            models: ["m.ts"],
          }),
        );
        const { repoContext } = await requireInitializedRepoReadOnly({
          repoDir: repo,
          outputMode: "log",
        });

        const resolved = await resolveExtensionFiles({
          repoDir: alias,
          manifestPath,
          repoContext,
          logger,
          moduleGraphReader: graphReader,
        });

        assertEquals(
          resolved.missingModules.map((m) => m.path),
          [join(alias, "extensions", "models", "typo.ts")],
        );
      });
    });
  },
});

// --- Symlinks anywhere on an extension file's path (swamp-club#3421) ---

Deno.test({
  name:
    "extension push: a model directory symlinked inside the repository is refused, and nothing is packaged through it (swamp-club#3421)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repo) => {
      await write(
        join(repo, "real", "foo", "m.ts"),
        `export const m = "${SECRET}";\n`,
      );
      const models = join(repo, "extensions", "models");
      await Deno.mkdir(models, { recursive: true });
      const linkDir = join(models, "foo");
      await Deno.symlink(join(repo, "real", "foo"), linkDir, { type: "dir" });
      const manifestPath = join(repo, "manifest.yaml");
      await write(
        manifestPath,
        stringifyYaml({
          manifestVersion: 1,
          name: "@test/linked-dir",
          version: "2026.10.15.1",
          models: ["foo/m.ts"],
        }),
      );

      const errors = await symlinkRefusal(repo, manifestPath);

      assertEquals(errors.map((e) => [e.file, e.ruleId]), [
        [join(linkDir, "m.ts"), "symlink"],
      ]);
    });
  },
});

Deno.test({
  name:
    "extension push: include and additional files through a symlinked directory are refused, quoting none of the target (swamp-club#3421)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repo) => {
      await withOutside(async (outside) => {
        await write(join(outside, "notes.md"), `${SECRET}\n`);
        await write(
          join(repo, "extensions", "models", "m.ts"),
          "export const m = 1;\n",
        );
        const includeLink = join(repo, "extensions", "models", "data");
        const filesLink = join(repo, "linked");
        await Deno.symlink(outside, includeLink, { type: "dir" });
        await Deno.symlink(outside, filesLink, { type: "dir" });
        const manifestPath = join(repo, "manifest.yaml");
        await write(
          manifestPath,
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/linked-files",
            version: "2026.10.15.1",
            models: ["m.ts"],
            include: ["data/notes.md"],
            additionalFiles: ["linked/notes.md"],
          }),
        );

        const errors = await symlinkRefusal(repo, manifestPath);

        assertEquals(
          errors.map((e) => [e.file, e.ruleId]).sort(),
          [
            [join(filesLink, "notes.md"), "symlink"],
            [join(includeLink, "notes.md"), "symlink"],
          ].sort(),
        );
      });
    });
  },
});

Deno.test({
  name:
    "extension quality: collect mode leaves a symlinked file out and archives regular files only (swamp-club#3421)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repo) => {
      await withOutside(async (outside) => {
        await write(join(outside, "notes.md"), `${SECRET}\n`);
        await write(
          join(repo, "extensions", "models", "m.ts"),
          "export const m = 1;\n",
        );
        await write(join(repo, "README.md"), "# readme\n");
        await Deno.symlink(outside, join(repo, "linked"), { type: "dir" });
        const manifestPath = join(repo, "manifest.yaml");
        await write(
          manifestPath,
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/collect-linked",
            version: "2026.10.15.1",
            models: ["m.ts"],
            additionalFiles: ["README.md", "linked/notes.md"],
          }),
        );

        const prepared = await prepare(
          repo,
          manifestPath,
          { ...stubDeps, analyzeExtensionSafety, extractContentMetadata },
          "collect",
        );

        assertEquals(
          prepared.gateFailures.map((f) => f.gate).includes("safety"),
          true,
        );
        assertEquals(
          JSON.stringify(prepared.gateFailures).includes(SECRET),
          false,
        );
        const out = await Deno.makeTempDir({ prefix: "swamp-3421-out-" });
        try {
          await extractTarGz(ReadableStream.from([prepared.archiveBytes]), out);
          const kinds: string[] = [];
          const walk = async (dir: string) => {
            for await (const entry of Deno.readDir(dir)) {
              if (entry.isSymlink) kinds.push(`link:${entry.name}`);
              else if (entry.isDirectory) await walk(join(dir, entry.name));
              else {
                const text = await Deno.readTextFile(join(dir, entry.name));
                assertEquals(text.includes(SECRET), false);
              }
            }
          };
          await walk(out);
          assertEquals(kinds, []);
        } finally {
          await Deno.remove(out, { recursive: true });
        }
      });
    });
  },
});
