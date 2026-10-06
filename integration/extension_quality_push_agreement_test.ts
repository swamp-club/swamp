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
 * `swamp extension fmt --check`, `quality` and `push` give one answer for
 * the same extension (swamp-club#3022). Each scenario runs push's prepare
 * phase (enforce, as a push does), the quality generator and the fmt
 * generator over one real extension on disk, with the real safety analyzer,
 * review rules and `deno fmt` / `deno lint`. Only bundling, dependency trust
 * and the rubric's deno invocations are stubbed: they need the network or
 * are scored elsewhere.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { parseExtensionManifest } from "../src/domain/extensions/extension_manifest.ts";
import {
  computePackageCacheHash,
  ExtensionPackageCache,
  type PackageCacheHashInput,
} from "../src/domain/extensions/extension_package_cache.ts";
import { analyzeExtensionSafety } from "../src/domain/extensions/extension_safety_analyzer.ts";
import { checkExtensionQuality } from "../src/domain/extensions/extension_quality_checker.ts";
import { checkReviewRules } from "../src/domain/extensions/extension_review_rules.ts";
import { extractDependencySpecifiers } from "../src/domain/extensions/extension_dependency_extractor.ts";
import type { RubricScoreDeps } from "../src/domain/extensions/extension_rubric_scorer.ts";
import { extractTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import type { ReviewFinding } from "../src/domain/extensions/extension_review_rules.ts";
import type { SafetyIssue } from "../src/domain/extensions/extension_safety_analyzer.ts";
import {
  createLibSwampContext,
  extensionFmt,
  type ExtensionFmtEvent,
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
  extensionQuality,
  type ExtensionQualityData,
  type SwampError,
} from "../src/libswamp/mod.ts";
import { collect } from "../src/libswamp/testing.ts";
import { buildPrepareInput } from "../src/libswamp/extensions/push_test_helpers.ts";

const ctx = createLibSwampContext();
const DENO = Deno.execPath();

const MANIFEST = [
  "manifestVersion: 1",
  'name: "@acme/agree"',
  'version: "2026.10.06.1"',
  "description: quality, fmt and push agreement fixture",
  "models:",
  "  - model.ts",
  "",
].join("\n");

function prepareDeps(): ExtensionPushPrepareDeps {
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
    analyzeExtensionSafety,
    checkExtensionQuality,
    extractDependencySpecifiers,
    checkDependencyTrust: () =>
      Promise.resolve({ errors: [], warnings: [], audited: [], passed: true }),
    checkReviewRules,
    bundleEntryPoint: () => Promise.resolve("export const model = {};\n"),
    ensureDenoPath: () => Promise.resolve(DENO),
    getDenoEnv: () => Deno.env.toObject(),
    findPublishedVersion: () => Promise.resolve(null),
    getLatestVersionDetail: () => Promise.resolve(null),
  };
}

/**
 * The real archive extraction, so the archive collect mode builds is the one
 * scored; the rubric's deno calls answer with an empty doc.
 */
function scoreDeps(): RubricScoreDeps {
  return {
    extractTarball: extractTarGz,
    runDeno: (args) =>
      Promise.resolve({
        success: true,
        stdout: args[0] === "doc" && args[1] === "--json"
          ? JSON.stringify({ version: 1, nodes: {} })
          : "",
        stderr: "",
      }),
  };
}

interface Fixture {
  root: string;
  prepareInput: ExtensionPushPrepareInput;
  hashInput: PackageCacheHashInput;
  tsFiles: string[];
  denoConfigPath: string | undefined;
}

/**
 * Writes the extension into a temp dir laid out as CI publishes it (the
 * repo is the extension dir) and resolves its inputs as the CLI would.
 */
async function withExtension(
  files: {
    model: string;
    denoJson?: string;
    additional?: Record<string, string>;
  },
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "quality-push-agree-" });
  try {
    const additional = Object.keys(files.additional ?? {});
    const manifestText = additional.length > 0
      ? MANIFEST +
        ["additionalFiles:", ...additional.map((f) => `  - ${f}`), ""]
          .join("\n")
      : MANIFEST;
    await Deno.writeTextFile(join(root, "manifest.yaml"), manifestText);
    await Deno.mkdir(join(root, "models"));
    const model = join(root, "models", "model.ts");
    await Deno.writeTextFile(model, files.model);
    for (const [rel, content] of Object.entries(files.additional ?? {})) {
      await Deno.writeTextFile(join(root, rel), content);
    }
    let denoConfigPath: string | undefined;
    if (files.denoJson !== undefined) {
      denoConfigPath = join(root, "deno.json");
      await Deno.writeTextFile(denoConfigPath, files.denoJson);
    }
    const manifest = parseExtensionManifest(manifestText);
    const additionalPaths = additional.map((f) => join(root, f));
    await fn({
      root,
      prepareInput: buildPrepareInput(manifest, root, {
        allModelFiles: [model],
        modelEntryPoints: [model],
        additionalFilePaths: additionalPaths,
        dryRun: true,
        registryChecks: "skip",
        denoConfigPath,
      }),
      hashInput: {
        manifest,
        rootDir: root,
        manifestDir: root,
        modelFilePaths: [model],
        vaultFilePaths: [],
        datastoreFilePaths: [],
        reportFilePaths: [],
        webhookFilePaths: [],
        workflowFilePaths: [],
        additionalFilePaths: additionalPaths,
        binaryFilePaths: [],
        skillFilePaths: [],
        includeFilePaths: [],
        denoConfigPath,
        packageJsonPath: undefined,
      },
      tsFiles: [model],
      denoConfigPath,
    });
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

async function runQuality(
  fixture: Fixture,
  cache = new ExtensionPackageCache(
    join(fixture.root, ".swamp", "cache"),
    "agreement-test",
  ),
): Promise<ExtensionQualityData> {
  const events = await collect(extensionQuality(ctx, {
    pushPrepareDeps: prepareDeps(),
    cache,
    ensureDenoPath: () => Promise.resolve(DENO),
    makeScoreDeps: () => scoreDeps(),
  }, { prepareInput: fixture.prepareInput, hashInput: fixture.hashInput }));
  const last = events[events.length - 1];
  if (last.kind !== "completed") {
    throw new Error(`quality did not complete: ${JSON.stringify(last)}`);
  }
  return last.data;
}

async function runFmtCheck(fixture: Fixture): Promise<boolean> {
  const events = await collect<ExtensionFmtEvent>(extensionFmt(ctx, {
    checkQuality: (files, denoConfigPath) =>
      checkExtensionQuality(files, DENO, denoConfigPath),
    runFmt: () => Promise.resolve(""),
    runLint: () => Promise.resolve(""),
  }, {
    tsFiles: fixture.tsFiles,
    check: true,
    denoConfigPath: fixture.denoConfigPath,
  }));
  const last = events[events.length - 1];
  if (last.kind !== "completed") throw new Error("fmt did not complete");
  return last.data.passed;
}

Deno.test("quality and push agree: bare specifiers are the same warning with the same import-map fix", async () => {
  await withExtension({
    model:
      'import { z } from "zod";\nexport const model = { s: z.string() };\n',
    denoJson: JSON.stringify({ imports: { zod: "npm:zod@4.3.6" } }),
  }, async (fixture) => {
    const pushed = await extensionPushPrepare(
      ctx,
      prepareDeps(),
      fixture.prepareInput,
    );
    const pushBare = pushed.reviewRulesResult.warnings.filter((w) =>
      w.ruleId === "bare-specifiers"
    );
    const quality = await runQuality(fixture);
    const qualityBare = quality.findings.reviewRulesResult.warnings.filter((
      w,
    ) => w.ruleId === "bare-specifiers");

    assertEquals(pushBare.length, 1);
    assertEquals(qualityBare, pushBare);
    assertStringIncludes(pushBare[0].message, '"zod" with "npm:zod@4.3.6"');
    assertEquals(quality.registryScorable, false);
    assertEquals(quality.gateFailures, []);
  });
});

Deno.test("quality and push agree: a hidden packaged file is the same safety error, and quality still scores", async () => {
  await withExtension({
    model:
      'import { z } from "npm:zod@4";\nexport const model = { s: z.string() };\n',
    additional: { ".notes.md": "hidden\n" },
  }, async (fixture) => {
    const error = await assertRejects(() =>
      extensionPushPrepare(ctx, prepareDeps(), fixture.prepareInput)
    ) as SwampError;
    const pushSafety =
      (error.details as { safetyErrors: SafetyIssue[] }).safetyErrors;

    const quality = await runQuality(fixture);
    const safety = quality.gateFailures.find((f) => f.gate === "safety");
    assert(safety !== undefined, "quality must report the safety gate");
    assertEquals(safety.message, error.message);
    assertEquals(
      (safety.details as { safetyErrors: SafetyIssue[] }).safetyErrors,
      pushSafety,
    );
    assertEquals(pushSafety.map((i) => i.ruleId), ["hidden-file"]);
    assertEquals(quality.excludedFromArchive, [
      join(fixture.root, ".notes.md"),
    ]);
    assertEquals(quality.score.factors.length > 0, true);

    // Never cached: the next run is cold and reports the same failure.
    const again = await runQuality(fixture);
    assertEquals(again.cacheHit, false);
    assertEquals(again.gateFailures.map((f) => f.gate), ["safety"]);
  });
});

Deno.test("fmt --check, quality and push agree: a project deno.json's format rules apply, and npm: imports pass lint", async () => {
  await withExtension({
    model:
      "import { z } from 'npm:zod@4';\n\nexport const model = { s: z.string() };\n",
    denoJson: JSON.stringify({ fmt: { singleQuote: true } }),
  }, async (fixture) => {
    assertEquals(await runFmtCheck(fixture), true);
    const pushed = await extensionPushPrepare(
      ctx,
      prepareDeps(),
      fixture.prepareInput,
    );
    assertEquals(
      pushed.reviewRulesResult.warnings.map((w: ReviewFinding) => w.ruleId)
        .includes("bare-specifiers"),
      false,
    );
    const quality = await runQuality(fixture);
    assertEquals(quality.gateFailures, []);
    assertEquals(quality.registryScorable, true);
  });
});

Deno.test("fmt --check, quality and push agree: double quotes fail all three under a singleQuote config", async () => {
  await withExtension({
    model:
      'import { z } from "npm:zod@4";\n\nexport const model = { s: z.string() };\n',
    denoJson: JSON.stringify({ fmt: { singleQuote: true } }),
  }, async (fixture) => {
    assertEquals(await runFmtCheck(fixture), false);
    const error = await assertRejects(() =>
      extensionPushPrepare(ctx, prepareDeps(), fixture.prepareInput)
    ) as SwampError;
    assertStringIncludes(error.message, "formatting or lint issues");
    const quality = await runQuality(fixture);
    assertEquals(quality.gateFailures.map((f) => f.gate), ["fmt-lint"]);
  });
});

Deno.test("quality: a cache entry another swamp version wrote is not reused", async () => {
  await withExtension({
    model:
      'import { z } from "npm:zod@4";\nexport const model = { s: z.string() };\n',
  }, async (fixture) => {
    const cacheRoot = join(fixture.root, ".swamp", "cache");
    const older = await runQuality(
      fixture,
      new ExtensionPackageCache(cacheRoot, "older"),
    );
    assertEquals(older.cacheHit, false);
    const hash = await computePackageCacheHash(fixture.hashInput);
    assert(
      await new ExtensionPackageCache(cacheRoot, "older").get(hash) !== null,
    );

    const newer = await runQuality(
      fixture,
      new ExtensionPackageCache(cacheRoot, "newer"),
    );
    assertEquals(newer.cacheHit, false);
    const sameVersion = await runQuality(
      fixture,
      new ExtensionPackageCache(cacheRoot, "newer"),
    );
    assertEquals(sameVersion.cacheHit, true);
  });
});
