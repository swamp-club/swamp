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
 * A private publication refused on entitlement names the collective, the
 * plan the registry reported for it and what it needs, in the dry run and in
 * the real push alike, from the one whoami call the push already makes.
 *
 * The prepare deps are the real factory's, with credentials supplied as a
 * literal so the operator's auth.json is never read, pointed at a port-0
 * registry that answers whoami, the versions list and the push initiation.
 * Packaging is faked, as in extension_publish_visibility_test.ts.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { parseExtensionManifest } from "../src/domain/extensions/extension_manifest.ts";
import { ExtensionApiClient } from "../src/infrastructure/http/extension_api_client.ts";
import { createApiCallRecorder } from "../src/infrastructure/http/recording_fetcher.ts";
import {
  createExtensionPushPrepareDeps,
  extensionPush,
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
} from "../src/libswamp/extensions/push.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import type { SwampError } from "../src/libswamp/errors.ts";

const REFUSAL =
  "Private publication requires a paid plan or an eligible collective trial";

interface Registry {
  serverUrl: string;
  requests: string[];
  shutdown: () => Promise<void>;
}

/** A registry that reports `entitlements` from whoami and refuses private pushes. */
function serveRegistry(
  entitlements: Record<string, unknown>[] | undefined,
): Registry {
  const requests: string[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/api/whoami") {
      return Response.json({
        authenticated: true,
        id: "u1",
        username: "seth",
        organizations: [
          { slug: "acme", name: "Acme", role: "owner", personal: false },
        ],
        ...(entitlements ? { collectiveEntitlements: entitlements } : {}),
      });
    }
    if (url.pathname.endsWith("/versions")) {
      return Response.json({
        versions: [],
        meta: { page: 1, perPage: 100, total: 0 },
      });
    }
    if (url.pathname === "/api/v1/extensions/push") {
      return Response.json({ error: REFUSAL }, { status: 403 });
    }
    return new Response(null, { status: 404 });
  });
  return {
    serverUrl: `http://localhost:${server.addr.port}`,
    requests,
    shutdown: () => server.shutdown(),
  };
}

async function withScenario(
  entitlements: Record<string, unknown>[] | undefined,
  run: (scenario: {
    registry: Registry;
    deps: ExtensionPushPrepareDeps;
    input: (registryChecks: "collect" | "enforce") => ExtensionPushPrepareInput;
    root: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  const registry = serveRegistry(entitlements);
  try {
    const source = join(root, "model.ts");
    await Deno.writeTextFile(source, "export const model = {};\n");
    const manifest = parseExtensionManifest(JSON.stringify({
      manifestVersion: 1,
      name: "@acme/internal",
      version: "2026.10.06.1",
      repository: "https://example.com/repo",
      models: ["model.ts"],
      visibility: "private",
    }));
    const real = createExtensionPushPrepareDeps(undefined, {
      recorder: createApiCallRecorder(),
      fetch: (input, init) => fetch(input, init),
    });
    const deps: ExtensionPushPrepareDeps = {
      loadCredentials: () =>
        Promise.resolve({
          serverUrl: registry.serverUrl,
          apiKey: "swamp_test",
          username: "seth",
        }),
      fetchCollectives: real.fetchCollectives,
      findPublishedVersion: real.findPublishedVersion,
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
      bundleEntryPoint: () => Promise.resolve("export const model = {};\n"),
      ensureDenoPath: () => Promise.resolve("unused-deno"),
      getDenoEnv: () => ({}),
      getLatestVersionDetail: () => Promise.resolve(null),
    };
    const input = (
      registryChecks: "collect" | "enforce",
    ): ExtensionPushPrepareInput => ({
      manifest,
      repoDir: root,
      manifestDir: root,
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
      webhooksDir: root,
      allWebhookFiles: [],
      webhookEntryPoints: [],
      workflowFiles: [],
      skillDirs: [],
      allSkillFiles: [],
      includeFilePaths: [],
      additionalFilePaths: [],
      binaryFilePaths: [],
      dryRun: registryChecks === "collect",
      registryChecks,
    });
    await run({ registry, deps, input, root });
  } finally {
    await registry.shutdown();
    if (Deno.build.os === "windows") {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(root, { recursive: true });
    }
  }
}

const ctx = createLibSwampContext();

async function filesUnder(root: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(root)) names.push(entry.name);
  return names.sort();
}

Deno.test("extension push entitlement: a free collective whose trial ended is refused in the dry run and the push alike, from one whoami call", async () => {
  await withScenario([{
    slug: "acme",
    plan: "free",
    planName: "Free",
    subscriptionStatus: null,
    trial: {
      state: "expired",
      startedAt: "2026-07-20T00:00:00.000Z",
      endsAt: "2026-08-19T00:00:00.000Z",
      daysRemaining: 0,
    },
  }], async ({ registry, deps, input, root }) => {
    const expected =
      'Collective "@acme" is on the Free plan and its trial ended on 2026-08-19. ' +
      `Private publication requires a paid plan; upgrade at ${registry.serverUrl}/o/acme/billing.`;

    const dryRun = await extensionPushPrepare(ctx, deps, input("collect"));
    const check = dryRun.registryChecks.find((c) =>
      c.name === "private-entitlement"
    );
    assertEquals(check?.status, "failed");
    assertEquals(check?.message, expected);
    assertEquals(registry.requests, [
      "GET /api/whoami",
      "GET /api/v1/extensions/%40acme%2Finternal/versions",
    ]);

    registry.requests.length = 0;
    const error = await assertRejects(() =>
      extensionPushPrepare(ctx, deps, input("enforce"))
    ) as SwampError;
    assertEquals(error.code, "validation_failed");
    assertEquals(error.message, expected);
    // The push stopped at the check: one whoami, no versions, no upload.
    assertEquals(registry.requests, ["GET /api/whoami"]);
    // Entitlement lives in the prepared result only; nothing reached disk.
    assertEquals(await filesUnder(root), ["model.ts"]);
  });
});

Deno.test("extension push entitlement: a paid collective passes the check and the push proceeds to the registry", async () => {
  await withScenario([{
    slug: "acme",
    plan: "team",
    planName: "Team",
    subscriptionStatus: "active",
    trial: null,
  }], async ({ registry, deps, input }) => {
    const prepared = await extensionPushPrepare(ctx, deps, input("enforce"));
    assertEquals(
      prepared.registryChecks.map((c) => [c.name, c.status]),
      [
        ["authentication", "passed"],
        ["reserved-collective", "passed"],
        ["collective-membership", "passed"],
        ["private-entitlement", "passed"],
        ["version-exists", "passed"],
      ],
    );
    assertEquals<unknown>(prepared.collectiveEntitlement, {
      slug: "acme",
      plan: "team",
      planName: "Team",
      subscriptionStatus: "active",
      trial: null,
    });
    assertEquals(registry.requests.length, 2);
  });
});

Deno.test("extension push entitlement: a registry that reports no entitlement leaves the check undecided, and its refusal says so", async () => {
  await withScenario(undefined, async ({ registry, deps, input }) => {
    const prepared = await extensionPushPrepare(ctx, deps, input("enforce"));
    const check = prepared.registryChecks.find((c) =>
      c.name === "private-entitlement"
    );
    assertEquals(check?.status, "not-run");
    assertEquals(check?.cause, "entitlement-undecided");
    assertEquals(prepared.collectiveEntitlement, undefined);

    const client = new ExtensionApiClient(registry.serverUrl);
    const events = [];
    for await (
      const event of extensionPush(ctx, {
        loadCredentials: () =>
          Promise.resolve({
            serverUrl: registry.serverUrl,
            apiKey: "swamp_test",
          }),
        initiatePush: (_server, metadata, key) =>
          client.initiatePush(metadata, key),
        uploadArchive: () => {
          throw new Error("initiation was refused; nothing to upload");
        },
        confirmPush: () => {
          throw new Error("initiation was refused; nothing to confirm");
        },
        getExtensionVisibility: () => Promise.resolve(null),
      }, {
        manifest: prepared.manifest,
        archiveBytes: prepared.archiveBytes,
        contentMetadata: prepared.contentMetadata,
        counts: prepared.counts,
        collectiveEntitlement: prepared.collectiveEntitlement,
      })
    ) events.push(event);
    const last = events.at(-1);
    assertEquals(last?.kind, "error");
    if (last?.kind === "error") {
      assertEquals(
        last.error.message,
        `${REFUSAL}. At sign-in the registry did not report entitlement for "@acme".`,
      );
    }
    assertEquals(registry.requests.at(-1), "POST /api/v1/extensions/push");
  });
});
