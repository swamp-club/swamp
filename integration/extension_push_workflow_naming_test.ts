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

// swamp-club#2613: a manifest that lists several workflows under one
// directory prefix must package every one of them. This wires the resolver
// to the push prepare step and inspects the archive it produces, for both
// of the issue's manifests (prefixed and bare).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { extractTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import {
  createLibSwampContext,
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
} from "../src/libswamp/mod.ts";

const logger = getLogger(["test"]);

const stubRepoContext = {
  workflowRepo: { findByName: () => Promise.resolve(null) },
  definitionRepo: { findByNameGlobal: () => Promise.resolve(null) },
} as unknown as RepositoryContext;

const prepareDeps: ExtensionPushPrepareDeps = {
  loadCredentials: () => Promise.resolve(null),
  fetchCollectives: () => Promise.resolve(["test"]),
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
  bundleEntryPoint: () => Promise.resolve("export const model = {};\n"),
  ensureDenoPath: () => Promise.resolve("unused-deno"),
  getDenoEnv: () => ({}),
  findPublishedVersion: () => Promise.resolve(null),
  getLatestVersionDetail: () => Promise.resolve(null),
};

const WORKFLOWS = ["alpha", "beta", "gamma"] as const;

async function stageRepo(root: string): Promise<void> {
  await Deno.writeTextFile(
    join(root, ".swamp.yaml"),
    stringifyYaml({ swampVersion: "0.1.0" }),
  );
  await Deno.mkdir(join(root, "extensions", "models"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "extensions", "models", "noop.ts"),
    'export const model = { type: "@test/noop" };\n',
  );
  await Deno.mkdir(join(root, "workflows"), { recursive: true });
  for (const n of WORKFLOWS) {
    const body = `name: "@test/repro-${n}"\njobs: {}\n`;
    await Deno.writeTextFile(
      join(root, "workflows", `workflow-repro-${n}.yaml`),
      body,
    );
    await Deno.writeTextFile(join(root, `workflow-repro-${n}.yaml`), body);
  }
}

async function writeManifest(
  root: string,
  fileName: string,
  workflows: string[],
): Promise<string> {
  const manifestPath = join(root, fileName);
  await Deno.writeTextFile(
    manifestPath,
    stringifyYaml({
      manifestVersion: 1,
      name: "@test/wf-collapse-repro",
      version: "2026.01.01.1",
      paths: { base: "manifest" },
      models: ["extensions/models/noop.ts"],
      workflows,
    }),
  );
  return manifestPath;
}

const variants = [
  {
    name: "prefixed",
    workflows: WORKFLOWS.map((n) => `workflows/workflow-repro-${n}.yaml`),
  },
  {
    name: "bare",
    workflows: WORKFLOWS.map((n) => `workflow-repro-${n}.yaml`),
  },
];

for (const variant of variants) {
  Deno.test(`extension push: ${variant.name} manifest packages all three workflows under distinct names (swamp-club#2613)`, async () => {
    const root = await Deno.makeTempDir({ prefix: "wf-naming-" });
    try {
      await stageRepo(root);
      const manifestPath = await writeManifest(
        root,
        `manifest-${variant.name}.yaml`,
        variant.workflows,
      );

      const resolved = await resolveExtensionFiles({
        repoDir: root,
        manifestPath,
        repoContext: stubRepoContext,
        logger,
      });

      const input: ExtensionPushPrepareInput = {
        manifest: resolved.manifest,
        repoDir: root,
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
        dryRun: true,
        registryChecks: "skip",
      };

      const prepared = await extensionPushPrepare(
        createLibSwampContext(),
        prepareDeps,
        input,
      );

      // The dry-run report counts what the archive holds.
      assertEquals(prepared.resolvedData.workflowFiles.length, 3);

      const extracted = join(root, "extracted");
      await extractTarGz(
        new Blob([new Uint8Array(prepared.archiveBytes)]).stream(),
        extracted,
      );
      const archived: string[] = [];
      for await (
        const entry of Deno.readDir(join(extracted, "extension", "workflows"))
      ) {
        archived.push(entry.name);
      }
      archived.sort();
      assertEquals(archived, [
        "workflow-repro-alpha.yaml",
        "workflow-repro-beta.yaml",
        "workflow-repro-gamma.yaml",
      ]);
      for (const n of WORKFLOWS) {
        const content = await Deno.readTextFile(
          join(extracted, "extension", "workflows", `workflow-repro-${n}.yaml`),
        );
        assertEquals(content.includes(`@test/repro-${n}`), true);
      }
    } finally {
      await Deno.remove(root, { recursive: true }).catch((err) => {
        // Windows: V8 may not have released native handles yet (EBUSY).
        if (Deno.build.os !== "windows") throw err;
      });
    }
  });
}
