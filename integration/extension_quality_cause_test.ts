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
 * `swamp extension quality` names the real cause (swamp-club#3718): a
 * bundle failure prints its compilation errors, an unaudited dependency's
 * row and header follow the finding's fix, and a deno doc failure is named
 * on the documentation rows instead of asking for JSDoc. Each scenario runs
 * the quality generator in-process over a real extension on disk and
 * renders its events through the real renderer in log and JSON. Only the
 * registry lookups and the rubric's deno invocations are stubbed.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join, toFileUrl } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { stripAnsiCode } from "@std/fmt/colors";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import { requireInitializedRepoReadOnly } from "../src/cli/repo_context.ts";
import { DenoInfoModuleGraphReader } from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";
import { extractTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { parseExtensionManifest } from "../src/domain/extensions/extension_manifest.ts";
import { ExtensionPackageCache } from "../src/domain/extensions/extension_package_cache.ts";
import {
  checkDependencyTrust,
  type Fetcher,
} from "../src/domain/extensions/extension_dependency_trust_checker.ts";
import {
  extractDependencySpecifiers,
} from "../src/domain/extensions/extension_dependency_extractor.ts";
import type { RubricScoreDeps } from "../src/domain/extensions/extension_rubric_scorer.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import type {
  ExtensionPushPrepareDeps,
  ExtensionPushPrepareInput,
} from "../src/libswamp/extensions/push.ts";
import {
  extensionQuality,
  type ExtensionQualityEvent,
} from "../src/libswamp/extensions/quality.ts";
import { buildPrepareInput } from "../src/libswamp/extensions/push_test_helpers.ts";
import { emptyArchiveIndex } from "../src/libswamp/extensions/extension_tree_index_test_helpers.ts";
import { createExtensionQualityRenderer } from "../src/presentation/renderers/extension_quality.ts";
import { SHARED_SWAMP_DENO_CACHE } from "./test_helpers.ts";

await initializeLogging({});

const ctx = createLibSwampContext();
const DENO = Deno.execPath();
const logger = getLogger(["test"]);

const UNPUBLISHED_ERROR =
  "npm publishes no version matching npm:ms@99.0.0, so deno doc could " +
  "not resolve the extension's npm imports.";

function prepareDeps(
  overrides: Partial<ExtensionPushPrepareDeps> = {},
): ExtensionPushPrepareDeps {
  return {
    loadCredentials: () => Promise.resolve(null),
    fetchCollectives: () =>
      Promise.resolve({ collectives: ["acme"], entitlements: undefined }),
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
    bundleEntryPoint: () => Promise.resolve("export const model = {};\n"),
    ensureDenoPath: () => Promise.resolve(DENO),
    getDenoEnv: () => ({}),
    getLatestVersionDetail: () => Promise.resolve(null),
    ...overrides,
  };
}

/**
 * The real archive extraction; `deno doc --json` answers with `docStderr`
 * when given, failing as deno does, and with an empty doc otherwise.
 */
function scoreDeps(
  docStderr?: (entrypointUrl: string) => string,
): RubricScoreDeps {
  return {
    extractTarball: extractTarGz,
    runDeno: (args) => {
      if (args[0] === "doc" && args.includes("--json") && docStderr) {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: docStderr(toFileUrl(args[args.length - 1]).href),
        });
      }
      return Promise.resolve({
        success: true,
        stdout: args[0] === "doc" && args.includes("--json")
          ? JSON.stringify({ version: 1, nodes: {} })
          : "",
        stderr: "",
      });
    },
  };
}

async function runQuality(
  root: string,
  prepareInput: ExtensionPushPrepareInput,
  pushPrepareDeps: ExtensionPushPrepareDeps,
  makeScoreDeps: () => RubricScoreDeps = () => scoreDeps(),
): Promise<ExtensionQualityEvent[]> {
  return await collect(extensionQuality(ctx, {
    pushPrepareDeps,
    cache: new ExtensionPackageCache(
      join(root, ".swamp", "cache"),
      "cause-test",
    ),
    ensureDenoPath: () => Promise.resolve(DENO),
    makeScoreDeps,
    privateSourceLookup: {
      loadCredentials: () => Promise.resolve(null),
      whoami: () => Promise.reject(new Error("not called")),
      getExtensionVisibility: () => Promise.reject(new Error("not called")),
    },
  }, {
    prepareInput,
    hashInput: {
      manifest: prepareInput.manifest,
      rootDir: root,
      manifestDir: prepareInput.manifestDir,
      modelFilePaths: prepareInput.allModelFiles,
      vaultFilePaths: [],
      datastoreFilePaths: [],
      reportFilePaths: [],
      webhookFilePaths: [],
      workflowFilePaths: [],
      additionalFilePaths: prepareInput.additionalFilePaths,
      binaryFilePaths: [],
      skillFilePaths: [],
      includeFilePaths: [],
      denoConfigPath: undefined,
      packageJsonPath: undefined,
      bareImports: [],
    },
  }));
}

/**
 * Feeds the events to the real renderer, as the CLI does, and returns what
 * it printed and whether it failed the run.
 */
function render(
  mode: "log" | "json",
  events: ExtensionQualityEvent[],
  manifestDir: string,
): { output: string; failed: boolean } {
  const lines: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const push = (...args: unknown[]) => {
    lines.push(stripAnsiCode(args.map((a) => String(a)).join(" ")));
  };
  console.log = push;
  console.info = push;
  console.warn = push;
  console.error = push;
  let failed = false;
  try {
    const handlers = createExtensionQualityRenderer(mode).handlers({
      manifestDir,
      cwd: manifestDir,
    });
    for (const event of events) {
      // deno-lint-ignore no-explicit-any
      (handlers[event.kind] as (e: any) => void)(event);
    }
  } catch {
    failed = true;
  } finally {
    Object.assign(console, original);
  }
  return { output: lines.join("\n"), failed };
}

/** The JSON documents the JSON renderer printed, in order. */
function jsonDocs(output: string): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < output.length; i++) {
    if (output[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (output[i] === "}") {
      depth--;
      if (depth === 0) docs.push(JSON.parse(output.slice(start, i + 1)));
    }
  }
  return docs;
}

function factor(
  doc: Record<string, unknown>,
  id: string,
): { earnedPoints: number; status: string; remediation?: string } {
  const factors = doc.factors as {
    id: string;
    earnedPoints: number;
    status: string;
    remediation?: string;
  }[];
  return factors.find((f) => f.id === id)!;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "quality-cause-" }),
  );
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

const MANIFEST = {
  manifestVersion: 1,
  name: "@acme/cause",
  version: "2026.10.21.1",
  description: "quality names the cause",
  models: ["model.ts"],
};

/** An extension laid out as CI publishes it, its inputs built directly. */
async function writeExtension(
  root: string,
  model: string,
): Promise<ExtensionPushPrepareInput> {
  const manifestText = stringifyYaml(MANIFEST);
  await write(join(root, "manifest.yaml"), manifestText);
  const modelPath = join(root, "models", "model.ts");
  await write(modelPath, model);
  return buildPrepareInput(parseExtensionManifest(manifestText), root, {
    allModelFiles: [modelPath],
    modelEntryPoints: [modelPath],
    dryRun: true,
    registryChecks: "skip",
  });
}

Deno.test("extension quality: a missing local module prints its compilation error in log and JSON, as push does (swamp-club#3718)", async () => {
  await withTempDir(async (repo) => {
    const version = "20260101.120000.0";
    const init = await collect(
      repoInit(createLibSwampContext(), createRepoInitDeps(version), {
        path: repo,
        force: false,
        version,
        tools: [],
      }),
    );
    assertEquals(init.some((event) => event.kind === "error"), false);
    const model = join(repo, "extensions", "models", "model.ts");
    await write(
      model,
      'import { helper } from "../lib/gone.ts";\nexport const model = { helper };\n',
    );
    const manifestPath = join(repo, "manifest.yaml");
    await write(manifestPath, stringifyYaml(MANIFEST));
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: repo,
      outputMode: "log",
    });
    const resolved = await resolveExtensionFiles({
      repoDir: repo,
      manifestPath,
      repoContext,
      logger,
      moduleGraphReader: new DenoInfoModuleGraphReader(DENO),
    });
    const prepareInput = buildPrepareInput(resolved.manifest, repo, {
      allModelFiles: resolved.allModelFiles,
      modelEntryPoints: resolved.modelEntryPoints,
      modelsDir: resolved.modelsDir,
      sourcePlan: resolved.sourcePlan,
      missingModules: resolved.missingModules,
      dryRun: true,
      registryChecks: "skip",
    });

    const events = await runQuality(repo, prepareInput, prepareDeps());
    const last = events[events.length - 1];
    assert(last.kind === "error");

    const log = render("log", events, repo);
    assert(log.failed);
    assertStringIncludes(log.output, "Bundle compilation failed:");
    // LogTape quotes the path, escaping a Windows separator.
    assertStringIncludes(
      log.output,
      JSON.stringify(join("extensions", "models", "model.ts")),
    );
    assertStringIncludes(log.output, "gone.ts");

    const json = render("json", events, repo);
    assert(json.failed);
    const [doc] = jsonDocs(json.output);
    const errors = doc.compilationErrors as { file: string; error: string }[];
    assertEquals(errors.length, 1);
    assertEquals(errors[0].file, model);
    assertStringIncludes(errors[0].error, "gone.ts");
  });
});

/** npm knows ms, but not at 99.0.0; OSV and downloads answer. */
const unpublishedVersionFetcher: Fetcher = (url: string | URL) => {
  const href = url.toString();
  const body = href.includes("api.osv.dev")
    ? { vulns: [] }
    : href.includes("api.npmjs.org/downloads")
    ? { downloads: 50_000 }
    : {
      "dist-tags": { latest: "2.1.3" },
      versions: { "2.1.3": { license: "MIT", maintainers: [{ name: "a" }] } },
      time: { "2.1.3": new Date().toISOString() },
    };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
};

/**
 * deno 2.9's stderr when one npm import names a version npm does not
 * publish beside another that resolves: it names the wrong import.
 */
function unpublishedVersionDocStderr(url: string): string {
  return [
    "Warning Failed resolving types. Could not find constraint 'zod@4' in the list of packages.",
    `    at ${url}:1:19`,
    "Warning Failed resolving types. Could not find constraint 'ms@99.0.0' in the list of packages.",
    `    at ${url}:2:34`,
    `error: Failed resolving 'npm:zod@4' from '${url}'.`,
  ].join("\n");
}

Deno.test("extension quality: a version npm does not publish is named on the row, the header and the doc failure, never as an outage (swamp-club#3718)", async () => {
  await withTempDir(async (root) => {
    const prepareInput = await writeExtension(
      root,
      [
        'import { z } from "npm:zod@4";',
        'import type { StringValue } from "npm:ms@99.0.0";',
        "/** The model. */",
        "export const model = { s: z.string() };",
        "/** A duration. */",
        "export const d: StringValue | undefined = undefined;",
        "",
      ].join("\n"),
    );
    const events = await runQuality(
      root,
      prepareInput,
      prepareDeps({
        extractDependencySpecifiers: (files) =>
          extractDependencySpecifiers(files),
        checkDependencyTrust: (specs) =>
          checkDependencyTrust(
            specs.filter((s) => s.name === "ms"),
            unpublishedVersionFetcher,
          ),
      }),
      () => scoreDeps(unpublishedVersionDocStderr),
    );

    const log = render("log", events, root);
    assertStringIncludes(
      log.output,
      "1 dependency(ies) not audited because no published version matches " +
        "the specifier. Change the specifier to a version the registry " +
        "publishes.",
    );
    assertStringIncludes(log.output, "Dependencies not audited:");
    assertEquals(log.output.includes("OSV, npm and JSR are reachable"), false);
    assertStringIncludes(log.output, UNPUBLISHED_ERROR);

    const [doc] = jsonDocs(render("json", events, root).output);
    assertEquals(doc.docAnalysisError, UNPUBLISHED_ERROR);
    const trust = doc.dependencyTrust as {
      warnings: { cause?: string; notAuditedFix?: string }[];
      audited: { notAuditedFix?: string }[];
    };
    assertEquals(
      trust.warnings.filter((w) => w.cause === "not-audited")
        .map((w) => w.notAuditedFix),
      ["specifier"],
    );
    assertEquals(trust.audited[0].notAuditedFix, "specifier");
    assertEquals(
      factor(doc, "symbols-docs").remediation,
      "deno doc could not analyse the source, so JSDoc coverage could not " +
        `be measured: ${UNPUBLISHED_ERROR}`,
    );
  });
});

Deno.test("extension quality: a deno doc failure is named on symbols-docs and has-readme, with points unchanged (swamp-club#3718)", async () => {
  await withTempDir(async (root) => {
    const prepareInput = await writeExtension(
      root,
      '/** The model. */\nimport { z } from "zod";\nexport const model = { s: z.string() };\n',
    );
    const bareZod = (url: string) =>
      [
        'Warning Import "zod" not a dependency',
        "  hint: If you want to use the npm package, try running `deno add npm:zod`",
        `    at ${url}:2:19`,
        `error: Failed resolving 'zod' from '${url}'.`,
      ].join("\n");
    const events = await runQuality(
      root,
      prepareInput,
      prepareDeps(),
      () => scoreDeps(bareZod),
    );
    const error =
      'The registry cannot resolve the bare import "zod"; use an explicit ' +
      "npm: or jsr: specifier (npm:zod@4 for zod).";

    const [doc] = jsonDocs(render("json", events, root).output);
    assertEquals(doc.docAnalysisError, error);
    const symbols = factor(doc, "symbols-docs");
    assertEquals(symbols.earnedPoints, 0);
    assertEquals(symbols.status, "missing");
    assertEquals(
      symbols.remediation,
      "deno doc could not analyse the source, so JSDoc coverage could not " +
        `be measured: ${error}`,
    );
    const readme = factor(doc, "has-readme");
    assertEquals(readme.earnedPoints, 0);
    assertStringIncludes(
      readme.remediation ?? "",
      "A module-level JSDoc counts only once deno doc can analyse the " +
        `source: ${error}`,
    );

    const log = render("log", events, root);
    assert(log.failed);
    assertEquals(log.output.includes("Add JSDoc to"), false);
    assertEquals(log.output.includes("current: 0%"), false);
  });
});

Deno.test("extension quality: a file: package.json dependency loses the dependency-trust factor and is named, in log and JSON (swamp-club#4018)", async () => {
  await withTempDir(async (repo) => {
    const version = "20260101.120000.0";
    const init = await collect(
      repoInit(createLibSwampContext(), createRepoInitDeps(version), {
        path: repo,
        force: false,
        version,
        tools: [],
      }),
    );
    assertEquals(init.some((event) => event.kind === "error"), false);
    await write(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { shared: "file:./shared" } }) + "\n",
    );
    // node_modules as npm install leaves a file: dependency, copied in
    const installed = join(repo, "node_modules", "shared");
    await write(
      join(installed, "package.json"),
      JSON.stringify({
        name: "shared",
        version: "1.0.0",
        main: "index.js",
        type: "module",
      }) + "\n",
    );
    await write(join(installed, "index.js"), "export const shared = 1;\n");
    await write(
      join(repo, "extensions", "models", "model.ts"),
      'import { shared } from "shared";\nexport const model = { shared };\n',
    );
    const manifestPath = join(repo, "manifest.yaml");
    await write(manifestPath, stringifyYaml(MANIFEST));
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: repo,
      outputMode: "log",
    });
    const resolved = await resolveExtensionFiles({
      repoDir: repo,
      manifestPath,
      repoContext,
      logger,
      moduleGraphReader: new DenoInfoModuleGraphReader(DENO, {
        DENO_DIR: SHARED_SWAMP_DENO_CACHE,
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:1/",
      }, { readOnlyLock: true }),
    });
    assertEquals(
      resolved.graphDependencies.unaudited?.map((u) => [u.kind, u.origin]),
      [["package-json", "file:./shared"]],
    );
    const prepareInput = buildPrepareInput(resolved.manifest, repo, {
      allModelFiles: resolved.allModelFiles,
      modelEntryPoints: resolved.modelEntryPoints,
      modelsDir: resolved.modelsDir,
      sourcePlan: resolved.sourcePlan,
      graphDependencies: resolved.graphDependencies,
      bareImports: resolved.bareImports,
      packageJsonDir: resolved.packageJsonDir,
      dryRun: true,
      registryChecks: "skip",
    });

    const events = await runQuality(repo, prepareInput, prepareDeps());

    const log = render("log", events, repo);
    assertStringIncludes(log.output, "file:./shared");
    assertStringIncludes(log.output, "the code comes from outside npm and JSR");

    const [doc] = jsonDocs(render("json", events, repo).output);
    const trust = doc.dependencyTrust as {
      passed: boolean;
      warnings: {
        dependency: string;
        cause?: string;
        notAuditedFix?: string;
      }[];
    };
    assertEquals(trust.passed, true);
    assertEquals(
      trust.warnings.map((w) => [w.dependency, w.cause, w.notAuditedFix]),
      [["file:./shared", "not-audited", "origin"]],
    );
    const row = factor(doc, "dependency-trust");
    assertEquals([row.earnedPoints, row.status], [0, "missing"]);
  });
});
