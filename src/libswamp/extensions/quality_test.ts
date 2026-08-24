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
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  computePackageCacheHash,
  ExtensionPackageCache,
  type PackageCacheHashInput,
} from "../../domain/extensions/extension_package_cache.ts";
import {
  type DocOutput,
  RUBRIC_VERSION,
  type RubricScoreDeps,
} from "../../domain/extensions/extension_rubric_scorer.ts";
import type { ExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import type {
  ExtensionPushPrepareDeps,
  ExtensionPushPrepareInput,
} from "./push.ts";
import {
  extensionQuality,
  type ExtensionQualityDeps,
  type ExtensionQualityEvent,
  type ExtensionQualityInput,
} from "./quality.ts";

const ctx = createLibSwampContext();

const CLEAN_MODEL_SOURCE = "export const echo = (s: string): string => s;\n";

// Substantive README: > 500 chars with >= 2 fenced code blocks, so the
// rich-readme factor is earned and the fixture scores a full envelope.
const RICH_README = "# Test Extension\n\n" +
  "This extension echoes input. ".repeat(30) +
  "\n\n```ts\nimport { echo } from './models/echo.ts';\n```\n\n" +
  "```ts\necho('swamp');\n```\n";

function makeManifest(
  overrides?: Partial<ExtensionManifest>,
): ExtensionManifest {
  return {
    manifestVersion: 1,
    name: "@testuser/test-ext",
    version: "2026.03.22.1",
    description: "Test extension",
    repository: "https://github.com/testuser/test-ext",
    paths: { base: "typedDir" },
    workflows: [],
    models: ["echo.ts"],
    vaults: [],
    drivers: [],
    datastores: [],
    reports: [],
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

async function makeRepo(modelSource: string): Promise<string> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_quality_repo_" });
  await Deno.mkdir(join(repoDir, "models"), { recursive: true });
  await Deno.writeTextFile(join(repoDir, "models", "echo.ts"), modelSource);
  return repoDir;
}

function makePrepareInput(
  repoDir: string,
  manifest: ExtensionManifest,
  overrides?: Partial<ExtensionPushPrepareInput>,
): ExtensionPushPrepareInput {
  const modelPath = join(repoDir, "models", "echo.ts");
  return {
    manifest,
    repoDir,
    modelsDir: join(repoDir, "models"),
    allModelFiles: [modelPath],
    modelEntryPoints: [modelPath],
    vaultsDir: join(repoDir, "vaults"),
    allVaultFiles: [],
    vaultEntryPoints: [],
    driversDir: join(repoDir, "drivers"),
    allDriverFiles: [],
    driverEntryPoints: [],
    datastoresDir: join(repoDir, "datastores"),
    allDatastoreFiles: [],
    datastoreEntryPoints: [],
    reportsDir: join(repoDir, "reports"),
    allReportFiles: [],
    reportEntryPoints: [],
    workflowFiles: [],
    skillDirs: [],
    allSkillFiles: [],
    includeFilePaths: [],
    additionalFilePaths: [],
    binaryFilePaths: [],
    dryRun: true,
    ...overrides,
  };
}

function makeHashInput(
  repoDir: string,
  manifest: ExtensionManifest,
  overrides?: Partial<PackageCacheHashInput>,
): PackageCacheHashInput {
  return {
    manifest,
    rootDir: repoDir,
    modelFilePaths: [join(repoDir, "models", "echo.ts")],
    vaultFilePaths: [],
    driverFilePaths: [],
    datastoreFilePaths: [],
    reportFilePaths: [],
    workflowFilePaths: [],
    additionalFilePaths: [],
    binaryFilePaths: [],
    skillFilePaths: [],
    includeFilePaths: [],
    denoConfigPath: undefined,
    packageJsonPath: undefined,
    ...overrides,
  };
}

function makeQualityInput(
  repoDir: string,
  manifest: ExtensionManifest,
  overrides?: {
    prepareInput?: Partial<ExtensionPushPrepareInput>;
    hashInput?: Partial<PackageCacheHashInput>;
  },
): ExtensionQualityInput {
  return {
    prepareInput: makePrepareInput(repoDir, manifest, overrides?.prepareInput),
    hashInput: makeHashInput(repoDir, manifest, overrides?.hashInput),
  };
}

function makePushPrepareDeps(
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
        drivers: [],
        datastores: [],
        reports: [],
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
    ensureDenoPath: () => Promise.resolve("/fake/deno"),
    getDenoEnv: () => ({}),
    getLatestVersion: () => Promise.resolve(null),
    getLatestVersionDetail: () => Promise.resolve(null),
    ...overrides,
  };
}

const MINIMAL_DOC_OUTPUT: DocOutput = { version: 1, nodes: {} };

/**
 * In-process stand-in for the real tarball scorer plumbing: "extraction"
 * writes a fixed tree (ignoring the archive bytes — orchestration is
 * under test here, not the archiver) and "deno" invocations return
 * canned doc/lint output. No subprocesses are spawned.
 */
function fakeScoreDeps(
  onRunDeno?: (args: string[], cwd: string) => void,
): RubricScoreDeps {
  return {
    extractTarball: async (
      _source: ReadableStream<Uint8Array>,
      destDir: string,
    ) => {
      const extDir = join(destDir, "extension");
      await Deno.mkdir(join(extDir, "models"), { recursive: true });
      await Deno.writeTextFile(
        join(extDir, "manifest.yaml"),
        "manifestVersion: 1\nname: '@testuser/test-ext'\n",
      );
      await Deno.writeTextFile(
        join(extDir, "models", "echo.ts"),
        CLEAN_MODEL_SOURCE,
      );
      await Deno.writeTextFile(join(extDir, "README.md"), RICH_README);
      await Deno.writeTextFile(join(extDir, "LICENSE"), "AGPL-3.0-only\n");
    },
    runDeno: (args: string[], cwd: string) => {
      onRunDeno?.(args, cwd);
      if (args[0] === "doc" && args[1] === "--json") {
        return Promise.resolve({
          success: true,
          stdout: JSON.stringify(MINIMAL_DOC_OUTPUT),
          stderr: "",
        });
      }
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
  };
}

function makeQualityDeps(
  cacheRoot: string,
  options?: {
    pushPrepareOverrides?: Partial<ExtensionPushPrepareDeps>;
    ensureDenoPath?: () => Promise<string>;
    onRunDeno?: (args: string[], cwd: string) => void;
  },
): ExtensionQualityDeps {
  return {
    pushPrepareDeps: makePushPrepareDeps(options?.pushPrepareOverrides),
    cache: new ExtensionPackageCache(cacheRoot),
    ensureDenoPath: options?.ensureDenoPath ??
      (() => Promise.resolve("/fake/deno")),
    makeScoreDeps: () => fakeScoreDeps(options?.onRunDeno),
  };
}

function eventKinds(events: ExtensionQualityEvent[]): string[] {
  return events.map((e) => e.kind);
}

function completedData(events: ExtensionQualityEvent[]) {
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
  if (last.kind !== "completed") throw new Error("unreachable");
  return last.data;
}

async function withQualityFixture(
  modelSource: string,
  fn: (repoDir: string, cacheRoot: string) => Promise<void>,
): Promise<void> {
  const repoDir = await makeRepo(modelSource);
  const cacheRoot = await Deno.makeTempDir({ prefix: "swamp_quality_cache_" });
  try {
    await fn(repoDir, cacheRoot);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    await Deno.remove(cacheRoot, { recursive: true }).catch(() => {});
  }
}

// ── Fresh run: aggregation into the band/score envelope ───────────────

Deno.test("extensionQuality: fresh run yields packaging → scoring → completed with the full score envelope", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    const deps = makeQualityDeps(cacheRoot);

    const events = await collect(extensionQuality(ctx, deps, input));
    assertEquals(eventKinds(events), ["packaging", "scoring", "completed"]);

    const data = completedData(events);
    assertEquals(data.cacheHit, false);
    assertEquals(
      data.cacheHash,
      await computePackageCacheHash(input.hashInput),
    );
    assert(data.archiveSize > 0);
    assertEquals(data.dependencyTrustResult.passed, true);

    // The documented envelope for a fully-earned extension whose
    // repository URL is structurally verifiable (provisional factor).
    const score = data.score;
    assertEquals(score.rubricVersion, RUBRIC_VERSION);
    assertEquals(score.factors.length, 10);
    assertEquals(score.earnedPoints, 12);
    assertEquals(score.maxEarnablePoints, 14);
    assertEquals(score.maxClientEarnablePoints, 12);
    assertEquals(score.provisionalPoints, 2);
    assertEquals(score.percentage, 100);
    assertEquals(score.allPassed, true);
    const repoFactor = score.factors.find((f) =>
      f.id === "repository-verified"
    )!;
    assertEquals(repoFactor.status, "provisional");
  });
});

Deno.test("extensionQuality: fresh run populates the package cache with tarball bytes and metadata", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    const deps = makeQualityDeps(cacheRoot);

    const events = await collect(extensionQuality(ctx, deps, input));
    const data = completedData(events);

    const cached = await deps.cache.get(data.cacheHash);
    assert(cached !== null, "cache entry must exist after a fresh run");
    assertEquals(cached.archiveBytes.length, data.archiveSize);
    assertEquals(cached.metadata.hash, data.cacheHash);
    assertEquals(cached.metadata.extensionName, manifest.name);
    assertEquals(cached.metadata.extensionVersion, manifest.version);
    assertEquals(cached.metadata.archiveSize, data.archiveSize);
    assertEquals(cached.metadata.rubricVersion, RUBRIC_VERSION);
  });
});

// ── Cache reuse ───────────────────────────────────────────────────────

Deno.test("extensionQuality: cache populated by quality is reused on second run", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    let bundleCalls = 0;
    const deps = makeQualityDeps(cacheRoot, {
      pushPrepareOverrides: {
        bundleEntryPoint: () => {
          bundleCalls++;
          return Promise.resolve("/* bundled */");
        },
      },
    });

    const first = await collect(extensionQuality(ctx, deps, input));
    const firstData = completedData(first);
    assertEquals(firstData.cacheHit, false);
    assertEquals(bundleCalls, 1);

    const second = await collect(extensionQuality(ctx, deps, input));
    assertEquals(eventKinds(second), ["cache_hit", "scoring", "completed"]);
    const cacheHitEvent = second[0];
    if (cacheHitEvent.kind === "cache_hit") {
      assertEquals(cacheHitEvent.hash, firstData.cacheHash);
    }

    const secondData = completedData(second);
    assertEquals(secondData.cacheHit, true);
    assertEquals(secondData.cacheHash, firstData.cacheHash);
    assertEquals(secondData.archiveSize, firstData.archiveSize);
    assertEquals(secondData.score.percentage, firstData.score.percentage);
    assertEquals(bundleCalls, 1, "cache hit must not repackage");
  });
});

Deno.test("extensionQuality: source content change produces a new hash and repackages", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    const deps = makeQualityDeps(cacheRoot);

    const first = await collect(extensionQuality(ctx, deps, input));
    const firstData = completedData(first);

    await Deno.writeTextFile(
      join(repoDir, "models", "echo.ts"),
      "export const echo = (s: string): string => s + s;\n",
    );

    const second = await collect(extensionQuality(ctx, deps, input));
    assertEquals(eventKinds(second), ["packaging", "scoring", "completed"]);
    const secondData = completedData(second);
    assertEquals(secondData.cacheHit, false);
    assertNotEquals(secondData.cacheHash, firstData.cacheHash);
  });
});

// ── Error paths ───────────────────────────────────────────────────────

Deno.test("extensionQuality: prepare failure yields an error event and does not populate the cache", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    const deps = makeQualityDeps(cacheRoot, {
      pushPrepareOverrides: {
        analyzeExtensionSafety: () =>
          Promise.resolve({
            errors: [{ file: "echo.ts", message: "contains eval()" }],
            warnings: [],
          }),
      },
    });

    const events = await collect(extensionQuality(ctx, deps, input));
    assertEquals(eventKinds(events), ["packaging", "error"]);
    const last = events[events.length - 1];
    if (last.kind === "error") {
      assertEquals(last.error.code, "validation_failed");
    }

    const hash = await computePackageCacheHash(input.hashInput);
    assertEquals(await deps.cache.get(hash), null);
  });
});

const BARE_IMPORT_MODEL_SOURCE =
  'import { z } from "zod";\nexport const schema = z.string();\n';

Deno.test("extensionQuality: bare import specifiers abort before scoring with a validation error", async () => {
  await withQualityFixture(
    BARE_IMPORT_MODEL_SOURCE,
    async (repoDir, cacheRoot) => {
      const manifest = makeManifest();
      const input = makeQualityInput(repoDir, manifest);
      let denoResolves = 0;
      const deps = makeQualityDeps(cacheRoot, {
        ensureDenoPath: () => {
          denoResolves++;
          return Promise.resolve("/fake/deno");
        },
      });

      const events = await collect(extensionQuality(ctx, deps, input));
      assertEquals(eventKinds(events), ["packaging", "error"]);
      const last = events[events.length - 1];
      if (last.kind === "error") {
        assertEquals(last.error.code, "validation_failed");
        assertStringIncludes(last.error.message, '"zod"');
        assertStringIncludes(last.error.message, "npm:");
      }
      assertEquals(denoResolves, 0, "scoring must not start on bare imports");
    },
  );
});

Deno.test("extensionQuality: bare import specifier check also fires on the cache-hit path", async () => {
  await withQualityFixture(
    BARE_IMPORT_MODEL_SOURCE,
    async (repoDir, cacheRoot) => {
      const manifest = makeManifest();
      const input = makeQualityInput(repoDir, manifest);
      const deps = makeQualityDeps(cacheRoot);

      // First run packages (populating the cache) and then errors.
      const first = await collect(extensionQuality(ctx, deps, input));
      assertEquals(eventKinds(first), ["packaging", "error"]);

      // Second run hits the cache but must still refuse to score.
      const second = await collect(extensionQuality(ctx, deps, input));
      assertEquals(eventKinds(second), ["cache_hit", "error"]);
      const last = second[second.length - 1];
      if (last.kind === "error") {
        assertStringIncludes(last.error.message, '"zod"');
      }
    },
  );
});

// ── Dependency trust on the cache-hit path ────────────────────────────

Deno.test("extensionQuality: cache hit re-audits dependency trust and folds the result into the score", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);

    const cleanDeps = makeQualityDeps(cacheRoot);
    completedData(await collect(extensionQuality(ctx, cleanDeps, input)));

    // Same cache, but the trust audit now reports a blocker.
    const failingDeps = makeQualityDeps(cacheRoot, {
      pushPrepareOverrides: {
        extractDependencySpecifiers: () =>
          Promise.resolve([{
            name: "leftpad",
            version: "1.0.0",
            registry: "npm" as const,
            sourceFile: join(repoDir, "models", "echo.ts"),
          }]),
        checkDependencyTrust: () =>
          Promise.resolve({
            errors: [{ dependency: "npm:leftpad", message: "too new" }],
            warnings: [],
            audited: [],
            passed: false,
          }),
      },
    });

    const events = await collect(extensionQuality(ctx, failingDeps, input));
    assertEquals(eventKinds(events), ["cache_hit", "scoring", "completed"]);
    const data = completedData(events);
    assertEquals(data.cacheHit, true);
    assertEquals(data.dependencyTrustResult.passed, false);
    assertEquals(data.dependencyTrustResult.errors.length, 1);

    const trustFactor = data.score.factors.find((f) =>
      f.id === "dependency-trust"
    )!;
    assertEquals(trustFactor.status, "missing");
    assertEquals(trustFactor.earnedPoints, 0);
    assertEquals(data.score.allPassed, false);
    assertEquals(data.score.earnedPoints, 10);
  });
});

Deno.test("extensionQuality: cache hit with no specifiers synthesizes a passing trust result without auditing", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);

    const cleanDeps = makeQualityDeps(cacheRoot);
    completedData(await collect(extensionQuality(ctx, cleanDeps, input)));

    let trustCalls = 0;
    const secondDeps = makeQualityDeps(cacheRoot, {
      pushPrepareOverrides: {
        extractDependencySpecifiers: () => Promise.resolve([]),
        checkDependencyTrust: () => {
          trustCalls++;
          return Promise.resolve({
            errors: [],
            warnings: [],
            audited: [],
            passed: true,
          });
        },
      },
    });

    const events = await collect(extensionQuality(ctx, secondDeps, input));
    const data = completedData(events);
    assertEquals(data.cacheHit, true);
    assertEquals(trustCalls, 0, "no specifiers → no audit call");
    assertEquals(data.dependencyTrustResult, {
      errors: [],
      warnings: [],
      audited: [],
      passed: true,
    });
  });
});

// ── Import map handling ───────────────────────────────────────────────

Deno.test("extensionQuality: import map from denoConfigPath is forwarded into the scorer's controlled config", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const denoConfigPath = join(repoDir, "deno.json");
    await Deno.writeTextFile(
      denoConfigPath,
      JSON.stringify({ imports: { "zod": "npm:zod@4" } }),
    );

    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest, {
      prepareInput: { denoConfigPath },
      hashInput: { denoConfigPath },
    });

    let capturedConfig: Record<string, unknown> | undefined;
    const deps = makeQualityDeps(cacheRoot, {
      onRunDeno: (_args, cwd) => {
        capturedConfig = JSON.parse(
          Deno.readTextFileSync(join(cwd, "deno.json")),
        ) as Record<string, unknown>;
      },
    });

    const events = await collect(extensionQuality(ctx, deps, input));
    completedData(events);
    assert(capturedConfig !== undefined, "scorer should have invoked deno");
    assertEquals(capturedConfig!.nodeModulesDir, "auto");
    assertEquals(capturedConfig!.imports, { "zod": "npm:zod@4" });
  });
});

Deno.test("extensionQuality: unparseable deno config falls back to no import map", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const denoConfigPath = join(repoDir, "deno.json");
    await Deno.writeTextFile(denoConfigPath, "not valid json {");

    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest, {
      prepareInput: { denoConfigPath },
      hashInput: { denoConfigPath },
    });

    let capturedConfig: Record<string, unknown> | undefined;
    const deps = makeQualityDeps(cacheRoot, {
      onRunDeno: (_args, cwd) => {
        capturedConfig = JSON.parse(
          Deno.readTextFileSync(join(cwd, "deno.json")),
        ) as Record<string, unknown>;
      },
    });

    const events = await collect(extensionQuality(ctx, deps, input));
    completedData(events);
    assert(capturedConfig !== undefined, "scorer should have invoked deno");
    assertEquals(capturedConfig!.imports, undefined);
  });
});
