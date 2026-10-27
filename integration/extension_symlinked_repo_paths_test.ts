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

// swamp-club#3536: a repository reached through a symlink (macOS `/var` is
// `/private/var`) reports its extension files under the spelling the user
// gave. This wires manifest re-spelling, the file resolver (with the real
// module graph reader) and the push prepare step over a real temp tree whose
// parent is a symlink, and checks every path stays in the link spelling,
// and that a symlinked workflow found by dependency resolution, whose path
// the repo context reports in the real spelling, is still refused. Below a
// node_modules, where deno info reports imports by real path, the planned
// files keep the link spelling too (swamp-club#3794).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import { respellUnderRepoDir } from "../src/cli/resolve_manifest_path.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
} from "../src/libswamp/extensions/push.ts";
import { fileRelativeToManifest } from "../src/domain/extensions/extension_acceptances.ts";
import { DenoInfoModuleGraphReader } from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";
import { emptyArchiveIndex } from "../src/libswamp/extensions/extension_tree_index_test_helpers.ts";

const graphReader = new DenoInfoModuleGraphReader(Deno.execPath());

const logger = getLogger(["test"]);

const stubRepoContext = {
  workflowRepo: { findByName: () => Promise.resolve(null) },
  definitionRepo: { findByNameGlobal: () => Promise.resolve(null) },
} as unknown as RepositoryContext;

const prepareDeps: ExtensionPushPrepareDeps = {
  loadCredentials: () => Promise.resolve(null),
  fetchCollectives: () =>
    Promise.resolve({ collectives: ["test"], entitlements: undefined }),
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
  ensureDenoPath: () => Promise.resolve("unused-deno"),
  getDenoEnv: () => ({}),
  findPublishedVersion: () => Promise.resolve(null),
  getLatestVersionDetail: () => Promise.resolve(null),
};

/**
 * A repo at `<tmp>/real/repo`, also reachable as `<tmp>/link/repo`, with a
 * model that imports a local helper and a listed workflow.
 */
async function withLinkedRepo(
  fn: (paths: { real: string; link: string; tmp: string }) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-symlinked-repo-" }),
  );
  try {
    const real = join(tmp, "real", "repo");
    const link = join(tmp, "link", "repo");
    const models = join(real, "extensions", "models", "ext");
    await Deno.mkdir(models, { recursive: true });
    await Deno.mkdir(join(real, "workflows"), { recursive: true });
    await Deno.symlink(join(tmp, "real"), join(tmp, "link"), { type: "dir" });
    await Deno.writeTextFile(
      join(real, ".swamp.yaml"),
      stringifyYaml({ swampVersion: "0.1.0" }),
    );
    await Deno.writeTextFile(
      join(models, "fields.ts"),
      'import { helper } from "./helper.ts";\n' +
        'export const model = { type: "@test/fields", helper };\n',
    );
    await Deno.writeTextFile(
      join(models, "helper.ts"),
      "export const helper = 1;\n",
    );
    await Deno.writeTextFile(
      join(real, "workflows", "deploy.yaml"),
      'name: "@test/deploy"\njobs: {}\n',
    );
    await Deno.writeTextFile(
      join(real, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/fields",
        version: "2026.01.01.1",
        models: ["ext/fields.ts"],
        workflows: ["deploy.yaml"],
      }),
    );
    await fn({ real, link, tmp });
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch((err) => {
      // Windows: V8 may not have released native handles yet (EBUSY).
      if (Deno.build.os !== "windows") throw err;
    });
  }
}

for (
  const manifestSpelling of ["link", "real"] as const
) {
  Deno.test(`extension push: a repo reached through a symlink reports its files in that spelling, with the manifest given under the ${manifestSpelling} spelling (swamp-club#3536)`, async () => {
    await withLinkedRepo(async ({ real, link }) => {
      const repoDir = link;
      const manifestPath = await respellUnderRepoDir(
        join(manifestSpelling === "link" ? link : real, "manifest.yaml"),
        repoDir,
      );
      assertEquals(manifestPath, join(link, "manifest.yaml"));

      const resolved = await resolveExtensionFiles({
        repoDir,
        manifestPath,
        repoContext: stubRepoContext,
        logger,
        moduleGraphReader: graphReader,
      });

      const fields = join(link, "extensions", "models", "ext", "fields.ts");
      const helper = join(link, "extensions", "models", "ext", "helper.ts");
      assertEquals(resolved.modelEntryPoints, [fields]);
      // The module graph keeps the root's spelling for a local import, so
      // the helper is filed under the models kind.
      assertEquals([...resolved.allModelFiles].sort(), [fields, helper]);
      assertEquals(
        resolved.workflowFiles.map((w) => w.sourcePath),
        [join(link, "workflows", "deploy.yaml")],
      );
      assertEquals(
        fileRelativeToManifest(link, fields, repoDir),
        "extensions/models/ext/fields.ts",
      );

      const input: ExtensionPushPrepareInput = {
        manifest: resolved.manifest,
        bareImports: resolved.bareImports,
        graphDependencies: resolved.graphDependencies,
        repoDir,
        manifestDir: link,
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
      };
      const prepared = await extensionPushPrepare(
        createLibSwampContext(),
        prepareDeps,
        input,
      );

      // Push reports these with the platform's separators.
      assertEquals(
        prepared.resolvedData.models.map((m) => m.fileName),
        [join("extensions", "models", "ext", "fields.ts")],
      );
      assertEquals(prepared.resolvedData.workflowFiles, [
        join("workflows", "deploy.yaml"),
      ]);
    });
  });
}

/**
 * A repo context whose `deploy` workflow runs the `shared` workflow, which
 * the context reports at `sharedPath`, as the workflow repository of a repo
 * opened on its resolved path does.
 */
function repoContextWithSharedWorkflow(sharedPath: string): RepositoryContext {
  const workflowStep = {
    task: {
      isModelMethod: () => false,
      isWorkflow: () => true,
      data: { type: "workflow", workflowIdOrName: "shared" },
    },
  };
  const workflows: Record<string, { id: string; jobs: unknown[] }> = {
    deploy: { id: "deploy", jobs: [{ steps: [workflowStep] }] },
    shared: { id: "shared", jobs: [] },
  };
  return {
    workflowRepo: {
      findByName: (name: string) => Promise.resolve(workflows[name] ?? null),
      getPath: (id: string) =>
        id === "shared" ? sharedPath : "/nonexistent/deploy.yaml",
    },
    definitionRepo: { findByNameGlobal: () => Promise.resolve(null) },
  } as unknown as RepositoryContext;
}

for (
  const layout of [
    { name: "a symlinked workflow file", dir: "workflows", linkDir: false },
    {
      name: "a workflow under a symlinked directory",
      dir: "wfs",
      linkDir: true,
    },
  ]
) {
  Deno.test(`extension push: ${layout.name} found by dependency resolution in a symlinked repo is listed in the link spelling and refused as a symlink (swamp-club#3536, swamp-club#3421)`, async () => {
    await withLinkedRepo(async ({ real, link, tmp }) => {
      const outside = join(tmp, "outside");
      await Deno.mkdir(outside, { recursive: true });
      await Deno.writeTextFile(
        join(outside, "shared.yaml"),
        'name: "@test/shared"\njobs: {}\n',
      );
      if (layout.linkDir) {
        await Deno.symlink(outside, join(real, layout.dir), { type: "dir" });
      } else {
        await Deno.symlink(
          join(outside, "shared.yaml"),
          join(real, layout.dir, "shared.yaml"),
          { type: "file" },
        );
      }

      const resolved = await resolveExtensionFiles({
        repoDir: link,
        manifestPath: join(link, "manifest.yaml"),
        repoContext: repoContextWithSharedWorkflow(
          join(real, layout.dir, "shared.yaml"),
        ),
        logger,
        moduleGraphReader: graphReader,
      });

      const shared = join(link, layout.dir, "shared.yaml");
      assertEquals(
        resolved.workflowFiles.map((w) => w.sourcePath),
        [join(link, "workflows", "deploy.yaml"), shared],
      );
      assertEquals(resolved.symlinkedPaths.has(shared), true);
    });
  });
}

Deno.test({
  name:
    "symlinked repo paths: a repo dir given through a symlink above a node_modules ancestor plans its local modules in the repo dir's spelling (swamp-club#3794)",
  ignore: Deno.build.os === "windows",
  async fn() {
    const outer = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "swamp-resolve-ext-link-" }),
    );
    try {
      const real = join(outer, "real", "node_modules", "repo");
      const modelsDir = join(real, "extensions", "models");
      await Deno.mkdir(modelsDir, { recursive: true });
      await Deno.mkdir(join(real, "lib"));
      await Deno.writeTextFile(
        join(real, ".swamp.yaml"),
        stringifyYaml({ swampVersion: "0.1.0" }),
      );
      await Deno.writeTextFile(
        join(modelsDir, "my_model.ts"),
        'import { x } from "./helper.ts";\n' +
          'import { t } from "../../lib/two.ts";\n' +
          "export const value = x + t;\n",
      );
      await Deno.writeTextFile(
        join(modelsDir, "helper.ts"),
        "export const x = 1;\n",
      );
      await Deno.writeTextFile(
        join(real, "lib", "two.ts"),
        "export const t = 2;\n",
      );
      await Deno.writeTextFile(
        join(real, "manifest.yaml"),
        stringifyYaml({
          manifestVersion: 1,
          name: "@test/linked",
          version: "2026.10.23.1",
          models: ["my_model.ts"],
        }),
      );
      // Like macOS /var: the repo dir is spelled through a link above the
      // node_modules it sits in, and deno info reports what the entry
      // point imports by real path.
      await Deno.symlink(join(outer, "real"), join(outer, "link"), {
        type: "dir",
      });
      const resolveAt = (repoDir: string) =>
        resolveExtensionFiles({
          repoDir,
          manifestPath: join(repoDir, "manifest.yaml"),
          repoContext: stubRepoContext,
          logger,
          moduleGraphReader: graphReader,
        });
      const repoDir = join(outer, "link", "node_modules", "repo");
      const result = await resolveAt(repoDir);
      const linkedModels = join(repoDir, "extensions", "models");
      assertEquals(result.allModelFiles.sort(), [
        join(linkedModels, "helper.ts"),
        join(linkedModels, "my_model.ts"),
        join(repoDir, "lib", "two.ts"),
      ]);
      // The archive is the one the repo's real path plans.
      const archived = (r: typeof result) =>
        r.sourcePlan.entries.map((e) => e.archivePath).sort();
      assertEquals(archived(result), archived(await resolveAt(real)));
      assertEquals(archived(result).length, 3);
    } finally {
      await Deno.remove(outer, { recursive: true });
    }
  },
});
