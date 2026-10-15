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
 * Pull installs the shared sources push places at the archive root
 * (swamp-club#3384), so a pulled extension's source resolves and rebundles
 * as it did in the author's repository. Wires the real push resolver,
 * module graph reader, planner and archive assembly to the real install,
 * bundler and removal; only the registry download is mocked.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join, relative } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import { requireInitializedRepoReadOnly } from "../src/cli/repo_context.ts";
import { DenoInfoModuleGraphReader } from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
} from "../src/libswamp/extensions/push.ts";
import { installExtension } from "../src/libswamp/extensions/pull.ts";
import { RemoveExtensionService } from "../src/libswamp/extensions/remove_extension_service.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { bundleExtension } from "../src/domain/models/bundle.ts";
import { emptyArchiveIndex } from "../src/libswamp/extensions/extension_tree_index_test_helpers.ts";

const NAME = "@test/pull-shared";
const VERSION = "2026.10.14.1";

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

async function withRepos(
  fn: (author: string, consumer: string) => Promise<void>,
): Promise<void> {
  const author = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-pull-shared-author-" }),
  );
  const consumer = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-pull-shared-consumer-" }),
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

/** Packages the author's extension as push does and returns the archive. */
async function pushArchive(author: string): Promise<Uint8Array> {
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
    stubDeps,
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
      dryRun: true,
      registryChecks: "skip",
    },
  );
  return prepared.archiveBytes;
}

/** Installs `archive` into `consumer` as pull does, with the download mocked. */
async function pull(
  consumer: string,
  lockfile: LockfileRepository,
  archive: Uint8Array,
  force = false,
): Promise<void> {
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
    force,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("extension pull: installs archive-root shared sources so the pulled source rebundles (swamp-club#3384)", async () => {
  await withRepos(async (author, consumer) => {
    const models = join(author, "extensions", "models");
    await write(
      join(author, "extensions", "lib", "cmp.ts"),
      "export const cmp = 41;\n",
    );
    await write(
      join(author, "shared", "util.ts"),
      "export const one = 1;\n",
    );
    await write(
      join(models, "rel.ts"),
      'import { cmp } from "../lib/cmp.ts";\n' +
        'import { one } from "../../shared/util.ts";\n' +
        "export const answer: number = cmp + one;\n",
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
    const archive = await pushArchive(author);

    const lockfile = await LockfileRepository.create(
      join(consumer, "upstream_extensions.json"),
    );
    await pull(consumer, lockfile, archive);

    const root = join(consumer, ".swamp", "pulled-extensions", NAME);
    const installed = ["lib/cmp.ts", "_shared/shared/util.ts"].map((rel) =>
      join(root, ...rel.split("/"))
    );
    const files = lockfile.getEntry(NAME)!.files!;
    for (const path of installed) {
      assertEquals(await exists(path), true, path);
      assertEquals(files.includes(relative(consumer, path)), true, path);
    }

    // The installed source resolves and rebundles on its own.
    const entry = join(root, "models", "rel.ts");
    const bundle = await bundleExtension(entry, Deno.execPath());
    assertStringIncludes(bundle, "41");
    const check = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--no-lock", "--no-config", entry],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      check.success,
      true,
      new TextDecoder().decode(check.stderr),
    );

    // Pulling the same version again replaces it cleanly.
    await pull(consumer, lockfile, archive, true);
    assertEquals(lockfile.getEntry(NAME)!.files!.sort(), [...files].sort());

    // rm removes the shared sources with everything else.
    const catalog = new ExtensionCatalogStore(
      join(consumer, ".swamp", "_extension_catalog_rm.db"),
    );
    try {
      await new RemoveExtensionService({
        repository: new ExtensionRepository({
          catalog,
          lockfileRepository: lockfile,
          repoRoot: consumer,
        }),
        lockfileRepository: lockfile,
        repoDir: consumer,
      }).execute(NAME);
    } finally {
      catalog.close();
    }
    for (const path of installed) {
      assertEquals(await exists(path), false, path);
    }
    assertEquals(await exists(join(root, "lib")), false);
    assertEquals(await exists(join(root, "_shared")), false);
  });
});

Deno.test("extension push: refuses a shared source pull would refuse to install (swamp-club#3384)", async () => {
  await withRepos(async (author) => {
    await write(join(author, "extensions", "deno.json"), "{}\n");
    await write(
      join(author, "extensions", "models", "rel.ts"),
      'import config from "../deno.json" with { type: "json" };\n' +
        "export const c = config;\n",
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
    // Push fails with a SwampError document, as its other packing checks do.
    const error = await pushArchive(author).then(
      () => undefined,
      (e: unknown) => e as { code?: string; message?: string },
    );
    assertEquals(error?.code, "validation_failed");
    assertStringIncludes(
      error?.message ?? "",
      "Extension pull would refuse this archive: extension/deno.json is deno.json",
    );
  });
});
