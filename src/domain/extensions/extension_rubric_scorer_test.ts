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
  repositoryLikelyVerifiable,
  RUBRIC_VERSION,
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
    repository: "https://github.com/example/test",
    paths: { base: "typedDir" },
    workflows: [],
    models: [],
    vaults: [],
    drivers: [],
    datastores: [],
    reports: [],
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
  };
}

Deno.test("composeScore: perfect extension earns 14/14 (100%)", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  assertEquals(score.earnedPoints, 14);
  assertEquals(score.maxEarnablePoints, 14);
  assertEquals(score.percentage, 100);
  assertEquals(score.allPassed, true);
});

Deno.test("composeScore: has-readme is worth 2 points", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  const factor = score.factors.find((f) => f.id === "has-readme")!;
  assertEquals(factor.maxPoints, 2);
});

Deno.test("composeScore: repository-verified is worth 2 points", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  const factor = score.factors.find((f) => f.id === "repository-verified")!;
  assertEquals(factor.maxPoints, 2);
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
    .filter((f) => f.status !== "earned")
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

Deno.test("composeScore: missing LICENSE file misses has-license", () => {
  const score = composeScore(
    { ...factorsAllEarned(), hasLicenseFile: false },
    makeManifest(),
  );
  const f = score.factors.find((f) => f.id === "has-license")!;
  assertEquals(f.status, "missing");
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

Deno.test("composeScore: has-license remediation names the archive path and bare-basename rule", () => {
  const score = composeScore(
    { ...factorsAllEarned(), hasLicenseFile: false },
    makeManifest(),
  );
  const f = score.factors.find((f) => f.id === "has-license")!;
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
    "repository-verified",
    "dependency-trust",
  ]);
});

Deno.test("composeScore: percentage floors (not rounds)", () => {
  // 13/14 = 92.86 → floor = 92
  const score = composeScore(
    { ...factorsAllEarned(), hasLicenseFile: false },
    makeManifest(),
  );
  assertEquals(score.earnedPoints, 13);
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
    },
    makeManifest({
      description: "",
      repository: undefined,
      platforms: [],
    }),
  );
  // Universal platforms earns 2 points only; dependency-trust fails.
  assertEquals(score.earnedPoints, 2);
  assertEquals(score.percentage, Math.floor((2 * 100) / 14));
  assertEquals(score.rubricVersion, 3);
  assertEquals(score.factors.length, 10);
  const byId = new Map(score.factors.map((f) => [f.id, f]));
  assertEquals(byId.get("platforms")?.status, "earned");
  assertEquals(byId.get("platforms")?.earnedPoints, 2);
  assertEquals(byId.get("repository-verified")?.status, "missing");
  // verified-by-swamp is not a factor in the rubric (badge only)
  assertEquals(byId.get("verified-by-swamp"), undefined);
  // entrypoints-docs was dropped at v2
  assertEquals(byId.get("entrypoints-docs"), undefined);
});

Deno.test("[parity] composeScore: perfect score hits 100% without any verification badge", () => {
  const score = composeScore(factorsAllEarned(), makeManifest());
  // 14/14
  assertEquals(score.earnedPoints, 14);
  assertEquals(score.percentage, 100);
  assertEquals(score.allPassed, true);
});

Deno.test("[parity] composeScore: percentage floors (13/14 → 92)", () => {
  const score = composeScore(
    { ...factorsAllEarned(), hasLicenseFile: false },
    makeManifest(),
  );
  assertEquals(score.earnedPoints, 13);
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
