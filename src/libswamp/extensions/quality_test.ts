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
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { buildPrepareInput } from "./push_test_helpers.ts";
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
import type { WhoamiResponse } from "../../infrastructure/http/swamp_club_client.ts";
import type {
  ExtensionPushPrepareDeps,
  ExtensionPushPrepareInput,
} from "./push.ts";
import {
  createExtensionQualityDeps,
  extensionQuality,
  type ExtensionQualityDeps,
  type ExtensionQualityEvent,
  type ExtensionQualityInput,
  type PrivateSourceLookupDeps,
  resolvePrivateSourceStanding,
} from "./quality.ts";
import { emptyArchiveIndex } from "./extension_tree_index_test_helpers.ts";
import { walk } from "@std/fs";
import type { ExtensionTreeIndex } from "./extension_tree_index.ts";

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
  return buildPrepareInput(manifest, repoDir, {
    allModelFiles: [modelPath],
    modelEntryPoints: [modelPath],
    registryChecks: "skip",
    ...overrides,
  });
}

function makeHashInput(
  repoDir: string,
  manifest: ExtensionManifest,
  overrides?: Partial<PackageCacheHashInput>,
): PackageCacheHashInput {
  return {
    manifest,
    rootDir: repoDir,
    manifestDir: repoDir,
    modelFilePaths: [join(repoDir, "models", "echo.ts")],
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
    fetchCollectives: () =>
      Promise.resolve({ collectives: ["testuser"], entitlements: undefined }),
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
    ensureDenoPath: () => Promise.resolve("/fake/deno"),
    getDenoEnv: () => ({}),
    findPublishedVersion: () => Promise.resolve(null),
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
    privateSourceLookup?: PrivateSourceLookupDeps;
  },
): ExtensionQualityDeps {
  return {
    pushPrepareDeps: makePushPrepareDeps(options?.pushPrepareOverrides),
    cache: new ExtensionPackageCache(cacheRoot, "test-version"),
    ensureDenoPath: options?.ensureDenoPath ??
      (() => Promise.resolve("/fake/deno")),
    makeScoreDeps: () => fakeScoreDeps(options?.onRunDeno),
    privateSourceLookup: options?.privateSourceLookup ?? {
      loadCredentials: () => Promise.resolve(null),
      whoami: () => Promise.reject(new Error("not called")),
      getExtensionVisibility: () => Promise.reject(new Error("not called")),
    },
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
    const manifest = makeManifest({ license: "MIT" });
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
    assertEquals(score.factors.length, 12);
    assertEquals(score.earnedPoints, 14);
    assertEquals(score.maxEarnablePoints, 16);
    assertEquals(score.maxClientEarnablePoints, 14);
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

Deno.test("extensionQuality: a failed gate is reported beside the rubric and the cache is not written", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    const deps = makeQualityDeps(cacheRoot, {
      pushPrepareOverrides: {
        analyzeExtensionSafety: () =>
          Promise.resolve({
            errors: [{
              ruleId: "dynamic-code",
              file: join(repoDir, "models", "echo.ts"),
              message: "contains eval()",
            }],
            warnings: [],
          }),
      },
    });

    const events = await collect(extensionQuality(ctx, deps, input));
    assertEquals(eventKinds(events), ["packaging", "scoring", "completed"]);
    const data = completedData(events);
    assertEquals(data.gateFailures.map((f) => f.gate), ["safety"]);
    assertStringIncludes(data.gateFailures[0].message, "safety errors");
    assertEquals(data.score.rubricVersion, RUBRIC_VERSION);

    const hash = await computePackageCacheHash(input.hashInput);
    assertEquals(await deps.cache.get(hash), null);
  });
});

Deno.test("extensionQuality: a file a safety error rejects is reported as left out of the scored archive", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const hidden = join(repoDir, ".notes.md");
    await Deno.writeTextFile(hidden, "hidden\n");
    const manifest = makeManifest({ additionalFiles: [".notes.md"] });
    const input = makeQualityInput(repoDir, manifest, {
      prepareInput: { additionalFilePaths: [hidden] },
      hashInput: { additionalFilePaths: [hidden] },
    });
    const deps = makeQualityDeps(cacheRoot, {
      pushPrepareOverrides: {
        analyzeExtensionSafety: () =>
          Promise.resolve({
            errors: [{
              ruleId: "hidden-file",
              file: hidden,
              message: "Hidden files are not allowed in extensions.",
            }],
            warnings: [],
          }),
      },
    });

    const data = completedData(
      await collect(extensionQuality(ctx, deps, input)),
    );
    assertEquals(data.gateFailures.map((f) => f.gate), ["safety"]);
    assertEquals(data.excludedFromArchive, [hidden]);
  });
});

const UNCATALOGUED_MODEL_SOURCE =
  'const definition = { version: "2026.09.25.1" };\n' +
  'export const model = {\n  ...definition,\n  type: "@testuser/echo",\n};\n';

Deno.test("extensionQuality: a model without a literal version is reported as uncatalogued on a fresh run and on a cache hit", async () => {
  await withQualityFixture(
    UNCATALOGUED_MODEL_SOURCE,
    async (repoDir, cacheRoot) => {
      const manifest = makeManifest();
      const input = makeQualityInput(repoDir, manifest);
      const deps = makeQualityDeps(cacheRoot);

      for (const run of ["fresh", "cache hit"]) {
        const data = completedData(
          await collect(extensionQuality(ctx, deps, input)),
        );
        const findings = data.findings.reviewRulesResult.warnings.filter((
          w,
        ) => w.ruleId === "uncatalogued-model");
        assertEquals(findings.length, 1, run);
        assertStringIncludes(findings[0].message, "string-literal version");
        assertEquals(data.registryScorable, true, run);
        assertEquals(data.cacheHit, run === "cache hit", run);
      }
    },
  );
});

const BARE_IMPORT_MODEL_SOURCE =
  'import { z } from "zod";\nexport const schema = z.string();\n';

Deno.test("extensionQuality: bare import specifiers are scored locally but reported as unscorable by the registry", async () => {
  await withQualityFixture(
    BARE_IMPORT_MODEL_SOURCE,
    async (repoDir, cacheRoot) => {
      const manifest = makeManifest();
      const input = makeQualityInput(repoDir, manifest);
      const deps = makeQualityDeps(cacheRoot);

      const events = await collect(extensionQuality(ctx, deps, input));
      assertEquals(eventKinds(events), ["packaging", "scoring", "completed"]);
      const data = completedData(events);
      assertEquals(data.registryScorable, false);
      const bare = data.findings.reviewRulesResult.warnings.find((w) =>
        w.ruleId === "bare-specifiers"
      );
      assert(bare !== undefined, "bare-specifiers finding must be reported");
      assertStringIncludes(bare.message, '"zod"');
      assertStringIncludes(bare.message, "documentation factors 0");
    },
  );
});

Deno.test("extensionQuality: bare imports the deno.json import map resolves leave the extension registry-scorable", async () => {
  await withQualityFixture(
    BARE_IMPORT_MODEL_SOURCE,
    async (repoDir, cacheRoot) => {
      const denoConfigPath = join(repoDir, "deno.json");
      await Deno.writeTextFile(
        denoConfigPath,
        JSON.stringify({ imports: { zod: "npm:zod@^4" } }),
      );
      const manifest = makeManifest();
      // What Deno resolves the model's bare "zod" to under that config.
      const bareImports = [{
        importer: join(repoDir, "models", "echo.ts"),
        specifier: "zod",
        target: "npm:zod@^4",
      }];
      const input = makeQualityInput(repoDir, manifest, {
        prepareInput: { denoConfigPath, bareImports },
        hashInput: { denoConfigPath, bareImports },
      });
      const data = completedData(
        await collect(
          extensionQuality(ctx, makeQualityDeps(cacheRoot), input),
        ),
      );
      assertEquals(data.registryScorable, true);
      assertEquals(
        data.findings.reviewRulesResult.warnings.some((w) =>
          w.ruleId === "bare-specifiers"
        ),
        false,
      );
    },
  );
});

Deno.test("extensionQuality: an import-map target that could escape its string literal fails quality as it fails push", async () => {
  await withQualityFixture(
    BARE_IMPORT_MODEL_SOURCE,
    async (repoDir, cacheRoot) => {
      const denoConfigPath = join(repoDir, "deno.json");
      await Deno.writeTextFile(
        denoConfigPath,
        JSON.stringify({ imports: { zod: 'npm:zod@4"; globalThis.x = 1; "' } }),
      );
      const bareImports = [{
        importer: join(repoDir, "models", "echo.ts"),
        specifier: "zod",
        target: 'npm:zod@4"; globalThis.x = 1; "',
      }];
      const input = makeQualityInput(repoDir, makeManifest(), {
        prepareInput: { denoConfigPath, bareImports },
        hashInput: { denoConfigPath, bareImports },
      });
      const events = await collect(
        extensionQuality(ctx, makeQualityDeps(cacheRoot), input),
      );
      const failure = events.find((e) => e.kind === "error");
      assert(failure?.kind === "error", "quality must fail");
      assertStringIncludes(
        failure.error.message,
        'Fix the import map entry for "zod"',
      );
    },
  );
});

Deno.test("extensionQuality: a cache hit still reports bare import specifiers as unscorable", async () => {
  await withQualityFixture(
    BARE_IMPORT_MODEL_SOURCE,
    async (repoDir, cacheRoot) => {
      const manifest = makeManifest();
      const input = makeQualityInput(repoDir, manifest);
      const deps = makeQualityDeps(cacheRoot);

      const first = completedData(
        await collect(extensionQuality(ctx, deps, input)),
      );
      assertEquals(first.registryScorable, false);

      const second = await collect(extensionQuality(ctx, deps, input));
      assertEquals(eventKinds(second), ["cache_hit", "scoring", "completed"]);
      assertEquals(completedData(second).registryScorable, false);
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
    assertEquals(data.score.earnedPoints, 11);
  });
});

Deno.test("extensionQuality: a dependency that was not audited loses the dependency-trust factor", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    const deps = makeQualityDeps(cacheRoot, {
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
            errors: [],
            warnings: [{
              dependency: "leftpad",
              message: "not audited: OSV lookup failed (HTTP 503)",
              cause: "not-audited" as const,
            }],
            audited: [],
            passed: true,
          }),
      },
    });

    const data = completedData(
      await collect(extensionQuality(ctx, deps, input)),
    );
    assertEquals(data.dependencyTrustResult.passed, true);
    const trustFactor = data.score.factors.find((f) =>
      f.id === "dependency-trust"
    )!;
    assertEquals(trustFactor.status, "missing");
    assertEquals(trustFactor.earnedPoints, 0);
    assertStringIncludes(
      trustFactor.remediation ?? "",
      "1 dependency(ies) not audited",
    );
  });
});

Deno.test("extensionQuality: a specifier no published version matches is named on the dependency-trust row, not an outage", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    const deps = makeQualityDeps(cacheRoot, {
      pushPrepareOverrides: {
        extractDependencySpecifiers: () =>
          Promise.resolve([{
            name: "ms",
            version: "99.0.0",
            registry: "npm" as const,
            sourceFile: join(repoDir, "models", "echo.ts"),
          }]),
        checkDependencyTrust: () =>
          Promise.resolve({
            errors: [],
            warnings: [{
              dependency: "ms",
              message: "not audited: npm lists no version 99.0.0",
              cause: "not-audited" as const,
              remediation:
                "Change the specifier to a version the registry publishes.",
              notAuditedFix: "specifier" as const,
            }],
            audited: [],
            passed: true,
          }),
      },
    });

    const data = completedData(
      await collect(extensionQuality(ctx, deps, input)),
    );
    const trustFactor = data.score.factors.find((f) =>
      f.id === "dependency-trust"
    )!;
    assertEquals(trustFactor.earnedPoints, 0);
    assertEquals(
      trustFactor.remediation,
      "1 dependency(ies) not audited because no published version matches " +
        "the specifier. Change the specifier to a version the registry " +
        "publishes.",
    );
  });
});

for (
  const [label, result, earned] of [
    [
      "a loose specifier warning loses one point of the dependency-trust factor",
      {
        errors: [],
        warnings: [{
          dependency: "leftpad",
          message:
            "npm:leftpad@^1.0.0 is a range; audited 1.3.0, the version this push resolves",
          cause: "loose-specifier" as const,
        }],
        audited: [],
        passed: true,
      },
      1,
    ],
    [
      "a yanked JSR version loses the dependency-trust factor",
      {
        errors: [],
        warnings: [{
          dependency: "@std/assert",
          message: "version 0.0.1 is yanked on JSR",
          cause: "jsr-yanked" as const,
        }],
        audited: [],
        passed: true,
      },
      0,
    ],
    [
      "a pinned deprecated version loses the dependency-trust factor",
      {
        errors: [],
        warnings: [{
          dependency: "leftpad",
          message: "version 1.0.0 is deprecated: use leftpad@2",
          cause: "deprecated-version" as const,
        }],
        audited: [],
        passed: true,
      },
      0,
    ],
    [
      "a missing JSR version loses the dependency-trust factor",
      {
        errors: [{
          dependency: "@std/assert",
          message: "version 0.0.999 not found on JSR",
          cause: "jsr-missing" as const,
        }],
        warnings: [],
        audited: [],
        passed: false,
      },
      0,
    ],
  ] as const
) {
  Deno.test(`extensionQuality: ${label}`, async () => {
    await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
      const manifest = makeManifest();
      const input = makeQualityInput(repoDir, manifest);
      const deps = makeQualityDeps(cacheRoot, {
        pushPrepareOverrides: {
          extractDependencySpecifiers: () =>
            Promise.resolve([{
              name: "leftpad",
              version: "^1.0.0",
              registry: "npm" as const,
              sourceFile: join(repoDir, "models", "echo.ts"),
            }]),
          checkDependencyTrust: () =>
            Promise.resolve({
              ...result,
              errors: [...result.errors],
              warnings: [...result.warnings],
              audited: [],
            }),
        },
      });

      const data = completedData(
        await collect(extensionQuality(ctx, deps, input)),
      );
      const trustFactor = data.score.factors.find((f) =>
        f.id === "dependency-trust"
      )!;
      assertEquals(trustFactor.earnedPoints, earned);
    });
  });
}

Deno.test("extensionQuality: cache hit audits webhook source dependencies", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const webhookPath = join(repoDir, "webhooks", "hook.ts");
    await Deno.mkdir(join(repoDir, "webhooks"), { recursive: true });
    await Deno.writeTextFile(webhookPath, CLEAN_MODEL_SOURCE);
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest, {
      prepareInput: { allWebhookFiles: [webhookPath] },
      hashInput: { webhookFilePaths: [webhookPath] },
    });

    completedData(
      await collect(extensionQuality(ctx, makeQualityDeps(cacheRoot), input)),
    );

    let auditedFiles: string[] = [];
    const deps = makeQualityDeps(cacheRoot, {
      pushPrepareOverrides: {
        extractDependencySpecifiers: (files: string[]) => {
          auditedFiles = files;
          return Promise.resolve([]);
        },
      },
    });
    const events = await collect(extensionQuality(ctx, deps, input));
    assertEquals(completedData(events).cacheHit, true);
    assert(
      auditedFiles.includes(webhookPath),
      `webhook source must be audited on a cache hit, got ${auditedFiles}`,
    );
  });
});

Deno.test("extensionQuality: a bare import in a webhook source makes the extension unscorable", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const webhookPath = join(repoDir, "webhooks", "hook.ts");
    await Deno.mkdir(join(repoDir, "webhooks"), { recursive: true });
    await Deno.writeTextFile(
      webhookPath,
      'import { z } from "zod";\nexport const schema = z.object({});\n',
    );
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest, {
      prepareInput: { allWebhookFiles: [webhookPath] },
      hashInput: { webhookFilePaths: [webhookPath] },
    });

    const data = completedData(
      await collect(extensionQuality(ctx, makeQualityDeps(cacheRoot), input)),
    );
    assertEquals(data.registryScorable, false);
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

Deno.test("extensionQuality: the scorer's controlled config has no import map, as the registry's (swamp-club#3612)", async () => {
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
    assertEquals(capturedConfig!.imports, undefined);
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

// ── Declared acceptances ──────────────────────────────────────────────

const ACCEPTING_MODEL_SOURCE = [
  "const S = z.object({",
  "  apiKey: z.string(), // swamp-quality-ignore credentials-sensitive-field: holds the name of a vault key",
  "  token: z.string(),",
  "});",
  "",
].join("\n");

Deno.test("extensionQuality: findings and acceptances are reported on the fresh run and again on the cache hit", async () => {
  await withQualityFixture(
    ACCEPTING_MODEL_SOURCE,
    async (repoDir, cacheRoot) => {
      const manifest = makeManifest();
      const input = makeQualityInput(repoDir, manifest);
      const model = join(repoDir, "models", "echo.ts");
      const finding = (line: number) => ({
        ruleId: "credentials-sensitive-field",
        dimension: "Credentials & Secrets",
        severity: "medium" as const,
        file: model,
        line,
        message: `line ${line} looks like a secret`,
      });
      const deps = makeQualityDeps(cacheRoot, {
        pushPrepareOverrides: {
          checkReviewRules: () =>
            Promise.resolve({
              errors: [],
              warnings: [finding(2), finding(3)],
              passed: true,
            }),
        },
      });

      const first = completedData(
        await collect(extensionQuality(ctx, deps, input)),
      );
      assertEquals(first.cacheHit, false);
      assertEquals(
        first.findings.reviewRulesResult.warnings.map((w) => w.line),
        [3],
      );
      assertEquals(first.findings.acceptances.accepted.map((a) => a.line), [2]);
      assertEquals(
        first.findings.acceptances.accepted[0].file,
        "models/echo.ts",
      );

      const second = completedData(
        await collect(extensionQuality(ctx, deps, input)),
      );
      assertEquals(second.cacheHit, true);
      assertEquals(
        second.findings.reviewRulesResult.warnings.map((w) => w.line),
        [3],
      );
      assertEquals(second.findings.acceptances.accepted.map((a) => a.line), [
        2,
      ]);
    },
  );
});

Deno.test("extensionQuality: a cache hit still reports an invalid acceptance as a failed review gate", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    const deps = makeQualityDeps(cacheRoot);
    const first = await collect(extensionQuality(ctx, deps, input));
    assertEquals(completedData(first).cacheHit, false);

    // Same source, so the second run is a cache hit; the review rules are
    // stubbed to report an invalid acceptance, as an upgraded rule set could
    // without the source hash moving.
    const second = await collect(extensionQuality(ctx, {
      ...deps,
      pushPrepareDeps: makePushPrepareDeps({
        checkReviewRules: () =>
          Promise.resolve({
            errors: [{
              ruleId: "invalid-acceptance",
              dimension: "Declared acceptances",
              severity: "high" as const,
              file: join(repoDir, "models", "echo.ts"),
              line: 1,
              message: "Acceptance is invalid",
            }],
            warnings: [],
            passed: false,
          }),
      }),
    }, input));
    assertEquals(eventKinds(second), ["cache_hit", "scoring", "completed"]);
    const data = completedData(second);
    assertEquals(data.cacheHit, true);
    assertEquals(data.gateFailures.map((f) => f.gate), ["review"]);
  });
});

Deno.test("extensionQuality: a cache hit runs the gates the old cache-hit path skipped", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    const deps = makeQualityDeps(cacheRoot);
    assertEquals(
      completedData(await collect(extensionQuality(ctx, deps, input)))
        .cacheHit,
      false,
    );

    // The content collective check and the dependency-trust blocker now
    // fail without the source hash moving.
    const second = completedData(
      await collect(extensionQuality(ctx, {
        ...deps,
        pushPrepareDeps: makePushPrepareDeps({
          extractContentMetadata: () =>
            Promise.resolve({
              models: [{
                fileName: "echo.ts",
                type: "@someoneelse/echo",
                version: "2026.03.22.1",
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
        }),
      }, input)),
    );
    assertEquals(second.cacheHit, true);
    assertEquals(
      second.gateFailures.map((f) => f.gate),
      ["content-collectives", "dependency-trust"],
    );
  });
});

/** An archive index whose one model registers `type`. */
function loadedModel(type: string): Promise<ExtensionTreeIndex> {
  return Promise.resolve({
    sources: [{
      kindDir: "models" as const,
      absolutePath: "/archive/models/echo.ts",
      fileName: "echo.ts",
      indexed: {
        kind: "model" as const,
        typeNormalized: type,
        bundlePath: "",
        fingerprint: "f",
        fromCache: false,
      },
    }],
    failures: [],
  });
}

Deno.test("extensionQuality: a cache hit judges the loaded types stored with the archive instead of loading it again (swamp-club#3456)", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    const deps = makeQualityDeps(cacheRoot);
    const first = completedData(
      await collect(extensionQuality(ctx, {
        ...deps,
        pushPrepareDeps: makePushPrepareDeps({
          indexArchive: () => loadedModel("@testuser/echo"),
        }),
      }, input)),
    );
    assertEquals(first.cacheHit, false);

    let indexed = 0;
    const second = completedData(
      await collect(extensionQuality(ctx, {
        ...deps,
        pushPrepareDeps: makePushPrepareDeps({
          indexArchive: () => {
            indexed++;
            return loadedModel("@someoneelse/echo");
          },
        }),
      }, input)),
    );
    assertEquals(second.cacheHit, true);
    assertEquals(indexed, 0);
    assertEquals(second.gateFailures, []);
  });
});

Deno.test("extensionQuality: a cache hit on an entry with no stored types loads the archive and checks its collective (swamp-club#3456)", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    const deps = makeQualityDeps(cacheRoot);
    assertEquals(
      completedData(await collect(extensionQuality(ctx, deps, input)))
        .cacheHit,
      false,
    );
    // An entry written before the field existed, or one whose stored index
    // was tampered with, carries no usable types.
    for await (const entry of walk(cacheRoot, { match: [/metadata\.json$/] })) {
      const metadata = JSON.parse(await Deno.readTextFile(entry.path));
      metadata.archiveIndex = { sources: "not a list", failures: [] };
      await Deno.writeTextFile(entry.path, JSON.stringify(metadata));
    }

    let indexed = 0;
    const second = completedData(
      await collect(extensionQuality(ctx, {
        ...deps,
        pushPrepareDeps: makePushPrepareDeps({
          indexArchive: () => {
            indexed++;
            return loadedModel("@someoneelse/echo");
          },
        }),
      }, input)),
    );
    assertEquals(second.cacheHit, true);
    assertEquals(indexed, 1);
    assertEquals(
      second.gateFailures.map((f) => f.gate),
      ["content-collectives"],
    );
  });
});

Deno.test("extensionQuality: a cache entry from another swamp version is a miss, so every gate runs", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest();
    const input = makeQualityInput(repoDir, manifest);
    let fmtLintRuns = 0;
    const counting = {
      checkExtensionQuality: () => {
        fmtLintRuns++;
        return Promise.resolve({ passed: true, issues: [] });
      },
    };
    const older: ExtensionQualityDeps = {
      ...makeQualityDeps(cacheRoot, { pushPrepareOverrides: counting }),
      cache: new ExtensionPackageCache(cacheRoot, "older-version"),
    };
    completedData(await collect(extensionQuality(ctx, older, input)));
    assertEquals(fmtLintRuns, 1);

    const newer = makeQualityDeps(cacheRoot, {
      pushPrepareOverrides: counting,
    });
    const events = await collect(extensionQuality(ctx, newer, input));
    assertEquals(eventKinds(events), ["packaging", "scoring", "completed"]);
    assertEquals(fmtLintRuns, 2, "a cold run checks fmt/lint again");
  });
});

Deno.test("extensionQuality: a declared license is reported, and a non-SPDX one warns without failing a gate", async () => {
  for (
    const [license, warned] of [
      [undefined, false],
      ["MIT", false],
      ["LicenseRef-Mine", true],
    ] as const
  ) {
    await withQualityFixture(
      CLEAN_MODEL_SOURCE,
      async (repoDir, cacheRoot) => {
        const manifest = makeManifest({ license });
        const data = completedData(
          await collect(
            extensionQuality(
              ctx,
              makeQualityDeps(cacheRoot),
              makeQualityInput(repoDir, manifest),
            ),
          ),
        );
        assertEquals(data.license, license ?? null);
        assertEquals(
          data.licenseWarning?.reason,
          warned ? "custom-ref" : undefined,
        );
        assertEquals(data.gateFailures, []);
        assertEquals(
          data.score.factors.find((f) => f.id === "has-license")?.status,
          license === "MIT" ? "earned" : "missing",
        );
      },
    );
  }
});

// ── private source hosting (swamp-club#3406) ───────────────────────────

const CREDS = { serverUrl: "https://club.test", apiKey: "swamp_test_key" };

/** A lookup whose whoami reports `entries` and counts visibility reads. */
function fakeLookup(options: {
  entries?: unknown;
  authenticated?: boolean;
  existing?: { isPrivate: boolean } | null;
  whoamiError?: Error;
  credentials?: typeof CREDS | null;
}): PrivateSourceLookupDeps & { visibilityReads: number } {
  const lookup = {
    visibilityReads: 0,
    loadCredentials: () =>
      Promise.resolve(
        options.credentials === undefined ? CREDS : options.credentials,
      ),
    whoami: () =>
      options.whoamiError
        ? Promise.reject(options.whoamiError)
        : Promise.resolve({
          authenticated: options.authenticated ?? true,
          ...(options.entries === undefined
            ? {}
            : { collectiveSourceHosting: options.entries }),
        } as unknown as WhoamiResponse),
    getExtensionVisibility: () => {
      lookup.visibilityReads++;
      return Promise.resolve(options.existing ?? null);
    },
  };
  return lookup;
}

function hosting(privateSourceHosting: boolean, privateNamespace = false) {
  return [
    { slug: "other", privateSourceHosting: true, privateNamespace: true },
    { slug: "testuser", privateSourceHosting, privateNamespace },
  ];
}

Deno.test("resolvePrivateSourceStanding: unknown whenever the registry's answer cannot be read", async () => {
  const cases: Array<[string, Parameters<typeof fakeLookup>[0]]> = [
    ["no credentials", { credentials: null, entries: hosting(true) }],
    ["rejected key", { authenticated: false, entries: hosting(true) }],
    ["server predates the field", {}],
    ["collective not reported", { entries: [hosting(true)[0]] }],
    ["malformed entry", {
      entries: [{ slug: "testuser", privateSourceHosting: "yes" }],
    }],
    ["field not an array", { entries: { testuser: true } }],
    ["whoami fails", { whoamiError: new Error("connection refused") }],
  ];
  for (const [label, options] of cases) {
    const lookup = fakeLookup(options);
    assertEquals(
      await resolvePrivateSourceStanding(ctx, lookup, makeManifest()),
      { kind: "unknown" },
      label,
    );
    assertEquals(lookup.visibilityReads, 0, label);
  }
});

Deno.test("resolvePrivateSourceStanding: a collective without private source hosting never reads visibility", async () => {
  const lookup = fakeLookup({ entries: hosting(false, true) });
  assertEquals(
    await resolvePrivateSourceStanding(ctx, lookup, makeManifest()),
    { kind: "not_attested", reason: "no_private_source_hosting" },
  );
  assertEquals(lookup.visibilityReads, 0);
});

Deno.test("resolvePrivateSourceStanding: attested exactly when the extension will publish as private", async () => {
  const attested = { kind: "attested" };
  const publicExtension = { kind: "not_attested", reason: "public_extension" };
  const cases: Array<
    [
      string,
      { isPrivate: boolean } | null,
      "public" | "private" | undefined,
      boolean,
      unknown,
    ]
  > = [
    ["published private", { isPrivate: true }, "public", false, attested],
    [
      "published public",
      { isPrivate: false },
      "private",
      true,
      publicExtension,
    ],
    ["first publish, private requested", null, "private", false, attested],
    ["first publish, private namespace", null, "public", true, attested],
    [
      "first publish, public namespace",
      null,
      undefined,
      false,
      publicExtension,
    ],
  ];
  for (
    const [label, existing, visibility, privateNamespace, expected] of cases
  ) {
    const lookup = fakeLookup({
      entries: hosting(true, privateNamespace),
      existing,
    });
    assertEquals(
      await resolvePrivateSourceStanding(
        ctx,
        lookup,
        makeManifest(visibility ? { visibility } : {}),
      ),
      expected,
      label,
    );
    assertEquals(lookup.visibilityReads, 1, label);
  }
});

Deno.test("resolvePrivateSourceStanding: a lookup that outlasts the timeout is unknown", async () => {
  const hanging: PrivateSourceLookupDeps = {
    loadCredentials: () => Promise.resolve(CREDS),
    whoami: (_url, _key, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
    getExtensionVisibility: () => Promise.reject(new Error("not called")),
  };
  assertEquals(
    await resolvePrivateSourceStanding(ctx, hanging, makeManifest(), 1),
    { kind: "unknown" },
  );
});

Deno.test("extensionQuality: an attested private extension on a self-hosted forge passes repository-verified", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifest = makeManifest({
      repository: "https://git.example-corp.internal/team/test-ext",
      visibility: "private",
    });
    const run = async (lookup: PrivateSourceLookupDeps) =>
      completedData(
        await collect(
          extensionQuality(
            ctx,
            makeQualityDeps(cacheRoot, { privateSourceLookup: lookup }),
            makeQualityInput(repoDir, manifest),
          ),
        ),
      ).score.factors.find((f) => f.id === "repository-verified")!;

    const attested = await run(fakeLookup({ entries: hosting(true) }));
    assertEquals(attested.status, "provisional");
    assertEquals(attested.label, "Private repository (collective attested)");

    const notAttested = await run(fakeLookup({ entries: hosting(false) }));
    assertEquals(notAttested.status, "missing");
  });
});

/** The real lookup wiring, reading swamp-club through a mocked fetch. */
async function realLookupStanding(
  cacheRoot: string,
  extension: Record<string, unknown> | null,
): Promise<{ standing: unknown; paths: string[] }> {
  const lookup = createExtensionQualityDeps(
    makePushPrepareDeps({
      loadCredentials: () => Promise.resolve({ ...CREDS, username: "t" }),
    }),
    new ExtensionPackageCache(cacheRoot, "test-version"),
  ).privateSourceLookup;
  const { result, calls } = await withMockedFetch((req) => {
    if (new URL(req.url).pathname === "/api/whoami") {
      return Response.json({
        authenticated: true,
        collectiveSourceHosting: hosting(true),
      });
    }
    return extension
      ? Response.json(extension)
      : Response.json({ error: "not found" }, { status: 404 });
  }, () => resolvePrivateSourceStanding(ctx, lookup, makeManifest()));
  return {
    standing: result,
    paths: calls.map((c) => new URL(c.url).pathname),
  };
}

Deno.test("createExtensionQualityDeps: the lookup reads whoami, then the extension, from the credentials' server", async () => {
  const cacheRoot = await Deno.makeTempDir();
  try {
    const { standing, paths } = await realLookupStanding(cacheRoot, {
      name: "@testuser/test-ext",
      isPrivate: true,
    });
    assertEquals(standing, { kind: "attested" });
    assertEquals(paths, [
      "/api/whoami",
      "/api/v1/extensions/%40testuser%2Ftest-ext",
    ]);
    assertEquals(
      (await realLookupStanding(cacheRoot, null)).standing,
      { kind: "not_attested", reason: "public_extension" },
    );
  } finally {
    await Deno.remove(cacheRoot, { recursive: true });
  }
});

Deno.test("createExtensionQualityDeps: an extension answer without visibility is unknown, not public", async () => {
  const cacheRoot = await Deno.makeTempDir();
  try {
    const { standing } = await realLookupStanding(cacheRoot, {
      name: "@testuser/test-ext",
    });
    assertEquals(standing, { kind: "unknown" });
  } finally {
    await Deno.remove(cacheRoot, { recursive: true });
  }
});

Deno.test("ExtensionApiClient.getExtension: the caller's signal reaches fetch", async () => {
  const cacheRoot = await Deno.makeTempDir();
  try {
    const lookup = createExtensionQualityDeps(
      makePushPrepareDeps(),
      new ExtensionPackageCache(cacheRoot, "test-version"),
    ).privateSourceLookup;
    const controller = new AbortController();
    const seen: boolean[] = [];
    await withMockedFetch((req) => {
      seen.push(req.signal.aborted);
      controller.abort();
      seen.push(req.signal.aborted);
      return Response.json({ name: "@testuser/test-ext", isPrivate: false });
    }, () =>
      lookup.getExtensionVisibility(
        CREDS.serverUrl,
        "@testuser/test-ext",
        CREDS.apiKey,
        controller.signal,
      ));
    assertEquals(seen, [false, true]);
  } finally {
    await Deno.remove(cacheRoot, { recursive: true });
  }
});

// ── secret-unsafe-docs (swamp-club#3757) ──────────────────────────────

const LEAKY_README = [
  "# Test Extension", // 1
  "", // 2
  "```bash", // 3
  'swamp vault put my-vault api-token "abc123"', // 4
  "swamp model create @testuser/test-ext e \\", // 5
  "  --global-arg 'apiToken=vault://my-vault/api-token'", // 6
  "```", // 7
  "",
].join("\n");

function secretDocsFactor(data: ReturnType<typeof completedData>) {
  return data.score.factors.find((f) => f.id === "secret-safe-docs");
}

function secretDocsWarnings(data: ReturnType<typeof completedData>) {
  return data.findings.reviewRulesResult.warnings.filter((w) =>
    w.ruleId === "secret-unsafe-docs"
  );
}

Deno.test("extensionQuality: clean docs earn secret-safe-docs", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const readme = join(repoDir, "README.md");
    await Deno.writeTextFile(readme, RICH_README);
    const manifest = makeManifest({ additionalFiles: ["README.md"] });
    const input = makeQualityInput(repoDir, manifest, {
      prepareInput: { additionalFilePaths: [readme] },
      hashInput: { additionalFilePaths: [readme] },
    });
    const data = completedData(
      await collect(extensionQuality(ctx, makeQualityDeps(cacheRoot), input)),
    );
    assertEquals(secretDocsWarnings(data), []);
    assertEquals(secretDocsFactor(data)?.status, "earned");
  });
});

Deno.test("extensionQuality: a README that puts a secret in plaintext warns per command and loses secret-safe-docs", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const readme = join(repoDir, "README.md");
    await Deno.writeTextFile(readme, LEAKY_README);
    const manifest = makeManifest({ additionalFiles: ["README.md"] });
    const input = makeQualityInput(repoDir, manifest, {
      prepareInput: { additionalFilePaths: [readme] },
      hashInput: { additionalFilePaths: [readme] },
    });
    const data = completedData(
      await collect(extensionQuality(ctx, makeQualityDeps(cacheRoot), input)),
    );
    const warnings = secretDocsWarnings(data);
    assertEquals(warnings.map((w) => [w.file, w.line]), [
      [readme, 4],
      [readme, 5],
    ]);
    assertStringIncludes(warnings[1].message, "`vault://`");
    assertEquals(secretDocsFactor(data)?.status, "missing");
    assertEquals(data.gateFailures, []);
  });
});

Deno.test("extensionQuality: a quality.yaml line entry accepts a code-block finding and restores secret-safe-docs", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const readme = join(repoDir, "README.md");
    await Deno.writeTextFile(readme, LEAKY_README);
    await Deno.writeTextFile(
      join(repoDir, "quality.yaml"),
      [
        "version: 1",
        "accept:",
        "  - rule: secret-unsafe-docs",
        "    file: README.md",
        "    line: 4",
        "  - rule: secret-unsafe-docs",
        "    file: README.md",
        "    line: 5",
        "    reason: shows the forms to avoid",
        "",
      ].join("\n"),
    );
    const manifest = makeManifest({ additionalFiles: ["README.md"] });
    const input = makeQualityInput(repoDir, manifest, {
      prepareInput: { additionalFilePaths: [readme] },
      hashInput: { additionalFilePaths: [readme] },
    });
    const data = completedData(
      await collect(extensionQuality(ctx, makeQualityDeps(cacheRoot), input)),
    );
    assertEquals(secretDocsWarnings(data), []);
    assertEquals(
      data.findings.acceptances.accepted.map((a) => [a.ruleId, a.line]),
      [["secret-unsafe-docs", 4], ["secret-unsafe-docs", 5]],
    );
    assertEquals(secretDocsFactor(data)?.status, "earned");
  });
});

Deno.test("extensionQuality: the manifest description is checked on the author's own lines", async () => {
  await withQualityFixture(CLEAN_MODEL_SOURCE, async (repoDir, cacheRoot) => {
    const manifestPath = join(repoDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      [
        "manifestVersion: 1", // 1
        'name: "@testuser/test-ext"', // 2
        "description: |", // 3
        "  Echoes input.", // 4
        "", // 5
        "      --global-arg 'apiToken=vault://v/k'", // 6
        "models:", // 7
        "  - echo.ts", // 8
        "",
      ].join("\n"),
    );
    const input = makeQualityInput(repoDir, makeManifest(), {
      prepareInput: { manifestPath },
    });
    const data = completedData(
      await collect(extensionQuality(ctx, makeQualityDeps(cacheRoot), input)),
    );
    const warnings = secretDocsWarnings(data);
    assertEquals(warnings.map((w) => [w.file, w.line]), [[manifestPath, 6]]);
    assertStringIncludes(warnings[0].message, "Line 6 (description)");
  });
});

Deno.test("extensionQuality: describe strings are checked, test files and include files are not", async () => {
  const source = [
    "export const S = {",
    '  token: z.string().describe("vault:// reference to the token"),',
    "};",
    "",
  ].join("\n");
  await withQualityFixture(source, async (repoDir, cacheRoot) => {
    const model = join(repoDir, "models", "echo.ts");
    const testFile = join(repoDir, "models", "echo_test.ts");
    await Deno.writeTextFile(testFile, source);
    await Deno.mkdir(join(repoDir, "vendor"));
    const included = join(repoDir, "vendor", "NOTES.md");
    await Deno.writeTextFile(included, LEAKY_README);
    const input = makeQualityInput(repoDir, makeManifest(), {
      prepareInput: {
        allModelFiles: [model, testFile],
        includeFilePaths: [included],
      },
    });
    const data = completedData(
      await collect(extensionQuality(ctx, makeQualityDeps(cacheRoot), input)),
    );
    assertEquals(
      secretDocsWarnings(data).map((w) => [w.file, w.line]),
      [[model, 2]],
    );
  });
});
