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
 * Declared acceptances, end to end on a real temp filesystem: the
 * quality.yaml sidecar beside the manifest is packaged at the archive root
 * beside manifest.yaml, byte for byte; the content hash moves when the
 * sidecar changes; and a sidecar that names a file outside the manifest's
 * directory is refused before any gate runs.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { join } from "@std/path";
import { parseExtensionManifest } from "../src/domain/extensions/extension_manifest.ts";
import { computePackageCacheHash } from "../src/domain/extensions/extension_package_cache.ts";
import { extractTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import {
  createLibSwampContext,
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
} from "../src/libswamp/mod.ts";
import { buildPrepareInput } from "../src/libswamp/extensions/push_test_helpers.ts";

const MANIFEST = [
  "manifestVersion: 1",
  'name: "@acme/accepting"',
  'version: "2026.10.06.1"',
  "description: declared acceptances fixture",
  "models:",
  "  - model.ts",
  "",
].join("\n");

const SIDECAR = [
  "version: 1",
  "generated:",
  "  by: swamp-extensions/codegen",
  "  source: https://api.example.com/openapi.yaml",
  "  commit: 0123abcd",
  "accept:",
  "  - rule: ipv4-address-literals",
  "    file: docs/hosts.txt",
  "    reason: documented lab addresses",
  "",
].join("\n");

function fakeDeps(): ExtensionPushPrepareDeps {
  return {
    loadCredentials: () => Promise.resolve(null),
    fetchCollectives: () =>
      Promise.resolve({ collectives: ["acme"], entitlements: undefined }),
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
}

async function withExtension(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "acceptances-" });
  try {
    await Deno.writeTextFile(join(root, "manifest.yaml"), MANIFEST);
    await Deno.writeTextFile(
      join(root, "model.ts"),
      "export const model = { name: 'thing' };\n",
    );
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

function hashInput(
  root: string,
  manifest: ReturnType<typeof parseExtensionManifest>,
) {
  return {
    manifest,
    rootDir: root,
    manifestDir: root,
    modelFilePaths: [join(root, "model.ts")],
    vaultFilePaths: [],
    datastoreFilePaths: [],
    reportFilePaths: [],
    webhookFilePaths: [],
    workflowFilePaths: [],
    additionalFilePaths: [],
    binaryFilePaths: [],
    skillFilePaths: [],
    includeFilePaths: [],
    denoConfigPath: undefined,
    packageJsonPath: undefined,
  };
}

Deno.test("declared acceptances: quality.yaml beside the manifest is packaged at the archive root, byte for byte", async () => {
  await withExtension(async (root) => {
    await Deno.writeTextFile(join(root, "quality.yaml"), SIDECAR);
    const manifest = parseExtensionManifest(MANIFEST);
    const input = buildPrepareInput(manifest, root, {
      modelsDir: root,
      allModelFiles: [join(root, "model.ts")],
      modelEntryPoints: [join(root, "model.ts")],
      registryChecks: "skip",
    });
    const prepared = await extensionPushPrepare(
      createLibSwampContext(),
      fakeDeps(),
      input,
    );
    assert(prepared.sidecar);
    assertEquals(
      prepared.sidecar.value.generated?.by,
      "swamp-extensions/codegen",
    );

    const extracted = join(root, "extracted");
    await extractTarGz(
      new Blob([new Uint8Array(prepared.archiveBytes)]).stream(),
      extracted,
    );
    const packaged = await Deno.readTextFile(
      join(extracted, "extension", "quality.yaml"),
    );
    assertEquals(packaged, SIDECAR);
    // Beside the manifest, not under files/.
    await Deno.stat(join(extracted, "extension", "manifest.yaml"));
  });
});

Deno.test("declared acceptances: the content hash moves when the sidecar appears or changes", async () => {
  await withExtension(async (root) => {
    const manifest = parseExtensionManifest(MANIFEST);
    const without = await computePackageCacheHash(hashInput(root, manifest));
    await Deno.writeTextFile(join(root, "quality.yaml"), SIDECAR);
    const withSidecar = await computePackageCacheHash(
      hashInput(root, manifest),
    );
    assertNotEquals(without, withSidecar);
    await Deno.writeTextFile(
      join(root, "quality.yaml"),
      SIDECAR.replace("lab addresses", "test addresses"),
    );
    const changed = await computePackageCacheHash(hashInput(root, manifest));
    assertNotEquals(withSidecar, changed);
  });
});

Deno.test("declared acceptances: a sidecar with a traversal path is refused before any gate runs", async () => {
  await withExtension(async (root) => {
    await Deno.writeTextFile(
      join(root, "quality.yaml"),
      "version: 1\naccept:\n  - rule: ipv4-address-literals\n    file: ../hosts.txt\n    reason: r\n",
    );
    const manifest = parseExtensionManifest(MANIFEST);
    let gatesRan = 0;
    const deps = fakeDeps();
    deps.analyzeExtensionSafety = () => {
      gatesRan++;
      return Promise.resolve({ errors: [], warnings: [] });
    };
    const input = buildPrepareInput(manifest, root, {
      modelsDir: root,
      allModelFiles: [join(root, "model.ts")],
      modelEntryPoints: [join(root, "model.ts")],
      registryChecks: "skip",
    });
    const error = await assertRejects(() =>
      extensionPushPrepare(createLibSwampContext(), deps, input)
    ) as { code: string; message: string };
    assertEquals(error.code, "validation_failed");
    assert(error.message.includes("quality.yaml"));
    assertEquals(gatesRan, 0);
  });
});
