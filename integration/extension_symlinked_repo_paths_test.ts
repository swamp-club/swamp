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
// parent is a symlink, and checks every path stays in the link spelling.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import { manifestPathUnderRepo } from "../src/cli/resolve_manifest_path.ts";
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
  fn: (paths: { real: string; link: string }) => Promise<void>,
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
    await fn({ real, link });
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

for (
  const manifestSpelling of ["link", "real"] as const
) {
  Deno.test(`extension push: a repo reached through a symlink reports its files in that spelling, with the manifest given under the ${manifestSpelling} spelling (swamp-club#3536)`, async () => {
    await withLinkedRepo(async ({ real, link }) => {
      const repoDir = link;
      const manifestPath = await manifestPathUnderRepo(
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

      assertEquals(
        prepared.resolvedData.models.map((m) => m.fileName),
        ["extensions/models/ext/fields.ts"],
      );
      assertEquals(prepared.resolvedData.workflowFiles, [
        "workflows/deploy.yaml",
      ]);
    });
  });
}
