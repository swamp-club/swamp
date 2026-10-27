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
 * Runs one dependency input vector (see dependency_input_vectors_test.ts)
 * in its own process, whose working directory is the vector's repository:
 * Deno discovers a config from the working directory, as it does when an
 * author runs `swamp extension push` in the repository, so the vector never
 * reads the swamp checkout's own deno.json. Wires push's pieces in-process
 * and writes what push, quality, fmt and the loader make of the vector, as
 * JSON, to the output path.
 *
 * Usage: deno run -A dependency_input_vectors_driver.ts <tree root>
 *   <repository> <manifest> <registry origin> <output path>
 */

import { dirname, join, relative, SEPARATOR } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { stripAnsiCode } from "@std/fmt/colors";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import { requireInitializedRepoReadOnly } from "../src/cli/repo_context.ts";
import { DenoInfoModuleGraphReader } from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";
import {
  readOnlyLockFor,
  readProjectLockfile,
} from "../src/infrastructure/runtime/deno_lockfile_reader.ts";
import { extractTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
} from "../src/libswamp/extensions/push.ts";
import { extractDependencySpecifiers } from "../src/domain/extensions/extension_dependency_extractor.ts";
import type { DependencySpecifier } from "@swamp-club/extension-scoring/dependency-audit";
import { checkDependencyTrust } from "../src/domain/extensions/extension_dependency_trust_checker.ts";
import { analyzeExtensionSafety } from "../src/domain/extensions/extension_safety_analyzer.ts";
import { checkExtensionQuality } from "../src/domain/extensions/extension_quality_checker.ts";
import { checkReviewRules } from "../src/domain/extensions/extension_review_rules.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import {
  bundleExtension,
  denoProjectArgs,
  isExpectedBundleFailure,
  zod4SpecifiersReachedFrom,
} from "../src/domain/models/bundle.ts";
import { emptyArchiveIndex } from "../src/libswamp/extensions/extension_tree_index_test_helpers.ts";
import { vectorFetcher } from "./dependency_input_vectors_registry.ts";
import { SHARED_SWAMP_DENO_CACHE } from "./test_helpers.ts";

const DENO = Deno.execPath();

const logger = getLogger(["test"]);

/** What the driver knows of the registries: its environment and fetcher. */
interface DriverRegistry {
  env: Record<string, string>;
  fetcher: ReturnType<typeof vectorFetcher>;
  generalize(text: string): string;
}

/** Everything a vector pins, with paths relative to the tree root. */
export type Outcome = Record<string, unknown>;

/** `text` with the tree root written `<root>` and separators as `/`. */
function relativize(text: string, root: string): string {
  return stripAnsiCode(text)
    .replaceAll(root, "<root>")
    .replaceAll(root.replaceAll(SEPARATOR, "/"), "<root>")
    .replaceAll("\\", "/");
}

function rel(root: string, path: string | undefined): string | null {
  if (path === undefined) return null;
  return relative(root, path).replaceAll(SEPARATOR, "/") || ".";
}

/** The archive's files under `extension/`, by forward-slash path. */
async function archiveFiles(archive: Uint8Array): Promise<Map<string, string>> {
  const out = await Deno.makeTempDir({ prefix: "swamp-input-vector-out-" });
  try {
    await extractTarGz(ReadableStream.from([archive]), out);
    const files = new Map<string, string>();
    const walk = async (dir: string, prefix: string) => {
      for await (const entry of Deno.readDir(dir)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory) await walk(join(dir, entry.name), path);
        else files.set(path, await Deno.readTextFile(join(dir, entry.name)));
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

/** An error's message; a libswamp error is a plain object with one. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" && error !== null && "message" in error &&
    typeof error.message === "string"
  ) {
    return "code" in error && typeof error.code === "string"
      ? `${error.code}: ${error.message}`
      : error.message;
  }
  return String(error);
}

/** push's prepare dependencies, real but for the registries and metadata. */
function prepareDeps(
  registry: DriverRegistry,
  env: Record<string, string>,
  lockProject: { denoConfigPath?: string; packageJsonDir?: string },
  audited: DependencySpecifier[],
): ExtensionPushPrepareDeps {
  return {
    loadCredentials: () => Promise.resolve(null),
    fetchCollectives: () =>
      Promise.resolve({ collectives: ["vectors"], entitlements: undefined }),
    findPublishedVersion: () => Promise.resolve(null),
    getLatestVersionDetail: () => Promise.resolve(null),
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
    analyzeExtensionSafety,
    checkExtensionQuality: (files, _denoPath, denoConfigPath) =>
      checkExtensionQuality(files, DENO, denoConfigPath, env),
    extractDependencySpecifiers,
    // As push wires it: the project's lock decides a range's version.
    checkDependencyTrust: async (specifiers) => {
      audited.push(...specifiers);
      return checkDependencyTrust(
        specifiers,
        registry.fetcher,
        undefined,
        undefined,
        await readProjectLockfile(lockProject),
      );
    },
    checkReviewRules,
    indexArchive: emptyArchiveIndex,
    bundleEntryPoint: bundleExtension,
    ensureDenoPath: () => Promise.resolve(DENO),
    getDenoEnv: () => env,
  };
}

/** Runs push, quality, fmt and the loader over the vector at `root`. */
export async function runVector(
  root: string,
  repoDir: string,
  manifestPath: string,
  registry: DriverRegistry,
): Promise<Outcome> {
  const env = registry.env;
  const manifestDir = dirname(manifestPath);
  const outcome: Outcome = {};

  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir,
    outputMode: "log",
  });
  let resolved;
  try {
    resolved = await resolveExtensionFiles({
      repoDir,
      manifestPath,
      repoContext,
      logger,
      moduleGraphReader: new DenoInfoModuleGraphReader(DENO, env, {
        readOnlyLock: true,
      }),
    });
  } catch (error) {
    outcome.resolveError = relativize(errorText(error), root);
    return outcome;
  }

  // The project config and lock, as the push, quality and fmt commands
  // read them.
  const { denoConfigPath } = resolved;
  const project = { denoConfigPath, packageJsonDir: resolved.packageJsonDir };
  const readOnlyLock = await readOnlyLockFor(project);
  outcome.project = {
    config: rel(root, denoConfigPath),
    packageDir: rel(root, resolved.packageJsonDir),
    lock: rel(root, readOnlyLock.lockPath),
    flags: denoProjectArgs({ ...project, readOnlyLock }).map((arg) =>
      relativize(arg, root)
    ),
  };
  outcome.bareImports = resolved.bareImports.map((b) => ({
    importer: rel(root, b.importer),
    specifier: b.specifier,
    target: b.target === undefined
      ? null
      : relativize(registry.generalize(b.target), root),
    ...(b.installedVersion ? { installedVersion: b.installedVersion } : {}),
  }));
  outcome.fmt = { config: rel(root, denoConfigPath) };

  const audited: DependencySpecifier[] = [];
  try {
    const prepared = await extensionPushPrepare(
      createLibSwampContext(),
      prepareDeps(registry, env, project, audited),
      {
        manifest: resolved.manifest,
        bareImports: resolved.bareImports,
        graphDependencies: resolved.graphDependencies,
        repoDir,
        manifestDir,
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
        denoConfigPath,
        packageJsonDir: resolved.packageJsonDir,
        dryRun: true,
        registryChecks: "skip",
        // As quality runs it: a failed gate is collected, not thrown, so
        // every gate's answer is pinned.
        localGates: "collect",
      },
    );
    const files = await archiveFiles(prepared.archiveBytes);
    // The shipped source as written; of each bundle, whose text names
    // machine paths, only whether it leaves zod to the host.
    const shipped: Record<string, string> = {};
    const bundles: Record<string, string> = {};
    for (const [path, text] of [...files].sort(([a], [b]) => a < b ? -1 : 1)) {
      if (path.startsWith("bundles/")) {
        bundles[path] = text.includes("__swamp_zod") ? "zod external" : "ok";
      } else if (/\.[cm]?[jt]sx?$/.test(path)) {
        shipped[path] = relativize(registry.generalize(text), root);
      }
    }
    outcome.archive = [...files.keys()].sort();
    outcome.shipped = shipped;
    outcome.bundles = bundles;
    const record = files.get("dependency-audit.json");
    outcome.record = record === undefined
      ? null
      : await withCheckedBundleHashes(
        JSON.parse(registry.generalize(record)),
        files,
      );
    outcome.audited = audited
      .map((s) => ({
        registry: s.registry,
        name: s.name,
        version: s.version,
        sourceFile: rel(root, s.sourceFile),
        ...(s.importedAs ? { importedAs: s.importedAs } : {}),
        ...(s.installedVersion ? { installedVersion: s.installedVersion } : {}),
      }))
      .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    const trust = prepared.dependencyTrustResult;
    // a URL import's origin carries the mock registry's port
    outcome.trust = {
      errors: trust.errors.map((e) =>
        registry.generalize(
          `${e.dependency}${e.cause ? ` [${e.cause}]` : ""}: ${e.message}`,
        )
      ),
      warnings: trust.warnings.map((w) =>
        registry.generalize(
          `${w.dependency}${w.cause ? ` [${w.cause}]` : ""}: ${w.message}`,
        )
      ),
    };
    outcome.reviewWarnings = prepared.reviewRulesResult.warnings.map((w) =>
      relativize(`${w.ruleId}: ${w.message}`, root)
    );
    outcome.gateFailures = prepared.gateFailures.map((f) =>
      relativize(registry.generalize(`${f.gate}: ${f.message}`), root)
    );
  } catch (error) {
    outcome.pushError = relativize(
      registry.generalize(errorText(error)),
      root,
    );
  }

  // The loader's view of each model entry point: the config it bundles
  // under, whether a failed bundle is expected, the zod it externalizes
  // and whether the bundle builds.
  const loader: Record<string, unknown> = {};
  for (const entry of resolved.modelEntryPoints) {
    const config = modelKindAdapter.resolveDenoConfig?.(entry, repoDir);
    let bundle: string;
    try {
      const js = await bundleExtension(entry, DENO, {
        denoConfigPath: config,
        env,
      });
      bundle = js.includes("__swamp_zod") ? "ok, zod external" : "ok";
    } catch (error) {
      bundle = relativize(registry.generalize(errorText(error)), root);
    }
    loader[rel(root, entry)!] = {
      config: rel(root, config),
      expectedBundleFailure: isExpectedBundleFailure(entry, repoDir),
      zod4: await zod4SpecifiersReachedFrom(entry),
      bundle,
    };
  }
  outcome.loader = loader;
  return outcome;
}

if (import.meta.main) {
  const [root, repoDir, manifestPath, origin, outPath] = Deno.args;
  const registry: DriverRegistry = {
    env: {
      NPM_CONFIG_REGISTRY: `${origin}/`,
      JSR_URL: `${origin}/`,
      DENO_DIR: SHARED_SWAMP_DENO_CACHE,
    },
    fetcher: vectorFetcher(),
    generalize: (text) => text.replaceAll(origin, "{{ORIGIN}}"),
  };
  const outcome = await runVector(root, repoDir, manifestPath, registry);
  await Deno.writeTextFile(outPath, JSON.stringify(outcome, null, 2) + "\n");
}

/**
 * The record with each bundle hash checked against the archive's bundle
 * and replaced by whether it matched: the bundle's bytes name machine paths,
 * so the hash itself differs from one machine to the next.
 */
async function withCheckedBundleHashes(
  record: {
    bundles?: Record<string, string>;
    unaudited?: { modules: Record<string, string> }[];
  },
  files: ReadonlyMap<string, string>,
): Promise<unknown> {
  // A fetched module's text names the local registry's port, so only the
  // shape of its hash is stable.
  const unaudited = record.unaudited?.map((u) => ({
    ...u,
    modules: Object.fromEntries(
      Object.entries(u.modules).map(([module, hash]) => [
        module,
        /^sha256:[0-9a-f]{64}$/.test(hash) ? "sha256 of the module" : hash,
      ]),
    ),
  }));
  if (unaudited) record = { ...record, unaudited };
  if (!record.bundles) return record;
  const bundles: Record<string, string> = {};
  for (const [path, hash] of Object.entries(record.bundles)) {
    const text = files.get(path);
    const digest = text === undefined ? undefined : new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
    const actual = digest &&
      `sha256:${
        Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
      }`;
    bundles[path] = actual === hash
      ? "sha256 of the bundle"
      : `mismatch: ${hash}`;
  }
  return { ...record, bundles };
}
