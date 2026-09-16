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

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import {
  parseExtensionManifest,
  type PublishVisibility,
  resolvePublishVisibility,
} from "../src/domain/extensions/extension_manifest.ts";
import {
  computePackageCacheHash,
  ExtensionPackageCache,
} from "../src/domain/extensions/extension_package_cache.ts";
import { extractTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { ExtensionApiClient } from "../src/infrastructure/http/extension_api_client.ts";
import {
  createLibSwampContext,
  extensionPush,
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
  RUBRIC_VERSION,
} from "../src/libswamp/mod.ts";

const selections: Array<{
  name: string;
  declared?: PublishVisibility;
  cli?: PublishVisibility;
  expected?: PublishVisibility;
}> = [
  { name: "omitted" },
  { name: "manifest private", declared: "private", expected: "private" },
  { name: "CLI private", cli: "private", expected: "private" },
  {
    name: "both private",
    declared: "private",
    cli: "private",
    expected: "private",
  },
  { name: "manifest public", declared: "public", expected: "public" },
  { name: "CLI public", cli: "public", expected: "public" },
  {
    name: "CLI public overrides private",
    declared: "private",
    cli: "public",
    expected: "public",
  },
  {
    name: "CLI private overrides public",
    declared: "public",
    cli: "private",
    expected: "private",
  },
];

for (
  const { name: selection, declared: declaredVisibility, cli, expected }
    of selections
) {
  Deno.test(`extension publication: ${selection} visibility survives packaging, cache and HTTP`, async () => {
    const root = await Deno.makeTempDir();
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let uploaded: Uint8Array | undefined;
    const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/upload") {
        uploaded = new Uint8Array(await req.arrayBuffer());
        return new Response(null, { status: 200 });
      }
      const body = await req.json() as Record<string, unknown>;
      requests.push({ path: url.pathname, body });
      if (body.visibility !== undefined && body.visibility !== "private") {
        return Response.json({
          error: 'visibility must be "private" when provided',
        }, { status: 400 });
      }
      if (url.pathname === "/api/v1/extensions/push") {
        return Response.json({
          uploadUrl: new URL("/upload", url).href,
          s3Key: "test-key",
          extensionId: "test-extension",
        });
      }
      if (url.pathname === "/api/v1/extensions/confirm") {
        // Model the upgraded registry's first-publish public-collective contract.
        return Response.json({
          name: body.name,
          version: body.version,
          extensionId: "test-extension",
          visibility: body.visibility ?? "public",
        }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    });
    try {
      const source = join(root, "model.ts");
      await Deno.writeTextFile(source, "export const model = {};\n");
      const declared = parseExtensionManifest(JSON.stringify({
        manifestVersion: 1,
        name: "@public-collective/internal",
        version: "2026.09.16.1",
        repository: "https://example.com/repo",
        models: ["model.ts"],
        ...(declaredVisibility ? { visibility: declaredVisibility } : {}),
      }));
      const manifest = {
        ...declared,
        visibility: resolvePublishVisibility(
          declared.visibility,
          cli,
        ),
      };
      const input: ExtensionPushPrepareInput = {
        manifest,
        repoDir: root,
        modelsDir: root,
        allModelFiles: [source],
        modelEntryPoints: [source],
        vaultsDir: root,
        allVaultFiles: [],
        vaultEntryPoints: [],
        datastoresDir: root,
        allDatastoreFiles: [],
        datastoreEntryPoints: [],
        reportsDir: root,
        allReportFiles: [],
        reportEntryPoints: [],
        workflowFiles: [],
        skillDirs: [],
        allSkillFiles: [],
        includeFilePaths: [],
        additionalFilePaths: [],
        binaryFilePaths: [],
        dryRun: true,
      };
      let bundles = 0;
      const prepareDeps: ExtensionPushPrepareDeps = {
        loadCredentials: () => Promise.resolve(null),
        fetchCollectives: () => Promise.resolve(["public-collective"]),
        extractContentMetadata: () =>
          Promise.resolve({
            models: [],
            extensions: [],
            workflows: [],
            vaults: [],
            datastores: [],
            reports: [],
            skills: [],
          }),
        analyzeExtensionSafety: () =>
          Promise.resolve({ errors: [], warnings: [] }),
        checkExtensionQuality: () =>
          Promise.resolve({ passed: true, issues: [] }),
        extractDependencySpecifiers: () => Promise.resolve([]),
        checkDependencyTrust: () =>
          Promise.resolve({
            errors: [],
            warnings: [],
            audited: [],
            passed: true,
          }),
        checkReviewRules: () =>
          Promise.resolve({ errors: [], warnings: [], passed: true }),
        bundleEntryPoint: () => {
          bundles++;
          return Promise.resolve("export const model = {};\n");
        },
        ensureDenoPath: () => Promise.resolve("unused-deno"),
        getDenoEnv: () => ({}),
        getLatestVersion: () => Promise.resolve(null),
        getLatestVersionDetail: () => Promise.resolve(null),
      };
      const hashInput = {
        manifest,
        rootDir: root,
        modelFilePaths: [source],
        vaultFilePaths: [],
        datastoreFilePaths: [],
        reportFilePaths: [],
        workflowFilePaths: [],
        additionalFilePaths: [],
        binaryFilePaths: [],
        skillFilePaths: [],
        includeFilePaths: [],
        denoConfigPath: undefined,
        packageJsonPath: undefined,
      };
      const cache = new ExtensionPackageCache(join(root, "cache"));
      const hash = await computePackageCacheHash(hashInput);
      const omittedHash = await computePackageCacheHash({
        ...hashInput,
        manifest: { ...manifest, visibility: undefined },
      });
      if (expected) assertNotEquals(hash, omittedHash);
      else assertEquals(hash, omittedHash);

      const ctx = createLibSwampContext();
      const prepared = await extensionPushPrepare(ctx, prepareDeps, input);
      assertEquals(prepared.resolvedData.visibility, expected ?? "default");
      assertEquals(requests, []);
      await cache.put(hash, prepared.archiveBytes, {
        extensionName: manifest.name,
        extensionVersion: manifest.version,
        rubricVersion: RUBRIC_VERSION,
      });
      if (expected) assertEquals(await cache.get(omittedHash), null);
      const cached = await cache.get(hash);
      assert(cached);
      const reused = await extensionPushPrepare(ctx, prepareDeps, {
        ...input,
        cachedArchive: cached.archiveBytes,
      });
      assertEquals(bundles, 1);
      const extracted = join(root, "extracted");
      await extractTarGz(
        new Blob([new Uint8Array(reused.archiveBytes)]).stream(),
        extracted,
      );
      const archived = parseExtensionManifest(
        await Deno.readTextFile(join(extracted, "extension", "manifest.yaml")),
      );
      assertEquals(archived.visibility, expected);
      assertEquals(
        declared.visibility,
        declaredVisibility,
      );

      const serverUrl = `http://localhost:${server.addr.port}`;
      const client = new ExtensionApiClient(serverUrl);
      const events = [];
      for await (
        const event of extensionPush(ctx, {
          loadCredentials: () =>
            Promise.resolve({ serverUrl, apiKey: "test-key" }),
          initiatePush: (_server, metadata, key) =>
            client.initiatePush(metadata, key),
          uploadArchive: (url, archive) => client.uploadArchive(url, archive),
          confirmPush: (_server, metadata, key) =>
            client.confirmPush(metadata, key),
          getExtensionVisibility: () => {
            throw new Error("Confirmation is authoritative");
          },
        }, reused)
      ) events.push(event);
      assertEquals(requests.map((request) => request.path), [
        "/api/v1/extensions/push",
        "/api/v1/extensions/confirm",
      ]);
      for (const request of requests) {
        assertEquals(
          request.body.visibility,
          expected === "private" ? "private" : undefined,
        );
        assertEquals("visibility" in request.body, expected === "private");
      }
      assertEquals(uploaded, reused.archiveBytes);
      const last = events.at(-1);
      assertEquals(last?.kind, "completed");
      if (last?.kind === "completed") {
        assertEquals(last.data.visibility, expected ?? "public");
      }
    } finally {
      await server.shutdown();
      if (Deno.build.os === "windows") {
        await Deno.remove(root, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(root, { recursive: true });
      }
    }
  });
}
