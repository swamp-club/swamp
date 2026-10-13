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
 * Extensions whose source copy was already complete keep their content
 * hash when push moves to the module graph (swamp-club#3376). Each pin was
 * computed with the regex resolver push used before; the fixtures import
 * only modules inside their kind's directory, so the graph finds the same
 * files.
 */

import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import { requireInitializedRepoReadOnly } from "../src/cli/repo_context.ts";
import { computePackageCacheHash } from "../src/domain/extensions/extension_package_cache.ts";
import { DenoInfoModuleGraphReader } from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";

const graphReader = new DenoInfoModuleGraphReader(Deno.execPath());
const logger = getLogger(["test"]);
async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

const HASH_FIXTURES: Array<{
  name: string;
  pinned: string;
  stage: (repo: string) => Promise<string>;
}> = [
  {
    name: "flat model importing ./_lib, multi-line import included",
    pinned: "a26a4075d654c95efae98442b3985050d0310e1065ce5d8c512e38f2fe945a68",
    stage: async (repo) => {
      const models = join(repo, "extensions", "models");
      await write(join(models, "_lib", "a.ts"), "export const a = 1;\n");
      await write(join(models, "_lib", "b.ts"), "export const b = 2;\n");
      await write(
        join(models, "flat.ts"),
        'import { a } from "./_lib/a.ts";\nimport {\n  b,\n} from "./_lib/b.ts";\nexport const model = { a, b };\n',
      );
      const manifest = join(repo, "manifest.yaml");
      await write(
        manifest,
        stringifyYaml({
          manifestVersion: 1,
          name: "@test/flat",
          version: "2026.10.13.1",
          models: ["flat.ts"],
        }),
      );
      return manifest;
    },
  },
  {
    name: "typedDir sub-directory model with a vault",
    pinned: "5d8ecdc69e75e4595952e5192d82aea63540377f1d707f4e0c8ed3b14df8315b",
    stage: async (repo) => {
      const models = join(repo, "extensions", "models");
      await write(join(models, "svc", "helpers.ts"), "export const h = 1;\n");
      await write(
        join(models, "svc", "svc.ts"),
        'import { h } from "./helpers.ts";\nexport const model = { h };\n',
      );
      await write(
        join(repo, "extensions", "vaults", "v.ts"),
        "export const vault = {};\n",
      );
      const manifest = join(repo, "manifest.yaml");
      await write(
        manifest,
        stringifyYaml({
          manifestVersion: 1,
          name: "@test/svc",
          version: "2026.10.13.1",
          models: ["svc/svc.ts"],
          vaults: ["v.ts"],
        }),
      );
      return manifest;
    },
  },
  {
    name: "paths.base manifest without outside imports",
    pinned: "3de6e20d6c1640c67bb6e445358aef1d6db1fdac1f6da37447523298659dd2f9",
    stage: async (repo) => {
      const dir = join(repo, "extensions", "models", "keygen");
      await write(join(dir, "util.ts"), "export const u = 1;\n");
      await write(
        join(dir, "keygen.ts"),
        'import { u } from "./util.ts";\nexport const model = { u };\n',
      );
      const manifest = join(dir, "manifest.yaml");
      await write(
        manifest,
        stringifyYaml({
          manifestVersion: 1,
          name: "@test/keygen",
          version: "2026.10.13.1",
          paths: { base: "manifest" },
          models: ["keygen.ts"],
        }),
      );
      return manifest;
    },
  },
  {
    name: "report importing a module the models directory owns",
    pinned: "1b44dd5e433ae3d172fe492418305959c5752c3a11462010145fe410455f0f6e",
    stage: async (repo) => {
      const models = join(repo, "extensions", "models");
      await write(join(models, "_lib", "run_data.ts"), "export const r = 1;\n");
      await write(
        join(models, "m.ts"),
        'import { r } from "./_lib/run_data.ts";\nexport const model = { r };\n',
      );
      await write(
        join(repo, "extensions", "reports", "rep.ts"),
        'import { r } from "../models/_lib/run_data.ts";\nexport const report = { r };\n',
      );
      const manifest = join(repo, "manifest.yaml");
      await write(
        manifest,
        stringifyYaml({
          manifestVersion: 1,
          name: "@test/cross-kind",
          version: "2026.10.13.1",
          models: ["m.ts"],
          reports: ["rep.ts"],
        }),
      );
      return manifest;
    },
  },
];

for (const fixture of HASH_FIXTURES) {
  Deno.test(`extension push: an already complete extension keeps its content hash — ${fixture.name}`, async () => {
    const repo = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "swamp-hash-pin-" }),
    );
    try {
      const version = "20260101.120000.0";
      await collect(
        repoInit(createLibSwampContext(), createRepoInitDeps(version), {
          path: repo,
          force: false,
          version,
          tools: [],
        }),
      );
      const manifestPath = await fixture.stage(repo);
      const { repoContext } = await requireInitializedRepoReadOnly({
        repoDir: repo,
        outputMode: "log",
      });
      const r = await resolveExtensionFiles({
        repoDir: repo,
        manifestPath,
        repoContext,
        logger,
        moduleGraphReader: graphReader,
      });
      const hash = await computePackageCacheHash({
        manifest: r.manifest,
        rootDir: r.extensionsRoot,
        manifestDir: dirname(manifestPath),
        modelFilePaths: [...r.allModelFiles, ...r.dataFilesByKind.models],
        vaultFilePaths: [...r.allVaultFiles, ...r.dataFilesByKind.vaults],
        datastoreFilePaths: [
          ...r.allDatastoreFiles,
          ...r.dataFilesByKind.datastores,
        ],
        reportFilePaths: [...r.allReportFiles, ...r.dataFilesByKind.reports],
        webhookFilePaths: [
          ...r.allWebhookFiles,
          ...r.dataFilesByKind.webhooks,
        ],
        workflowFilePaths: r.workflowFiles.map((w) => w.sourcePath),
        additionalFilePaths: r.additionalFilePaths,
        binaryFilePaths: r.binaryFilePaths,
        skillFilePaths: r.allSkillFiles,
        includeFilePaths: r.includeFilePaths,
        denoConfigPath: undefined,
        packageJsonPath: undefined,
      });
      assertEquals(hash, fixture.pinned);
    } finally {
      await Deno.remove(repo, { recursive: true }).catch((error) => {
        if (Deno.build.os !== "windows") throw error;
      });
    }
  });
}
