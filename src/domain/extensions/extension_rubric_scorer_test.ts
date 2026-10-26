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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join, toFileUrl } from "@std/path";
import type { ExtensionManifest } from "./extension_manifest.ts";
import {
  composeLocalScore,
  isolatedDenoEnv,
  predictPublishedPrivate,
  type RubricScore,
  type RubricScoreDeps,
  scoreExtensionTarball,
} from "./extension_rubric_scorer.ts";
import {
  type AnalysisFactors,
  computeAnalysisFactors,
  type DocOutput,
  type NotAuditedFix,
  type PrivateSourceStanding,
  RUBRIC_VERSION,
} from "@swamp-club/extension-scoring/rubric";
import { DOC_FAILURE_FALLBACK } from "@swamp-club/extension-scoring/doc-failure";

function makeManifest(
  overrides: Partial<ExtensionManifest> = {},
): ExtensionManifest {
  return {
    manifestVersion: 1,
    name: "@example/test",
    version: "2026.01.01.0",
    description: "A test extension",
    license: "MIT",
    repository: "https://github.com/example/test",
    paths: { base: "typedDir" },
    workflows: [],
    models: [],
    vaults: [],
    datastores: [],
    reports: [],
    webhooks: [],
    skills: [],
    include: [],
    additionalFiles: [],
    binaries: [],
    platforms: ["linux", "darwin"],
    labels: [],
    releaseNotes: undefined,
    dependencies: [],
    ...overrides,
  };
}

// ── composeLocalScore ───────────────────────────────────────────────────

/** The analysis plus what the CLI adds before publish, as these tests write it. */
type LocalFactors = AnalysisFactors & {
  dependencyTrustPassed?: boolean;
  dependencyTrustBlockerCount?: number;
  dependencyNotAuditedCount?: number;
  dependencyNotAuditedFixes?: readonly NotAuditedFix[];
  dependencyLooseCount?: number;
  secretSafeDocs?: boolean;
};

function composeScore(
  factors: LocalFactors,
  manifest: ExtensionManifest,
  privateSource?: PrivateSourceStanding,
  docAnalysisError: string | null = null,
): RubricScore {
  const {
    dependencyTrustPassed,
    dependencyTrustBlockerCount,
    dependencyNotAuditedCount,
    dependencyNotAuditedFixes,
    dependencyLooseCount,
    secretSafeDocs,
    ...analysis
  } = factors;
  return composeLocalScore(analysis, manifest, {
    dependencyTrustBlockerCount: dependencyTrustPassed === false
      ? Math.max(dependencyTrustBlockerCount ?? 0, 1)
      : dependencyTrustBlockerCount ??
        (dependencyTrustPassed ? 0 : undefined),
    dependencyNotAuditedCount,
    dependencyNotAuditedFixes,
    dependencyLooseCount,
    secretSafeDocs,
    privateSource,
  }, docAnalysisError);
}

Deno.test("RUBRIC_VERSION is 5 (one scorer shared with the registry, swamp-club#3781)", () => {
  assertEquals(RUBRIC_VERSION, 5);
});

function factorsAllEarned(): LocalFactors {
  return {
    hasReadme: true,
    hasReadmeExamples: true,
    allEntrypointsDocs: true,
    percentageDocumentedSymbols: 1,
    allFastCheck: true,
    readmeLength: 800,
    readmeCodeBlockCount: 3,
    hasLicenseFile: true,
    dependencyTrustPassed: true,
    dependencyTrustBlockerCount: 0,
    dependencyNotAuditedCount: 0,
    dependencyNotAuditedFixes: [],
    dependencyLooseCount: 0,
    secretSafeDocs: true,
  };
}

Deno.test("composeScore: perfect extension earns 14/16 (87%, B) and 100% (A) once the registry verifies the repository", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  assertEquals(score.earnedPoints, 14);
  assertEquals(score.maxEarnablePoints, 16);
  assertEquals(score.maxClientEarnablePoints, 14);
  assertEquals(score.provisionalPoints, 2);
  assertEquals(score.percentage, 87);
  assertEquals(score.grade, "B");
  assertEquals(score.ifProvisionalEarned, { percentage: 100, grade: "A" });
  assertEquals(score.allPassed, true);
});

Deno.test("composeScore: nothing provisional has no raise to show", () => {
  const score = composeScore(
    factorsAllEarned(),
    makeManifest({ repository: undefined }),
  );
  assertEquals(score.provisionalPoints, 0);
  assertEquals([score.percentage, score.grade], [87, "B"]);
  assertEquals(score.ifProvisionalEarned, null);
});

Deno.test("composeScore: secret-safe-docs is worth 1 point, earned only when the docs are clean", () => {
  const clean = composeScore(factorsAllEarned(), makeManifest());
  const earned = clean.factors.find((f) => f.id === "secret-safe-docs")!;
  assertEquals([earned.maxPoints, earned.earnedPoints], [1, 1]);
  assertEquals(earned.status, "earned");

  const leaky = composeScore(
    { ...factorsAllEarned(), secretSafeDocs: false },
    makeManifest(),
  );
  const missing = leaky.factors.find((f) => f.id === "secret-safe-docs")!;
  assertEquals([missing.earnedPoints, missing.status], [0, "missing"]);
  assertStringIncludes(missing.remediation ?? "", "vault.get");
  assertEquals(leaky.percentage, Math.floor((13 * 100) / 16));
  assertEquals(leaky.allPassed, false);
});

Deno.test("composeScore: has-readme is worth 2 points", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  const factor = score.factors.find((f) => f.id === "has-readme")!;
  assertEquals(factor.maxPoints, 2);
});

Deno.test("composeScore: repository-verified is provisional when URL is verifiable", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  const factor = score.factors.find((f) => f.id === "repository-verified")!;
  assertEquals(factor.maxPoints, 2);
  assertEquals(factor.earnedPoints, 0);
  assertEquals(factor.status, "provisional");
});

Deno.test("composeScore: repository-verified is missing when URL is not verifiable", () => {
  const score = composeScore(
    factorsAllEarned(),
    makeManifest({ repository: "http://bad/x" }),
  );
  const factor = score.factors.find((f) => f.id === "repository-verified")!;
  assertEquals(factor.maxPoints, 2);
  assertEquals(factor.earnedPoints, 0);
  assertEquals(factor.status, "missing");
});

// ── private source hosting (swamp-club#3396, swamp-club#3406) ──────────

const SELF_HOSTED = "https://git.example-corp.internal/team/ext";

function repositoryFactor(
  repository: string | undefined,
  privateSource?: PrivateSourceStanding,
) {
  const score = composeScore(
    factorsAllEarned(),
    makeManifest({ repository }),
    privateSource,
  );
  return {
    score,
    factor: score.factors.find((f) => f.id === "repository-verified")!,
  };
}

Deno.test("predictPublishedPrivate: a republish keeps the stored visibility", () => {
  assertEquals(
    predictPublishedPrivate({ isPrivate: true }, "public", false),
    true,
  );
  assertEquals(
    predictPublishedPrivate({ isPrivate: false }, "private", true),
    false,
  );
});

Deno.test("predictPublishedPrivate: a first publish is private when asked or when the namespace is private", () => {
  assertEquals(predictPublishedPrivate(null, "private", false), true);
  assertEquals(predictPublishedPrivate(null, "public", true), true);
  assertEquals(predictPublishedPrivate(null, undefined, true), true);
  assertEquals(predictPublishedPrivate(null, undefined, false), false);
  assertEquals(predictPublishedPrivate(null, "public", false), false);
});

Deno.test("composeScore: an attested private extension scores repository-verified like a public forge, whatever its URL", () => {
  const publicForge = repositoryFactor("https://github.com/example/test");
  for (const repository of [SELF_HOSTED, undefined, "http://bad/x"]) {
    const { score, factor } = repositoryFactor(repository, {
      kind: "attested",
    });
    assertEquals(factor.status, "provisional", String(repository));
    assertEquals(factor.label, "Private repository (collective attested)");
    assertEquals(factor.earnedPoints, 0);
    assertEquals(factor.remediation, undefined);
    assertEquals(score.allPassed, true);
    assertEquals(score.percentage, publicForge.score.percentage);
    assertEquals(
      score.maxClientEarnablePoints,
      publicForge.score.maxClientEarnablePoints,
    );
    assertEquals(score.provisionalPoints, publicForge.score.provisionalPoints);
  }
});

Deno.test("composeScore: without attestation a self-hosted URL stays missing, as the registry scores it", () => {
  for (
    const privateSource of [
      undefined,
      { kind: "unknown" },
      { kind: "not_attested", reason: "no_private_source_hosting" },
      { kind: "not_attested", reason: "public_extension" },
    ] satisfies Array<PrivateSourceStanding | undefined>
  ) {
    const { score, factor } = repositoryFactor(SELF_HOSTED, privateSource);
    assertEquals(factor.status, "missing", JSON.stringify(privateSource));
    assertEquals(score.allPassed, false);
    assertStringIncludes(
      factor.remediation ?? "",
      "Set `repository:` to a public HTTPS URL on github.com",
    );
  }
});

Deno.test("composeScore: the missing remediation says why private source hosting does not apply", () => {
  assertStringIncludes(
    repositoryFactor(SELF_HOSTED).factor.remediation ?? "",
    "which could not be checked",
  );
  assertStringIncludes(
    repositoryFactor(SELF_HOSTED, {
      kind: "not_attested",
      reason: "no_private_source_hosting",
    }).factor.remediation ?? "",
    "ask Swamp Club to mark the collective for private source hosting",
  );
  assertStringIncludes(
    repositoryFactor(SELF_HOSTED, {
      kind: "not_attested",
      reason: "public_extension",
    }).factor.remediation ?? "",
    "this extension will publish as public",
  );
});

Deno.test("composeScore: a public-forge URL scores as before whatever the private source standing", () => {
  const released = repositoryFactor("https://github.com/example/test");
  for (
    const privateSource of [
      { kind: "unknown" },
      { kind: "not_attested", reason: "no_private_source_hosting" },
      { kind: "not_attested", reason: "public_extension" },
    ] satisfies PrivateSourceStanding[]
  ) {
    const { score, factor } = repositoryFactor(
      "https://github.com/example/test",
      privateSource,
    );
    assertEquals(factor, released.factor, JSON.stringify(privateSource));
    assertEquals(score, released.score);
  }
});

Deno.test("composeScore: bad manifest fails several factors", () => {
  const score = composeScore(
    factorsAllEarned(),
    makeManifest({
      description: "",
      repository: "http://bad/x",
      platforms: ["linux"],
    }),
  );
  assertEquals(score.allPassed, false);
  const failed = score.factors
    .filter((f) => f.status !== "earned" && f.status !== "provisional")
    .map((f) => f.id);
  assert(failed.includes("description"));
  assert(failed.includes("repository-verified"));
  assert(!failed.includes("platforms"));
});

Deno.test("composeScore: empty platforms is universal (platform factor earned)", () => {
  const score = composeScore(
    factorsAllEarned(),
    makeManifest({ platforms: [] }),
  );
  const factor = score.factors.find((f) => f.id === "platforms")!;
  assertEquals(factor.status, "earned");
  assertEquals(factor.earnedPoints, 2);
});

Deno.test("composeScore: missing LICENSE file misses license-file only", () => {
  const score = composeScore(
    { ...factorsAllEarned(), hasLicenseFile: false },
    makeManifest(),
  );
  const byId = new Map(score.factors.map((f) => [f.id, f]));
  assertEquals(byId.get("license-file")?.status, "missing");
  assertEquals(byId.get("license-file")?.label, "LICENSE file included");
  assertEquals(byId.get("has-license")?.status, "earned");
});

Deno.test("composeScore: has-license is earned only by a valid SPDX license:", () => {
  const cases: Array<[string | undefined, string]> = [
    ["MIT", "earned"],
    ["MIT OR Apache-2.0", "earned"],
    ["GPL-2.0-only WITH Classpath-exception-2.0", "earned"],
    [undefined, "missing"],
    ["Not-A-License", "missing"],
    ["LicenseRef-Mine", "missing"],
    ["AGPL-3.0-only WITH AdditionRef-Swamp-Extension-Exception", "missing"],
  ];
  for (const [license, status] of cases) {
    const score = composeScore(factorsAllEarned(), makeManifest({ license }));
    const f = score.factors.find((f) => f.id === "has-license")!;
    assertEquals(f.status, status, String(license));
    assertEquals(f.label, "License declared");
  }
});

Deno.test("composeScore: has-license remediation asks for an SPDX expression", () => {
  const score = composeScore(
    factorsAllEarned(),
    makeManifest({ license: undefined }),
  );
  const f = score.factors.find((f) => f.id === "has-license")!;
  assertStringIncludes(f.remediation ?? "", "license: MIT");
  assertStringIncludes(f.remediation ?? "", "Only SPDX identifiers count");
});

Deno.test("composeScore: has-readme remediation names the archive path and bare-basename rule", () => {
  const score = composeScore(
    { ...factorsAllEarned(), hasReadme: false },
    makeManifest(),
  );
  const f = score.factors.find((f) => f.id === "has-readme")!;
  assertEquals(f.status, "missing");
  const remediation = f.remediation ?? "";
  assertStringIncludes(remediation, "extension/files/");
  assertStringIncludes(remediation, "bare basename");
});

Deno.test("composeScore: license-file remediation names the archive path and bare-basename rule", () => {
  const score = composeScore(
    { ...factorsAllEarned(), hasLicenseFile: false },
    makeManifest(),
  );
  const f = score.factors.find((f) => f.id === "license-file")!;
  assertEquals(f.status, "missing");
  const remediation = f.remediation ?? "";
  assertStringIncludes(remediation, "extension/files/");
  assertStringIncludes(remediation, "bare basename");
});

Deno.test("composeScore: symbols-docs below 80% fails", () => {
  const score = composeScore(
    { ...factorsAllEarned(), percentageDocumentedSymbols: 0.79 },
    makeManifest(),
  );
  const f = score.factors.find((f) => f.id === "symbols-docs")!;
  assertEquals(f.status, "missing");
});

Deno.test("composeScore: symbols-docs at exactly 80% earns", () => {
  const score = composeScore(
    { ...factorsAllEarned(), percentageDocumentedSymbols: 0.8 },
    makeManifest(),
  );
  const f = score.factors.find((f) => f.id === "symbols-docs")!;
  assertEquals(f.status, "earned");
});

Deno.test("composeScore: rich-readme requires both length AND fences", () => {
  // Long enough but only 1 fence
  const s1 = composeScore(
    {
      ...factorsAllEarned(),
      readmeLength: 1000,
      readmeCodeBlockCount: 1,
    },
    makeManifest(),
  );
  assertEquals(
    s1.factors.find((f) => f.id === "rich-readme")!.status,
    "missing",
  );

  // Enough fences but too short
  const s2 = composeScore(
    {
      ...factorsAllEarned(),
      readmeLength: 300,
      readmeCodeBlockCount: 5,
    },
    makeManifest(),
  );
  assertEquals(
    s2.factors.find((f) => f.id === "rich-readme")!.status,
    "missing",
  );
});

Deno.test("composeScore: factor IDs and order match server", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  const ids = score.factors.map((f) => f.id);
  assertEquals(ids, [
    "has-readme",
    "readme-example",
    "rich-readme",
    "symbols-docs",
    "fast-check",
    "dependency-trust",
    "secret-safe-docs",
    "description",
    "platforms",
    "has-license",
    "license-file",
    "repository-verified",
  ]);
});

Deno.test("composeScore: percentage floors (not rounds)", () => {
  // 14/16 = 87.5 → floor = 87
  const score = composeScore(factorsAllEarned(), makeManifest());
  assertEquals(score.earnedPoints, 14);
  assertEquals(score.percentage, 87);
});

// --- scorecard_test.ts ports (core scenarios) --------------------------

Deno.test("[parity] composeScore: empty everything earns universal-platform only", () => {
  const score = composeScore(
    {
      hasReadme: false,
      hasReadmeExamples: false,
      allEntrypointsDocs: false,
      percentageDocumentedSymbols: 0,
      allFastCheck: false,
      readmeLength: null,
      readmeCodeBlockCount: null,
      hasLicenseFile: false,
      dependencyTrustPassed: false,
      dependencyTrustBlockerCount: 0,
      dependencyNotAuditedCount: 0,
      dependencyNotAuditedFixes: [],
      dependencyLooseCount: 0,
      secretSafeDocs: false,
    },
    makeManifest({
      description: "",
      license: undefined,
      repository: undefined,
      platforms: [],
    }),
  );
  // Universal platforms earns 2 + fast-check always earns 1 (deprecated).
  assertEquals(score.earnedPoints, 3);
  assertEquals(score.percentage, Math.floor((3 * 100) / 16));
  assertEquals(score.rubricVersion, 5);
  assertEquals(score.factors.length, 12);
  const byId = new Map(score.factors.map((f) => [f.id, f]));
  assertEquals(byId.get("platforms")?.status, "earned");
  assertEquals(byId.get("platforms")?.earnedPoints, 2);
  assertEquals(byId.get("repository-verified")?.status, "missing");
  // verified-by-swamp is not a factor in the rubric (badge only)
  assertEquals(byId.get("verified-by-swamp"), undefined);
  // entrypoints-docs was dropped at v2
  assertEquals(byId.get("entrypoints-docs"), undefined);
});

Deno.test("[parity] composeScore: perfect score hits 100% once the registry awards repository-verified", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  // 14/16: repo-verified is provisional, not earned yet, still in the divisor
  assertEquals(score.earnedPoints, 14);
  assertEquals(score.maxClientEarnablePoints, 14);
  assertEquals(score.provisionalPoints, 2);
  assertEquals(score.percentage, 87);
  assertEquals(score.ifProvisionalEarned?.percentage, 100);
  assertEquals(score.allPassed, true);
});

Deno.test("[parity] composeScore: percentage floors (13/16 → 81, 15/16 → 93)", () => {
  const score = composeScore(
    { ...factorsAllEarned(), hasLicenseFile: false },
    makeManifest(),
  );
  assertEquals(score.earnedPoints, 13);
  assertEquals(score.percentage, 81);
  assertEquals(score.ifProvisionalEarned, { percentage: 93, grade: "A" });
});

Deno.test("[parity] composeScore: platforms factor earns 2 for any count", () => {
  // 1 platform: earned
  const s1 = composeScore(
    factorsAllEarned(),
    makeManifest({ platforms: ["linux"] }),
  );
  const m1 = new Map(s1.factors.map((f) => [f.id, f]));
  assertEquals(m1.get("platforms")?.status, "earned");
  assertEquals(m1.get("platforms")?.earnedPoints, 2);

  // 2+ platforms: earned
  const s2 = composeScore(
    factorsAllEarned(),
    makeManifest({ platforms: ["linux", "darwin"] }),
  );
  const m2 = new Map(s2.factors.map((f) => [f.id, f]));
  assertEquals(m2.get("platforms")?.status, "earned");
  assertEquals(m2.get("platforms")?.earnedPoints, 2);

  // Empty (= universal): earned
  const s3 = composeScore(
    factorsAllEarned(),
    makeManifest({ platforms: [] }),
  );
  const m3 = new Map(s3.factors.map((f) => [f.id, f]));
  assertEquals(m3.get("platforms")?.status, "earned");
  assertEquals(m3.get("platforms")?.earnedPoints, 2);
});

Deno.test("composeScore: fast-check is always earned (deprecated)", () => {
  const score = composeScore(
    { ...factorsAllEarned(), allFastCheck: false },
    makeManifest(),
  );
  const factor = score.factors.find((f) => f.id === "fast-check")!;
  assertEquals(factor.status, "earned");
  assertEquals(factor.earnedPoints, 1);
  assertEquals(factor.label, "No slow types (deprecated)");
});

Deno.test("composeScore: dependency-trust is worth 2 points when passing", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  const factor = score.factors.find((f) => f.id === "dependency-trust")!;
  assertEquals(factor.maxPoints, 2);
  assertEquals(factor.earnedPoints, 2);
  assertEquals(factor.status, "earned");
});

Deno.test("composeScore: dependency-trust fails with blockers", () => {
  const score = composeScore(
    {
      ...factorsAllEarned(),
      dependencyTrustPassed: false,
      dependencyTrustBlockerCount: 3,
    },
    makeManifest(),
  );
  const factor = score.factors.find((f) => f.id === "dependency-trust")!;
  assertEquals(factor.earnedPoints, 0);
  assertEquals(factor.status, "missing");
  assertStringIncludes(factor.remediation ?? "", "3 dependency blocker(s)");
});

Deno.test("composeScore: dependency-trust earns nothing while a dependency is not audited", () => {
  const score = composeScore(
    {
      ...factorsAllEarned(),
      dependencyNotAuditedCount: 2,
      dependencyNotAuditedFixes: ["outage"],
    },
    makeManifest(),
  );
  const factor = score.factors.find((f) => f.id === "dependency-trust")!;
  assertEquals(factor.earnedPoints, 0);
  assertEquals(factor.status, "missing");
  assertEquals(
    factor.remediation,
    "2 dependency(ies) not audited because an OSV, npm or JSR lookup " +
      "failed. Re-run when OSV, npm and JSR are reachable.",
  );
});

for (
  const [fix, expected] of [
    [
      "specifier",
      "1 dependency(ies) not audited because no published version matches " +
      "the specifier. Change the specifier to a version the registry publishes.",
    ],
    [
      "name",
      "1 dependency(ies) not audited because the package name is invalid. " +
      "Correct the package name in the import.",
    ],
    [
      "unexpected",
      "1 dependency(ies) not audited because the audit failed unexpectedly. " +
      "Re-run; if it fails again, report it.",
    ],
    [
      "other",
      "1 dependency(ies) not audited. Resolve the reason given in each " +
      "not-audited finding, then re-run.",
    ],
  ] as const
) {
  Deno.test(`composeScore: dependency-trust names the ${fix} cause, not an outage`, () => {
    const score = composeScore(
      {
        ...factorsAllEarned(),
        dependencyNotAuditedCount: 1,
        dependencyNotAuditedFixes: [fix],
      },
      makeManifest(),
    );
    const factor = score.factors.find((f) => f.id === "dependency-trust")!;
    assertEquals(factor.earnedPoints, 0);
    assertEquals(factor.remediation, expected);
  });
}

Deno.test("composeScore: dependency-trust with several causes sends the author to each fix and never says re-run", () => {
  const score = composeScore(
    {
      ...factorsAllEarned(),
      dependencyNotAuditedCount: 2,
      dependencyNotAuditedFixes: ["outage", "specifier"],
      dependencyLooseCount: 1,
    },
    makeManifest(),
  );
  const factor = score.factors.find((f) => f.id === "dependency-trust")!;
  assertEquals(factor.earnedPoints, 0);
  assertStringIncludes(
    factor.remediation ?? "",
    "2 dependency(ies) not audited, for different reasons. Apply the fix " +
      "listed with each not-audited finding. Also: 1 loose dependency",
  );
  assertEquals(factor.remediation?.includes("Re-run"), false);
});

Deno.test("composeScore: a deno doc failure is named on symbols-docs and has-readme instead of asking for JSDoc", () => {
  const error =
    'The registry cannot resolve the bare import "zod"; use an explicit npm: or jsr: specifier (npm:zod@4 for zod).';
  const factors = {
    ...factorsAllEarned(),
    hasReadme: false,
    percentageDocumentedSymbols: 0,
  };
  const failed = composeScore(factors, makeManifest(), undefined, error);
  const symbols = failed.factors.find((f) => f.id === "symbols-docs")!;
  assertEquals(symbols.earnedPoints, 0);
  assertEquals(symbols.status, "missing");
  assertEquals(
    symbols.remediation,
    "deno doc could not analyse the source, so JSDoc coverage could not " +
      `be measured: ${error}`,
  );
  const readme = failed.factors.find((f) => f.id === "has-readme")!;
  assertEquals(readme.earnedPoints, 0);
  assertStringIncludes(readme.remediation ?? "", "Add `README.md`");
  assertStringIncludes(
    readme.remediation ?? "",
    "A module-level JSDoc counts only once deno doc can analyse the " +
      `source: ${error}`,
  );
  assertEquals(readme.remediation?.includes("Or add a module-level"), false);

  const analysed = composeScore(factors, makeManifest());
  assertStringIncludes(
    analysed.factors.find((f) => f.id === "symbols-docs")!.remediation ?? "",
    "Add JSDoc to ≥80% of exported symbols in entrypoints (current: 0%).",
  );
  assertStringIncludes(
    analysed.factors.find((f) => f.id === "has-readme")!.remediation ?? "",
    "Or add a module-level JSDoc at the top of every entrypoint file.",
  );
});

Deno.test("composeScore: dependency-trust remediation names blockers before unaudited dependencies", () => {
  const score = composeScore(
    {
      ...factorsAllEarned(),
      dependencyTrustPassed: false,
      dependencyTrustBlockerCount: 1,
      dependencyNotAuditedCount: 1,
    },
    makeManifest(),
  );
  const factor = score.factors.find((f) => f.id === "dependency-trust")!;
  assertEquals(factor.earnedPoints, 0);
  assertStringIncludes(factor.remediation ?? "", "1 dependency blocker(s)");
});

Deno.test("composeScore: dependency-trust loses one point for loose specifiers alone", () => {
  const score = composeScore(
    { ...factorsAllEarned(), dependencyLooseCount: 2 },
    makeManifest(),
  );
  const factor = score.factors.find((f) => f.id === "dependency-trust")!;
  assertEquals(factor.earnedPoints, 1);
  assertEquals(factor.maxPoints, 2);
  assertEquals(factor.status, "partial");
  assertStringIncludes(
    factor.remediation ?? "",
    "2 loose dependency specifier(s) (loose-specifier) cost 1 of 2 points",
  );
  assertEquals(score.allPassed, false);
});

Deno.test("composeScore: dependency-trust stays at 0 when loose specifiers join a blocker or an unaudited dependency", () => {
  for (
    const extra of [
      { dependencyTrustPassed: false, dependencyTrustBlockerCount: 1 },
      { dependencyNotAuditedCount: 1 },
    ]
  ) {
    const score = composeScore(
      { ...factorsAllEarned(), ...extra, dependencyLooseCount: 1 },
      makeManifest(),
    );
    const factor = score.factors.find((f) => f.id === "dependency-trust")!;
    assertEquals(factor.earnedPoints, 0);
    assertStringIncludes(factor.remediation ?? "", "Also: 1 loose dependency");
  }
});

Deno.test("computeAnalysisFactors: a failed deno doc documents nothing, not 100% of nothing", () => {
  const input = {
    entrypointUrls: ["file:///a.ts"],
    readme: null,
    hasLicenseFile: false,
    doc: { version: 1, nodes: {} },
    rawLintOutput: "",
  };
  assertEquals(computeAnalysisFactors(input).percentageDocumentedSymbols, 1);
  const failed = computeAnalysisFactors({ ...input, docFailed: true });
  assertEquals(failed.percentageDocumentedSymbols, 0);
  assertEquals(failed.allEntrypointsDocs, false);
  assertEquals(failed.allFastCheck, true);
});

// ── scoreExtensionTarball: import map merging ────────────────────────

function fakeExtractTarball(
  files: Record<string, string>,
): RubricScoreDeps["extractTarball"] {
  return async (_source: ReadableStream<Uint8Array>, destDir: string) => {
    const extDir = join(destDir, "extension");
    await Deno.mkdir(join(extDir, "models"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const path = join(extDir, ...name.split("/"));
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
  };
}

const MINIMAL_DOC_OUTPUT: DocOutput = { version: 1, nodes: {} };

function fakeScoreDeps(
  files: Record<string, string>,
  onRunDeno?: (args: string[], cwd: string) => void,
): RubricScoreDeps {
  return {
    extractTarball: fakeExtractTarball(files),
    runDeno: (args: string[], cwd: string) => {
      onRunDeno?.(args, cwd);
      if (args[0] === "doc" && args.includes("--json")) {
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

Deno.test("scoreExtensionTarball: the controlled deno.json has no import map, as the registry's (swamp-club#3612)", async () => {
  let capturedConfig: Record<string, unknown> | undefined;
  const deps = fakeScoreDeps(
    {
      "manifest.yaml": "manifestVersion: 1\nname: '@test/no-map'\n",
      // A bare import push shipped as written stays unresolved locally too.
      "models/mod.ts": 'import { z } from "zod";\nexport const s = z.string();',
      "README.md": "# Test",
      "LICENSE": "MIT",
    },
    (_args, cwd) => {
      const raw = Deno.readTextFileSync(join(cwd, "deno.json"));
      capturedConfig = JSON.parse(raw);
    },
  );

  const tarball = new Uint8Array(0);
  const manifest = makeManifest({ models: ["mod.ts"] });

  await scoreExtensionTarball(tarball, manifest, deps);

  assert(capturedConfig !== undefined, "runDeno should have been called");
  assertEquals(capturedConfig!.nodeModulesDir, "auto");
  assertEquals(capturedConfig!.imports, undefined);
});

Deno.test("scoreExtensionTarball: an empty LICENSE file does not earn license-file", async () => {
  for (
    const [content, status] of [["MIT License", "earned"], ["", "missing"]]
  ) {
    const deps = fakeScoreDeps({
      "manifest.yaml": "manifestVersion: 1\nname: '@test/lic'\n",
      "models/mod.ts": "export const s = 1;",
      "README.md": "# Test",
      "LICENSE": content,
    });
    const score = await scoreExtensionTarball(
      new Uint8Array(0),
      makeManifest({ models: ["mod.ts"] }),
      deps,
    );
    assertEquals(
      score.factors.find((f) => f.id === "license-file")?.status,
      status,
    );
  }
});

// ── scoreExtensionTarball: deno doc failure (swamp-club#3669) ────────

/**
 * deno 2.9.7's stderr for `deno doc --json` on an entrypoint with a bare
 * `zod` import nothing maps, with the importing file's URL left to fill in.
 */
function bareZodDocStderr(moduleUrl: string): string {
  return [
    'Warning Import "zod" not a dependency',
    "  hint: If you want to use the npm package, try running `deno add npm:zod`",
    `    at ${moduleUrl}:2:19`,
    `error: Failed resolving 'zod' from '${moduleUrl}'.`,
  ].join("\n");
}

function failingDocDeps(
  stderr: (cwd: string) => string,
  calls: string[][],
): RubricScoreDeps {
  return {
    extractTarball: fakeExtractTarball({
      "manifest.yaml": "manifestVersion: 1\nname: '@test/bare'\n",
      "models/mod.ts":
        '// deno-lint-ignore-file\nimport { z } from "zod";\nexport const s = z.string();\n',
      "README.md": "# Test",
    }),
    runDeno: (args, cwd) => {
      calls.push(args);
      if (args[0] === "doc" && args.includes("--json")) {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: stderr(cwd),
        });
      }
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    },
  };
}

Deno.test("scoreExtensionTarball: a deno doc failure is scored, not thrown, as the registry scores it", async () => {
  const calls: string[][] = [];
  const deps = failingDocDeps(
    (cwd) => bareZodDocStderr(toFileUrl(join(cwd, "models", "mod.ts")).href),
    calls,
  );

  const score = await scoreExtensionTarball(
    new Uint8Array(0),
    makeManifest({ models: ["mod.ts"] }),
    deps,
  );

  assertEquals(
    score.docAnalysisError,
    'The registry cannot resolve the bare import "zod"; use an explicit npm: or jsr: specifier (npm:zod@4 for zod).',
  );
  const symbols = score.factors.find((f) => f.id === "symbols-docs")!;
  assertEquals(symbols.earnedPoints, 0);
  assertEquals(symbols.status, "missing");
  // The registry skips the lint run once deno doc has failed.
  assertEquals(calls.filter((a) => a[1] === "--lint"), []);
  // The README still counts.
  assertEquals(
    score.factors.find((f) => f.id === "has-readme")!.status,
    "earned",
  );
});

Deno.test("scoreExtensionTarball: a doc failure names archive files relative to the extraction root", async () => {
  const deps = failingDocDeps(
    (cwd) =>
      [
        `Warning Module not found "${
          toFileUrl(join(cwd, "models", "_lib", "gone.ts")).href
        }".`,
        `    at ${toFileUrl(join(cwd, "models", "mod.ts")).href}:3:8`,
      ].join("\n"),
    [],
  );

  const score = await scoreExtensionTarball(
    new Uint8Array(0),
    makeManifest({ models: ["mod.ts"] }),
    deps,
  );

  assertEquals(
    score.docAnalysisError,
    "Not in the published archive: models/_lib/gone.ts (imported from models/mod.ts).",
  );
});

/**
 * deno 2.9's output when one npm import names a version npm does not
 * publish and another npm import resolves: every constraint is reported
 * missing and the error names whichever import deno was resolving.
 */
function unpublishedVersionDocStderr(moduleUrl: string): string {
  return [
    "Warning Failed resolving types. Could not find constraint 'zod@4' in the list of packages.",
    `    at ${moduleUrl}:1:19`,
    "Warning Failed resolving types. Could not find constraint 'ms@99.0.0' in the list of packages.",
    `    at ${moduleUrl}:2:34`,
    `error: Failed resolving 'npm:zod@4' from '${moduleUrl}'.`,
  ].join("\n");
}

Deno.test("scoreExtensionTarball: an unpublished npm version from the audit names a doc failure deno's output cannot", async () => {
  const deps = failingDocDeps(
    (cwd) =>
      unpublishedVersionDocStderr(
        toFileUrl(join(cwd, "models", "mod.ts")).href,
      ),
    [],
  );
  const manifest = makeManifest({ models: ["mod.ts"] });

  const unexplained = await scoreExtensionTarball(
    new Uint8Array(0),
    manifest,
    deps,
  );
  assertEquals(unexplained.docAnalysisError, DOC_FAILURE_FALLBACK);

  const score = await scoreExtensionTarball(
    new Uint8Array(0),
    manifest,
    deps,
    { unpublishedSpecifiers: ["npm:ms@99.0.0"] },
  );
  const error =
    "npm publishes no version matching npm:ms@99.0.0, so deno doc could " +
    "not resolve the extension's npm imports.";
  assertEquals(score.docAnalysisError, error);
  assertStringIncludes(
    score.factors.find((f) => f.id === "symbols-docs")!.remediation ?? "",
    error,
  );
});

Deno.test("scoreExtensionTarball: a doc failure deno's output explains keeps its own description", async () => {
  const deps = failingDocDeps(
    (cwd) => bareZodDocStderr(toFileUrl(join(cwd, "models", "mod.ts")).href),
    [],
  );
  const score = await scoreExtensionTarball(
    new Uint8Array(0),
    makeManifest({ models: ["mod.ts"] }),
    deps,
    { unpublishedSpecifiers: ["npm:ms@99.0.0"] },
  );
  assertEquals(
    score.docAnalysisError,
    'The registry cannot resolve the bare import "zod"; use an explicit npm: or jsr: specifier (npm:zod@4 for zod).',
  );
});

Deno.test("scoreExtensionTarball: docAnalysisError is null when deno doc succeeds", async () => {
  const score = await scoreExtensionTarball(
    new Uint8Array(0),
    makeManifest({ models: ["mod.ts"] }),
    fakeScoreDeps({
      "manifest.yaml": "manifestVersion: 1\nname: '@test/ok'\n",
      "models/mod.ts": "export const x = 1;",
    }),
  );
  assertEquals(score.docAnalysisError, null);
});

Deno.test("scoreExtensionTarball: invalid JSON from a successful deno doc is scored as a doc failure, as the registry scores it", async () => {
  const deps: RubricScoreDeps = {
    ...fakeScoreDeps({
      "manifest.yaml": "manifestVersion: 1\nname: '@test/bad-json'\n",
      "models/mod.ts": "export const x = 1;",
    }),
    runDeno: () =>
      Promise.resolve({ success: true, stdout: "not json", stderr: "" }),
  };
  const score = await scoreExtensionTarball(
    new Uint8Array(0),
    makeManifest({ models: ["mod.ts"] }),
    deps,
  );
  assertEquals(score.docAnalysisError, DOC_FAILURE_FALLBACK);
  assertEquals(
    score.factors.find((f) => f.id === "symbols-docs")?.earnedPoints,
    0,
  );
});

// ── archive rules shared with the registry (swamp-club#3781) ──────────

Deno.test("scoreExtensionTarball: an entry already under its kind directory is analysed where push archives it", async () => {
  // typedDir `models: [models/foo.ts]` resolves to extensions/models/models/foo.ts,
  // which push archives at models/models/foo.ts
  const docArgs: string[][] = [];
  const score = await scoreExtensionTarball(
    new Uint8Array(0),
    makeManifest({ models: ["models/foo.ts"] }),
    fakeScoreDeps({
      "manifest.yaml": "manifestVersion: 1\nname: '@test/nested'\n",
      "models/models/foo.ts": "export const x = 1;",
      "README.md": "# Test",
    }, (args) => {
      if (args.includes("--json")) docArgs.push(args);
    }),
  );
  assertEquals(docArgs.length, 1);
  const entrypoint = docArgs[0][docArgs[0].length - 1];
  assertStringIncludes(
    entrypoint.replaceAll("\\", "/"),
    "/models/models/foo.ts",
  );
  assertEquals(score.docAnalysisError, null);
});

Deno.test("scoreExtensionTarball: deno doc runs with the registry's import allowlist", async () => {
  const docArgs: string[][] = [];
  await scoreExtensionTarball(
    new Uint8Array(0),
    makeManifest({ models: ["mod.ts"] }),
    fakeScoreDeps({
      "manifest.yaml": "manifestVersion: 1\nname: '@test/hosts'\n",
      "models/mod.ts": "export const x = 1;",
    }, (args) => docArgs.push(args)),
  );
  for (const args of docArgs) {
    assert(
      args.some((a) =>
        a.startsWith("--allow-import=") && a.includes("registry.npmjs.org:443")
      ),
    );
  }
});

Deno.test("scoreExtensionTarball: a README or LICENSE counts only under an accepted name, matched exactly", async () => {
  const score = await scoreExtensionTarball(
    new Uint8Array(0),
    makeManifest({ models: ["mod.ts"] }),
    fakeScoreDeps({
      "manifest.yaml": "manifestVersion: 1\nname: '@test/case'\n",
      "models/mod.ts": "export const x = 1;",
      "files/ReadMe.md": "# Test\n\n```ts\nx\n```\n",
      "files/LICENSE.Md": "MIT License",
    }),
  );
  const byId = new Map(score.factors.map((f) => [f.id, f]));
  assertEquals(byId.get("readme-example")?.status, "missing");
  assertEquals(byId.get("license-file")?.status, "missing");
});

Deno.test("composeScore: a description of only whitespace earns nothing", () => {
  for (const description of ["", "   ", "\n\t"]) {
    const score = composeScore(
      factorsAllEarned(),
      makeManifest({ description }),
    );
    assertEquals(
      score.factors.find((f) => f.id === "description")?.status,
      "missing",
    );
  }
});

Deno.test("composeScore: repository-verified is provisional only for a URL naming an owner and a repository", () => {
  for (
    const [repository, status] of [
      ["https://github.com/example/test", "provisional"],
      ["https://gitlab.com/group/sub/test/-/tree/main", "provisional"],
      ["https://github.com/", "missing"],
      ["https://github.com/example", "missing"],
    ] as const
  ) {
    const score = composeScore(
      factorsAllEarned(),
      makeManifest({ repository }),
    );
    assertEquals(
      score.factors.find((f) => f.id === "repository-verified")?.status,
      status,
      repository,
    );
  }
});

// ── isolated deno doc (swamp-club#3781) ───────────────────────────────

Deno.test("scoreExtensionTarball: an isolated run gives deno doc an empty cache of its own and removes it", async () => {
  const dirs: (string | undefined)[] = [];
  let emptyWhenUsed = true;
  const deps: RubricScoreDeps = {
    ...fakeScoreDeps({
      "manifest.yaml": "manifestVersion: 1\nname: '@test/isolated'\n",
      "models/mod.ts": "export const x = 1;",
    }),
    isolated: true,
  };
  const run = deps.runDeno;
  deps.runDeno = async (args, cwd, denoDir) => {
    dirs.push(denoDir);
    if (denoDir !== undefined) {
      for await (const _ of Deno.readDir(denoDir)) emptyWhenUsed = false;
    }
    return await run(args, cwd, denoDir);
  };
  await scoreExtensionTarball(
    new Uint8Array(0),
    makeManifest({ models: ["mod.ts"] }),
    deps,
  );
  assertEquals(dirs.length, 2);
  assert(dirs[0] !== undefined && dirs[0] === dirs[1]);
  assert(emptyWhenUsed);
  let exists = true;
  try {
    await Deno.stat(dirs[0]!);
  } catch {
    exists = false;
  }
  assertEquals(exists, false);
});

Deno.test("scoreExtensionTarball: a default run keeps the usual deno cache", async () => {
  const dirs: (string | undefined)[] = [];
  await scoreExtensionTarball(
    new Uint8Array(0),
    makeManifest({ models: ["mod.ts"] }),
    {
      ...fakeScoreDeps({
        "manifest.yaml": "manifestVersion: 1\nname: '@test/cached'\n",
        "models/mod.ts": "export const x = 1;",
      }),
      runDeno: (_args, _cwd, denoDir) => {
        dirs.push(denoDir);
        return Promise.resolve({
          success: true,
          stdout: '{"version":1,"nodes":{}}',
          stderr: "",
        });
      },
    },
  );
  assertEquals(dirs, [undefined, undefined]);
});

Deno.test("isolatedDenoEnv: keeps what deno needs to run and drops registry credentials", () => {
  const env = isolatedDenoEnv({
    PATH: "/usr/bin",
    HOME: "/home/u",
    SystemRoot: "C:\\Windows",
    HTTPS_PROXY: "http://proxy:3128",
    DENO_AUTH_TOKENS: "secret@npm.example.com",
    NPM_CONFIG_REGISTRY: "https://npm.example.com",
    NPM_TOKEN: "t",
    DENO_DIR: "/home/u/.cache/deno",
  }, "/tmp/empty");
  assertEquals(env, {
    PATH: "/usr/bin",
    HOME: "/home/u",
    SystemRoot: "C:\\Windows",
    HTTPS_PROXY: "http://proxy:3128",
    DENO_DIR: "/tmp/empty",
    NO_COLOR: "1",
  });
});
