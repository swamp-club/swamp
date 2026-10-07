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
 * One extension hashes the same however it is pushed (swamp-club#3100):
 * from a repo initialised inside the extension directory (the publish.yml
 * layout), and from a sibling repo with the extensions root inferred from
 * the manifest or named by `--extensions-dir`. Each run resolves the
 * extension as `extension push` and `extension quality` do and hashes it
 * with the extensions root as `rootDir`, as both commands pass it.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import { requireInitializedRepoReadOnly } from "../src/cli/repo_context.ts";
import { computePackageCacheHash } from "../src/domain/extensions/extension_package_cache.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";

const logger = getLogger(["test"]);

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

async function stageExtension(ext: string): Promise<string> {
  await Deno.mkdir(join(ext, "extensions", "models"), { recursive: true });
  await Deno.writeTextFile(
    join(ext, "extensions", "models", "hello.ts"),
    'export const name = "hello";\n',
  );
  await Deno.mkdir(join(ext, "extensions", "workflows", "hello-wf"), {
    recursive: true,
  });
  await Deno.writeTextFile(
    join(ext, "extensions", "workflows", "hello-wf", "workflow.yaml"),
    "name: hello-wf\njobs: {}\n",
  );
  await Deno.writeTextFile(join(ext, "README.md"), "# hello\n");
  const manifestPath = join(ext, "manifest.yaml");
  await Deno.writeTextFile(
    manifestPath,
    stringifyYaml({
      manifestVersion: 1,
      name: "@test/layout-hash",
      version: "2026.10.07.1",
      models: ["hello.ts"],
      workflows: ["hello-wf/workflow.yaml"],
      additionalFiles: ["README.md"],
    }),
  );
  return manifestPath;
}

async function hashFrom(
  repoDir: string,
  manifestPath: string,
  extensionsDir: string | undefined,
  rootDir: "extensionsRoot" | "repoDir" = "extensionsRoot",
): Promise<string> {
  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir,
    outputMode: "log",
  });
  const resolved = await resolveExtensionFiles({
    repoDir,
    manifestPath,
    repoContext,
    logger,
    extensionsDir,
  });
  assertEquals(resolved.modelEntryPoints.length, 1);
  assertEquals(resolved.workflowFiles.length, 1);
  assertEquals(resolved.additionalFilePaths.length, 1);
  return await computePackageCacheHash({
    manifest: resolved.manifest,
    rootDir: rootDir === "extensionsRoot" ? resolved.extensionsRoot : repoDir,
    manifestDir: dirname(manifestPath),
    modelFilePaths: resolved.allModelFiles,
    vaultFilePaths: resolved.allVaultFiles,
    datastoreFilePaths: resolved.allDatastoreFiles,
    reportFilePaths: resolved.allReportFiles,
    webhookFilePaths: resolved.allWebhookFiles,
    workflowFilePaths: resolved.workflowFiles.map((w) => w.sourcePath),
    additionalFilePaths: resolved.additionalFilePaths,
    binaryFilePaths: resolved.binaryFilePaths,
    skillFilePaths: resolved.allSkillFiles,
    includeFilePaths: resolved.includeFilePaths,
    denoConfigPath: undefined,
    packageJsonPath: undefined,
  });
}

Deno.test("extension push and quality: a sibling repo hashes an extension like the publish layout (swamp-club#3100)", async () => {
  // Real paths throughout: workflow source paths are symlink-free, and
  // macOS puts the temp dir behind the /var symlink.
  const parent = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-layout-hash-" }),
  );
  try {
    const ext = join(parent, "ext");
    const scratch = join(parent, "scratch");
    const manifestPath = await stageExtension(ext);
    await Deno.mkdir(scratch);
    await initRepo(scratch);

    const inferred = await hashFrom(scratch, manifestPath, undefined);
    const flagged = await hashFrom(scratch, manifestPath, ext);
    const repoRelative = await hashFrom(
      scratch,
      manifestPath,
      undefined,
      "repoDir",
    );

    await initRepo(ext);
    const publish = await hashFrom(ext, manifestPath, undefined);

    assertEquals(inferred, publish);
    assertEquals(flagged, publish);
    // Labelled from the sibling repo dir, the same files hash differently:
    // the hash input must be the extensions root, not the repo dir.
    assertNotEquals(repoRelative, publish);
  } finally {
    await Deno.remove(parent, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});
