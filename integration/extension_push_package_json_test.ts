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
 * A package.json-mode extension (no Deno config, bare imports installed in
 * node_modules) is read, bundled, audited and packaged as push does
 * (swamp-club#3630): the module graph read and the bundle use
 * `--node-modules-dir=manual`, so the author's node_modules is left byte for
 * byte as installed; each bare import ships, and is audited, as the package
 * installed there, `npm:<name>@<installed version>`, with the range
 * package.json declares; and no bare-specifiers finding fires for them.
 * Wires the real resolver, module graph reader, bundler, dependency
 * extractor and archive assembly, offline: the packages are written by hand
 * in the npm and the deno install layouts, and the registry is unreachable.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join, relative } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import { requireInitializedRepoReadOnly } from "../src/cli/repo_context.ts";
import { DenoInfoModuleGraphReader } from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";
import { readOnlyLockFor } from "../src/infrastructure/runtime/deno_lockfile_reader.ts";
import { extractTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
} from "../src/libswamp/extensions/push.ts";
import {
  type DependencySpecifier,
  extractDependencySpecifiers,
} from "../src/domain/extensions/extension_dependency_extractor.ts";
import { checkDependencyTrust } from "../src/domain/extensions/extension_dependency_trust_checker.ts";
import { bundleExtension } from "../src/domain/models/bundle.ts";
import { emptyArchiveIndex } from "../src/libswamp/extensions/extension_tree_index_test_helpers.ts";
import { SHARED_SWAMP_DENO_CACHE } from "./test_helpers.ts";

const ENV = {
  DENO_DIR: SHARED_SWAMP_DENO_CACHE,
  NPM_CONFIG_REGISTRY: "http://127.0.0.1:1/",
};

const logger = getLogger(["test"]);

/** npm, its download counts and OSV, answering for ms 2.1.2 and 2.1.3. */
function fakeRegistries(url: string | URL): Promise<Response> {
  const host = new URL(String(url)).host;
  if (host === "registry.npmjs.org") {
    const manifest = { license: "MIT", maintainers: [{ name: "a" }] };
    const published = new Date().toISOString();
    return Promise.resolve(Response.json({
      "dist-tags": { latest: "2.1.3" },
      versions: { "2.1.2": manifest, "2.1.3": manifest },
      time: { "2.1.2": published, "2.1.3": published },
    }));
  }
  if (host === "api.npmjs.org") {
    return Promise.resolve(Response.json({ downloads: 1_000_000 }));
  }
  if (host === "api.osv.dev") {
    return Promise.resolve(Response.json({ vulns: [] }));
  }
  throw new Error(`unexpected call to ${host}`);
}

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
    // The real audit, so the archive records what it resolved
    // (swamp-club#3662); only the registries are fake.
    checkDependencyTrust: (specifiers) => {
      audited.push(...specifiers);
      return checkDependencyTrust(specifiers, fakeRegistries);
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

async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/** Writes an ESM package under `dir`, as an installer leaves it. */
async function writePackage(
  dir: string,
  name: string,
  version: string,
  code: string,
): Promise<void> {
  await write(
    join(dir, "package.json"),
    JSON.stringify({ name, version, main: "index.js", type: "module" }) + "\n",
  );
  await write(join(dir, "index.js"), code);
}

const MS_CODE = "export default function ms(n) {\n  return `${n}ms`;\n}\n";
const ZOD_CODE = "export const z = {};\n";

/** node_modules as `npm install` lays it out. */
async function npmLayout(project: string): Promise<void> {
  const modules = join(project, "node_modules");
  await writePackage(join(modules, "ms"), "ms", "2.1.3", MS_CODE);
  await writePackage(join(modules, "zod"), "zod", "4.1.0", ZOD_CODE);
}

/** node_modules as `deno install` lays it out: symlinks into `.deno/`. */
async function denoLayout(project: string): Promise<void> {
  const modules = join(project, "node_modules");
  for (
    const [name, version, code] of [
      ["ms", "2.1.3", MS_CODE],
      ["zod", "4.1.0", ZOD_CODE],
    ]
  ) {
    const real = join(modules, ".deno", `${name}@${version}`, "node_modules");
    await writePackage(join(real, name), name, version, code);
    await Deno.symlink(join(real, name), join(modules, name), { type: "dir" });
  }
}

/** Every path under `dir` with its bytes and mtime, symlinks unfollowed. */
async function treeSnapshot(dir: string): Promise<string[]> {
  const entries: string[] = [];
  const visit = async (path: string) => {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      const stat = await Deno.lstat(child);
      const content = entry.isFile
        ? await Deno.readTextFile(child)
        : entry.isSymlink
        ? await Deno.readLink(child)
        : "";
      entries.push(
        `${relative(dir, child)} ${stat.mtime?.getTime()} ${content}`,
      );
      if (entry.isDirectory) await visit(child);
    }
  };
  await visit(dir);
  return entries.sort();
}

async function withAuthor(
  layout: (project: string) => Promise<void>,
  fn: (author: string) => Promise<void>,
): Promise<void> {
  const author = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-package-json-push-" }),
  );
  try {
    const version = "20260101.120000.0";
    const events = await collect(
      repoInit(createLibSwampContext(), createRepoInitDeps(version), {
        path: author,
        force: false,
        version,
        tools: [],
      }),
    );
    assertEquals(events.some((event) => event.kind === "error"), false);
    await write(
      join(author, "package.json"),
      JSON.stringify({
        dependencies: { "ms": "^2.1.0", "zod": "^4.1.0" },
      }) + "\n",
    );
    await layout(author);
    await write(
      join(author, "extensions", "models", "took.ts"),
      'import ms from "ms";\nimport { z } from "zod";\n' +
        "export const took = { took: ms(2), z };\n",
    );
    await write(
      join(author, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/package-json-push",
        version: "2026.10.22.1",
        models: ["took.ts"],
      }),
    );
    await fn(author);
  } finally {
    await Deno.remove(author, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

/** The archive's files under `extension/`, by forward-slash path. */
async function archiveFiles(archive: Uint8Array): Promise<Map<string, string>> {
  const out = await Deno.makeTempDir({ prefix: "swamp-package-json-out-" });
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

for (
  const [label, layout] of [
    ["npm install", npmLayout],
    ["deno install", denoLayout],
  ] as const
) {
  Deno.test(`extension push (package.json, ${label}): leaves node_modules unchanged, and ships and audits the installed versions (swamp-club#3630)`, async () => {
    await withAuthor(layout, async (author) => {
      const nodeModules = join(author, "node_modules");
      const before = await treeSnapshot(nodeModules);

      const { repoContext } = await requireInitializedRepoReadOnly({
        repoDir: author,
        outputMode: "log",
      });
      const resolved = await resolveExtensionFiles({
        repoDir: author,
        manifestPath: join(author, "manifest.yaml"),
        repoContext,
        logger,
        moduleGraphReader: new DenoInfoModuleGraphReader(
          Deno.execPath(),
          ENV,
          { readOnlyLock: true },
        ),
      });
      assertEquals(resolved.packageJsonDir, author);

      const project = { packageJsonDir: author };
      const bundle = await bundleExtension(
        resolved.modelEntryPoints[0],
        Deno.execPath(),
        {
          ...project,
          readOnlyLock: await readOnlyLockFor(project),
          env: ENV,
        },
      );
      assertStringIncludes(bundle, "ms");

      const audited: DependencySpecifier[] = [];
      const prepared = await extensionPushPrepare(
        createLibSwampContext(),
        stubDeps(audited),
        {
          manifest: resolved.manifest,
          bareImports: resolved.bareImports,
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
          packageJsonDir: resolved.packageJsonDir,
          dryRun: true,
          registryChecks: "skip",
        },
      );

      assertEquals(await treeSnapshot(nodeModules), before);

      const files = await archiveFiles(prepared.archiveBytes);
      // Push ships zod as the host's zod 4, as under a Deno config.
      assertEquals(
        files.get("models/took.ts"),
        'import ms from "npm:ms@2.1.3";\nimport { z } from "npm:zod@4";\n' +
          "export const took = { took: ms(2), z };\n",
      );
      assertEquals(
        prepared.reviewRulesResult.warnings.filter((w) =>
          w.ruleId === "bare-specifiers"
        ),
        [],
      );
      // zod is the host's, never audited.
      assertEquals(
        audited.map((s) => [s.name, s.version, s.installedVersion]),
        [["ms", "^2.1.0", "2.1.3"]],
      );
      // The record keys ms by the installed version the source now pins
      // (swamp-club#3662).
      assertEquals(JSON.parse(files.get("dependency-audit.json") ?? ""), {
        recordVersion: 1,
        dependencies: [{
          registry: "npm",
          name: "ms",
          spec: "2.1.3",
          version: "2.1.3",
          from: "installed",
        }],
      });
    });
  });
}

Deno.test("extension push (package.json, nested node_modules): audits and records each installed copy under one declared range (swamp-club#3793)", async () => {
  await withAuthor(npmLayout, async (author) => {
    // A workspace member declares the same range and installs its own copy,
    // which Deno resolves for the module beside it.
    const member = join(author, "extensions", "models", "member");
    await write(
      join(member, "package.json"),
      JSON.stringify({ dependencies: { "ms": "^2.1.0" } }) + "\n",
    );
    await writePackage(
      join(member, "node_modules", "ms"),
      "ms",
      "2.1.2",
      MS_CODE,
    );
    await write(
      join(member, "also.ts"),
      'import ms from "ms";\nexport const also = { took: ms(3) };\n',
    );
    await write(
      join(author, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/package-json-push",
        version: "2026.10.22.1",
        models: ["took.ts", "member/also.ts"],
      }),
    );

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: author,
      outputMode: "log",
    });
    const resolved = await resolveExtensionFiles({
      repoDir: author,
      manifestPath: join(author, "manifest.yaml"),
      repoContext,
      logger,
      moduleGraphReader: new DenoInfoModuleGraphReader(
        Deno.execPath(),
        ENV,
        { readOnlyLock: true },
      ),
    });

    const audited: DependencySpecifier[] = [];
    const prepared = await extensionPushPrepare(
      createLibSwampContext(),
      stubDeps(audited),
      {
        manifest: resolved.manifest,
        bareImports: resolved.bareImports,
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
        packageJsonDir: resolved.packageJsonDir,
        dryRun: true,
        registryChecks: "skip",
      },
    );

    const files = await archiveFiles(prepared.archiveBytes);
    assertEquals(
      files.get("models/member/also.ts"),
      'import ms from "npm:ms@2.1.2";\nexport const also = { took: ms(3) };\n',
    );
    assertEquals(
      audited.map((s) => [s.name, s.version, s.installedVersion]).sort(),
      [["ms", "^2.1.0", "2.1.2"], ["ms", "^2.1.0", "2.1.3"]],
    );
    assertEquals(JSON.parse(files.get("dependency-audit.json") ?? ""), {
      recordVersion: 1,
      dependencies: [
        {
          registry: "npm",
          name: "ms",
          spec: "2.1.2",
          version: "2.1.2",
          from: "installed",
        },
        {
          registry: "npm",
          name: "ms",
          spec: "2.1.3",
          version: "2.1.3",
          from: "installed",
        },
      ],
    });
  });
});
