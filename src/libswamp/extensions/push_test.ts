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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { Logger } from "@logtape/logtape";
import {
  createExtensionPushPrepareDeps,
  extensionPush,
  type ExtensionPushExecuteDeps,
  type ExtensionPushExecuteInput,
  type ExtensionPushMetadata,
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
} from "./push.ts";
import { notAuthenticated, type SwampError } from "../errors.ts";
import { createApiCallRecorder } from "../../infrastructure/http/recording_fetcher.ts";
import type { ExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { MAX_EXTENSION_ARCHIVE_BYTES } from "../../domain/extensions/extension_archive_limits.ts";

function makeManifest(
  overrides?: Partial<ExtensionManifest>,
): ExtensionManifest {
  return {
    manifestVersion: 1,
    name: "@testuser/test-ext",
    version: "2026.03.22.1",
    description: "Test extension",
    repository: undefined,
    paths: { base: "typedDir" },
    workflows: [],
    models: ["echo.ts"],
    vaults: [],
    datastores: [],
    reports: [],
    webhooks: [],
    skills: [],
    include: [],
    additionalFiles: [],
    binaries: [],
    platforms: [],
    labels: [],
    releaseNotes: undefined,
    dependencies: [],
    ...overrides,
  };
}

function makePrepareInput(
  overrides?: Partial<ExtensionPushPrepareInput>,
): ExtensionPushPrepareInput {
  const dryRun = overrides?.dryRun ?? true;
  return {
    manifest: makeManifest(),
    repoDir: "/tmp/test-repo",
    modelsDir: "/tmp/test-repo/models",
    allModelFiles: [],
    modelEntryPoints: [],
    vaultsDir: "/tmp/test-repo/vaults",
    allVaultFiles: [],
    vaultEntryPoints: [],
    datastoresDir: "/tmp/test-repo/datastores",
    allDatastoreFiles: [],
    datastoreEntryPoints: [],
    reportsDir: "/tmp/test-repo/reports",
    allReportFiles: [],
    reportEntryPoints: [],
    webhooksDir: "/tmp/test-repo/webhooks",
    allWebhookFiles: [],
    webhookEntryPoints: [],
    workflowFiles: [],
    skillDirs: [],
    allSkillFiles: [],
    includeFilePaths: [],
    additionalFilePaths: [],
    binaryFilePaths: [],
    dryRun,
    registryChecks: dryRun ? "collect" : "enforce",
    ...overrides,
  };
}

function makePrepareDeps(
  overrides?: Partial<ExtensionPushPrepareDeps>,
): ExtensionPushPrepareDeps {
  return {
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.swamp-club.com",
        apiKey: "swamp_test",
        username: "testuser",
      }),
    fetchCollectives: () => Promise.resolve(["testuser"]),
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
    bundleEntryPoint: () => Promise.resolve("/* bundled */"),
    ensureDenoPath: () => Promise.resolve("/usr/bin/deno"),
    getDenoEnv: () => Deno.env.toObject(),
    findPublishedVersion: () => Promise.resolve(null),
    getLatestVersionDetail: () => Promise.resolve(null),
    ...overrides,
  };
}

function makeExecuteDeps(
  overrides?: Partial<ExtensionPushExecuteDeps>,
): ExtensionPushExecuteDeps {
  return {
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.swamp-club.com",
        apiKey: "swamp_test",
      }),
    initiatePush: () =>
      Promise.resolve({
        uploadUrl: "https://s3.example.com/upload",
      }),
    uploadArchive: () => Promise.resolve(),
    confirmPush: () =>
      Promise.resolve({
        name: "@testuser/test-ext",
        version: "2026.03.22.1",
        extensionId: "ext-123",
      }),
    getExtensionVisibility: () => Promise.resolve({ isPrivate: false }),
    ...overrides,
  };
}

function makeExecuteInput(
  overrides?: Partial<ExtensionPushExecuteInput>,
): ExtensionPushExecuteInput {
  return {
    manifest: makeManifest(),
    archiveBytes: new Uint8Array([0x1F, 0x8B, 0x00]),
    contentMetadata: undefined,
    counts: {
      models: 1,
      workflows: 0,
      bundles: 1,
      vaults: 0,
      datastores: 0,
      reports: 0,
      webhooks: 0,
      skills: 0,
    },
    ...overrides,
  };
}

const ctx = createLibSwampContext();

Deno.test("extensionPush: sends private intent to both phases and uses applied visibility", async () => {
  const requests: ExtensionPushMetadata[] = [];
  const deps = makeExecuteDeps({
    initiatePush: (_url, metadata) => {
      requests.push(metadata);
      return Promise.resolve({ uploadUrl: "https://example.com/upload" });
    },
    confirmPush: (_url, metadata) => {
      requests.push(metadata);
      return Promise.resolve({
        name: metadata.name,
        version: metadata.version,
        extensionId: "ext-private",
        visibility: "private",
      });
    },
    getExtensionVisibility: () => {
      throw new Error("Confirmed visibility must not use a lookup");
    },
  });
  // Reusing the effective manifest after a version bump retains private intent.
  const manifest = makeManifest({ visibility: "private" });
  for (const version of ["2026.09.16.1", "2026.09.16.2"]) {
    const events = await collect(extensionPush(
      ctx,
      deps,
      makeExecuteInput({
        manifest: { ...manifest, version },
      }),
    ));
    const completed = events.at(-1);
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.visibility, "private");
      assertEquals(completed.data.version, version);
    }
  }
  assertEquals(requests.map((request) => request.visibility), [
    "private",
    "private",
    "private",
    "private",
  ]);
});

for (const visibility of [undefined, "public"] as const) {
  Deno.test(`extensionPush: private intent rejects ${visibility} confirmation without fallback`, async () => {
    let lookups = 0;
    const events = await collect(extensionPush(
      ctx,
      makeExecuteDeps({
        confirmPush: () =>
          Promise.resolve({
            name: "@testuser/test-ext",
            version: "2026.09.16.1",
            extensionId: "ext-123",
            visibility,
          }),
        getExtensionVisibility: () => {
          lookups++;
          return Promise.resolve({ isPrivate: true });
        },
      }),
      makeExecuteInput({ manifest: makeManifest({ visibility: "private" }) }),
    ));
    const last = events.at(-1);
    assertEquals(last?.kind, "error");
    if (last?.kind === "error") {
      assertStringIncludes(last.error.message, "did not confirm private");
      assertStringIncludes(last.error.message, "before retrying");
    }
    assertEquals(lookups, 0);
    assertEquals(events.some((event) => event.kind === "completed"), false);
  });
}

Deno.test("extensionPush: omitted intent sends no visibility and prefers confirmation", async () => {
  const requests: ExtensionPushMetadata[] = [];
  let lookups = 0;
  const events = await collect(extensionPush(
    ctx,
    makeExecuteDeps({
      initiatePush: (_url, metadata) => {
        requests.push(metadata);
        return Promise.resolve({ uploadUrl: "https://example.com/upload" });
      },
      confirmPush: (_url, metadata) => {
        requests.push(metadata);
        return Promise.resolve({
          name: metadata.name,
          version: metadata.version,
          extensionId: "ext-123",
          visibility: "private",
        });
      },
      getExtensionVisibility: () => {
        lookups++;
        return Promise.resolve({ isPrivate: false });
      },
    }),
    makeExecuteInput(),
  ));
  assertEquals(requests.length, 2);
  assertEquals(requests.map((request) => "visibility" in request), [
    false,
    false,
  ]);
  assertEquals(lookups, 0);
  const last = events.at(-1);
  assertEquals(last?.kind, "completed");
  if (last?.kind === "completed") assertEquals(last.data.visibility, "private");
});

for (const confirmed of [true, false]) {
  Deno.test(`extensionPush: public uses registry defaults and reports actual private visibility (${confirmed ? "confirmation" : "legacy lookup"})`, async () => {
    const requests: ExtensionPushMetadata[] = [];
    let lookups = 0;
    const events = await collect(extensionPush(
      ctx,
      makeExecuteDeps({
        initiatePush: (_url, metadata) => {
          requests.push(metadata);
          return Promise.resolve({ uploadUrl: "https://example.com/upload" });
        },
        confirmPush: (_url, metadata) => {
          requests.push(metadata);
          return Promise.resolve({
            name: metadata.name,
            version: metadata.version,
            extensionId: "ext-private",
            ...(confirmed ? { visibility: "private" as const } : {}),
          });
        },
        getExtensionVisibility: () => {
          lookups++;
          return Promise.resolve({ isPrivate: true });
        },
      }),
      makeExecuteInput({ manifest: makeManifest({ visibility: "public" }) }),
    ));
    assertEquals(requests.map((request) => "visibility" in request), [
      false,
      false,
    ]);
    assertEquals(lookups, confirmed ? 0 : 1);
    const last = events.at(-1);
    assertEquals(last?.kind, "completed");
    if (last?.kind === "completed") {
      assertEquals(last.data.visibility, "private");
    }
  });
}

for (const phase of ["initiate", "confirm"] as const) {
  Deno.test(`extensionPush: private ${phase} denial never retries without privacy`, async () => {
    const calls: string[] = [];
    const events = await collect(extensionPush(
      ctx,
      makeExecuteDeps({
        initiatePush: () => {
          calls.push("initiate");
          if (phase === "initiate") {
            throw new Error("Private publication denied (HTTP 403)");
          }
          return Promise.resolve({ uploadUrl: "https://example.com/upload" });
        },
        uploadArchive: () => {
          calls.push("upload");
          return Promise.resolve();
        },
        confirmPush: () => {
          calls.push("confirm");
          throw new Error("Private publication denied (HTTP 409)");
        },
      }),
      makeExecuteInput({ manifest: makeManifest({ visibility: "private" }) }),
    ));
    assertEquals(
      calls,
      phase === "initiate" ? ["initiate"] : ["initiate", "upload", "confirm"],
    );
    const last = events.at(-1);
    assertEquals(last?.kind, "error");
    if (last?.kind === "error") {
      assertStringIncludes(last.error.message, "Private publication denied");
    }
  });
}

Deno.test("extensionPush: non-CLI invalid visibility is rejected before I/O", async () => {
  const manifest = {
    ...makeManifest(),
    visibility: "internal",
  } as unknown as ExtensionManifest;
  let calls = 0;
  const events = await collect(extensionPush(
    ctx,
    makeExecuteDeps({
      loadCredentials: () => {
        calls++;
        return Promise.resolve(null);
      },
    }),
    makeExecuteInput({ manifest }),
  ));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "error");
  assertEquals(calls, 0);
  const error = await assertRejects(() =>
    extensionPushPrepare(ctx, makePrepareDeps(), makePrepareInput({ manifest }))
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "visibility");
});

// ── Prepare tests ─────────────────────────────────────────────────────

Deno.test("extensionPushPrepare: not authenticated throws SwampError", async () => {
  const deps = makePrepareDeps({
    loadCredentials: () => Promise.resolve(null),
  });
  const input = makePrepareInput({ dryRun: false });

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, input),
  ) as SwampError;
  assertEquals(error.code, "not_authenticated");
});

Deno.test("extensionPushPrepare: invalid collective throws SwampError", async () => {
  const deps = makePrepareDeps({
    fetchCollectives: () => Promise.resolve(["other-collective"]),
  });
  const input = makePrepareInput({ dryRun: false });

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, input),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
});

Deno.test("extensionPushPrepare: collective token allows matching collective namespace", async () => {
  const deps = makePrepareDeps({
    fetchCollectives: () => Promise.resolve(["testuser"]),
  });
  const input = makePrepareInput({ dryRun: false });

  const result = await extensionPushPrepare(ctx, deps, input);
  assertEquals(result.manifest.name, "@testuser/test-ext");
});

Deno.test("extensionPushPrepare: collective token rejects mismatched namespace", async () => {
  const deps = makePrepareDeps({
    fetchCollectives: () => Promise.resolve(["other-org"]),
  });
  const input = makePrepareInput({ dryRun: false });

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, input),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
});

Deno.test("extensionPushPrepare: additionalFiles with disallowed extension suggests binaries", async () => {
  const deps = makePrepareDeps();
  const input = makePrepareInput({
    additionalFilePaths: ["/tmp/test-repo/helper.bin"],
    manifest: makeManifest({ additionalFiles: ["helper.bin"] }),
  });

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, input),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "additionalFiles");
  assertStringIncludes(error.message, "binaries");
  assertStringIncludes(error.message, ".bin");
});

Deno.test("extensionPushPrepare: additionalFiles with legal basenames pass pre-check", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const copyingPath = join(tmpDir, "COPYING");
    const licensePath = join(tmpDir, "LICENSE");
    await Deno.writeTextFile(copyingPath, "Legal text\n");
    await Deno.writeTextFile(licensePath, "Legal text\n");

    const deps = makePrepareDeps();
    const input = makePrepareInput({
      repoDir: tmpDir,
      additionalFilePaths: [copyingPath, licensePath],
      manifest: makeManifest({
        additionalFiles: ["COPYING", "LICENSE"],
      }),
      dryRun: true,
    });

    const result = await extensionPushPrepare(ctx, deps, input);
    assertEquals(result.isDryRun, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("extensionPushPrepare: safety errors throw SwampError", async () => {
  const deps = makePrepareDeps({
    analyzeExtensionSafety: () =>
      Promise.resolve({
        errors: [{ file: "evil.ts", message: "contains eval()" }],
        warnings: [],
      }),
  });
  const input = makePrepareInput();

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, input),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
});

Deno.test("extensionPushPrepare: quality failures throw SwampError", async () => {
  const deps = makePrepareDeps({
    checkExtensionQuality: () =>
      Promise.resolve({
        passed: false,
        issues: [{ check: "fmt" as const, output: "bad format" }],
      }),
  });
  const input = makePrepareInput();

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, input),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
});

Deno.test("extensionPushPrepare: dry run returns prepared data", async () => {
  const deps = makePrepareDeps();
  const input = makePrepareInput({ dryRun: true });

  const result = await extensionPushPrepare(ctx, deps, input);
  assertEquals(result.isDryRun, true);
  assertEquals(result.resolvedData.name, "@testuser/test-ext");
  assertEquals(result.safetyWarnings.length, 0);
});

Deno.test("extensionPushPrepare: safety warnings are returned in result", async () => {
  const deps = makePrepareDeps({
    analyzeExtensionSafety: () =>
      Promise.resolve({
        errors: [],
        warnings: [{ file: "cmd.ts", message: "uses Deno.Command()" }],
      }),
  });
  const input = makePrepareInput();

  const result = await extensionPushPrepare(ctx, deps, input);
  assertEquals(result.safetyWarnings.length, 1);
  assertEquals(result.safetyWarnings[0].file, "cmd.ts");
});

Deno.test("extensionPushPrepare: review-rule errors throw SwampError", async () => {
  const deps = makePrepareDeps({
    checkReviewRules: () =>
      Promise.resolve({
        errors: [{
          ruleId: "always-high",
          dimension: "Schema strictness",
          severity: "high" as const,
          file: "model.ts",
          message: "blocking issue",
        }],
        warnings: [],
        passed: false,
      }),
  });
  const input = makePrepareInput();

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, input),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
  assertEquals(
    Array.isArray(
      (error.details as Record<string, unknown>).reviewRuleErrors,
    ),
    true,
  );
});

Deno.test("extensionPushPrepare: review-rule warnings are returned in result", async () => {
  const deps = makePrepareDeps({
    checkReviewRules: () =>
      Promise.resolve({
        errors: [],
        warnings: [{
          ruleId: "testing-completeness",
          dimension: "Testing Completeness",
          severity: "medium" as const,
          file: "model.ts",
          message: "no sibling test",
        }],
        passed: true,
      }),
  });
  const input = makePrepareInput();

  const result = await extensionPushPrepare(ctx, deps, input);
  assertEquals(result.reviewRulesResult.warnings.length, 1);
  assertEquals(
    result.reviewRulesResult.warnings[0].ruleId,
    "testing-completeness",
  );
});

Deno.test("extensionPushPrepare: dry run collects every registry check as passed", async () => {
  const deps = makePrepareDeps();
  const input = makePrepareInput({ dryRun: true, contentHash: "abc123" });

  const result = await extensionPushPrepare(ctx, deps, input);
  assertEquals(result.contentHash, "abc123");
  assertEquals(
    result.registryChecks.map((c) => [c.name, c.status]),
    [
      ["authentication", "passed"],
      ["reserved-collective", "passed"],
      ["collective-membership", "passed"],
      ["version-exists", "passed"],
    ],
  );
  assertEquals(result.registryChecks[0].message, "Signed in as testuser.");
});

Deno.test("extensionPushPrepare: dry run without credentials lists every check as not run and calls nothing", async () => {
  let registryCalls = 0;
  const deps = makePrepareDeps({
    loadCredentials: () => Promise.resolve(null),
    fetchCollectives: () => {
      registryCalls++;
      return Promise.resolve([]);
    },
    findPublishedVersion: () => {
      registryCalls++;
      return Promise.resolve(null);
    },
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true }),
  );
  assertEquals(registryCalls, 0);
  assertEquals(result.registryChecks.length, 4);
  for (const check of result.registryChecks) {
    assertEquals(check.status, "not-run");
    assertEquals(check.cause, "no-credentials");
    assertStringIncludes(check.message, "no credentials");
  }
});

Deno.test("extensionPushPrepare: dry run reports a version published on any channel as failed, without throwing", async () => {
  const deps = makePrepareDeps({
    findPublishedVersion: () =>
      Promise.resolve({ version: "2026.03.22.1", channel: "beta" }),
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true }),
  );
  const check = result.registryChecks.find((c) => c.name === "version-exists");
  assertEquals(check?.status, "failed");
  assertEquals(
    check?.message,
    "Version 2026.03.22.1 already exists for @testuser/test-ext.",
  );
});

Deno.test("extensionPushPrepare: dry run reports a foreign collective as failed and still checks the version", async () => {
  let versionLookups = 0;
  const deps = makePrepareDeps({
    fetchCollectives: () => Promise.resolve(["other-org"]),
    findPublishedVersion: () => {
      versionLookups++;
      return Promise.resolve(null);
    },
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true }),
  );
  const membership = result.registryChecks.find((c) =>
    c.name === "collective-membership"
  );
  assertEquals(membership?.status, "failed");
  assertEquals(
    membership?.message,
    'Extension collective "@testuser" is not one of your collectives (@other-org). ' +
      "Use one of: @other-org",
  );
  assertEquals(versionLookups, 1);
  assertEquals(
    result.registryChecks.find((c) => c.name === "version-exists")?.status,
    "passed",
  );
});

Deno.test("extensionPushPrepare: dry run reports a rejected key as failed authentication and skips the rest", async () => {
  let versionLookups = 0;
  const deps = makePrepareDeps({
    fetchCollectives: () => Promise.reject(notAuthenticated()),
    findPublishedVersion: () => {
      versionLookups++;
      return Promise.resolve(null);
    },
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true }),
  );
  assertEquals(versionLookups, 0);
  assertEquals(
    result.registryChecks.map((c) => [c.name, c.status, c.cause]),
    [
      ["authentication", "failed", undefined],
      ["reserved-collective", "not-run", "authentication-failed"],
      ["collective-membership", "not-run", "authentication-failed"],
      ["version-exists", "not-run", "authentication-failed"],
    ],
  );
  assertEquals(
    result.registryChecks[0].message,
    "Not authenticated. Run 'swamp auth login' to sign in.",
  );
  assertEquals(result.registryChecks[3].message, "authentication failed");
});

Deno.test("extensionPushPrepare: dry run reports authentication as not run when the registry did not answer", async () => {
  const deps = makePrepareDeps({
    fetchCollectives: () => Promise.reject(new Error("fetch failed")),
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true }),
  );
  assertEquals(result.registryChecks[0].status, "not-run");
  assertEquals(result.registryChecks[0].cause, "registry-unavailable");
  assertEquals(
    result.registryChecks[0].message,
    "registry did not answer: fetch failed",
  );
  // A plain collective still passes on the username fallback.
  assertEquals(
    result.registryChecks.find((c) => c.name === "collective-membership")
      ?.status,
    "passed",
  );
});

Deno.test("extensionPushPrepare: dry run reports a failed version lookup as not run", async () => {
  const deps = makePrepareDeps({
    findPublishedVersion: () => Promise.reject(new Error("registry down")),
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true }),
  );
  const check = result.registryChecks.find((c) => c.name === "version-exists");
  assertEquals(check?.status, "not-run");
  assertEquals(check?.cause, "registry-unavailable");
  assertEquals(check?.message, "registry lookup failed: registry down");
});

Deno.test("extensionPushPrepare: push fails authentication on a rejected key instead of falling back to the username", async () => {
  const deps = makePrepareDeps({
    fetchCollectives: () => Promise.reject(notAuthenticated()),
  });

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, makePrepareInput({ dryRun: false })),
  ) as SwampError;
  assertEquals(error.code, "not_authenticated");
});

Deno.test("extensionPushPrepare: push rejects a version published on any channel", async () => {
  const deps = makePrepareDeps({
    findPublishedVersion: () =>
      Promise.resolve({ version: "2026.03.22.1", channel: "rc" }),
  });

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, makePrepareInput({ dryRun: false })),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
  assertEquals(
    error.message,
    "Version 2026.03.22.1 already exists for @testuser/test-ext.",
  );
  assertEquals(
    (error.details as { existingVersion: string }).existingVersion,
    "2026.03.22.1",
  );
});

Deno.test("extensionPushPrepare: skip mode never loads credentials or contacts the registry", async () => {
  let calls = 0;
  const deps = makePrepareDeps({
    loadCredentials: () => {
      calls++;
      return Promise.resolve(null);
    },
    fetchCollectives: () => {
      calls++;
      return Promise.resolve([]);
    },
    findPublishedVersion: () => {
      calls++;
      return Promise.resolve(null);
    },
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true, registryChecks: "skip" }),
  );
  assertEquals(calls, 0);
  assertEquals(result.registryChecks, []);
});

// ── Deps factory tests ────────────────────────────────────────────────

const REGISTRY = "https://registry.test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("createExtensionPushPrepareDeps: findPublishedVersion asks every channel and pages until the version is found", async () => {
  const recorder = createApiCallRecorder();
  const requested: URL[] = [];
  const deps = createExtensionPushPrepareDeps(undefined, {
    recorder,
    fetch: (url) => {
      const u = new URL(String(url));
      requested.push(u);
      const page = Number(u.searchParams.get("page"));
      const versions = page === 1
        ? Array.from({ length: 100 }, (_, i) => ({
          version: `2026.01.01.${i}`,
          channel: "stable",
          publishedAt: "",
        }))
        : [{ version: "2026.03.22.1", channel: "beta", publishedAt: "" }];
      return Promise.resolve(jsonResponse({
        versions,
        meta: { total: 101, page, perPage: 100 },
      }));
    },
  });

  const found = await deps.findPublishedVersion(
    REGISTRY,
    "@testuser/test-ext",
    "2026.03.22.1",
    "swamp_test",
  );
  assertEquals(found, { version: "2026.03.22.1", channel: "beta" });
  assertEquals(requested.length, 2);
  assertEquals(
    requested[0].pathname,
    "/api/v1/extensions/%40testuser%2Ftest-ext/versions",
  );
  assertEquals(requested[0].searchParams.getAll("channel"), [
    "stable",
    "rc",
    "beta",
  ]);
  assertEquals(recorder.calls.map((c) => [c.service, c.method, c.outcome]), [
    ["registry", "GET", "ok"],
    ["registry", "GET", "ok"],
  ]);
});

Deno.test("createExtensionPushPrepareDeps: findPublishedVersion stops at a short page", async () => {
  let pages = 0;
  const deps = createExtensionPushPrepareDeps(undefined, {
    fetch: () => {
      pages++;
      return Promise.resolve(jsonResponse({
        versions: [{
          version: "2026.01.01.1",
          channel: "stable",
          publishedAt: "",
        }],
        meta: { total: 1, page: 1, perPage: 100 },
      }));
    },
  });
  assertEquals(
    await deps.findPublishedVersion(REGISTRY, "@t/e", "2026.03.22.1", "k"),
    null,
  );
  assertEquals(pages, 1);
});

Deno.test("createExtensionPushPrepareDeps: findPublishedVersion does not page a response without paging metadata", async () => {
  let pages = 0;
  const deps = createExtensionPushPrepareDeps(undefined, {
    fetch: () => {
      pages++;
      return Promise.resolve(jsonResponse({
        versions: Array.from({ length: 100 }, (_, i) => ({
          version: `2026.01.01.${i}`,
          channel: "stable",
          publishedAt: "",
        })),
      }));
    },
  });
  assertEquals(
    await deps.findPublishedVersion(REGISTRY, "@t/e", "2026.03.22.1", "k"),
    null,
  );
  assertEquals(pages, 1);
});

Deno.test("createExtensionPushPrepareDeps: findPublishedVersion resolves null for an unpublished extension", async () => {
  const recorder = createApiCallRecorder();
  const deps = createExtensionPushPrepareDeps(undefined, {
    recorder,
    fetch: () => Promise.resolve(new Response("not found", { status: 404 })),
  });
  const found = await deps.findPublishedVersion(
    REGISTRY,
    "@testuser/test-ext",
    "2026.03.22.1",
    "swamp_test",
  );
  assertEquals(found, null);
  assertEquals(recorder.calls.map((c) => c.outcome), ["not-found"]);
});

Deno.test("createExtensionPushPrepareDeps: fetchCollectives fails authentication on whoami's 401 body", async () => {
  const recorder = createApiCallRecorder();
  const deps = createExtensionPushPrepareDeps(undefined, {
    recorder,
    fetch: () => Promise.resolve(jsonResponse({ authenticated: false }, 401)),
  });
  const error = await assertRejects(() =>
    deps.fetchCollectives(REGISTRY, "swamp_stale")
  ) as SwampError;
  assertEquals(error.code, "not_authenticated");
  assertEquals(recorder.calls.map((c) => [c.service, c.outcome]), [
    ["registry", "error"],
  ]);
});

Deno.test("createExtensionPushPrepareDeps: records the npm and OSV calls the trust audit makes, and nothing without npm specifiers", async () => {
  const recorder = createApiCallRecorder();
  let fetches = 0;
  const deps = createExtensionPushPrepareDeps(undefined, {
    recorder,
    fetch: (url) => {
      fetches++;
      const u = new URL(String(url));
      if (u.host === "registry.npmjs.org") {
        return Promise.resolve(jsonResponse({
          "dist-tags": { latest: "3.0.0" },
          versions: {
            "3.0.0": { license: "MIT", maintainers: [{}, {}] },
          },
          time: { "3.0.0": new Date().toISOString() },
        }));
      }
      if (u.host === "api.npmjs.org") {
        return Promise.resolve(jsonResponse({ downloads: 1_000_000 }));
      }
      if (u.host === "api.osv.dev") {
        return Promise.resolve(jsonResponse({ vulns: [] }));
      }
      throw new Error(`unexpected call to ${u.host}`);
    },
  });

  await deps.checkDependencyTrust([]);
  assertEquals(fetches, 0);
  assertEquals(recorder.calls, []);

  await deps.checkDependencyTrust([
    { name: "zod", version: "3.0.0", registry: "npm", sourceFile: "a.ts" },
  ]);
  assertEquals(
    recorder.calls.map((c) => c.service).sort(),
    ["npm", "npm", "osv"],
  );
  for (const call of recorder.calls) {
    assertEquals(
      Object.keys(call).sort(),
      ["method", "outcome", "service", "status", "url"],
    );
  }
});

// ── Push tests ────────────────────────────────────────────────────────

Deno.test("extensionPush: successful push yields completed", async () => {
  const deps = makeExecuteDeps();
  const input = makeExecuteInput();

  const events = await collect(extensionPush(ctx, deps, input));
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.name, "@testuser/test-ext");
    assertEquals(last.data.extensionId, "ext-123");
  }
});

Deno.test("extensionPush: warns when manifest has no repository (non-blocking)", async () => {
  const warnings: string[] = [];
  const mockLogger = {
    debug: () => {},
    info: () => {},
    warn: (line: string) => warnings.push(line),
    error: () => {},
    trace: () => {},
    fatal: () => {},
  } as unknown as Logger;
  const testCtx = createLibSwampContext({ logger: mockLogger });
  const deps = makeExecuteDeps();
  const input = makeExecuteInput({
    manifest: makeManifest({ repository: undefined }),
  });

  const events = await collect(extensionPush(testCtx, deps, input));
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed"); // Warning does not block push.
  assertEquals(warnings.length, 1);
  assertStringIncludes(
    warnings[0],
    "doesn't declare a `repository` URL",
  );
  assertStringIncludes(warnings[0], "@testuser/test-ext");
});

Deno.test("extensionPush: no warning when manifest declares a repository", async () => {
  const warnings: string[] = [];
  const mockLogger = {
    debug: () => {},
    info: () => {},
    warn: (line: string) => warnings.push(line),
    error: () => {},
    trace: () => {},
    fatal: () => {},
  } as unknown as Logger;
  const testCtx = createLibSwampContext({ logger: mockLogger });
  const deps = makeExecuteDeps();
  const input = makeExecuteInput({
    manifest: makeManifest({
      repository: "https://github.com/testuser/test-ext",
    }),
  });

  const events = await collect(extensionPush(testCtx, deps, input));
  assertEquals(events[events.length - 1].kind, "completed");
  assertEquals(warnings.length, 0);
});

Deno.test("extensionPush: not authenticated yields error", async () => {
  const deps = makeExecuteDeps({
    loadCredentials: () => Promise.resolve(null),
  });
  const input = makeExecuteInput();

  const events = await collect(extensionPush(ctx, deps, input));
  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "not_authenticated");
  }
});

Deno.test("extensionPush: initiate failure yields error", async () => {
  const deps = makeExecuteDeps({
    initiatePush: () => {
      return Promise.reject(new Error("Server unavailable"));
    },
  });
  const input = makeExecuteInput();

  const events = await collect(extensionPush(ctx, deps, input));
  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "validation_failed");
  }
});

Deno.test("extensionPush: upload failure yields error", async () => {
  const deps = makeExecuteDeps({
    uploadArchive: () => {
      return Promise.reject(new Error("Upload failed"));
    },
  });
  const input = makeExecuteInput();

  const events = await collect(extensionPush(ctx, deps, input));
  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
});

Deno.test("extensionPush: confirm failure yields error", async () => {
  const deps = makeExecuteDeps({
    confirmPush: () => {
      return Promise.reject(new Error("Confirm failed"));
    },
  });
  const input = makeExecuteInput();

  const events = await collect(extensionPush(ctx, deps, input));
  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
});

Deno.test("extensionPush: yields pushing events for each phase", async () => {
  const deps = makeExecuteDeps();
  const input = makeExecuteInput();

  const events = await collect(extensionPush(ctx, deps, input));
  const pushingEvents = events.filter((e) => e.kind === "pushing");
  assertEquals(pushingEvents.length, 3);
  if (
    pushingEvents[0].kind === "pushing" &&
    pushingEvents[1].kind === "pushing" &&
    pushingEvents[2].kind === "pushing"
  ) {
    assertEquals(pushingEvents[0].phase, "initiate");
    assertEquals(pushingEvents[1].phase, "upload");
    assertEquals(pushingEvents[2].phase, "confirm");
  }
});

Deno.test("extensionPush: completed includes visibility=private when extension is private", async () => {
  const deps = makeExecuteDeps({
    getExtensionVisibility: () => Promise.resolve({ isPrivate: true }),
  });
  const input = makeExecuteInput();

  const events = await collect(extensionPush(ctx, deps, input));
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.visibility, "private");
    assertEquals(last.data.channel, "stable");
  }
});

Deno.test("extensionPush: completed includes visibility=public when extension is public", async () => {
  const deps = makeExecuteDeps({
    getExtensionVisibility: () => Promise.resolve({ isPrivate: false }),
  });
  const input = makeExecuteInput();

  const events = await collect(extensionPush(ctx, deps, input));
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.visibility, "public");
  }
});

Deno.test("extensionPush: completed includes channel from input", async () => {
  const deps = makeExecuteDeps();
  const input = makeExecuteInput({ channel: "beta" });

  const events = await collect(extensionPush(ctx, deps, input));
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.channel, "beta");
  }
});

Deno.test("extensionPush: visibility check failure defaults to public", async () => {
  const deps = makeExecuteDeps({
    getExtensionVisibility: () => Promise.reject(new Error("Network error")),
  });
  const input = makeExecuteInput();

  const events = await collect(extensionPush(ctx, deps, input));
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.visibility, "public");
  }
});

Deno.test("extensionPushPrepare: resolvedData excludes helper files that are not entry points", async () => {
  const tempDir = await Deno.makeTempDir();
  const modelsDir = `${tempDir}/models`;
  await Deno.mkdir(`${modelsDir}/_lib`, { recursive: true });
  await Deno.writeTextFile(`${modelsDir}/echo.ts`, "export default {};");
  await Deno.writeTextFile(`${modelsDir}/_lib/retry.ts`, "export {};");

  const deps = makePrepareDeps();
  const input = makePrepareInput({
    repoDir: tempDir,
    modelsDir,
    allModelFiles: [
      `${modelsDir}/echo.ts`,
      `${modelsDir}/_lib/retry.ts`,
    ],
    modelEntryPoints: [`${modelsDir}/echo.ts`],
    dryRun: true,
  });

  const result = await extensionPushPrepare(ctx, deps, input);
  assertEquals(result.resolvedData.models.length, 1);
  assertPathEquals(result.resolvedData.models[0].fileName, "models/echo.ts");
  assertEquals(result.counts.models, 1);
  await Deno.remove(tempDir, { recursive: true }).catch(() => {});
});

Deno.test("extensionPushPrepare: rejects an archive over the archive size limit", async () => {
  const input = makePrepareInput({
    cachedArchive: new Uint8Array(MAX_EXTENSION_ARCHIVE_BYTES + 1),
  });

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, makePrepareDeps(), input),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "50 MiB archive size limit");
});

Deno.test("extensionPushPrepare: accepts an archive exactly at the archive size limit", async () => {
  const input = makePrepareInput({
    cachedArchive: new Uint8Array(MAX_EXTENSION_ARCHIVE_BYTES),
  });

  const result = await extensionPushPrepare(ctx, makePrepareDeps(), input);
  assertEquals(result.archiveBytes.byteLength, MAX_EXTENSION_ARCHIVE_BYTES);
});
