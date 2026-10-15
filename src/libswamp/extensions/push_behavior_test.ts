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

// Packing a behavior-spelled extension (swamp-club#3338): files under the
// behaviors directory land at models/<path from it>, a models/ path two
// files would share is refused, and the push reports the spelling once.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createLibSwampContext } from "../context.ts";
import { extensionPushPrepare, type ExtensionPushPrepareDeps } from "./push.ts";
import { buildPrepareInput } from "./push_test_helpers.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { extractContentMetadata } from "../../domain/extensions/extension_content_extractor.ts";
import { listTarGzEntries } from "../../infrastructure/archive/tar_archive.ts";
import type { SwampError } from "../errors.ts";
import { emptyArchiveIndex } from "./extension_tree_index_test_helpers.ts";

function deps(): ExtensionPushPrepareDeps {
  return {
    loadCredentials: () => Promise.resolve(null),
    fetchCollectives: () =>
      Promise.resolve({ collectives: [], entitlements: undefined }),
    extractContentMetadata,
    analyzeExtensionSafety: () => Promise.resolve({ errors: [], warnings: [] }),
    checkExtensionQuality: () => Promise.resolve({ passed: true, issues: [] }),
    extractDependencySpecifiers: () => Promise.resolve([]),
    checkDependencyTrust: () =>
      Promise.resolve({ errors: [], warnings: [], audited: [], passed: true }),
    checkReviewRules: () =>
      Promise.resolve({ errors: [], warnings: [], passed: true }),
    indexArchive: emptyArchiveIndex,
    bundleEntryPoint: (entry) => Promise.resolve(`// ${entry}`),
    ensureDenoPath: () => Promise.resolve("/unused/deno"),
    getDenoEnv: () => ({}),
    findPublishedVersion: () => Promise.resolve(null),
    getLatestVersionDetail: () => Promise.resolve(null),
  };
}

const source = (exportName: string, type: string) =>
  `export const ${exportName} = { type: "${type}", version: "2026.10.13.1", methods: {} };\n`;

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp_3338_push_" }),
  );
  try {
    await fn(repo);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repo, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repo, { recursive: true });
    }
  }
}

async function write(path: string, content: string): Promise<string> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, content);
  return path;
}

const manifest = (key: "models" | "behaviors", entries: string[]) =>
  parseExtensionManifest(JSON.stringify({
    manifestVersion: 1,
    name: "@acme/spelled",
    version: "2026.10.13.1",
    [key]: entries,
  }));

Deno.test("push: behaviors-dir sources, includes and a models-dir file resolved beside them all pack under models/", async () => {
  await withRepo(async (repo) => {
    const modelsDir = join(repo, "extensions", "models");
    const behaviorsDir = join(repo, "extensions", "behaviors");
    const entry = await write(
      join(behaviorsDir, "aws", "ec2.ts"),
      source("behavior", "@acme/ec2"),
    );
    const helper = await write(
      join(behaviorsDir, "aws", "lib.ts"),
      "export const x = 1;\n",
    );
    const include = await write(join(behaviorsDir, "aws", "data.json"), "{}");
    // A model a workflow references, resolved from the models directory.
    const fromWorkflow = await write(
      join(modelsDir, "acme", "wf", "model.ts"),
      source("model", "@acme/wf"),
    );
    const prepared = await extensionPushPrepare(
      createLibSwampContext(),
      deps(),
      buildPrepareInput(manifest("behaviors", ["aws/ec2.ts"]), repo, {
        modelsDir,
        behaviorsDir,
        modelEntryPoints: [entry],
        allModelFiles: [entry, helper, fromWorkflow],
        includeFilePaths: [include],
        registryChecks: "skip",
        localGates: "collect",
      }),
    );
    const entries = (await listTarGzEntries(
      ReadableStream.from([prepared.archiveBytes]),
    )).filter((e) => !e.endsWith("/")).sort();
    assertEquals(entries, [
      "extension/bundles/aws/ec2.js",
      "extension/manifest.yaml",
      "extension/models/acme/wf/model.ts",
      "extension/models/aws/data.json",
      "extension/models/aws/ec2.ts",
      "extension/models/aws/lib.ts",
    ]);
    assert(entries.every((e) => !e.includes("..")));
    assertEquals(
      prepared.contentMetadata?.models.map((m) => [m.fileName, m.type]),
      // Forward slashes on every OS: the registry receives this verbatim.
      [["aws/ec2.ts", "@acme/ec2"]],
    );
    const spelled = prepared.reviewRulesResult.warnings.filter((w) =>
      w.ruleId === "behavior-spelling"
    );
    assertEquals(spelled.length, 1);
    assertStringIncludes(spelled[0].message, "the behaviors: manifest key");
    assertStringIncludes(
      spelled[0].message,
      "the extensions/behaviors/ directory",
    );
    assertStringIncludes(
      spelled[0].message,
      "export const behavior in 1 entry point",
    );
  });
});

Deno.test("push: a models/ and a behaviors/ file packing to one archive path are refused", async () => {
  await withRepo(async (repo) => {
    const modelsDir = join(repo, "extensions", "models");
    const behaviorsDir = join(repo, "extensions", "behaviors");
    const entry = await write(
      join(behaviorsDir, "thing.ts"),
      source("behavior", "@acme/thing"),
    );
    const clash = await write(
      join(modelsDir, "thing.ts"),
      source("model", "@acme/other"),
    );
    let thrown: unknown;
    try {
      await extensionPushPrepare(
        createLibSwampContext(),
        deps(),
        buildPrepareInput(manifest("behaviors", ["thing.ts"]), repo, {
          modelsDir,
          behaviorsDir,
          modelEntryPoints: [entry],
          allModelFiles: [entry, clash],
          registryChecks: "skip",
          localGates: "collect",
        }),
      );
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as SwampError | undefined)?.message ?? "";
    assertStringIncludes(message, "would both be packed as models/thing.ts");
    assertStringIncludes(message, entry);
    assertStringIncludes(message, clash);
  });
});

Deno.test("push: a model-spelled extension reports no behavior-spelling finding", async () => {
  await withRepo(async (repo) => {
    const modelsDir = join(repo, "extensions", "models");
    const entry = await write(
      join(modelsDir, "thing.ts"),
      'export const behavior = "strict";\n' + source("model", "@acme/thing"),
    );
    const prepared = await extensionPushPrepare(
      createLibSwampContext(),
      deps(),
      buildPrepareInput(manifest("models", ["thing.ts"]), repo, {
        modelsDir,
        modelEntryPoints: [entry],
        allModelFiles: [entry],
        registryChecks: "skip",
        localGates: "collect",
      }),
    );
    assertEquals(
      prepared.reviewRulesResult.warnings.map((w) => w.ruleId),
      [],
    );
  });
});
