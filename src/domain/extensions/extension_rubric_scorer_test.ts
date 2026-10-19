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
import { join } from "@std/path";
import type { ExtensionManifest } from "./extension_manifest.ts";
import {
  composeScore,
  computeAnalysisFactors,
  countExports,
  countFencedCodeBlocks,
  countSlowTypeDiagnostics,
  type DocOutput,
  hasFencedCodeBlock,
  hasModuleDoc,
  predictPublishedPrivate,
  type PrivateSourceStanding,
  repositoryLikelyVerifiable,
  RUBRIC_VERSION,
  type RubricScoreDeps,
  scoreExtensionTarball,
  SLOW_TYPE_CODES,
  stripAnsi,
} from "./extension_rubric_scorer.ts";

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

// ── Pure helper tests (mirror server analysis-factors_test.ts) ─────────

Deno.test("RUBRIC_VERSION is 3 (matches swamp-club)", () => {
  assertEquals(RUBRIC_VERSION, 3);
});

Deno.test("SLOW_TYPE_CODES contains expected codes", () => {
  assert(SLOW_TYPE_CODES.has("missing-return-type"));
  assert(SLOW_TYPE_CODES.has("private-type-ref"));
  assert(SLOW_TYPE_CODES.has("unsupported-default-export-expr"));
  assertEquals(SLOW_TYPE_CODES.size, 13);
});

Deno.test("stripAnsi removes colour codes", () => {
  const input = "\x1b[31merror\x1b[0m";
  assertEquals(stripAnsi(input), "error");
});

Deno.test("hasFencedCodeBlock: true when markdown has a fence", () => {
  assertEquals(hasFencedCodeBlock("# hi\n```ts\nconsole.log(1)\n```\n"), true);
});

Deno.test("hasFencedCodeBlock: false when no fence", () => {
  assertEquals(hasFencedCodeBlock("# hi\njust text\n"), false);
});

Deno.test("countFencedCodeBlocks: counts complete fences", () => {
  const md = "# hi\n```\nA\n```\n\n```ts\nB\n```\n";
  assertEquals(countFencedCodeBlocks(md), 2);
});

Deno.test("countFencedCodeBlocks: 0 when empty", () => {
  assertEquals(countFencedCodeBlocks(""), 0);
});

Deno.test("countSlowTypeDiagnostics: counts listed slow-type codes", () => {
  const lintOutput =
    "error[missing-return-type]: bad\nerror[private-type-ref]: bad\nerror[something-else]: ok\n";
  assertEquals(countSlowTypeDiagnostics(lintOutput), 2);
});

Deno.test("countSlowTypeDiagnostics: returns 0 when no diagnostics", () => {
  assertEquals(countSlowTypeDiagnostics(""), 0);
});

Deno.test("countSlowTypeDiagnostics: strips ANSI before matching", () => {
  const withAnsi = "\x1b[31merror[missing-return-type]\x1b[0m: bad";
  assertEquals(countSlowTypeDiagnostics(withAnsi), 1);
});

Deno.test("hasModuleDoc: true when node has trimmed module_doc", () => {
  const doc: DocOutput = {
    version: 1,
    nodes: {
      "file:///a.ts": { module_doc: { doc: "  docs  " } },
    },
  };
  assertEquals(hasModuleDoc(doc, "file:///a.ts"), true);
});

Deno.test("hasModuleDoc: false when module_doc is empty string", () => {
  const doc: DocOutput = {
    version: 1,
    nodes: { "file:///a.ts": { module_doc: { doc: "   " } } },
  };
  assertEquals(hasModuleDoc(doc, "file:///a.ts"), false);
});

Deno.test("hasModuleDoc: false when node missing", () => {
  const doc: DocOutput = { version: 1, nodes: {} };
  assertEquals(hasModuleDoc(doc, "file:///a.ts"), false);
});

Deno.test("countExports: counts exported declarations with jsDoc", () => {
  const doc: DocOutput = {
    version: 1,
    nodes: {
      "file:///a.ts": {
        symbols: [
          {
            name: "a",
            declarations: [
              {
                declarationKind: "export",
                kind: "function",
                jsDoc: { doc: "x" },
              },
            ],
          },
          {
            name: "b",
            declarations: [{ declarationKind: "export", kind: "function" }],
          },
          {
            name: "internal",
            declarations: [
              { declarationKind: "declare", kind: "function" },
            ],
          },
        ],
      },
    },
  };
  const r = countExports(doc, "file:///a.ts");
  assertEquals(r.total, 2);
  assertEquals(r.documented, 1);
});

Deno.test("countExports: overloaded declarations each count separately", () => {
  const doc: DocOutput = {
    version: 1,
    nodes: {
      "file:///a.ts": {
        symbols: [
          {
            name: "overloaded",
            declarations: [
              {
                declarationKind: "export",
                kind: "function",
                jsDoc: { doc: "x" },
              },
              { declarationKind: "export", kind: "function" },
            ],
          },
        ],
      },
    },
  };
  const r = countExports(doc, "file:///a.ts");
  assertEquals(r.total, 2);
  assertEquals(r.documented, 1);
});

// ── computeAnalysisFactors ─────────────────────────────────────────────

Deno.test("computeAnalysisFactors: all clean", () => {
  const doc: DocOutput = {
    version: 1,
    nodes: {
      "file:///a.ts": {
        module_doc: { doc: "top-level" },
        symbols: [
          {
            name: "a",
            declarations: [
              {
                declarationKind: "export",
                kind: "function",
                jsDoc: { doc: "x" },
              },
            ],
          },
        ],
      },
    },
  };
  const f = computeAnalysisFactors({
    entrypointUrls: ["file:///a.ts"],
    readme: "# title\n\n" + "abc ".repeat(200) +
      "\n\n```ts\nusage\n```\n\n```ts\nmore\n```\n",
    hasLicenseFile: true,
    doc,
    rawLintOutput: "",
  });
  assertEquals(f.hasReadme, true);
  assertEquals(f.hasReadmeExamples, true);
  assertEquals(f.allEntrypointsDocs, true);
  assertEquals(f.percentageDocumentedSymbols, 1);
  assertEquals(f.allFastCheck, true);
  assertEquals(f.hasLicenseFile, true);
  assert(f.readmeLength !== null && f.readmeLength > 500);
  assertEquals(f.readmeCodeBlockCount, 2);
});

Deno.test("computeAnalysisFactors: hasReadme is true when only module doc present", () => {
  const doc: DocOutput = {
    version: 1,
    nodes: {
      "file:///a.ts": { module_doc: { doc: "module-level" } },
    },
  };
  const f = computeAnalysisFactors({
    entrypointUrls: ["file:///a.ts"],
    readme: null,
    hasLicenseFile: false,
    doc,
    rawLintOutput: "",
  });
  assertEquals(f.hasReadme, true);
  assertEquals(f.hasReadmeExamples, false);
  assertEquals(f.readmeLength, null);
});

Deno.test("computeAnalysisFactors: zero entrypoints = percentage 1 (vacuous)", () => {
  const f = computeAnalysisFactors({
    entrypointUrls: [],
    readme: "# hi",
    hasLicenseFile: false,
    doc: { version: 1, nodes: {} },
    rawLintOutput: "",
  });
  assertEquals(f.percentageDocumentedSymbols, 1);
  assertEquals(f.allEntrypointsDocs, false); // empty entrypoints → false by server convention
});

Deno.test("computeAnalysisFactors: slow-type diagnostic fails fast-check", () => {
  const f = computeAnalysisFactors({
    entrypointUrls: [],
    readme: null,
    hasLicenseFile: false,
    doc: { version: 1, nodes: {} },
    rawLintOutput: "error[missing-return-type]: bad",
  });
  assertEquals(f.allFastCheck, false);
});

Deno.test("computeAnalysisFactors: percentage rounds to 4 decimal places", () => {
  const doc: DocOutput = {
    version: 1,
    nodes: {
      "file:///a.ts": {
        symbols: [
          {
            name: "a",
            declarations: [
              {
                declarationKind: "export",
                kind: "function",
                jsDoc: { doc: "x" },
              },
            ],
          },
          {
            name: "b",
            declarations: [{ declarationKind: "export", kind: "function" }],
          },
          {
            name: "c",
            declarations: [{ declarationKind: "export", kind: "function" }],
          },
        ],
      },
    },
  };
  const f = computeAnalysisFactors({
    entrypointUrls: ["file:///a.ts"],
    readme: null,
    hasLicenseFile: false,
    doc,
    rawLintOutput: "",
  });
  assertEquals(f.percentageDocumentedSymbols, 0.3333);
});

// ── repositoryLikelyVerifiable ─────────────────────────────────────────

Deno.test("repositoryLikelyVerifiable: true for https github.com", () => {
  assertEquals(
    repositoryLikelyVerifiable("https://github.com/x/y"),
    true,
  );
});

Deno.test("repositoryLikelyVerifiable: true for https gitlab.com", () => {
  assertEquals(
    repositoryLikelyVerifiable("https://gitlab.com/x/y"),
    true,
  );
});

Deno.test("repositoryLikelyVerifiable: true for https codeberg.org", () => {
  assertEquals(
    repositoryLikelyVerifiable("https://codeberg.org/x/y"),
    true,
  );
});

Deno.test("repositoryLikelyVerifiable: true for https bitbucket.org", () => {
  assertEquals(
    repositoryLikelyVerifiable("https://bitbucket.org/x/y"),
    true,
  );
});

Deno.test("repositoryLikelyVerifiable: false for http (not https)", () => {
  assertEquals(
    repositoryLikelyVerifiable("http://github.com/x/y"),
    false,
  );
});

Deno.test("repositoryLikelyVerifiable: false for self-hosted host", () => {
  assertEquals(
    repositoryLikelyVerifiable("https://git.company.com/x/y"),
    false,
  );
});

Deno.test("repositoryLikelyVerifiable: false for missing URL", () => {
  assertEquals(repositoryLikelyVerifiable(undefined), false);
});

Deno.test("repositoryLikelyVerifiable: false for malformed URL", () => {
  assertEquals(repositoryLikelyVerifiable("not a url"), false);
});

// ── composeScore (mirror server score.ts v2) ───────────────────────────

function factorsAllEarned(): Parameters<typeof composeScore>[0] {
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
  };
}

Deno.test("composeScore: perfect extension earns 13/13 client-confirmed (100%)", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  assertEquals(score.earnedPoints, 13);
  assertEquals(score.maxEarnablePoints, 15);
  assertEquals(score.maxClientEarnablePoints, 13);
  assertEquals(score.provisionalPoints, 2);
  assertEquals(score.percentage, 100);
  assertEquals(score.allPassed, true);
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
    "description",
    "platforms",
    "has-license",
    "license-file",
    "repository-verified",
    "dependency-trust",
  ]);
});

Deno.test("composeScore: percentage floors (not rounds)", () => {
  // 12/13 client-earnable = 92.3 → floor = 92
  const score = composeScore(
    { ...factorsAllEarned(), hasLicenseFile: false },
    makeManifest(),
  );
  assertEquals(score.earnedPoints, 12);
  assertEquals(score.percentage, 92);
});

// ═══════════════════════════════════════════════════════════════════════
// Parity tests with swamp-club server scorer.
//
// These are ports of the authoritative test suite at
// swamp-club/tests/domain/analysis-factors_test.ts and the core cases
// from swamp-club/tests/domain/scorecard_test.ts. They exist so that if
// our mirrored logic ever drifts from the server's — even by a byte —
// the drift is caught here before it ships. Do NOT remove cases when
// pruning; if something looks redundant, check the server file first.
// ═══════════════════════════════════════════════════════════════════════

// --- analysis-factors_test.ts ports ------------------------------------

Deno.test("[parity] hasFencedCodeBlock - triple-backtick block matches", () => {
  const md = "# Title\n\n```ts\nconst x = 1;\n```\n";
  assertEquals(hasFencedCodeBlock(md), true);
});

Deno.test("[parity] hasFencedCodeBlock - fenced block with language tag", () => {
  const md = "preamble\n\n```yaml\nkey: value\n```\n";
  assertEquals(hasFencedCodeBlock(md), true);
});

Deno.test("[parity] hasFencedCodeBlock - no fence returns false", () => {
  const md = "# Title\n\nSome prose.\n\nMore prose.";
  assertEquals(hasFencedCodeBlock(md), false);
});

Deno.test("[parity] hasFencedCodeBlock - inline backticks are not a block", () => {
  const md = "Use `foo()` to do it.";
  assertEquals(hasFencedCodeBlock(md), false);
});

Deno.test("[parity] countFencedCodeBlocks - counts multiple blocks", () => {
  const md = "# Title\n\n```ts\nconst x = 1;\n```\n\nSome prose.\n\n" +
    "```yaml\nfoo: bar\n```\n";
  assertEquals(countFencedCodeBlocks(md), 2);
});

Deno.test("[parity] countFencedCodeBlocks - returns 0 when there are no fences", () => {
  assertEquals(countFencedCodeBlocks("# Plain markdown"), 0);
});

Deno.test("[parity] countFencedCodeBlocks - single block counts as 1", () => {
  const md = "```ts\nconst x = 1;\n```\n";
  assertEquals(countFencedCodeBlocks(md), 1);
});

Deno.test("[parity] countSlowTypeDiagnostics - matches documented codes", () => {
  const out = "error[missing-return-type] at foo.ts:1:1\n" +
    "error[missing-explicit-type] at bar.ts:2:2";
  assertEquals(countSlowTypeDiagnostics(out), 2);
});

Deno.test("[parity] countSlowTypeDiagnostics - strips ANSI before matching", () => {
  const out = "\x1b[31merror[missing-return-type]\x1b[0m at foo.ts:1:1";
  assertEquals(countSlowTypeDiagnostics(out), 1);
});

Deno.test("[parity] countSlowTypeDiagnostics - ignores non-slow-type codes", () => {
  const out = "error[missing-jsdoc] at foo.ts:1:1";
  assertEquals(countSlowTypeDiagnostics(out), 0);
});

Deno.test("[parity] countSlowTypeDiagnostics - empty output returns 0", () => {
  assertEquals(countSlowTypeDiagnostics(""), 0);
});

function parityMakeDoc(
  fn: () => {
    module_doc?: { doc?: string };
    symbols?: DocOutput["nodes"][string]["symbols"];
  },
): DocOutput {
  return {
    version: 1,
    nodes: { "file:///tmp/a.ts": fn() },
  };
}

Deno.test("[parity] hasModuleDoc - true when module_doc.doc is non-empty", () => {
  const doc = parityMakeDoc(() => ({ module_doc: { doc: "Hello" } }));
  assertEquals(hasModuleDoc(doc, "file:///tmp/a.ts"), true);
});

Deno.test("[parity] hasModuleDoc - false when doc is whitespace", () => {
  const doc = parityMakeDoc(() => ({ module_doc: { doc: "   " } }));
  assertEquals(hasModuleDoc(doc, "file:///tmp/a.ts"), false);
});

Deno.test("[parity] hasModuleDoc - false when entrypoint missing from map", () => {
  const doc = parityMakeDoc(() => ({}));
  assertEquals(hasModuleDoc(doc, "file:///tmp/other.ts"), false);
});

Deno.test("[parity] countExports - counts declared exports, optionally documented", () => {
  const doc = parityMakeDoc(() => ({
    symbols: [
      {
        name: "A",
        declarations: [
          {
            declarationKind: "export",
            kind: "function",
            jsDoc: { doc: "Documented" },
          },
          { declarationKind: "export", kind: "function" },
        ],
      },
      {
        name: "B",
        declarations: [{ declarationKind: "private", kind: "function" }],
      },
    ],
  }));
  const result = countExports(doc, "file:///tmp/a.ts");
  assertEquals(result.total, 2);
  assertEquals(result.documented, 1);
});

Deno.test(
  "[parity] computeAnalysisFactors - README present with fence + all docs",
  () => {
    const doc: DocOutput = {
      version: 1,
      nodes: {
        "file:///tmp/a.ts": {
          module_doc: { doc: "module doc" },
          symbols: [
            {
              name: "x",
              declarations: [
                {
                  declarationKind: "export",
                  kind: "function",
                  jsDoc: { doc: "docs" },
                },
              ],
            },
          ],
        },
      },
    };
    const readme = "# Title\n\n```ts\nfoo();\n```\n";
    const factors = computeAnalysisFactors({
      entrypointUrls: ["file:///tmp/a.ts"],
      readme,
      doc,
      hasLicenseFile: false,
      rawLintOutput: "",
    });
    assertEquals(factors, {
      hasReadme: true,
      hasReadmeExamples: true,
      allEntrypointsDocs: true,
      percentageDocumentedSymbols: 1,
      allFastCheck: true,
      readmeLength: readme.length,
      readmeCodeBlockCount: 1,
      hasLicenseFile: false,
      dependencyTrustPassed: false,
      dependencyTrustBlockerCount: 0,
      dependencyNotAuditedCount: 0,
    });
  },
);

Deno.test(
  "[parity] computeAnalysisFactors - no README but module doc on every entrypoint",
  () => {
    const doc: DocOutput = {
      version: 1,
      nodes: {
        "file:///tmp/a.ts": {
          module_doc: { doc: "fallback doc" },
          symbols: [],
        },
      },
    };
    const factors = computeAnalysisFactors({
      entrypointUrls: ["file:///tmp/a.ts"],
      readme: null,
      doc,
      hasLicenseFile: false,
      rawLintOutput: "",
    });
    assertEquals(factors.hasReadme, true);
    assertEquals(factors.hasReadmeExamples, false);
    assertEquals(factors.allEntrypointsDocs, true);
    assertEquals(factors.readmeLength, null);
    assertEquals(factors.readmeCodeBlockCount, null);
  },
);

Deno.test(
  "[parity] computeAnalysisFactors - empty entrypoints give vacuous 1.0 ratio",
  () => {
    const factors = computeAnalysisFactors({
      entrypointUrls: [],
      readme: "hello",
      doc: { version: 1, nodes: {} },
      hasLicenseFile: false,
      rawLintOutput: "",
    });
    assertEquals(factors.allEntrypointsDocs, false);
    assertEquals(factors.percentageDocumentedSymbols, 1);
    assertEquals(factors.allFastCheck, true);
  },
);

Deno.test(
  "[parity] computeAnalysisFactors - partial docs produce fractional ratio (0.3333)",
  () => {
    const doc: DocOutput = {
      version: 1,
      nodes: {
        "file:///tmp/a.ts": {
          module_doc: { doc: "hi" },
          symbols: [
            {
              name: "x",
              declarations: [
                {
                  declarationKind: "export",
                  kind: "function",
                  jsDoc: { doc: "docs" },
                },
              ],
            },
            {
              name: "y",
              declarations: [{ declarationKind: "export", kind: "function" }],
            },
            {
              name: "z",
              declarations: [{ declarationKind: "export", kind: "function" }],
            },
          ],
        },
      },
    };
    const factors = computeAnalysisFactors({
      entrypointUrls: ["file:///tmp/a.ts"],
      readme: "plain",
      doc,
      hasLicenseFile: false,
      rawLintOutput: "",
    });
    assertEquals(factors.percentageDocumentedSymbols, 0.3333);
  },
);

Deno.test(
  "[parity] computeAnalysisFactors - slow-type diagnostic fails allFastCheck",
  () => {
    const factors = computeAnalysisFactors({
      entrypointUrls: [],
      readme: "hi",
      doc: { version: 1, nodes: {} },
      hasLicenseFile: false,
      rawLintOutput: "error[missing-return-type] at foo.ts:1:1",
    });
    assertEquals(factors.allFastCheck, false);
  },
);

Deno.test(
  "[parity] computeAnalysisFactors - missing-jsdoc is NOT a slow type",
  () => {
    const factors = computeAnalysisFactors({
      entrypointUrls: [],
      readme: "hi",
      doc: { version: 1, nodes: {} },
      hasLicenseFile: false,
      rawLintOutput: "error[missing-jsdoc] at foo.ts:1:1",
    });
    assertEquals(factors.allFastCheck, true);
  },
);

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
  assertEquals(score.percentage, Math.floor((3 * 100) / 15));
  assertEquals(score.rubricVersion, 3);
  assertEquals(score.factors.length, 11);
  const byId = new Map(score.factors.map((f) => [f.id, f]));
  assertEquals(byId.get("platforms")?.status, "earned");
  assertEquals(byId.get("platforms")?.earnedPoints, 2);
  assertEquals(byId.get("repository-verified")?.status, "missing");
  // verified-by-swamp is not a factor in the rubric (badge only)
  assertEquals(byId.get("verified-by-swamp"), undefined);
  // entrypoints-docs was dropped at v2
  assertEquals(byId.get("entrypoints-docs"), undefined);
});

Deno.test("[parity] composeScore: perfect score hits 100% with repository-verified provisional", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  // 13/13 client-earnable (repo-verified is provisional, excluded from total)
  assertEquals(score.earnedPoints, 13);
  assertEquals(score.maxClientEarnablePoints, 13);
  assertEquals(score.provisionalPoints, 2);
  assertEquals(score.percentage, 100);
  assertEquals(score.allPassed, true);
});

Deno.test("[parity] composeScore: percentage floors (12/13 → 92)", () => {
  const score = composeScore(
    { ...factorsAllEarned(), hasLicenseFile: false },
    makeManifest(),
  );
  assertEquals(score.earnedPoints, 12);
  assertEquals(score.percentage, 92);
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
    { ...factorsAllEarned(), dependencyNotAuditedCount: 2 },
    makeManifest(),
  );
  const factor = score.factors.find((f) => f.id === "dependency-trust")!;
  assertEquals(factor.earnedPoints, 0);
  assertEquals(factor.status, "missing");
  assertStringIncludes(
    factor.remediation ?? "",
    "2 dependency(ies) not audited",
  );
  assertStringIncludes(
    factor.remediation ?? "",
    "Re-run when all three are reachable",
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

// ── scoreExtensionTarball: import map merging ────────────────────────

function fakeExtractTarball(
  files: Record<string, string>,
): RubricScoreDeps["extractTarball"] {
  return async (_source: ReadableStream<Uint8Array>, destDir: string) => {
    const extDir = join(destDir, "extension");
    await Deno.mkdir(join(extDir, "models"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await Deno.writeTextFile(join(extDir, name), content);
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

Deno.test("scoreExtensionTarball: merges importMap into controlled deno.json", async () => {
  let capturedConfig: Record<string, unknown> | undefined;
  const deps = fakeScoreDeps(
    {
      "manifest.yaml": "manifestVersion: 1\nname: '@test/bare'\n",
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
  const manifest = makeManifest({
    models: ["mod.ts"],
  });
  const importMap = { "zod": "npm:zod@4" };

  const score = await scoreExtensionTarball(tarball, manifest, deps, {
    importMap,
  });

  assert(capturedConfig !== undefined, "runDeno should have been called");
  assertEquals(capturedConfig!.nodeModulesDir, "auto");
  assertEquals(capturedConfig!.imports, { "zod": "npm:zod@4" });
  assert(score.earnedPoints >= 0);
});

Deno.test("scoreExtensionTarball: omits imports when importMap is undefined", async () => {
  let capturedConfig: Record<string, unknown> | undefined;
  const deps = fakeScoreDeps(
    {
      "manifest.yaml": "manifestVersion: 1\nname: '@test/no-map'\n",
      "models/mod.ts": "export const x = 1;",
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
