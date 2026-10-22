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
 * Push rewrites each bare import the project's Deno config resolves to its
 * npm:, jsr: or node: target in the archive's source (swamp-club#3637), as
 * Deno resolves it from that module: deno.json or deno.jsonc imports, an
 * importMap file, the scope covering the module, a workspace root's imports
 * (swamp-club#3612). So the shipped source resolves without the author's
 * config: the registry's scan reads the specifiers, and a pulled extension
 * rebundles in a repository with no deno.json. Wires the real push resolver, module graph
 * reader, planner, dependency extractor and archive assembly to the real
 * install and bundler; only the registry download is mocked. The rebundle
 * resolves npm:ms, jsr:@std/path and npm:zod for real, so it needs network
 * access or a warm DENO_DIR, as the other bundle tests do.
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
import { checkDependencyTrust } from "../src/domain/extensions/extension_dependency_trust_checker.ts";
import {
  type ExtensionProject,
  readProjectLockfile,
} from "../src/infrastructure/runtime/deno_lockfile_reader.ts";

const NAME = "@test/bare-rewrite";
const VERSION = "2026.10.20.1";

const graphReader = new DenoInfoModuleGraphReader(Deno.execPath());
const logger = getLogger(["test"]);

/** npm, its download counts and OSV, answering for ms 2.x only. */
function fakeRegistries(url: string | URL): Promise<Response> {
  const host = new URL(String(url)).host;
  const healthy = { license: "MIT", maintainers: [{ name: "a" }] };
  if (host === "registry.npmjs.org") {
    return Promise.resolve(Response.json({
      "dist-tags": { latest: "2.1.3" },
      versions: { "2.0.0": healthy, "2.1.2": healthy, "2.1.3": healthy },
      time: { "2.1.3": new Date().toISOString() },
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

function stubDeps(
  audited: DependencySpecifier[],
  realAudit = false,
): ExtensionPushPrepareDeps {
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
    checkDependencyTrust: async (specifiers, project: ExtensionProject) => {
      audited.push(...specifiers);
      // The real audit reads the lock the bundler honours, so the archive
      // records what it resolved (swamp-club#3662).
      if (realAudit) {
        return await checkDependencyTrust(
          specifiers,
          fakeRegistries,
          undefined,
          undefined,
          await readProjectLockfile(project),
        );
      }
      return { errors: [], warnings: [], audited: [], passed: true };
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
  manifestDir = author,
  realAudit = false,
): Promise<
  { archive: Uint8Array; bareWarnings: number; bareMessages: string[] }
> {
  const manifestPath = join(manifestDir, "manifest.yaml");
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
    stubDeps(audited, realAudit),
    {
      manifest: resolved.manifest,
      bareImports: resolved.bareImports,
      repoDir: author,
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
      denoConfigPath: resolved.denoConfigPath,
      dryRun: true,
      registryChecks: "skip",
    },
  );
  const bare = prepared.reviewRulesResult.warnings.filter((w) =>
    w.ruleId === "bare-specifiers"
  );
  return {
    archive: prepared.archiveBytes,
    bareWarnings: bare.length,
    bareMessages: bare.map((w) => w.message),
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
      'import { z } from "npm:zod@4";',
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

/** A one-model extension at `dir` whose model imports `ms` bare. */
async function writeMsExtension(dir: string): Promise<void> {
  await write(
    join(dir, "extensions", "models", "took.ts"),
    'import ms from "ms";\nexport const took = ms(2000);\n',
  );
  await write(
    join(dir, "manifest.yaml"),
    stringifyYaml({
      manifestVersion: 1,
      name: NAME,
      version: VERSION,
      models: ["took.ts"],
    }),
  );
}

function auditedNames(audited: DependencySpecifier[]): string[] {
  return audited.map((s) => `${s.registry}:${s.name}@${s.version}`).sort();
}

Deno.test("extension push: each module ships and audits the version the scope covering it gives (swamp-club#3612)", async () => {
  await withRepos(async (author) => {
    await write(
      join(author, "deno.json"),
      JSON.stringify({
        imports: { "ms": "npm:ms@2.1.3" },
        scopes: { "./extensions/models/": { "ms": "npm:ms@2.1.2" } },
      }),
    );
    await write(
      join(author, "extensions", "lib", "fmt.ts"),
      'import ms from "ms";\nexport const fmt = (n: number) => ms(n);\n',
    );
    await write(
      join(author, "extensions", "models", "took.ts"),
      'import ms from "ms";\nimport { fmt } from "../lib/fmt.ts";\n' +
        "export const took = [ms(2000), fmt(1000)];\n",
    );
    await write(
      join(author, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: 1,
        name: NAME,
        version: VERSION,
        models: ["took.ts"],
      }),
    );

    const audited: DependencySpecifier[] = [];
    const { archive, bareWarnings } = await pushArchive(author, audited);
    assertEquals(bareWarnings, 0);
    const files = await archiveFiles(archive);
    assertStringIncludes(
      files.get("models/took.ts") ?? "",
      'import ms from "npm:ms@2.1.2";',
    );
    assertStringIncludes(
      [...files.entries()].find(([p]) => p.endsWith("fmt.ts"))?.[1] ?? "",
      'import ms from "npm:ms@2.1.3";',
    );
    assertEquals(auditedNames(audited), ["npm:ms@2.1.2", "npm:ms@2.1.3"]);
  });
});

Deno.test("extension push: a deno.jsonc with comments resolves, rewrites and audits bare imports (swamp-club#3612)", async () => {
  await withRepos(async (author) => {
    await write(
      join(author, "deno.jsonc"),
      '// project config\n{\n  "imports": { "ms": "npm:ms@2.1.2", },\n}\n',
    );
    await writeMsExtension(author);

    const audited: DependencySpecifier[] = [];
    const { archive, bareWarnings } = await pushArchive(author, audited);
    assertEquals(bareWarnings, 0);
    const files = await archiveFiles(archive);
    assertStringIncludes(
      files.get("models/took.ts") ?? "",
      'import ms from "npm:ms@2.1.2";',
    );
    assertEquals(auditedNames(audited), ["npm:ms@2.1.2"]);
    assert(
      ![...files.keys()].some((p) => p.endsWith("deno.jsonc")),
      "the project config does not ship",
    );
  });
});

Deno.test("extension push: an importMap file the deno.json references resolves bare imports (swamp-club#3612)", async () => {
  await withRepos(async (author) => {
    await write(
      join(author, "deno.json"),
      JSON.stringify({ importMap: "./import_map.json" }),
    );
    await write(
      join(author, "import_map.json"),
      JSON.stringify({ imports: { "ms": "npm:ms@2.1.2" } }),
    );
    await writeMsExtension(author);

    const audited: DependencySpecifier[] = [];
    const { archive, bareWarnings } = await pushArchive(author, audited);
    assertEquals(bareWarnings, 0);
    assertStringIncludes(
      (await archiveFiles(archive)).get("models/took.ts") ?? "",
      'import ms from "npm:ms@2.1.2";',
    );
    assertEquals(auditedNames(audited), ["npm:ms@2.1.2"]);
  });
});

Deno.test("extension push: a workspace member's bare imports resolve through the root's imports (swamp-club#3612)", async () => {
  await withRepos(async (author) => {
    await write(
      join(author, "deno.json"),
      JSON.stringify({
        workspace: ["./member"],
        imports: { "ms": "npm:ms@2.1.2" },
      }),
    );
    const member = join(author, "member");
    await write(join(member, "deno.json"), JSON.stringify({ imports: {} }));
    await writeMsExtension(member);

    const audited: DependencySpecifier[] = [];
    const { archive, bareWarnings } = await pushArchive(
      author,
      audited,
      member,
    );
    assertEquals(bareWarnings, 0);
    assertStringIncludes(
      (await archiveFiles(archive)).get("models/took.ts") ?? "",
      'import ms from "npm:ms@2.1.2";',
    );
    assertEquals(auditedNames(audited), ["npm:ms@2.1.2"]);
  });
});

Deno.test("extension push: a bare import nothing resolves ships as written and the finding names it (swamp-club#3612)", async () => {
  await withRepos(async (author) => {
    await write(
      join(author, "deno.json"),
      JSON.stringify({ imports: { "ms": "npm:ms@2.1.2" } }),
    );
    await write(
      join(author, "extensions", "models", "took.ts"),
      'import ms from "ms";\n' +
        "// @ts-ignore: never resolves; push must not invent a target\n" +
        'import x from "nothing-maps-this";\n' +
        "export const took = [ms(2000), x];\n",
    );
    await write(
      join(author, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: 1,
        name: NAME,
        version: VERSION,
        models: ["took.ts"],
      }),
    );

    const audited: DependencySpecifier[] = [];
    const { archive, bareMessages } = await pushArchive(author, audited);
    assertEquals(bareMessages.length, 1);
    assertStringIncludes(bareMessages[0], '"nothing-maps-this"');
    const took = (await archiveFiles(archive)).get("models/took.ts") ?? "";
    assertStringIncludes(took, 'import ms from "npm:ms@2.1.2";');
    assertStringIncludes(took, 'import x from "nothing-maps-this";');
    assertEquals(auditedNames(audited), ["npm:ms@2.1.2"]);
  });
});

Deno.test("extension push: deno.json wins over a deno.jsonc in the same directory, as for Deno (swamp-club#3612)", async () => {
  await withRepos(async (author) => {
    await write(
      join(author, "deno.json"),
      JSON.stringify({ imports: { "ms": "npm:ms@2.1.2" } }),
    );
    await write(
      join(author, "deno.jsonc"),
      '{ "imports": { "ms": "npm:ms@2.1.3" } }\n',
    );
    await writeMsExtension(author);

    const audited: DependencySpecifier[] = [];
    const { archive } = await pushArchive(author, audited);
    assertStringIncludes(
      (await archiveFiles(archive)).get("models/took.ts") ?? "",
      'import ms from "npm:ms@2.1.2";',
    );
    assertEquals(auditedNames(audited), ["npm:ms@2.1.2"]);
  });
});

Deno.test("extension push: a deno.json beside a package.json with nothing installed still ships each bare import as Deno maps it (swamp-club#3612)", async () => {
  await withRepos(async (author) => {
    await write(
      join(author, "deno.json"),
      JSON.stringify({ imports: { "zod": "npm:zod@4" } }),
    );
    // The package.json puts Deno in manual node_modules mode, and nothing is
    // installed: the first graph read reports both imports as missing.
    await write(
      join(author, "package.json"),
      JSON.stringify({
        name: "author",
        dependencies: { "zod": "^4.0.0", "ms": "2.1.2" },
      }),
    );
    await write(
      join(author, "extensions", "models", "took.ts"),
      'import { z } from "zod";\nimport ms from "ms";\n' +
        "export const took = { schema: z.string(), t: ms(2000) };\n",
    );
    await write(
      join(author, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: 1,
        name: NAME,
        version: VERSION,
        models: ["took.ts"],
      }),
    );

    const audited: DependencySpecifier[] = [];
    const { archive, bareWarnings } = await pushArchive(author, audited);
    assertEquals(bareWarnings, 0);
    const took = (await archiveFiles(archive)).get("models/took.ts") ?? "";
    assertStringIncludes(took, 'import { z } from "npm:zod@4";');
    // Listed only in the package.json, as Deno resolves it.
    assertStringIncludes(took, 'import ms from "npm:ms@2.1.2";');
    assertEquals(auditedNames(audited), ["npm:ms@2.1.2"]);
  });
});

Deno.test("extension push: the archive records the locked version of a written and an import-map range (swamp-club#3662)", async () => {
  await withRepos(async (author) => {
    await write(
      join(author, "deno.json"),
      JSON.stringify({ imports: { "ms": "npm:ms@^2.1.0" } }),
    );
    await write(
      join(author, "extensions", "models", "took.ts"),
      'import ms from "ms";\nimport ms2 from "npm:ms@~2.1.0";\n' +
        "export const took = [ms(2000), ms2(1000)];\n",
    );
    await write(
      join(author, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: 1,
        name: NAME,
        version: VERSION,
        models: ["took.ts"],
      }),
    );

    const { archive } = await pushArchive(author, [], author, true);
    // The module graph read locked both ranges; the record names the
    // version the lock gives each, keyed by the spec the source ships.
    const lock = await readProjectLockfile({
      denoConfigPath: join(author, "deno.json"),
    });
    const locked = (spec: string) => lock?.resolvedFor("npm", "ms", spec);
    assert(locked("^2.1.0") !== undefined);
    const files = await archiveFiles(archive);
    assertEquals(JSON.parse(files.get("dependency-audit.json") ?? ""), {
      recordVersion: 1,
      dependencies: [
        {
          registry: "npm",
          name: "ms",
          spec: "^2.1.0",
          version: locked("^2.1.0"),
          from: "lockfile",
        },
        {
          registry: "npm",
          name: "ms",
          spec: "~2.1.0",
          version: locked("~2.1.0") ?? locked("^2.1.0"),
          from: "lockfile",
        },
      ],
    });
  });
});
