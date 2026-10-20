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
 * Push rewrites each bare import the deno.json import map resolves to its
 * npm:, jsr: or node: target in the archive's source (swamp-club#3637), so
 * the shipped source resolves without the author's config: the registry's
 * scan reads the specifiers, and a pulled extension rebundles in a
 * repository with no deno.json. Wires the real push resolver, module graph
 * reader, planner, dependency extractor and archive assembly to the real
 * install and bundler; only the registry download is mocked.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
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
import { installExtension } from "../src/libswamp/extensions/pull.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import {
  type DependencySpecifier,
  extractDependencySpecifiers,
} from "../src/domain/extensions/extension_dependency_extractor.ts";
import {
  bundleExtension,
  installZodGlobal,
  rewriteZodImports,
  uint8ArrayToBase64,
} from "../src/domain/models/bundle.ts";
import { emptyArchiveIndex } from "../src/libswamp/extensions/extension_tree_index_test_helpers.ts";

const NAME = "@test/bare-rewrite";
const VERSION = "2026.10.20.1";

const graphReader = new DenoInfoModuleGraphReader(Deno.execPath());
const logger = getLogger(["test"]);

function stubDeps(audited: DependencySpecifier[]): ExtensionPushPrepareDeps {
  return {
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
    extractDependencySpecifiers,
    checkDependencyTrust: (specifiers) => {
      audited.push(...specifiers);
      return Promise.resolve({
        errors: [],
        warnings: [],
        audited: [],
        passed: true,
      });
    },
    checkReviewRules: () =>
      Promise.resolve({ errors: [], warnings: [], passed: true }),
    indexArchive: emptyArchiveIndex,
    bundleEntryPoint: () => Promise.resolve("export {};\n"),
    ensureDenoPath: () => Promise.resolve("unused-deno"),
    getDenoEnv: () => ({}),
    getLatestVersionDetail: () => Promise.resolve(null),
  };
}

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

async function withRepos(
  fn: (author: string, consumer: string) => Promise<void>,
): Promise<void> {
  const author = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-bare-rewrite-author-" }),
  );
  const consumer = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-bare-rewrite-consumer-" }),
  );
  try {
    await initRepo(author);
    await initRepo(consumer);
    await fn(author, consumer);
  } finally {
    for (const dir of [author, consumer]) {
      await Deno.remove(dir, { recursive: true }).catch((error) => {
        if (Deno.build.os !== "windows") throw error;
      });
    }
  }
}

/** Packages the author's extension as push does. */
async function pushArchive(
  author: string,
  audited: DependencySpecifier[],
): Promise<{ archive: Uint8Array; bareWarnings: number }> {
  const manifestPath = join(author, "manifest.yaml");
  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir: author,
    outputMode: "log",
  });
  const resolved = await resolveExtensionFiles({
    repoDir: author,
    manifestPath,
    repoContext,
    logger,
    moduleGraphReader: graphReader,
  });
  const prepared = await extensionPushPrepare(
    createLibSwampContext(),
    stubDeps(audited),
    {
      manifest: resolved.manifest,
      repoDir: author,
      manifestDir: author,
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
      denoConfigPath: resolved.denoConfigPath,
      dryRun: true,
      registryChecks: "skip",
    },
  );
  return {
    archive: prepared.archiveBytes,
    bareWarnings:
      prepared.reviewRulesResult.warnings.filter((w) =>
        w.ruleId === "bare-specifiers"
      ).length,
  };
}

/** The archive's files under `extension/`, by forward-slash path. */
async function archiveFiles(archive: Uint8Array): Promise<Map<string, string>> {
  const out = await Deno.makeTempDir({ prefix: "swamp-bare-rewrite-out-" });
  try {
    await extractTarGz(ReadableStream.from([archive]), out);
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

Deno.test("extension push: ships each bare import as its import-map target, and the pulled source rebundles without deno.json (swamp-club#3637)", async () => {
  await withRepos(async (author, consumer) => {
    await write(
      join(author, "deno.json"),
      JSON.stringify({
        imports: {
          "zod": "npm:zod@^4.1.0",
          "ms": "npm:ms@2.1.3",
          "@std/path": "jsr:@std/path@^1",
          "std-path/": "jsr:/@std/path@^1/",
          "@/": "./extensions/lib/",
        },
      }),
    );
    await write(
      join(author, "extensions", "lib", "two.ts"),
      "export const two = 2;\n",
    );
    await write(
      join(author, "extensions", "models", "_lib", "schema.ts"),
      'import { z } from "zod";\n' +
        "export const schema = z.object({ took: z.string() });\n",
    );
    await write(
      join(author, "extensions", "models", "rel.ts"),
      'import ms from "ms";\n' +
        'import { basename } from "@std/path";\n' +
        'import { join } from "std-path/posix";\n' +
        'import { two } from "@/two.ts";\n' +
        'import { schema } from "./_lib/schema.ts";\n' +
        "export const out = {\n" +
        "  took: ms(two * 1000),\n" +
        '  file: basename(join("a", "b.ts")),\n' +
        "  schema,\n" +
        "};\n",
    );
    await write(
      join(author, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: 1,
        name: NAME,
        version: VERSION,
        models: ["rel.ts"],
      }),
    );

    const audited: DependencySpecifier[] = [];
    const { archive, bareWarnings } = await pushArchive(author, audited);
    assertEquals(bareWarnings, 0);

    const files = await archiveFiles(archive);
    const rel = files.get("models/rel.ts") ?? "";
    assertStringIncludes(rel, 'import ms from "npm:ms@2.1.3";');
    assertStringIncludes(rel, 'import { basename } from "jsr:@std/path@^1";');
    assertStringIncludes(rel, 'import { join } from "jsr:@std/path@^1/posix";');
    assertStringIncludes(rel, 'import { two } from "../lib/two.ts";');
    assertStringIncludes(
      files.get("models/_lib/schema.ts") ?? "",
      'import { z } from "npm:zod@^4.1.0";',
    );
    assert(
      ![...files.keys()].some((p) =>
        p.endsWith("deno.json") || p.endsWith("deno.lock")
      ),
      "no project config ships",
    );

    // Every dependency the archive now names was audited by push.
    assertEquals(
      audited.map((s) => `${s.registry}:${s.name}@${s.version}`).sort(),
      ["jsr:@std/path@^1", "npm:ms@2.1.3"],
    );

    // Pulled into a repository with no deno.json, the source rebundles and
    // shares the host's zod.
    const lockfile = await LockfileRepository.create(
      join(consumer, "upstream_extensions.json"),
    );
    await installExtension({ name: NAME, version: null }, {
      getExtension: (name) =>
        Promise.resolve({ name, description: "", latestVersion: VERSION }),
      downloadArchive: () => Promise.resolve(archive),
      getChecksum: () => Promise.resolve(null),
      lockfileRepository: lockfile,
      skillsDirs: [],
      repoDir: consumer,
      alreadyPulled: new Set(),
      depth: 0,
      force: false,
    });
    const entry = join(
      consumer,
      ".swamp",
      "pulled-extensions",
      NAME,
      "models",
      "rel.ts",
    );
    const js = await bundleExtension(entry, Deno.execPath());
    installZodGlobal();
    const encoded = uint8ArrayToBase64(
      new TextEncoder().encode(rewriteZodImports(js)),
    );
    const mod = await import(`data:application/javascript;base64,${encoded}`);
    const out = mod.out as { took: string; file: string; schema: unknown };
    assertEquals(out.took, "2s");
    assertEquals(out.file, "b.ts");
    assertEquals(out.schema instanceof z.ZodType, true);
  });
});
