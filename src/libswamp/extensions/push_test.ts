// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { Logger } from "@logtape/logtape";
import {
  extensionPush,
  type ExtensionPushExecuteDeps,
  type ExtensionPushExecuteInput,
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
} from "./push.ts";
import type { SwampError } from "../errors.ts";
import type { ExtensionManifest } from "../../domain/extensions/extension_manifest.ts";

function makeManifest(
  overrides?: Partial<ExtensionManifest>,
): ExtensionManifest {
  return {
    manifestVersion: 1,
    name: "@testuser/test-ext",
    version: "2026.03.22.1",
    description: "Test extension",
    repository: undefined,
    workflows: [],
    models: ["echo.ts"],
    vaults: [],
    drivers: [],
    datastores: [],
    reports: [],
    skills: [],
    include: [],
    additionalFiles: [],
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
  return {
    manifest: makeManifest(),
    repoDir: "/tmp/test-repo",
    modelsDir: "/tmp/test-repo/models",
    allModelFiles: [],
    modelEntryPoints: [],
    vaultsDir: "/tmp/test-repo/vaults",
    allVaultFiles: [],
    vaultEntryPoints: [],
    driversDir: "/tmp/test-repo/drivers",
    allDriverFiles: [],
    driverEntryPoints: [],
    datastoresDir: "/tmp/test-repo/datastores",
    allDatastoreFiles: [],
    datastoreEntryPoints: [],
    reportsDir: "/tmp/test-repo/reports",
    allReportFiles: [],
    reportEntryPoints: [],
    workflowFiles: [],
    skillDirs: [],
    allSkillFiles: [],
    includeFilePaths: [],
    additionalFilePaths: [],
    dryRun: true,
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
        workflows: [],
        vaults: [],
        drivers: [],
        datastores: [],
        reports: [],
        skills: [],
      }),
    analyzeExtensionSafety: () => Promise.resolve({ errors: [], warnings: [] }),
    checkExtensionQuality: () => Promise.resolve({ passed: true, issues: [] }),
    bundleEntryPoint: () => Promise.resolve("/* bundled */"),
    ensureDenoPath: () => Promise.resolve("/usr/bin/deno"),
    getLatestVersion: () => Promise.resolve(null),
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
      drivers: 0,
      datastores: 0,
      reports: 0,
      skills: 0,
    },
    ...overrides,
  };
}

const ctx = createLibSwampContext();

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

Deno.test("extensionPushPrepare: skips auth for dry run", async () => {
  let credentialsCalled = false;
  const deps = makePrepareDeps({
    loadCredentials: () => {
      credentialsCalled = true;
      return Promise.resolve(null);
    },
  });
  const input = makePrepareInput({ dryRun: true });

  await extensionPushPrepare(ctx, deps, input);
  assertEquals(credentialsCalled, false);
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
