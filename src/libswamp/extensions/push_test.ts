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

import {
  extractDependencySpecifiers,
} from "../../domain/extensions/extension_dependency_extractor.ts";
import type {
  DependencySpecifier,
} from "@swamp-club/extension-scoring/dependency-audit";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { walk } from "@std/fs";
import { join, relative } from "@std/path";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { Logger } from "@logtape/logtape";
import {
  type CollectiveLookup,
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
import { buildPrepareInput, topLevelBareImports } from "./push_test_helpers.ts";
import { createApiCallRecorder } from "../../infrastructure/http/recording_fetcher.ts";
import { REGISTRY_FORBIDDEN_CODE } from "../../infrastructure/http/extension_api_client.ts";
import { UserError } from "../../domain/errors.ts";
import type { CollectiveEntitlement } from "../../domain/extensions/extension_publish_checks.ts";
import type { ExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import type { ReviewFinding } from "../../domain/extensions/extension_review_rules.ts";
import { MAX_EXTENSION_ARCHIVE_BYTES } from "../../domain/extensions/extension_archive_limits.ts";
import {
  extractTarGz,
  listTarGzEntries,
} from "../../infrastructure/archive/tar_archive.ts";
import { keyFingerprint } from "../../domain/auth/auth_credentials.ts";
import { emptyArchiveIndex } from "./extension_tree_index_test_helpers.ts";
import type {
  ExtensionKindDir,
  ExtensionTreeIndex,
} from "./extension_tree_index.ts";

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

/** A fetchCollectives answer for a server that reports no entitlement. */
function lookup(collectives: string[]): CollectiveLookup {
  return { collectives, entitlements: undefined };
}

function makePrepareInput(
  overrides?: Partial<ExtensionPushPrepareInput>,
): ExtensionPushPrepareInput {
  return buildPrepareInput(makeManifest(), "/tmp/test-repo", overrides);
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
    fetchCollectives: () => Promise.resolve(lookup(["testuser"])),
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

Deno.test("extensionPush: sends the declared license at initiate and confirm, and omits it when undeclared", async () => {
  for (const license of ["MIT", undefined]) {
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
          extensionId: "ext-licensed",
          visibility: "public",
        });
      },
    });
    await collect(extensionPush(
      ctx,
      deps,
      makeExecuteInput({ manifest: makeManifest({ license }) }),
    ));
    assertEquals(requests.length, 2);
    for (const request of requests) {
      assertEquals(request.license, license);
      assertEquals("license" in request, license !== undefined);
    }
  }
});

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
    fetchCollectives: () => Promise.resolve(lookup(["other-collective"])),
  });
  const input = makePrepareInput({ dryRun: false });

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, input),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
});

Deno.test("extensionPushPrepare: collective token allows matching collective namespace", async () => {
  const deps = makePrepareDeps({
    fetchCollectives: () => Promise.resolve(lookup(["testuser"])),
  });
  const input = makePrepareInput({ dryRun: false });

  const result = await extensionPushPrepare(ctx, deps, input);
  assertEquals(result.manifest.name, "@testuser/test-ext");
});

Deno.test("extensionPushPrepare: collective token rejects mismatched namespace", async () => {
  const deps = makePrepareDeps({
    fetchCollectives: () => Promise.resolve(lookup(["other-org"])),
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
        errors: [{
          ruleId: "dynamic-code",
          file: "evil.ts",
          message: "contains eval()",
        }],
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
        warnings: [{
          ruleId: "deno-command",
          file: "cmd.ts",
          line: 1,
          message: "uses Deno.Command()",
        }],
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
  assertEquals(result.registryChecks[0].credential, {
    username: "testuser",
    fingerprint: await keyFingerprint("swamp_test"),
  });
});

Deno.test("extensionPushPrepare: dry run with an API token names its collective and fingerprint", async () => {
  const deps = makePrepareDeps({
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.swamp-club.com",
        apiKey: "swamp_org_test",
        username: "",
      }),
    fetchCollectives: () =>
      Promise.resolve({
        ...lookup(["testuser"]),
        identity: { collectiveToken: true, collectiveSlug: "testuser" },
      }),
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true }),
  );
  const fingerprint = await keyFingerprint("swamp_org_test");
  assertEquals(result.registryChecks[0], {
    name: "authentication",
    status: "passed",
    message:
      `Signed in with an API token for @testuser (fingerprint ${fingerprint}).`,
    credential: {
      collectiveToken: true,
      collectiveSlug: "testuser",
      fingerprint,
    },
  });
  assertEquals(
    result.registryChecks.find((c) => c.name === "collective-membership")
      ?.status,
    "passed",
  );
});

Deno.test("extensionPushPrepare: dry run names a personal key from whoami when nothing is cached", async () => {
  const deps = makePrepareDeps({
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.swamp-club.com",
        apiKey: "swamp_test",
        username: "",
      }),
    fetchCollectives: () =>
      Promise.resolve({
        ...lookup(["testuser"]),
        identity: { username: "testuser" },
      }),
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true }),
  );
  assertEquals(result.registryChecks[0].message, "Signed in as testuser.");
});

Deno.test("extensionPushPrepare: an unanswered whoami with no username leaves membership unchecked", async () => {
  const deps = makePrepareDeps({
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.swamp-club.com",
        apiKey: "swamp_org_test",
        username: "",
      }),
    fetchCollectives: () => Promise.reject(new Error("fetch failed")),
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true }),
  );
  const membership = result.registryChecks.find((c) =>
    c.name === "collective-membership"
  );
  assertEquals(membership?.status, "not-run");
  assertEquals(membership?.cause, "registry-unavailable");
  assertEquals(
    membership?.message,
    "Could not check that @testuser is one of your collectives: the registry " +
      "did not report your collectives, and this credential has no username " +
      "to check against.",
  );
  assertEquals(
    result.registryChecks.some((c) => c.message.includes("(@)")),
    false,
  );

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, makePrepareInput({ dryRun: false })),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
  assertEquals(
    error.message,
    `${membership?.message} Try again when https://test.swamp-club.com is reachable.`,
  );
});

Deno.test("extensionPushPrepare: an API token on a server that lists no collectives leaves membership unchecked", async () => {
  const deps = makePrepareDeps({
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.swamp-club.com",
        apiKey: "swamp_org_test",
        username: "",
      }),
    fetchCollectives: () =>
      Promise.resolve({
        collectives: undefined,
        entitlements: undefined,
        identity: { collectiveToken: true, collectiveSlug: "testuser" },
      }),
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true }),
  );
  assertEquals(result.registryChecks[0].status, "passed");
  const membership = result.registryChecks.find((c) =>
    c.name === "collective-membership"
  );
  assertEquals(membership?.status, "not-run");
  assertEquals(membership?.cause, "registry-unavailable");
});

Deno.test("extensionPushPrepare: dry run without credentials lists every check as not run and calls nothing", async () => {
  let registryCalls = 0;
  const deps = makePrepareDeps({
    loadCredentials: () => Promise.resolve(null),
    fetchCollectives: () => {
      registryCalls++;
      return Promise.resolve(lookup([]));
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
    makePrepareInput({ dryRun: true, channel: "beta" }),
  );
  const check = result.registryChecks.find((c) => c.name === "version-exists");
  assertEquals(check?.status, "failed");
  assertEquals(
    check?.message,
    "Version 2026.03.22.1 already exists for @testuser/test-ext.",
  );
});

Deno.test("extensionPushPrepare: dry run names the lower channel a version is on and how to promote it", async () => {
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
  assertEquals(check?.existingChannel, "beta");
  assertEquals(check?.requestedChannel, "stable");
  assertStringIncludes(
    check?.message ?? "",
    "swamp extension promote @testuser/test-ext 2026.03.22.1 --channel stable",
  );
});

Deno.test("extensionPushPrepare: dry run reports a foreign collective as failed and still checks the version", async () => {
  let versionLookups = 0;
  const deps = makePrepareDeps({
    fetchCollectives: () => Promise.resolve(lookup(["other-org"])),
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
    () =>
      extensionPushPrepare(
        ctx,
        deps,
        makePrepareInput({ dryRun: false, channel: "rc" }),
      ),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
  assertEquals(
    error.message,
    "Version 2026.03.22.1 already exists for @testuser/test-ext.",
  );
  assertEquals(error.details, {
    existingVersion: "2026.03.22.1",
    existingChannel: "rc",
    requestedChannel: "rc",
  });
});

Deno.test("extensionPushPrepare: push rejection carries the existing and requested channels", async () => {
  const deps = makePrepareDeps({
    findPublishedVersion: () =>
      Promise.resolve({ version: "2026.03.22.1", channel: "rc" }),
  });

  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, makePrepareInput({ dryRun: false })),
  ) as SwampError;
  assertEquals(error.details, {
    existingVersion: "2026.03.22.1",
    existingChannel: "rc",
    requestedChannel: "stable",
  });
  assertStringIncludes(error.message, "on channel 'rc'");
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
      return Promise.resolve(lookup([]));
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

// ── Private entitlement ───────────────────────────────────────────────

const PRIVATE_REFUSAL =
  "Private publication requires a paid plan or an eligible collective trial";
const BILLING = "https://test.swamp-club.com/o/testuser/billing";
const EXPIRED_REFUSAL =
  `Collective "@testuser"'s 30-day free trial has ended. ` +
  `Private extensions need a paid plan; upgrade at ${BILLING}.`;

/** The caller's own collective as the registry reports it. */
function testuserPlan(
  overrides: Partial<CollectiveEntitlement> = {},
): CollectiveEntitlement {
  return { slug: "testuser", plan: "free", planName: "Free", ...overrides };
}

const EXPIRED = testuserPlan({
  trial: {
    state: "expired",
    endsAt: "2026-08-19T00:00:00.000Z",
    daysRemaining: 0,
    totalDays: 30,
  },
});
const PAID = testuserPlan({ plan: "team", planName: "Team" });
const NO_TRIAL = testuserPlan({ trial: null });
const NO_TRIAL_REFUSAL =
  `Private extensions in "@testuser" need a paid plan; upgrade at ${BILLING}.`;
/**
 * The issue's repro (swamp-club#3311): the personal trial ended, but a paid
 * collective the owner belongs to covers the personal namespace.
 */
const COVERED = { ...EXPIRED, privateExtensions: "allowed" };
const PAYWALLED = { ...EXPIRED, privateExtensions: "paywalled" };

function privateInput(
  overrides?: Partial<ExtensionPushPrepareInput>,
): ExtensionPushPrepareInput {
  return makePrepareInput({
    manifest: makeManifest({ visibility: "private" }),
    ...overrides,
  });
}

function entitledDeps(
  entitlements: CollectiveEntitlement[] | undefined,
  overrides?: Partial<ExtensionPushPrepareDeps>,
): ExtensionPushPrepareDeps {
  return makePrepareDeps({
    fetchCollectives: () =>
      Promise.resolve({ collectives: ["testuser"], entitlements }),
    ...overrides,
  });
}

Deno.test("extensionPushPrepare: a private dry run adds the entitlement check after membership and passes on a paid plan", async () => {
  const result = await extensionPushPrepare(
    ctx,
    entitledDeps([PAID]),
    privateInput(),
  );
  assertEquals(
    result.registryChecks.map((c) => [c.name, c.status]),
    [
      ["authentication", "passed"],
      ["reserved-collective", "passed"],
      ["collective-membership", "passed"],
      ["private-entitlement", "passed"],
      ["version-exists", "passed"],
    ],
  );
  assertEquals(
    result.registryChecks[3].message,
    'Collective "@testuser" is on the Team plan, which allows private extensions.',
  );
  assertEquals(result.collectiveEntitlement, PAID);
});

Deno.test("extensionPushPrepare: a private dry run passes on an active trial and names it", async () => {
  const result = await extensionPushPrepare(
    ctx,
    entitledDeps([testuserPlan({
      trial: {
        state: "active",
        endsAt: "2026-08-19T00:00:00.000Z",
        daysRemaining: 13,
      },
    })]),
    privateInput(),
  );
  const check = result.registryChecks.find((c) =>
    c.name === "private-entitlement"
  );
  assertEquals(check?.status, "passed");
  assertEquals(
    check?.message,
    'Collective "@testuser" is in its free trial (13 days left, ends 2026-08-19), which allows private extensions.',
  );
});

Deno.test("extensionPushPrepare: a private dry run reports an ended trial as failed with the push's message, without throwing", async () => {
  const result = await extensionPushPrepare(
    ctx,
    entitledDeps([EXPIRED]),
    privateInput(),
  );
  const check = result.registryChecks.find((c) =>
    c.name === "private-entitlement"
  );
  assertEquals(check?.status, "failed");
  assertEquals(check?.message, EXPIRED_REFUSAL);
  assertEquals(result.collectiveEntitlement, EXPIRED);
});

Deno.test("extensionPushPrepare: a private dry run reports a free plan with no trial as failed with the push's message, without throwing", async () => {
  for (const entitlement of [NO_TRIAL, testuserPlan()]) {
    const result = await extensionPushPrepare(
      ctx,
      entitledDeps([entitlement]),
      privateInput(),
    );
    const check = result.registryChecks.find((c) =>
      c.name === "private-entitlement"
    );
    assertEquals(check?.status, "failed");
    assertEquals(check?.cause, undefined);
    assertEquals(check?.message, NO_TRIAL_REFUSAL);
  }
});

Deno.test("extensionPushPrepare: a private dry run is undecided when no entitlement was reported", async () => {
  const unreported = await extensionPushPrepare(
    ctx,
    entitledDeps(undefined),
    privateInput(),
  );
  const check = unreported.registryChecks.find((c) =>
    c.name === "private-entitlement"
  );
  assertEquals(check?.status, "not-run");
  assertEquals(check?.cause, "entitlement-undecided");
  assertEquals(
    check?.message,
    'the registry did not report entitlement for "@testuser"; private publication is decided at publish',
  );
  assertEquals(unreported.collectiveEntitlement, undefined);
});

Deno.test("extensionPushPrepare: public or default intent adds no entitlement check", async () => {
  for (const visibility of [undefined, "public"] as const) {
    const result = await extensionPushPrepare(
      ctx,
      entitledDeps([EXPIRED]),
      makePrepareInput({ manifest: makeManifest({ visibility }) }),
    );
    assertEquals(
      result.registryChecks.some((c) => c.name === "private-entitlement"),
      false,
    );
    // The entitlement still rides along for a refusal to explain.
    assertEquals(result.collectiveEntitlement, EXPIRED);
  }
});

Deno.test("extensionPushPrepare: a private dry run lists the entitlement check as not run with the other checks' cause", async () => {
  const noCredentials = await extensionPushPrepare(
    ctx,
    makePrepareDeps({ loadCredentials: () => Promise.resolve(null) }),
    privateInput(),
  );
  assertEquals(
    noCredentials.registryChecks.map((c) => [c.name, c.cause]),
    [
      ["authentication", "no-credentials"],
      ["reserved-collective", "no-credentials"],
      ["collective-membership", "no-credentials"],
      ["private-entitlement", "no-credentials"],
      ["version-exists", "no-credentials"],
    ],
  );

  const rejectedKey = await extensionPushPrepare(
    ctx,
    makePrepareDeps({
      fetchCollectives: () => Promise.reject(notAuthenticated()),
    }),
    privateInput(),
  );
  const check = rejectedKey.registryChecks.find((c) =>
    c.name === "private-entitlement"
  );
  assertEquals(check?.status, "not-run");
  assertEquals(check?.cause, "authentication-failed");
});

Deno.test("extensionPushPrepare: a private dry run reports the entitlement check as unanswered when whoami did not answer", async () => {
  const result = await extensionPushPrepare(
    ctx,
    makePrepareDeps({
      fetchCollectives: () => Promise.reject(new Error("fetch failed")),
    }),
    privateInput(),
  );
  const check = result.registryChecks.find((c) =>
    c.name === "private-entitlement"
  );
  assertEquals(check?.status, "not-run");
  assertEquals(check?.cause, "registry-unavailable");
  assertEquals(check?.message, "registry did not answer: fetch failed");
  assertEquals(result.collectiveEntitlement, undefined);
});

Deno.test("extensionPushPrepare: a private dry run omits the entitlement check for a collective that is not the caller's", async () => {
  const result = await extensionPushPrepare(
    ctx,
    makePrepareDeps({
      fetchCollectives: () =>
        Promise.resolve({
          collectives: ["other-org"],
          entitlements: [{ slug: "other-org", plan: "team", planName: "Team" }],
        }),
    }),
    privateInput(),
  );
  assertEquals(
    result.registryChecks.find((c) => c.name === "collective-membership")
      ?.status,
    "failed",
  );
  assertEquals(
    result.registryChecks.some((c) => c.name === "private-entitlement"),
    false,
  );
});

Deno.test("extensionPushPrepare: a private push refuses an ended trial or no trial before packaging, with the dry run's message", async () => {
  for (
    const [entitlement, refusal] of [
      [EXPIRED, EXPIRED_REFUSAL],
      [NO_TRIAL, NO_TRIAL_REFUSAL],
    ] as const
  ) {
    let bundled = 0;
    const deps = entitledDeps([entitlement], {
      bundleEntryPoint: () => {
        bundled++;
        return Promise.resolve("/* bundled */");
      },
    });
    const error = await assertRejects(
      () => extensionPushPrepare(ctx, deps, privateInput({ dryRun: false })),
    ) as SwampError;
    assertEquals(error.code, "validation_failed");
    assertEquals(error.message, refusal);
    assertEquals(bundled, 0);
  }
});

Deno.test("extensionPushPrepare: a private push to a personal namespace the registry covers goes ahead (swamp-club#3311)", async () => {
  // Enforce mode: a failed check would throw here instead of returning.
  const result = await extensionPushPrepare(
    ctx,
    entitledDeps([COVERED]),
    privateInput({ dryRun: false }),
  );
  const check = result.registryChecks.find((c) =>
    c.name === "private-entitlement"
  );
  assertEquals(check?.status, "passed");
  assertEquals(
    check?.message,
    'Collective "@testuser" is covered by a paid plan or active trial on another collective you belong to, which allows private extensions.',
  );
  assertEquals(result.collectiveEntitlement, COVERED);
});

Deno.test("extensionPushPrepare: a private push the registry reports paywalled is refused before packaging, claiming no trial", async () => {
  let bundled = 0;
  const deps = entitledDeps([PAYWALLED], {
    bundleEntryPoint: () => {
      bundled++;
      return Promise.resolve("/* bundled */");
    },
  });
  const error = await assertRejects(
    () => extensionPushPrepare(ctx, deps, privateInput({ dryRun: false })),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
  assertEquals(error.message, NO_TRIAL_REFUSAL);
  assertEquals(bundled, 0);
});

Deno.test("extensionPushPrepare: a private push lets the registry decide an unreported entitlement", async () => {
  const result = await extensionPushPrepare(
    ctx,
    entitledDeps(undefined),
    privateInput({ dryRun: false }),
  );
  assertEquals(
    result.registryChecks.find((c) => c.name === "private-entitlement")
      ?.cause,
    "entitlement-undecided",
  );
});

function forbidden(message = PRIVATE_REFUSAL): UserError {
  return new UserError(message, REGISTRY_FORBIDDEN_CODE);
}

async function lastError(
  deps: ExtensionPushExecuteDeps,
  input: ExtensionPushExecuteInput,
): Promise<SwampError> {
  const events = await collect(extensionPush(ctx, deps, input));
  const last = events[events.length - 1];
  if (last.kind !== "error") {
    throw new Error(`expected error, got ${last.kind}`);
  }
  return last.error;
}

Deno.test("extensionPush: a refused private publication carries what the registry reported at sign-in", async () => {
  const atInitiate = await lastError(
    makeExecuteDeps({ initiatePush: () => Promise.reject(forbidden()) }),
    makeExecuteInput({
      manifest: makeManifest({ visibility: "private" }),
      collectiveEntitlement: EXPIRED,
    }),
  );
  assertEquals(atInitiate.code, "validation_failed");
  assertEquals(
    atInitiate.message,
    `${PRIVATE_REFUSAL}. At sign-in the registry reported that collective "@testuser"'s 30-day free trial has ended. ` +
      `Private extensions need a paid plan; upgrade at ${BILLING}.`,
  );

  const atConfirm = await lastError(
    makeExecuteDeps({ confirmPush: () => Promise.reject(forbidden()) }),
    makeExecuteInput({
      manifest: makeManifest({ visibility: "private" }),
      collectiveEntitlement: PAID,
    }),
  );
  assertEquals(
    atConfirm.message,
    `${PRIVATE_REFUSAL}. At sign-in the registry reported that collective "@testuser" is on the Team plan, which allows private extensions.`,
  );
});

Deno.test("extensionPush: a refused private publication with no entitlement reported says so and claims nothing about a plan", async () => {
  const error = await lastError(
    makeExecuteDeps({ initiatePush: () => Promise.reject(forbidden()) }),
    makeExecuteInput({ manifest: makeManifest({ visibility: "private" }) }),
  );
  assertEquals(
    error.message,
    `${PRIVATE_REFUSAL}. At sign-in the registry did not report entitlement for "@testuser".`,
  );
});

Deno.test("extensionPush: other failures and public pushes keep the registry's message as it came", async () => {
  const notForbidden = await lastError(
    makeExecuteDeps({
      initiatePush: () => Promise.reject(new UserError("Server unavailable")),
    }),
    makeExecuteInput({
      manifest: makeManifest({ visibility: "private" }),
      collectiveEntitlement: EXPIRED,
    }),
  );
  assertEquals(notForbidden.message, "Server unavailable");

  const publicPush = await lastError(
    makeExecuteDeps({
      initiatePush: () => Promise.reject(forbidden("Forbidden")),
    }),
    makeExecuteInput({ collectiveEntitlement: EXPIRED }),
  );
  assertEquals(publicPush.message, "Forbidden");
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

Deno.test("createExtensionPushPrepareDeps: fetchCollectives reads membership and entitlement from one whoami answer", async () => {
  const recorder = createApiCallRecorder();
  const deps = createExtensionPushPrepareDeps(undefined, {
    recorder,
    fetch: () =>
      Promise.resolve(jsonResponse({
        authenticated: true,
        username: "seth",
        organizations: [
          { slug: "seth", name: "Seth", role: "owner", personal: true },
          { slug: "acme", name: "Acme", role: "member", personal: false },
        ],
        collectiveEntitlements: [
          { slug: "seth", plan: "free", planName: "Free", trial: null },
          {
            slug: "acme",
            plan: "team",
            planName: "Team",
            subscriptionStatus: "active",
            trial: null,
          },
        ],
      })),
  });
  const lookup = await deps.fetchCollectives(REGISTRY, "swamp_key");
  assertEquals(lookup.collectives, ["seth", "acme"]);
  // The lookup carries the whole entitlement the server sent, including the
  // fields the domain type does not name.
  assertEquals<unknown>(lookup.entitlements, [
    { slug: "seth", plan: "free", planName: "Free", trial: null },
    {
      slug: "acme",
      plan: "team",
      planName: "Team",
      subscriptionStatus: "active",
      trial: null,
    },
  ]);
  assertEquals(recorder.calls.length, 1);

  const older = createExtensionPushPrepareDeps(undefined, {
    fetch: () =>
      Promise.resolve(jsonResponse({
        authenticated: true,
        username: "seth",
        organizations: [{
          slug: "seth",
          name: "Seth",
          role: "owner",
          personal: true,
        }],
      })),
  });
  assertEquals(await older.fetchCollectives(REGISTRY, "swamp_key"), {
    collectives: ["seth"],
    entitlements: undefined,
    identity: { username: "seth" },
  });
});

Deno.test("createExtensionPushPrepareDeps: fetchCollectives reads an API token's collective from whoami", async () => {
  const deps = createExtensionPushPrepareDeps(undefined, {
    fetch: () =>
      Promise.resolve(jsonResponse({
        authenticated: true,
        collectiveToken: true,
        collectiveId: "c1",
        collectiveSlug: "acme",
        organizations: [
          { slug: "acme", name: "Acme", role: "member", personal: false },
        ],
      })),
  });
  const lookup = await deps.fetchCollectives(REGISTRY, "swamp_org_key");
  assertEquals(lookup.collectives, ["acme"]);
  assertEquals(lookup.identity, {
    collectiveToken: true,
    collectiveSlug: "acme",
  });
});

Deno.test("createExtensionPushPrepareDeps: records the npm, OSV and JSR calls the trust audit makes, and nothing without specifiers", async () => {
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
      if (u.host === "jsr.io") {
        return Promise.resolve(
          jsonResponse({ latest: "1.0.0", versions: { "1.0.0": {} } }),
        );
      }
      throw new Error(`unexpected call to ${u.host}`);
    },
  });

  await deps.checkDependencyTrust([], {});
  assertEquals(fetches, 0);
  assertEquals(recorder.calls, []);

  await deps.checkDependencyTrust([
    { name: "zod", version: "3.0.0", registry: "npm", sourceFile: "a.ts" },
    {
      name: "@std/path",
      version: "1.0.0",
      registry: "jsr",
      sourceFile: "a.ts",
    },
  ], {});
  assertEquals(
    recorder.calls.map((c) => c.service).sort(),
    ["jsr", "npm", "npm", "osv"],
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

Deno.test("extensionPushPrepare: a quality.yaml beside the manifest is read and carried on the result", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tmp, "quality.yaml"),
      "version: 1\ngenerated:\n  by: codegen\n  source: spec.yaml\n  commit: abc\n",
    );
    const deps = makePrepareDeps();
    const result = await extensionPushPrepare(
      ctx,
      deps,
      makePrepareInput({ manifestDir: tmp }),
    );
    assertPathEquals(result.sidecar?.path ?? "", join(tmp, "quality.yaml"));
    assertEquals(result.sidecar?.value.generated, {
      by: "codegen",
      source: "spec.yaml",
      commit: "abc",
    });
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("extensionPushPrepare: no quality.yaml beside the manifest leaves the result without one", async () => {
  const result = await extensionPushPrepare(
    ctx,
    makePrepareDeps(),
    makePrepareInput(),
  );
  assertEquals(result.sidecar, undefined);
});

Deno.test("extensionPushPrepare: an invalid quality.yaml blocks before any gate, naming every problem", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tmp, "quality.yaml"),
      "version: 1\nignore: [deno-command]\n",
    );
    const error = await assertRejects(() =>
      extensionPushPrepare(
        ctx,
        makePrepareDeps(),
        makePrepareInput({ manifestDir: tmp }),
      )
    ) as SwampError;
    assertEquals(error.code, "validation_failed");
    assertStringIncludes(error.message, "quality.yaml");
    const errors = (error.details as Record<string, unknown>).sidecarErrors;
    assertEquals(Array.isArray(errors), true);
    assertStringIncludes((errors as string[]).join("\n"), "ignore");
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("extensionPushPrepare: a symlinked quality.yaml is refused unread, quoting none of its target (swamp-club#3420)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const target = join(tmp, "target.yaml");
    await Deno.writeTextFile(target, "SECRET-3420: [deno-command]\n");
    const dir = join(tmp, "ext");
    await Deno.mkdir(dir);
    await Deno.symlink(target, join(dir, "quality.yaml"), { type: "file" });
    const error = await assertRejects(() =>
      extensionPushPrepare(
        ctx,
        makePrepareDeps(),
        makePrepareInput({ manifestDir: dir }),
      )
    ) as SwampError;
    assertEquals(error.code, "validation_failed");
    assertStringIncludes(
      error.message,
      "quality.yaml beside the manifest is a symlink",
    );
    assertEquals(
      `${error.message}${JSON.stringify(error.details)}`.includes("SECRET"),
      false,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

// ── Declared acceptances ──────────────────────────────────────────────

const SECRET_FINDING = (file: string, line: number) => ({
  ruleId: "credentials-sensitive-field",
  dimension: "Credentials & Secrets",
  severity: "medium" as const,
  file,
  line,
  message: "looks like a secret",
  remediation: "mark it sensitive",
});

async function withAcceptanceFixture(
  files: Record<string, string>,
  fn: (dir: string, paths: Record<string, string>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "acceptances-" });
  try {
    await Deno.mkdir(join(dir, "models"));
    const paths: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
      paths[name] = join(dir, name);
      await Deno.writeTextFile(paths[name], content);
    }
    await fn(dir, paths);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function acceptanceInput(
  dir: string,
  models: string[],
): ExtensionPushPrepareInput {
  return makePrepareInput({
    manifestDir: dir,
    modelsDir: join(dir, "models"),
    allModelFiles: models,
    modelEntryPoints: models,
  });
}

Deno.test("extensionPushPrepare: an inline acceptance takes its finding out of the gate, records it, and leaves an unmarked field elsewhere warning", async () => {
  await withAcceptanceFixture({
    "models/a.ts": [
      "const S = z.object({",
      "  secretName: z.string(), // swamp-quality-ignore credentials-sensitive-field: reference to a Secret, not a secret",
      "});",
      "",
    ].join("\n"),
    "models/b.ts": "const T = z.object({\n  apiKey: z.string(),\n});\n",
  }, async (dir, paths) => {
    const deps = makePrepareDeps({
      checkReviewRules: () =>
        Promise.resolve({
          errors: [],
          warnings: [
            SECRET_FINDING(paths["models/a.ts"], 2),
            SECRET_FINDING(paths["models/b.ts"], 2),
          ],
          passed: true,
        }),
    });
    const result = await extensionPushPrepare(
      ctx,
      deps,
      acceptanceInput(dir, [paths["models/a.ts"], paths["models/b.ts"]]),
    );
    assertEquals(result.reviewRulesResult.warnings.length, 1);
    assertPathEquals(
      result.reviewRulesResult.warnings[0].file,
      paths["models/b.ts"],
    );
    assertEquals(result.acceptances.accepted, [{
      ruleId: "credentials-sensitive-field",
      file: "models/a.ts",
      archivePath: "models/a.ts",
      line: 2,
      reason: "reference to a Secret, not a secret",
      source: "inline",
      message: "looks like a secret",
    }]);
    assertEquals(result.contentMetadata?.acceptances, {
      accepted: [{
        rule: "credentials-sensitive-field",
        file: "models/a.ts",
        line: 2,
        reason: "reference to a Secret, not a secret",
        source: "inline",
      }],
    });
  });
});

Deno.test("extensionPushPrepare: an acceptance with no reason accepts its line, and neither record carries a reason", async () => {
  await withAcceptanceFixture({
    "models/a.ts": [
      'new Deno.Command("vendor"); // swamp-quality-ignore deno-command',
      "",
    ].join("\n"),
  }, async (dir, paths) => {
    const deps = makePrepareDeps({
      analyzeExtensionSafety: () =>
        Promise.resolve({
          errors: [],
          warnings: [{
            ruleId: "deno-command",
            file: paths["models/a.ts"],
            line: 1,
            message: "Line 1 uses Deno.Command() to spawn subprocesses.",
          }],
        }),
    });
    const result = await extensionPushPrepare(
      ctx,
      deps,
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    assertEquals(result.safetyWarnings, []);
    assertEquals(result.reviewRulesResult.errors, []);
    assertEquals(result.acceptances.accepted, [{
      ruleId: "deno-command",
      file: "models/a.ts",
      archivePath: "models/a.ts",
      line: 1,
      source: "inline",
      message: "Line 1 uses Deno.Command() to spawn subprocesses.",
    }]);
    assertEquals(result.contentMetadata?.acceptances, {
      accepted: [{
        rule: "deno-command",
        file: "models/a.ts",
        line: 1,
        source: "inline",
      }],
    });
  });
});

Deno.test("extensionPushPrepare: an inline acceptance covers a safety warning on its line", async () => {
  await withAcceptanceFixture({
    "models/a.ts": [
      "const a = 1;",
      "// swamp-quality-ignore deno-command: wraps the vendor CLI, arguments are validated",
      'new Deno.Command("vendor");',
      "",
    ].join("\n"),
  }, async (dir, paths) => {
    const deps = makePrepareDeps({
      analyzeExtensionSafety: () =>
        Promise.resolve({
          errors: [],
          warnings: [{
            ruleId: "deno-command",
            file: paths["models/a.ts"],
            line: 3,
            message: "Line 3 uses Deno.Command() to spawn subprocesses.",
          }],
        }),
    });
    const result = await extensionPushPrepare(
      ctx,
      deps,
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    assertEquals(result.safetyWarnings, []);
    assertEquals(result.acceptances.accepted.length, 1);
    assertEquals(result.acceptances.accepted[0].ruleId, "deno-command");
    assertEquals(result.acceptances.accepted[0].line, 3);
  });
});

Deno.test("extensionPushPrepare: an acceptance whose rule no longer fires is a stale-acceptance warning at the comment", async () => {
  await withAcceptanceFixture({
    "models/a.ts": [
      "const a = 1;",
      "const b = 2; // swamp-quality-ignore deno-command: used to spawn here",
      "",
    ].join("\n"),
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps(),
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    assertEquals(result.reviewRulesResult.warnings.length, 1);
    const stale = result.reviewRulesResult.warnings[0];
    assertEquals(stale.ruleId, "stale-acceptance");
    assertEquals(stale.severity, "medium");
    assertPathEquals(stale.file, paths["models/a.ts"]);
    assertEquals(stale.line, 2);
    assertEquals(result.acceptances.accepted, []);
  });
});

Deno.test("extensionPushPrepare: an acceptance of an error-level rule blocks the push, naming the comment", async () => {
  await withAcceptanceFixture({
    "models/a.ts": "eval(x); // swamp-quality-ignore dynamic-code: trust me\n",
  }, async (dir, paths) => {
    const error = await assertRejects(() =>
      extensionPushPrepare(
        ctx,
        makePrepareDeps(),
        acceptanceInput(dir, [paths["models/a.ts"]]),
      )
    ) as SwampError;
    assertEquals(error.code, "validation_failed");
    const errors = (error.details as Record<string, unknown>)
      .reviewRuleErrors as ReviewFinding[];
    assertEquals(errors.length, 1);
    assertEquals(errors[0].ruleId, "invalid-acceptance");
    assertEquals(errors[0].severity, "high");
    assertEquals(errors[0].line, 1);
    assertStringIncludes(errors[0].message, "dynamic-code");
    assertStringIncludes(errors[0].message, "cannot be accepted");
  });
});

Deno.test("extensionPushPrepare: a generated declaration accepts every testing-completeness finding and travels in content metadata", async () => {
  await withAcceptanceFixture({
    "models/a.ts": "export const a = 1;\n",
    "models/b.ts": "export const b = 1;\n",
    "quality.yaml":
      "version: 1\ngenerated:\n  by: codegen\n  source: spec.yaml\n  commit: abc\n",
  }, async (dir, paths) => {
    const untested = (file: string) => ({
      ruleId: "testing-completeness",
      dimension: "Testing Completeness",
      severity: "medium" as const,
      file,
      message: "No sibling _test.ts found",
    });
    const deps = makePrepareDeps({
      checkReviewRules: () =>
        Promise.resolve({
          errors: [],
          warnings: [
            untested(paths["models/a.ts"]),
            untested(paths["models/b.ts"]),
          ],
          passed: true,
        }),
    });
    const result = await extensionPushPrepare(
      ctx,
      deps,
      acceptanceInput(dir, [paths["models/a.ts"], paths["models/b.ts"]]),
    );
    assertEquals(result.reviewRulesResult.warnings, []);
    assertEquals(result.acceptances.accepted.length, 2);
    assertEquals(result.acceptances.accepted[0].source, "generated");
    assertStringIncludes(
      result.acceptances.accepted[0].reason ?? "",
      "codegen",
    );
    assertEquals(result.acceptances.generated, {
      by: "codegen",
      source: "spec.yaml",
      commit: "abc",
    });
    assertEquals(result.contentMetadata?.acceptances?.generated, {
      by: "codegen",
      source: "spec.yaml",
      commit: "abc",
    });
  });
});

Deno.test("extensionPushPrepare: a header comment accepts testing-completeness for that file only, and the rest collapse to one finding", async () => {
  await withAcceptanceFixture({
    "models/a.ts":
      "// swamp-quality-ignore testing-completeness: thin wrapper covered by the integration suite\nexport const a = 1;\n",
    "models/b.ts": "export const b = 1;\n",
    "models/c.ts": "export const c = 1;\n",
  }, async (dir, paths) => {
    const untested = (file: string) => ({
      ruleId: "testing-completeness",
      dimension: "Testing Completeness",
      severity: "medium" as const,
      file,
      message: "No sibling _test.ts found",
      remediation: "add a test",
    });
    const models = [
      paths["models/a.ts"],
      paths["models/b.ts"],
      paths["models/c.ts"],
    ];
    const deps = makePrepareDeps({
      checkReviewRules: () =>
        Promise.resolve({
          errors: [],
          warnings: models.map(untested),
          passed: true,
        }),
    });
    const result = await extensionPushPrepare(
      ctx,
      deps,
      acceptanceInput(dir, models),
    );
    assertEquals(result.acceptances.accepted.map((a) => a.file), [
      "models/a.ts",
    ]);
    assertEquals(result.reviewRulesResult.warnings.length, 1);
    const collapsed = result.reviewRulesResult.warnings[0];
    assertEquals(collapsed.ruleId, "testing-completeness");
    assertEquals(collapsed.file, "(2 files)");
    assertStringIncludes(collapsed.message, "2 of 3 entry points");
    assertStringIncludes(collapsed.message, "models/b.ts, models/c.ts");
    assertEquals(collapsed.files?.length, 2);
    assertEquals(collapsed.remediation, "add a test");
  });
});

Deno.test("extensionPushPrepare: a sidecar entry for bare-specifiers is an invalid acceptance that blocks the push", async () => {
  await withAcceptanceFixture({
    "models/a.ts": 'import x from "lodash";\nexport const a = x;\n',
    "quality.yaml":
      "version: 1\naccept:\n  - rule: bare-specifiers\n    reason: scored locally\n",
  }, async (dir, paths) => {
    const error = await assertRejects(() =>
      extensionPushPrepare(
        ctx,
        makePrepareDeps(),
        acceptanceInput(dir, [paths["models/a.ts"]]),
      )
    ) as SwampError;
    const details = error.details as { reviewRuleErrors: ReviewFinding[] };
    assertEquals(
      details.reviewRuleErrors.map((f) => f.ruleId),
      ["invalid-acceptance"],
    );
    assertStringIncludes(
      details.reviewRuleErrors[0].message,
      '"bare-specifiers" is not a rule that can be accepted. Map each bare name',
    );
  });
});

Deno.test("extensionPushPrepare: the bare-specifiers finding names only the bare imports that ship as written", async () => {
  await withAcceptanceFixture({
    "models/a.ts":
      'import { z } from "zod";\nimport { join } from "@std/path";\nimport x from "lodash";\nexport const a = [z, join, x];\n',
    "deno.json": JSON.stringify({
      imports: { "zod": "npm:zod@4.3.6", "@std/": "jsr:@std/" },
    }),
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(ctx, makePrepareDeps(), {
      ...acceptanceInput(dir, [paths["models/a.ts"]]),
      denoConfigPath: paths["deno.json"],
      bareImports: await topLevelBareImports(
        [paths["models/a.ts"]],
        paths["deno.json"],
      ),
    });
    const bare = result.reviewRulesResult.warnings.filter((w) =>
      w.ruleId === "bare-specifiers"
    );
    assertEquals(bare.length, 1);
    assertEquals(bare[0].severity, "medium");
    assertEquals(
      bare[0].message,
      "Extension has bare imports that ship as written, which the " +
        "registry's scorer cannot resolve, so it would score the " +
        'documentation factors 0: "lodash". Push rewrites a bare import only when the ' +
        "project's Deno config (deno.json or deno.jsonc imports, an " +
        "importMap file, a scope covering the module, or a workspace root's " +
        "imports) resolves it to an npm:, jsr:, node: or URL specifier, or, " +
        "with no Deno config, when package.json declares it as an npm " +
        "registry dependency installed in node_modules; add such an entry " +
        "or dependency for each, or write the specifier in its place.",
    );
  });
});

Deno.test("extensionPushPrepare: no bare-specifiers finding when the import map resolves every bare import", async () => {
  await withAcceptanceFixture({
    "models/a.ts":
      'import { z } from "zod";\nconst m = await import("ms");\nexport const a = [z, m];\n',
    "deno.json": JSON.stringify({
      imports: { "zod": "npm:zod@^4", "ms": "npm:ms@2.1.3" },
    }),
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(ctx, makePrepareDeps(), {
      ...acceptanceInput(dir, [paths["models/a.ts"]]),
      denoConfigPath: paths["deno.json"],
      bareImports: await topLevelBareImports(
        [paths["models/a.ts"]],
        paths["deno.json"],
      ),
    });
    assertEquals(
      result.reviewRulesResult.warnings.filter((w) =>
        w.ruleId === "bare-specifiers"
      ),
      [],
    );
  });
});

Deno.test("extensionPushPrepare: without a deno.json every bare import still raises the bare-specifiers finding", async () => {
  await withAcceptanceFixture({
    "models/a.ts": 'import ms from "ms";\nexport const a = ms;\n',
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps(),
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    const bare = result.reviewRulesResult.warnings.filter((w) =>
      w.ruleId === "bare-specifiers"
    );
    assertEquals(bare.length, 1);
    assertStringIncludes(bare[0].message, '"ms"');
  });
});

/** The text of each file under the archive's `extension/` directory, by path below it. */
async function archiveTexts(
  bytes: Uint8Array,
): Promise<Record<string, string>> {
  const root = await Deno.makeTempDir({ prefix: "archive-texts-" });
  try {
    await extractTarGz(ReadableStream.from([bytes]), root);
    const texts: Record<string, string> = {};
    for await (
      const entry of walk(join(root, "extension"), { includeDirs: false })
    ) {
      const rel = relative(join(root, "extension"), entry.path)
        .replaceAll("\\", "/");
      texts[rel] = await Deno.readTextFile(entry.path);
    }
    return texts;
  } finally {
    await Deno.remove(root, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

Deno.test("extensionPushPrepare: the archive's source carries each bare import's import-map target", async () => {
  await withAcceptanceFixture({
    "models/a.ts": [
      'import ms from "ms";',
      'import { posix } from "@std/path/posix";',
      "import fp from 'lodash/fp';",
      'import u from "unmapped";',
      'import { b } from "./b.ts";',
      'const t = `import ms from "ms"`;',
      "export const a = [ms, posix, fp, u, b, t];",
      "",
    ].join("\n"),
    "models/b.ts": 'export { default as b } from "ms";\n',
    "models/data.json": '{ "import": "ms" }\n',
    "deno.json": JSON.stringify({
      imports: {
        "ms": "npm:ms@^2",
        "@std/path": "jsr:@std/path@^1",
        "lodash/": "npm:/lodash@4/",
      },
    }),
  }, async (dir, paths) => {
    const models = [paths["models/a.ts"], paths["models/b.ts"]];
    const input = acceptanceInput(dir, models);
    const result = await extensionPushPrepare(ctx, makePrepareDeps(), {
      ...input,
      denoConfigPath: paths["deno.json"],
      bareImports: await topLevelBareImports(models, paths["deno.json"]),
      dataFilesByKind: { models: [paths["models/data.json"]] },
      sourcePlan: {
        entries: [
          ...input.sourcePlan.entries,
          {
            sourcePath: paths["models/data.json"],
            archivePath: "models/data.json",
            rewrites: [],
          },
        ],
      },
    });
    const texts = await archiveTexts(result.archiveBytes);
    assertEquals(
      texts["models/a.ts"],
      [
        'import ms from "npm:ms@^2";',
        'import { posix } from "jsr:@std/path@^1/posix";',
        "import fp from 'npm:lodash@4/fp';",
        'import u from "unmapped";',
        'import { b } from "./b.ts";',
        'const t = `import ms from "ms"`;',
        "export const a = [ms, posix, fp, u, b, t];",
        "",
      ].join("\n"),
    );
    assertEquals(
      texts["models/b.ts"],
      'export { default as b } from "npm:ms@^2";\n',
    );
    assertEquals(texts["models/data.json"], '{ "import": "ms" }\n');
    for (const name of ["deno.json", "deno.lock"]) {
      assertEquals(
        Object.keys(texts).some((p) => p.endsWith(name)),
        false,
        `${name} must not ship`,
      );
    }
  });
});

Deno.test("extensionPushPrepare: each module ships and audits the target Deno resolves for it, as a scope gives (swamp-club#3612)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": 'import ms from "ms";\nexport const a = ms;\n',
    "models/b.ts": 'import ms from "ms";\nexport const b = ms;\n',
    // The top level says 2.1.3; a scope gives a.ts 3.0.0, as deno info
    // reports below.
    "deno.json": JSON.stringify({
      imports: { "ms": "npm:ms@2.1.3" },
      scopes: { "./models/a.ts": { "ms": "npm:ms@3.0.0" } },
    }),
  }, async (dir, paths) => {
    const audited: DependencySpecifier[][] = [];
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        extractDependencySpecifiers,
        checkDependencyTrust: (specifiers) => {
          audited.push(specifiers);
          return Promise.resolve({
            errors: [],
            warnings: [],
            audited: [],
            passed: true,
          });
        },
      }),
      {
        ...acceptanceInput(dir, [paths["models/a.ts"], paths["models/b.ts"]]),
        denoConfigPath: paths["deno.json"],
        bareImports: [
          {
            importer: paths["models/a.ts"],
            specifier: "ms",
            target: "npm:ms@3.0.0",
          },
          {
            importer: paths["models/b.ts"],
            specifier: "ms",
            target: "npm:ms@2.1.3",
          },
        ],
      },
    );
    const texts = await archiveTexts(result.archiveBytes);
    assertEquals(
      texts["models/a.ts"],
      'import ms from "npm:ms@3.0.0";\nexport const a = ms;\n',
    );
    assertEquals(
      texts["models/b.ts"],
      'import ms from "npm:ms@2.1.3";\nexport const b = ms;\n',
    );
    assertEquals(
      audited[0].map((s) => [s.version, s.importedAs]).sort(),
      [["2.1.3", "ms"], ["3.0.0", "ms"]],
    );
    assertEquals(
      result.reviewRulesResult.warnings.filter((w) =>
        w.ruleId === "bare-specifiers"
      ),
      [],
    );
  });
});

Deno.test("extensionPushPrepare: a package.json project ships, audits and scores each installed dependency at its installed version (swamp-club#3630)", async () => {
  await withAcceptanceFixture({
    "models/a.ts":
      'import ms from "ms";\nimport lp from "left-pad";\nimport u from "unlisted";\nexport const a = [ms, lp, u];\n',
    "package.json": JSON.stringify({
      dependencies: { "ms": "^2.1.0" },
      devDependencies: { "left-pad": "1.3.0" },
    }),
  }, async (dir, paths) => {
    const audited: DependencySpecifier[][] = [];
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        extractDependencySpecifiers,
        checkDependencyTrust: (specifiers) => {
          audited.push(specifiers);
          return Promise.resolve({
            errors: [],
            warnings: [],
            audited: [],
            passed: true,
          });
        },
      }),
      {
        ...acceptanceInput(dir, [paths["models/a.ts"]]),
        packageJsonDir: dir,
        bareImports: [
          {
            importer: paths["models/a.ts"],
            specifier: "ms",
            target: "npm:ms@2.1.3",
            installedVersion: "2.1.3",
            declared: "npm:ms@^2.1.0",
          },
          {
            importer: paths["models/a.ts"],
            specifier: "left-pad",
            target: "npm:left-pad@1.3.0",
            installedVersion: "1.3.0",
            declared: "npm:left-pad@1.3.0",
          },
          { importer: paths["models/a.ts"], specifier: "unlisted" },
        ],
      },
    );
    const texts = await archiveTexts(result.archiveBytes);
    assertEquals(
      texts["models/a.ts"],
      'import ms from "npm:ms@2.1.3";\nimport lp from "npm:left-pad@1.3.0";\nimport u from "unlisted";\nexport const a = [ms, lp, u];\n',
    );
    assertEquals(
      audited[0].map((s) => [s.name, s.version, s.installedVersion]).sort(),
      [["left-pad", "1.3.0", "1.3.0"], ["ms", "^2.1.0", "2.1.3"]],
    );
    const bare = result.reviewRulesResult.warnings.filter((w) =>
      w.ruleId === "bare-specifiers"
    );
    assertEquals(bare.length, 1);
    assertStringIncludes(bare[0].message, ': "unlisted".');
  });
});

Deno.test("extensionPushPrepare: a bare import Deno does not resolve ships as written even when the top-level imports map it (swamp-club#3612)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": 'import ms from "ms";\nexport const a = ms;\n',
    "deno.json": JSON.stringify({ imports: { "ms": "npm:ms@2.1.3" } }),
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(ctx, makePrepareDeps(), {
      ...acceptanceInput(dir, [paths["models/a.ts"]]),
      denoConfigPath: paths["deno.json"],
      bareImports: [{ importer: paths["models/a.ts"], specifier: "ms" }],
    });
    const texts = await archiveTexts(result.archiveBytes);
    assertEquals(
      texts["models/a.ts"],
      'import ms from "ms";\nexport const a = ms;\n',
    );
    const bare = result.reviewRulesResult.warnings.filter((w) =>
      w.ruleId === "bare-specifiers"
    );
    assertEquals(bare.length, 1);
    assertStringIncludes(bare[0].message, '"ms"');
  });
});

Deno.test("extensionPushPrepare: without a deno.json the archive's source keeps its bare imports", async () => {
  await withAcceptanceFixture({
    "models/a.ts": 'import ms from "ms";\nexport const a = ms;\n',
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps(),
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    const texts = await archiveTexts(result.archiveBytes);
    assertEquals(
      texts["models/a.ts"],
      'import ms from "ms";\nexport const a = ms;\n',
    );
  });
});

Deno.test("extensionPushPrepare: an import-map target that could escape its string literal fails the push", async () => {
  await withAcceptanceFixture({
    "models/a.ts": 'import ms from "ms";\nexport const a = ms;\n',
    "deno.json": JSON.stringify({
      imports: { "ms": 'npm:ms@2"; globalThis.pwned = true; "' },
    }),
  }, async (dir, paths) => {
    const bareImports = await topLevelBareImports(
      [paths["models/a.ts"]],
      paths["deno.json"],
    );
    await assertRejects(
      () =>
        extensionPushPrepare(ctx, makePrepareDeps(), {
          ...acceptanceInput(dir, [paths["models/a.ts"]]),
          denoConfigPath: paths["deno.json"],
          bareImports,
        }),
      UserError,
      'Fix the import map entry for "ms"',
    );
  });
});

Deno.test("extensionPushPrepare: the dependency audit gets the project the bundler resolves from", async () => {
  await withAcceptanceFixture({
    "models/a.ts":
      'import x from "npm:left-pad@^1.0.0";\nexport const a = x;\n',
    "deno.json": "{}",
  }, async (dir, paths) => {
    const projects: unknown[] = [];
    await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        extractDependencySpecifiers: () =>
          Promise.resolve([{
            name: "left-pad",
            version: "^1.0.0",
            registry: "npm",
            sourceFile: paths["models/a.ts"],
          }]),
        checkDependencyTrust: (_specifiers, project) => {
          projects.push(project);
          return Promise.resolve({
            errors: [],
            warnings: [],
            audited: [],
            passed: true,
          });
        },
      }),
      {
        ...acceptanceInput(dir, [paths["models/a.ts"]]),
        denoConfigPath: paths["deno.json"],
      },
    );
    assertEquals(projects, [{
      denoConfigPath: paths["deno.json"],
      packageJsonDir: undefined,
    }]);
  });
});

Deno.test("extensionPushPrepare: bundles never write the extension's lockfile", async () => {
  await withAcceptanceFixture({
    "models/a.ts": "export const a = 1;\n",
    "deno.json": "{}",
    "deno.lock": '{"version":"5"}',
  }, async (dir, paths) => {
    const options: unknown[] = [];
    const deps = makePrepareDeps({
      bundleEntryPoint: (_entryPoint, _denoPath, bundleOptions) => {
        options.push(bundleOptions?.readOnlyLock);
        return Promise.resolve("export const a = 1;\n");
      },
    });
    const input = {
      ...acceptanceInput(dir, [paths["models/a.ts"]]),
      denoConfigPath: paths["deno.json"],
    };
    await extensionPushPrepare(ctx, deps, input);
    await Deno.remove(paths["deno.lock"]);
    await extensionPushPrepare(ctx, deps, input);
    assertEquals(options, [{ lockPath: paths["deno.lock"] }, {}]);
  });
});

Deno.test("extensionPushPrepare: a missing JSR version fails the dependency-trust gate", async () => {
  await withCollectFixture({}, async (_dir, input) => {
    const missing = {
      dependency: "@std/assert",
      message: "version 0.0.999 not found on JSR",
      cause: "jsr-missing" as const,
    };
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        extractDependencySpecifiers: () =>
          Promise.resolve([{
            name: "@std/assert",
            version: "0.0.999",
            registry: "jsr",
            sourceFile: input.allModelFiles[0],
          }]),
        checkDependencyTrust: () =>
          Promise.resolve({
            errors: [missing],
            warnings: [],
            audited: [],
            passed: false,
          }),
      }),
      input,
    );
    const failure = result.gateFailures.find((f) =>
      f.gate === "dependency-trust"
    );
    assertEquals(failure !== undefined, true);
  });
});

Deno.test("extensionPushPrepare: a bare import the deno.json maps is audited and its error fails the dependency-trust gate", async () => {
  await withAcceptanceFixture({
    "models/a.ts":
      'import { assert } from "missing-assert";\nexport const a = assert;\n',
    "deno.json": JSON.stringify({
      imports: { "missing-assert": "jsr:@std/assert@0.0.999" },
    }),
  }, async (dir, paths) => {
    const bareImports = await topLevelBareImports(
      [paths["models/a.ts"]],
      paths["deno.json"],
    );
    const audited: DependencySpecifier[][] = [];
    const error = await assertRejects(() =>
      extensionPushPrepare(
        ctx,
        makePrepareDeps({
          extractDependencySpecifiers,
          checkDependencyTrust: (specifiers) => {
            audited.push(specifiers);
            return Promise.resolve({
              errors: [{
                dependency: "@std/assert",
                message:
                  'version 0.0.999 not found on JSR (imported as "missing-assert" through the project\'s Deno config)',
                cause: "jsr-missing",
              }],
              warnings: [],
              audited: [],
              passed: false,
            });
          },
        }),
        {
          ...acceptanceInput(dir, [paths["models/a.ts"]]),
          denoConfigPath: paths["deno.json"],
          bareImports,
        },
      )
    ) as SwampError;
    assertEquals(error.code, "validation_failed");
    assertStringIncludes(
      error.message,
      "Extension has dependency trust errors that must be resolved before pushing.",
    );
    assertEquals(audited, [[{
      name: "@std/assert",
      version: "0.0.999",
      registry: "jsr",
      sourceFile: paths["models/a.ts"],
      importedAs: "missing-assert",
    }]]);
  });
});

const SPREAD_MODEL_SOURCE = 'import { make } from "./factory.ts";\n' +
  'const definition = make({ type: "@testuser/thing", version: "2026.09.25.1" });\n' +
  'export const model = {\n  ...definition,\n  type: "@testuser/thing",\n};\n';

Deno.test("extensionPushPrepare: a model without a literal version is an uncatalogued-model warning naming the file", async () => {
  await withAcceptanceFixture({
    "models/a.ts": SPREAD_MODEL_SOURCE,
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps(),
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    const findings = result.reviewRulesResult.warnings.filter((w) =>
      w.ruleId === "uncatalogued-model"
    );
    assertEquals(findings.length, 1);
    assertEquals(findings[0].file, paths["models/a.ts"]);
    assertEquals(findings[0].severity, "medium");
    assertEquals(findings[0].dimension, "Registry catalog");
    assertEquals(findings[0].line, undefined);
    assertEquals(
      findings[0].message,
      "Behavior export has no string-literal version in its export const model " +
        "object, so the registry catalog will not list this behavior type. " +
        "The extension still installs and the behavior still runs.",
    );
    assertStringIncludes(findings[0].remediation ?? "", "repeating both");
    assertEquals(result.reviewRulesResult.errors, []);
  });
});

Deno.test("extensionPushPrepare: the uncatalogued-model message names an annotation and a model missing both literals", async () => {
  await withAcceptanceFixture({
    "models/a.ts":
      'export const model: Definition = {\n  type: "@testuser/a",\n  version: "2026.09.25.1",\n};\n',
    "models/b.ts": "export const model = {\n  ...definition,\n};\n",
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps(),
      acceptanceInput(dir, [paths["models/a.ts"], paths["models/b.ts"]]),
    );
    const messages = new Map(
      result.reviewRulesResult.warnings
        .filter((w) => w.ruleId === "uncatalogued-model")
        .map((w) => [w.file, w.message]),
    );
    assertStringIncludes(
      messages.get(paths["models/a.ts"]) ?? "",
      "Behavior export has a type annotation, so it is not read as a plain",
    );
    assertStringIncludes(
      messages.get(paths["models/b.ts"]) ?? "",
      "Behavior export has neither a string-literal type nor a string-literal version",
    );
  });
});

Deno.test("extensionPushPrepare: a model with literal type and version is not an uncatalogued-model warning", async () => {
  await withAcceptanceFixture({
    "models/a.ts": SPREAD_MODEL_SOURCE.replace(
      '  type: "@testuser/thing",\n',
      '  type: "@testuser/thing",\n  version: "2026.09.25.1",\n',
    ),
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps(),
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    assertEquals(
      result.reviewRulesResult.warnings.filter((w) =>
        w.ruleId === "uncatalogued-model"
      ),
      [],
    );
  });
});

Deno.test("extensionPushPrepare: an acceptance for uncatalogued-model is invalid and blocks the push", async () => {
  await withAcceptanceFixture({
    "models/a.ts":
      "// swamp-quality-ignore uncatalogued-model: built by a factory\n" +
      SPREAD_MODEL_SOURCE,
  }, async (dir, paths) => {
    const error = await assertRejects(() =>
      extensionPushPrepare(
        ctx,
        makePrepareDeps(),
        acceptanceInput(dir, [paths["models/a.ts"]]),
      )
    ) as SwampError;
    const details = error.details as { reviewRuleErrors: ReviewFinding[] };
    assertEquals(
      details.reviewRuleErrors.map((f) => f.ruleId),
      ["invalid-acceptance"],
    );
    assertStringIncludes(
      details.reviewRuleErrors[0].message,
      '"uncatalogued-model" is not a rule that can be accepted',
    );
  });
});

Deno.test("extensionPushPrepare: an accepted finding in a typed directory beside the manifest is a ../ path in the summary and an archive path for the registry, never a local one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "acceptances-" });
  try {
    const manifestDir = join(dir, "extensions", "models");
    const vaultsDir = join(dir, "extensions", "vaults");
    await Deno.mkdir(manifestDir, { recursive: true });
    await Deno.mkdir(vaultsDir, { recursive: true });
    const vault = join(vaultsDir, "v.ts");
    await Deno.writeTextFile(
      vault,
      "const S = z.object({\n  apiKey: z.string(), // swamp-quality-ignore credentials-sensitive-field: vault key name\n});\n",
    );
    const deps = makePrepareDeps({
      checkReviewRules: () =>
        Promise.resolve({
          errors: [],
          warnings: [SECRET_FINDING(vault, 2)],
          passed: true,
        }),
    });
    const result = await extensionPushPrepare(
      ctx,
      deps,
      makePrepareInput({
        repoDir: dir,
        manifestDir,
        modelsDir: manifestDir,
        vaultsDir,
        allVaultFiles: [vault],
        vaultEntryPoints: [vault],
      }),
    );
    assertEquals(result.acceptances.accepted[0].file, "../vaults/v.ts");
    assertEquals(result.acceptances.accepted[0].archivePath, "vaults/v.ts");
    assertEquals(
      result.contentMetadata?.acceptances?.accepted[0].file,
      "vaults/v.ts",
    );
    // Search for dir as JSON spells it, so a Windows path is found too.
    assertEquals(
      JSON.stringify(result.contentMetadata).includes(
        JSON.stringify(dir).slice(1, -1),
      ),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("extensionPushPrepare: an accepted finding in an additional file maps to files/<entry> for the registry even when the manifest directory is the models directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "acceptances-" });
  try {
    await Deno.mkdir(join(dir, "docs"));
    const readme = join(dir, "docs", "hosts.md");
    await Deno.writeTextFile(
      readme,
      "<!-- swamp-quality-ignore ipv4-address-literals: lab gateway -->\nGateway: 10.0.0.1\n",
    );
    const model = join(dir, "thing.ts");
    await Deno.writeTextFile(model, "export const thing = 1;\n");
    const manifest = makeManifest();
    manifest.additionalFiles = ["docs/hosts.md"];
    const deps = makePrepareDeps({
      analyzeExtensionSafety: () =>
        Promise.resolve({
          errors: [],
          warnings: [{
            ruleId: "ipv4-address-literals",
            file: readme,
            line: 2,
            message: "Line 2 contains IPv4 address literals (10.0.0.1)",
          }],
        }),
    });
    const result = await extensionPushPrepare(
      ctx,
      deps,
      makePrepareInput({
        manifest,
        repoDir: dir,
        manifestDir: dir,
        modelsDir: dir,
        allModelFiles: [model],
        modelEntryPoints: [model],
        additionalFilePaths: [readme],
      }),
    );
    assertEquals(result.acceptances.accepted[0].file, "docs/hosts.md");
    assertEquals(
      result.acceptances.accepted[0].archivePath,
      "files/docs/hosts.md",
    );
    assertEquals(
      result.contentMetadata?.acceptances?.accepted[0].file,
      "files/docs/hosts.md",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── Local gates in collect mode (extension quality) ─────────────────

async function archiveEntries(bytes: Uint8Array): Promise<string[]> {
  return await listTarGzEntries(ReadableStream.from([bytes]));
}

/** A real extension dir: one model plus the given additional files. */
async function withCollectFixture(
  additional: Record<string, string>,
  fn: (dir: string, input: ExtensionPushPrepareInput) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "collect-gates-" });
  try {
    await Deno.mkdir(join(dir, "models"));
    const model = join(dir, "models", "echo.ts");
    await Deno.writeTextFile(model, "export const x = 1;\n");
    const rels = Object.keys(additional);
    for (const [rel, content] of Object.entries(additional)) {
      await Deno.writeTextFile(join(dir, rel), content);
    }
    const input = buildPrepareInput(
      makeManifest({ additionalFiles: rels }),
      dir,
      {
        allModelFiles: [model],
        modelEntryPoints: [model],
        additionalFilePaths: rels.map((r) => join(dir, r)),
        registryChecks: "skip",
        localGates: "collect",
      },
    );
    await fn(dir, input);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("extensionPushPrepare: collect mode records every failed local gate and still builds the archive", async () => {
  await withCollectFixture({ "README.md": "# hi\n" }, async (_dir, input) => {
    const deps = makePrepareDeps({
      analyzeExtensionSafety: () =>
        Promise.resolve({
          errors: [{
            ruleId: "dynamic-code",
            file: input.allModelFiles[0],
            line: 1,
            message: "File contains eval()",
          }],
          warnings: [],
        }),
      extractDependencySpecifiers: () =>
        Promise.resolve([{
          name: "left-pad",
          version: "1",
          registry: "npm",
          sourceFile: input.allModelFiles[0],
        }]),
      checkDependencyTrust: () =>
        Promise.resolve({
          errors: [{ dependency: "npm:left-pad@1", message: "untrusted" }],
          warnings: [],
          audited: [],
          passed: false,
        }),
      checkExtensionQuality: () =>
        Promise.resolve({
          passed: false,
          issues: [{ check: "fmt", output: "not formatted" }],
        }),
      checkReviewRules: () =>
        Promise.resolve({
          errors: [{
            ruleId: "schema-strictness",
            dimension: "schema",
            severity: "high",
            file: input.allModelFiles[0],
            message: "blocking",
          } as ReviewFinding],
          warnings: [],
          passed: false,
        }),
    });

    const result = await extensionPushPrepare(ctx, deps, input);

    assertEquals(
      result.gateFailures.map((f) => f.gate),
      ["safety", "dependency-trust", "fmt-lint", "review"],
    );
    assertStringIncludes(result.gateFailures[0].message, "safety errors");
    // The model has a site-level error, not a file-rejecting one, so it is
    // still packaged and the rubric can score it.
    const entries = await archiveEntries(result.archiveBytes);
    assertEquals(entries.includes("extension/models/echo.ts"), true);
    assertEquals(entries.includes("extension/files/README.md"), true);
  });
});

Deno.test("extensionPushPrepare: enforce mode (the default) still throws the first failed local gate", async () => {
  await withCollectFixture({}, async (_dir, input) => {
    const deps = makePrepareDeps({
      checkExtensionQuality: () =>
        Promise.resolve({
          passed: false,
          issues: [{ check: "lint", output: "lint" }],
        }),
    });
    const error = await assertRejects(
      () =>
        extensionPushPrepare(ctx, deps, { ...input, localGates: undefined }),
    ) as SwampError;
    assertStringIncludes(error.message, "formatting or lint issues");
  });
});

Deno.test("extensionPushPrepare: an unaudited dependency fails no gate and reaches the prepared result", async () => {
  await withCollectFixture({}, async (_dir, input) => {
    const notAudited = {
      dependency: "left-pad",
      message: "not audited: OSV lookup failed (HTTP 503)",
      cause: "not-audited" as const,
    };
    const deps = makePrepareDeps({
      extractDependencySpecifiers: () =>
        Promise.resolve([{
          name: "left-pad",
          version: "1",
          registry: "npm",
          sourceFile: input.allModelFiles[0],
        }]),
      checkDependencyTrust: () =>
        Promise.resolve({
          errors: [],
          warnings: [notAudited],
          audited: [],
          passed: true,
        }),
    });

    const result = await extensionPushPrepare(ctx, deps, {
      ...input,
      localGates: undefined,
    });

    assertEquals(result.gateFailures, []);
    assertEquals(result.dependencyTrustResult.warnings, [notAudited]);
  });
});

Deno.test("extensionPushPrepare: collect mode leaves files rejected by safety and the allowlist out of the archive", async () => {
  await withCollectFixture({
    "README.md": "# hi\n",
    ".secret.txt": "token\n",
    "tool.sh": "#!/bin/sh\n",
    "LICENSE.md": "MIT\n",
  }, async (dir, input) => {
    const deps = makePrepareDeps({
      analyzeExtensionSafety: () =>
        Promise.resolve({
          errors: [
            {
              ruleId: "hidden-file",
              file: join(dir, ".secret.txt"),
              message: "Hidden files are not allowed in extensions.",
            },
            {
              ruleId: "file-type",
              file: join(dir, "tool.sh"),
              message: 'File extension ".sh" is not allowed.',
            },
          ],
          warnings: [],
        }),
    });

    const result = await extensionPushPrepare(ctx, deps, input);

    assertEquals(
      result.gateFailures.map((f) => f.gate),
      ["additional-files", "safety"],
    );
    const files = (await archiveEntries(result.archiveBytes))
      .filter((e) => e.startsWith("extension/files/") && !e.endsWith("/"))
      .sort();
    assertEquals(files, [
      "extension/files/LICENSE.md",
      "extension/files/README.md",
    ]);
  });
});

Deno.test("extensionPushPrepare: collect mode never follows a symlink a safety error rejected", async () => {
  const outside = await Deno.makeTempDir({ prefix: "collect-outside-" });
  try {
    const target = join(outside, "secret.md");
    await Deno.writeTextFile(target, "do not package\n");
    await withCollectFixture({ "README.md": "# hi\n" }, async (dir, input) => {
      const link = join(dir, "NOTES.md");
      await Deno.symlink(target, link, { type: "file" });
      const withLink: ExtensionPushPrepareInput = {
        ...input,
        manifest: {
          ...input.manifest,
          additionalFiles: [...input.manifest.additionalFiles, "NOTES.md"],
        },
        additionalFilePaths: [...input.additionalFilePaths, link],
      };
      const deps = makePrepareDeps({
        analyzeExtensionSafety: () =>
          Promise.resolve({
            errors: [{
              ruleId: "symlink",
              file: link,
              message: "Symlinks are not allowed in extensions.",
            }],
            warnings: [],
          }),
      });

      const result = await extensionPushPrepare(ctx, deps, withLink);

      assertEquals(result.gateFailures.map((f) => f.gate), ["safety"]);
      const entries = await archiveEntries(result.archiveBytes);
      assertEquals(entries.includes("extension/files/NOTES.md"), false);
      assertEquals(entries.includes("extension/files/README.md"), true);
    });
  } finally {
    await Deno.remove(outside, { recursive: true }).catch(() => {});
  }
});

Deno.test("extensionPushPrepare: a symlinked model the safety gate refuses is never formatted, linted, audited or bundled (swamp-club#3420)", async () => {
  const symlinkError = (file: string) => ({
    errors: [{
      ruleId: "symlink",
      file,
      message: "Symlinks are not allowed in extensions.",
    }],
    warnings: [],
  });
  const recording = (file: string) => {
    const seen: string[][] = [];
    const deps = makePrepareDeps({
      analyzeExtensionSafety: () => Promise.resolve(symlinkError(file)),
      extractDependencySpecifiers: (files) => {
        seen.push([...files]);
        return Promise.resolve([]);
      },
      checkExtensionQuality: (files) => {
        seen.push([...files]);
        return Promise.resolve({ passed: true, issues: [] });
      },
      bundleEntryPoint: (entryPoint) => {
        seen.push([entryPoint]);
        return Promise.resolve("/* bundled */");
      },
    });
    return { deps, seen };
  };

  // A push (enforce) stops at the safety gate.
  const enforced = recording("evil.ts");
  await assertRejects(() =>
    extensionPushPrepare(ctx, enforced.deps, makePrepareInput())
  );
  assertEquals(enforced.seen, []);

  // `extension quality` (collect) runs the later gates without it.
  await withCollectFixture({}, async (dir, input) => {
    const link = join(dir, "models", "evil.ts");
    const withLink: ExtensionPushPrepareInput = {
      ...input,
      allModelFiles: [...input.allModelFiles, link],
      modelEntryPoints: [...input.modelEntryPoints, link],
    };
    const collected = recording(link);

    const result = await extensionPushPrepare(ctx, collected.deps, withLink);

    assertEquals(result.gateFailures.map((f) => f.gate), ["safety"]);
    assertEquals(collected.seen.length > 0, true);
    assertEquals(collected.seen.some((files) => files.includes(link)), false);
  });
});

Deno.test("extensionPushPrepare: an entry point whose graph reaches a symlink is never bundled (swamp-club#3420)", async () => {
  await withCollectFixture({}, async (_dir, input) => {
    const bundled: string[] = [];
    const deps = makePrepareDeps({
      bundleEntryPoint: (entryPoint) => {
        bundled.push(entryPoint);
        return Promise.resolve("/* bundled */");
      },
    });

    await extensionPushPrepare(ctx, deps, {
      ...input,
      entryPointsReachingSymlinks: [input.modelEntryPoints[0]],
    });

    assertEquals(bundled, []);
  });
});

Deno.test("extensionPushPrepare: collect mode with no failed gate reports none", async () => {
  await withCollectFixture({ "README.md": "# hi\n" }, async (_dir, input) => {
    const result = await extensionPushPrepare(ctx, makePrepareDeps(), input);
    assertEquals(result.gateFailures, []);
  });
});

Deno.test("extensionPushPrepare: collect mode names a code file that does not parse and leaves it out", async () => {
  await withCollectFixture({
    "README.md": "# hi\n",
    "worker.ts": 'import a from "npm:a@1.0.0";\nexport const broken = ;\n',
  }, async (_dir, input) => {
    const result = await extensionPushPrepare(ctx, makePrepareDeps(), input);
    assertEquals(result.gateFailures.map((f) => f.gate), ["source-syntax"]);
    assertStringIncludes(
      result.gateFailures[0].message,
      "Cannot read the imports of worker.ts: it does not parse (Unexpected token (2:22)).",
    );
    const files = (await archiveEntries(result.archiveBytes))
      .filter((e) => e.startsWith("extension/files/") && !e.endsWith("/"));
    assertEquals(files, ["extension/files/README.md"]);
  });
});

Deno.test("extensionPushPrepare: a code file that does not parse fails the push by name", async () => {
  await withCollectFixture({
    "worker.ts": "export const broken = ;\n",
  }, async (_dir, input) => {
    const error = await assertRejects(() =>
      extensionPushPrepare(ctx, makePrepareDeps(), {
        ...input,
        localGates: "enforce",
      })
    );
    assertStringIncludes(
      (error as Error).message,
      "Cannot read the imports of worker.ts: it does not parse",
    );
  });
});

Deno.test("extensionPushPrepare: a module deno info cannot load because it does not parse is named by the gate", async () => {
  await withCollectFixture({}, async (dir, input) => {
    const broken = join(dir, "models", "broken.ts");
    await Deno.writeTextFile(broken, "export const broken = ;\n");
    const result = await extensionPushPrepare(ctx, makePrepareDeps(), {
      ...input,
      missingModules: [{
        path: broken,
        reason: "SyntaxError: Expression expected",
      }],
    });
    assertEquals(result.gateFailures.map((f) => f.gate), ["source-syntax"]);
    assertStringIncludes(
      result.gateFailures[0].message,
      "Cannot read the imports of models/broken.ts",
    );
  });
});

Deno.test("extensionPushPrepare: a bundle the import scan cannot read fails as a swamp bug", async () => {
  await withCollectFixture({}, async (_dir, input) => {
    const deps = makePrepareDeps({
      bundleEntryPoint: () => Promise.resolve("export const broken = ;\n"),
    });
    const error = await assertRejects(() =>
      extensionPushPrepare(ctx, deps, input)
    );
    assertStringIncludes(
      (error as Error).message,
      "swamp built a bundle for echo that its import scan cannot read",
    );
    assertStringIncludes((error as Error).message, "This is a swamp bug");
  });
});

Deno.test("extensionPushPrepare: collect mode rebuilds instead of reusing a cached archive when a check rejected files", async () => {
  await withCollectFixture(
    { "README.md": "# hi\n", "NOTES.md": "n\n" },
    async (dir, input) => {
      let bundles = 0;
      const deps = makePrepareDeps({
        bundleEntryPoint: () => {
          bundles++;
          return Promise.resolve("/* bundled */");
        },
        analyzeExtensionSafety: () =>
          Promise.resolve({
            errors: [{
              ruleId: "symlink",
              file: join(dir, "NOTES.md"),
              message: "Symlinks are not allowed in extensions.",
            }],
            warnings: [],
          }),
      });
      const result = await extensionPushPrepare(ctx, deps, {
        ...input,
        cachedArchive: new Uint8Array([0x1f, 0x8b, 0x00]),
      });
      assertEquals(bundles, 1, "the cached archive must not be reused");
      const entries = await archiveEntries(result.archiveBytes);
      assertEquals(entries.includes("extension/files/NOTES.md"), false);
      assertEquals(result.excludedFromArchive, [join(dir, "NOTES.md")]);
    },
  );
});

Deno.test("extensionPushPrepare: collect mode leaves a rejected data module out of the archive's source copy", async () => {
  await withCollectFixture({}, async (dir, input) => {
    const blob = join(dir, "models", "blob.bin");
    await Deno.writeFile(blob, new Uint8Array([0, 1, 2]));
    const deps = makePrepareDeps({
      analyzeExtensionSafety: () =>
        Promise.resolve({
          errors: [{
            ruleId: "file-type",
            file: blob,
            message: "Binary files are not allowed in extensions.",
          }],
          warnings: [],
        }),
    });
    const result = await extensionPushPrepare(ctx, deps, {
      ...input,
      dataFilesByKind: { models: [blob] },
      sourcePlan: {
        entries: [
          ...input.sourcePlan.entries,
          { sourcePath: blob, archivePath: "models/blob.bin", rewrites: [] },
        ],
      },
    });
    const entries = await archiveEntries(result.archiveBytes);
    assertEquals(entries.includes("extension/models/blob.bin"), false);
    assertEquals(entries.includes("extension/models/echo.ts"), true);
    assertEquals(result.excludedFromArchive, [blob]);
  });
});

Deno.test("extensionPush: carries the registry's warnings on the completed event", async () => {
  const warnings = {
    messages: ["contentMetadata was rejected (too many methods)"],
    omitted: 2,
  };
  const events = await collect(extensionPush(
    ctx,
    makeExecuteDeps({
      confirmPush: () =>
        Promise.resolve({
          name: "@testuser/test-ext",
          version: "2026.03.22.1",
          extensionId: "ext-123",
          warnings,
        }),
    }),
    makeExecuteInput(),
  ));
  const last = events.at(-1);
  assertEquals(last?.kind, "completed");
  if (last?.kind === "completed") {
    assertEquals(last.data.registryWarnings, warnings);
  }
});

for (const warnings of [undefined, { messages: [], omitted: 0 }]) {
  Deno.test(
    `extensionPush: completed event has no registryWarnings when the registry returns ${
      warnings ? "none" : "no field"
    }`,
    async () => {
      const events = await collect(extensionPush(
        ctx,
        makeExecuteDeps({
          confirmPush: () =>
            Promise.resolve({
              name: "@testuser/test-ext",
              version: "2026.03.22.1",
              extensionId: "ext-123",
              ...(warnings ? { warnings } : {}),
            }),
        }),
        makeExecuteInput(),
      ));
      const last = events.at(-1);
      assertEquals(last?.kind, "completed");
      if (last?.kind === "completed") {
        assertEquals("registryWarnings" in last.data, false);
      }
    },
  );
}

Deno.test("extensionPushPrepare: push rejection for a yanked version carries the yank and its reason", async () => {
  const deps = makePrepareDeps({
    findPublishedVersion: () =>
      Promise.resolve({
        version: "2026.03.22.1",
        channel: "beta",
        yank: { reason: "broken build" },
      }),
  });

  const error = await assertRejects(
    () =>
      extensionPushPrepare(
        ctx,
        deps,
        makePrepareInput({ dryRun: false, channel: "rc" }),
      ),
  ) as SwampError;
  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "has been yanked (broken build)");
  assertEquals(error.message.includes("swamp extension promote"), false);
  assertEquals(error.details, {
    existingVersion: "2026.03.22.1",
    existingChannel: "beta",
    requestedChannel: "rc",
    existingYanked: true,
    existingYankReason: "broken build",
  });
});

Deno.test("extensionPushPrepare: dry run reports a yanked version as taken and names the yank", async () => {
  const deps = makePrepareDeps({
    findPublishedVersion: () =>
      Promise.resolve({
        version: "2026.03.22.1",
        channel: "beta",
        yank: { reason: null },
      }),
  });

  const result = await extensionPushPrepare(
    ctx,
    deps,
    makePrepareInput({ dryRun: true }),
  );
  const check = result.registryChecks.find((c) => c.name === "version-exists");
  assertEquals(check?.status, "failed");
  assertEquals(check?.existingYanked, true);
  assertStringIncludes(check?.message ?? "", "has been yanked.");
  assertEquals(
    (check?.message ?? "").includes("swamp extension promote"),
    false,
  );
});

// ── Declared license (optional) ─────────────────────────────────────

Deno.test("extensionPushPrepare: a license is optional — no license and no LICENSE file prepares with no warning", async () => {
  await withCollectFixture({}, async (_dir, input) => {
    const result = await extensionPushPrepare(ctx, makePrepareDeps(), input);
    assertEquals(result.gateFailures, []);
    assertEquals(result.licenseWarning, undefined);
    assertEquals(result.resolvedData.license, null);
  });
});

Deno.test("extensionPushPrepare: a valid SPDX license prepares with no warning and is resolved", async () => {
  await withCollectFixture({}, async (_dir, input) => {
    const result = await extensionPushPrepare(ctx, makePrepareDeps(), {
      ...input,
      manifest: { ...input.manifest, license: "MIT OR Apache-2.0" },
    });
    assertEquals(result.licenseWarning, undefined);
    assertEquals(result.resolvedData.license, "MIT OR Apache-2.0");
  });
});

Deno.test("extensionPushPrepare: an invalid or non-SPDX license warns and never blocks, even when a push enforces its gates", async () => {
  for (
    const [license, reason] of [
      ["MIT Apache-2.0", "invalid-syntax"],
      ["Swampy-1.0", "unknown-license"],
      ["GPL-2.0+", "deprecated-license"],
      ["LicenseRef-Mine", "custom-ref"],
      [
        "AGPL-3.0-only WITH AdditionRef-Swamp-Extension-Exception",
        "custom-ref",
      ],
    ] as const
  ) {
    await withCollectFixture({}, async (_dir, input) => {
      const result = await extensionPushPrepare(ctx, makePrepareDeps(), {
        ...input,
        manifest: { ...input.manifest, license },
        localGates: "enforce",
      });
      assertEquals(result.licenseWarning?.reason, reason, license);
      assertEquals(result.licenseWarning?.license, license);
      assertEquals(result.resolvedData.license, license);
    });
  }
});

/** An archive index whose sources load as `loaded` and fail as `failed`. */
function archiveIndex(
  loaded: Array<
    {
      fileName: string;
      type: string;
      kind?: "model" | "extension" | "vault";
      kindDir?: ExtensionKindDir;
    }
  >,
  failed: Array<{ fileName: string; reason: string }> = [],
): () => Promise<ExtensionTreeIndex> {
  return () =>
    Promise.resolve({
      sources: loaded.map((s) => ({
        kindDir: s.kindDir ?? "models",
        absolutePath: `/archive/models/${s.fileName}`,
        fileName: s.fileName,
        indexed: {
          kind: s.kind ?? "model",
          typeNormalized: s.type,
          bundlePath: "",
          fingerprint: "f",
          fromCache: false,
        },
      })),
      failures: failed.map((f) => ({
        kindDir: "models" as const,
        absolutePath: `/archive/models/${f.fileName}`,
        fileName: f.fileName,
        reason: f.reason,
      })),
    });
}

const CONSTANT_TYPE_SOURCE = 'const TYPE = "@testuser/thing";\n' +
  'export const model = {\n  type: TYPE,\n  version: "2026.09.25.1",\n};\n';

Deno.test("extensionPushPrepare: a model whose type is not a literal shows the type it registers when loaded, not its path (swamp-club#3456)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": CONSTANT_TYPE_SOURCE,
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        indexArchive: archiveIndex([{
          fileName: "a.ts",
          type: "@testuser/thing",
        }]),
      }),
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    assertEquals(result.resolvedData.models[0].type, "@testuser/thing");
    assertEquals(result.gateFailures, []);
  });
});

Deno.test("extensionPushPrepare: a model whose type is neither readable nor loadable has no type, not its path (swamp-club#3456)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": CONSTANT_TYPE_SOURCE,
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        indexArchive: archiveIndex([], [{
          fileName: "a.ts",
          reason: "Module not found\nat line 1",
        }]),
      }),
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    assertEquals(result.resolvedData.models[0].type, undefined);
    assertEquals(
      result.resolvedData.models[0].fileName.endsWith("a.ts"),
      true,
    );
  });
});

Deno.test("extensionPushPrepare: a loaded type outside the collective blocks a push even when the source writes no literal type (swamp-club#3456)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": CONSTANT_TYPE_SOURCE,
  }, async (dir, paths) => {
    const error = await assertRejects(
      () =>
        extensionPushPrepare(
          ctx,
          makePrepareDeps({
            indexArchive: archiveIndex([{
              fileName: "a.ts",
              type: "@swamp/aws-ec2",
            }]),
          }),
          {
            ...acceptanceInput(dir, [paths["models/a.ts"]]),
            localGates: undefined,
          },
        ),
    ) as SwampError;
    assertStringIncludes(error.message, "don't match the extension package");
    assertEquals(error.details, {
      expectedCollective: "@testuser/",
      mismatches: [{
        kind: "model",
        identifier: "@swamp/aws-ec2",
        fileName: "a.ts",
      }],
    });
  });
});

Deno.test("extensionPushPrepare: a helper file that registers a foreign type is a collective mismatch (swamp-club#3456)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": CONSTANT_TYPE_SOURCE,
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        indexArchive: archiveIndex([
          { fileName: "a.ts", type: "@testuser/thing" },
          { fileName: "lib/helper.ts", type: "@swamp/aws-ec2" },
          // An extension source adds methods to another type; it registers
          // none of its own, so it is not checked.
          { fileName: "ext.ts", type: "@swamp/aws-s3", kind: "extension" },
        ]),
      }),
      {
        ...acceptanceInput(dir, [paths["models/a.ts"]]),
        localGates: "collect",
      },
    );
    assertEquals(result.gateFailures.map((f) => f.gate), [
      "content-collectives",
    ]);
    assertEquals(
      (result.gateFailures[0].details as {
        mismatches: Array<{ fileName: string }>;
      }).mismatches.map((m) => m.fileName),
      ["lib/helper.ts"],
    );
  });
});

Deno.test("extensionPushPrepare: a file the static check already reported is listed once, beside a mismatch only loading finds (swamp-club#3456)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": 'export const model = { type: "@other/x" };\n',
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        extractContentMetadata: () =>
          Promise.resolve({
            models: [{
              fileName: "a.ts",
              type: "@other/x",
              version: "2026.09.25.1",
              globalArguments: [],
              methods: [],
              resources: [],
              files: [],
            }],
            extensions: [],
            workflows: [],
            vaults: [],
            datastores: [],
            reports: [],
            webhooks: [],
            skills: [],
          }),
        indexArchive: archiveIndex([
          { fileName: "a.ts", type: "@other/x" },
          { fileName: "b.ts", type: "@evil/y" },
        ]),
      }),
      {
        ...acceptanceInput(dir, [paths["models/a.ts"]]),
        localGates: "collect",
      },
    );
    const collectives = result.gateFailures.filter((f) =>
      f.gate === "content-collectives"
    );
    assertEquals(collectives.length, 1);
    assertEquals(
      (collectives[0].details as {
        mismatches: Array<{ fileName: string; identifier: string }>;
      }).mismatches.map((m) => [m.fileName, m.identifier]),
      [["a.ts", "@other/x"], ["b.ts", "@evil/y"]],
    );
  });
});

Deno.test("extensionPushPrepare: a literal type in the collective still fails when the loaded type is outside it (swamp-club#3456)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": SPREAD_MODEL_SOURCE,
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        indexArchive: archiveIndex([{ fileName: "a.ts", type: "@evil/y" }]),
      }),
      {
        ...acceptanceInput(dir, [paths["models/a.ts"]]),
        localGates: "collect",
      },
    );
    assertEquals(result.gateFailures.map((f) => f.gate), [
      "content-collectives",
    ]);
  });
});

Deno.test("extensionPushPrepare: a source that neither reads nor loads gets an unverified-collective warning; one that reads does not (swamp-club#3456)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": CONSTANT_TYPE_SOURCE,
    "models/b.ts": 'export const model = { type: "@testuser/b" };\n',
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        extractContentMetadata: () =>
          Promise.resolve({
            models: [{
              fileName: "b.ts",
              type: "@testuser/b",
              version: "2026.09.25.1",
              globalArguments: [],
              methods: [],
              resources: [],
              files: [],
            }],
            extensions: [],
            workflows: [],
            vaults: [],
            datastores: [],
            reports: [],
            webhooks: [],
            skills: [],
          }),
        indexArchive: archiveIndex([], [
          { fileName: "a.ts", reason: "Uncaught Error: boom\n    at x" },
          { fileName: "b.ts", reason: "Uncaught Error: boom" },
        ]),
      }),
      acceptanceInput(dir, [paths["models/a.ts"], paths["models/b.ts"]]),
    );
    const unverified = result.reviewRulesResult.warnings.filter((w) =>
      w.ruleId === "unverified-collective"
    );
    assertEquals(unverified.map((w) => w.file), [paths["models/a.ts"]]);
    assertStringIncludes(unverified[0].message, "(Uncaught Error: boom)");
    assertEquals(result.gateFailures, []);
  });
});

Deno.test("extensionPushPrepare: when the archive cannot be indexed the push goes on, warning for each source without a literal type (swamp-club#3456)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": CONSTANT_TYPE_SOURCE,
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        indexArchive: () => Promise.reject(new Error("over the limit")),
      }),
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    assertEquals(
      result.reviewRulesResult.warnings
        .filter((w) => w.ruleId === "unverified-collective")
        .map((w) => w.file),
      [paths["models/a.ts"]],
    );
    assertEquals(result.resolvedData.models[0].type, undefined);
  });
});

Deno.test("extensionPushPrepare: an extension source shows the type it extends, not its path (swamp-club#3456)", async () => {
  await withAcceptanceFixture({
    "models/ext.ts": 'export const extension = { type: "@other/base" };\n',
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        extractContentMetadata: () =>
          Promise.resolve({
            models: [],
            extensions: [{
              fileName: "ext.ts",
              extendsType: "@other/base",
              methods: [],
              resources: [],
            }],
            workflows: [],
            vaults: [],
            datastores: [],
            reports: [],
            webhooks: [],
            skills: [],
          }),
      }),
      acceptanceInput(dir, [paths["models/ext.ts"]]),
    );
    assertEquals(result.resolvedData.models[0].type, "@other/base");
    assertEquals(result.gateFailures, []);
  });
});

Deno.test("extensionPushPrepare: bundles that finish out of order are packed in entry point order (swamp-club#3456)", async () => {
  const names = ["a", "b", "c", "d", "e", "f"];
  await withAcceptanceFixture(
    Object.fromEntries(
      names.map((n) => [`models/${n}.ts`, `export const ${n} = 1;\n`]),
    ),
    async (dir, paths) => {
      const entryPoints = names.map((n) => paths[`models/${n}.ts`]);
      const result = await extensionPushPrepare(
        ctx,
        makePrepareDeps({
          // Earlier entry points take more turns to finish, so with several
          // running at once the later ones complete first.
          bundleEntryPoint: async (entryPoint) => {
            const turns = names.length - entryPoints.indexOf(entryPoint);
            for (let i = 0; i < turns * 10; i++) await Promise.resolve();
            return `/* ${entryPoint} */`;
          },
        }),
        acceptanceInput(dir, entryPoints),
      );
      const entries = await listTarGzEntries(
        ReadableStream.from([result.archiveBytes]),
      );
      assertEquals(
        entries.filter((e) =>
          e.startsWith("extension/bundles/") && e.endsWith(".js")
        ),
        names.map((n) => `extension/bundles/${n}.js`),
      );
    },
  );
});

Deno.test("extensionPushPrepare: a _test.ts source whose loaded type is outside the collective blocks the push, as consumers load it (swamp-club#3456)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": CONSTANT_TYPE_SOURCE,
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        indexArchive: archiveIndex([
          { fileName: "a.ts", type: "@testuser/thing" },
          { fileName: "ec2_test.ts", type: "@swamp/aws/ec2" },
        ]),
      }),
      {
        ...acceptanceInput(dir, [paths["models/a.ts"]]),
        localGates: "collect",
      },
    );
    assertEquals(
      (result.gateFailures[0]?.details as {
        mismatches: Array<{ fileName: string }>;
      } | undefined)?.mismatches.map((m) => m.fileName),
      ["ec2_test.ts"],
    );
  });
});

Deno.test("extensionPushPrepare: a file with a symlink on its path is refused by the symlink rule, and never analyzed or read for metadata (swamp-club#3421)", async () => {
  await withCollectFixture({}, async (dir, input) => {
    const linkDir = join(dir, "models", "foo");
    const linked = join(linkDir, "foo.ts");
    const analyzed: string[][] = [];
    const extracted: string[][] = [];
    const deps = makePrepareDeps({
      analyzeExtensionSafety: (files) => {
        analyzed.push([...files]);
        return Promise.resolve({ errors: [], warnings: [] });
      },
      extractContentMetadata: (models, _dir, workflows) => {
        extracted.push([...models, ...workflows.map((w) => w.sourcePath)]);
        return Promise.resolve({
          models: [],
          extensions: [],
          workflows: [],
          vaults: [],
          datastores: [],
          reports: [],
          webhooks: [],
          skills: [],
        });
      },
    });

    const result = await extensionPushPrepare(ctx, deps, {
      ...input,
      allModelFiles: [...input.allModelFiles, linked],
      modelEntryPoints: [...input.modelEntryPoints, linked],
      symlinkedPaths: new Map([[linked, linkDir]]),
    });

    const safety = result.gateFailures.find((f) => f.gate === "safety");
    // Read the message itself: JSON would double each backslash of a
    // Windows path, so the path never matches its JSON text.
    const symlinkError = (safety?.details as {
      safetyErrors?: Array<{ ruleId: string; message: string }>;
    } | undefined)?.safetyErrors?.find((e) => e.ruleId === "symlink");
    assertStringIncludes(
      symlinkError?.message ?? "",
      `${linkDir} is a symlink`,
    );
    assertEquals(analyzed.some((files) => files.includes(linked)), false);
    assertEquals(extracted.some((files) => files.includes(linked)), false);
  });
});

Deno.test("extensionPushPrepare: the archive records the version the audit checked for each dependency (swamp-club#3662)", async () => {
  await withAcceptanceFixture({
    "models/a.ts":
      'import ms from "npm:ms@^2.0.0";\nimport p from "pkg";\nexport const a = [ms, p];\n',
  }, async (dir, paths) => {
    const written: DependencySpecifier = {
      name: "ms",
      version: "^2.0.0",
      registry: "npm",
      sourceFile: paths["models/a.ts"],
    };
    const installed: DependencySpecifier = {
      name: "pkg",
      version: "^1.0.0",
      registry: "npm",
      sourceFile: paths["models/a.ts"],
      importedAs: "pkg",
      installedVersion: "1.4.0",
    };
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps({
        extractDependencySpecifiers: () =>
          Promise.resolve([written, installed]),
        checkDependencyTrust: () =>
          Promise.resolve({
            errors: [],
            warnings: [],
            audited: [],
            passed: true,
            shipped: [
              {
                specifier: written,
                shipped: { version: "2.1.0", from: "lockfile" },
              },
              {
                specifier: installed,
                shipped: { version: "1.4.0", from: "installed" },
              },
            ],
          }),
      }),
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    const texts = await archiveTexts(result.archiveBytes);
    assertEquals(JSON.parse(texts["dependency-audit.json"]), {
      recordVersion: 1,
      dependencies: [
        {
          registry: "npm",
          name: "ms",
          spec: "^2.0.0",
          version: "2.1.0",
          from: "lockfile",
        },
        {
          registry: "npm",
          name: "pkg",
          spec: "1.4.0",
          version: "1.4.0",
          from: "installed",
        },
      ],
    });
  });
});

Deno.test("extensionPushPrepare: an extension with no dependencies still records an empty audit (swamp-club#3662)", async () => {
  await withAcceptanceFixture({
    "models/a.ts": "export const a = 1;\n",
  }, async (dir, paths) => {
    const result = await extensionPushPrepare(
      ctx,
      makePrepareDeps(),
      acceptanceInput(dir, [paths["models/a.ts"]]),
    );
    const texts = await archiveTexts(result.archiveBytes);
    assertEquals(
      texts["dependency-audit.json"],
      '{\n  "recordVersion": 1,\n  "dependencies": []\n}\n',
    );
  });
});
