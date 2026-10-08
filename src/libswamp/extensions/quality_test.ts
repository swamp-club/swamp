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
  },
): ExtensionQualityDeps {
  return {
    pushPrepareDeps: makePushPrepareDeps(options?.pushPrepareOverrides),
    cache: new ExtensionPackageCache(cacheRoot, "test-version"),
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
      assertStringIncludes(bare.message, "unscored");
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
    assertEquals(data.score.earnedPoints, 10);
  });
});

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
