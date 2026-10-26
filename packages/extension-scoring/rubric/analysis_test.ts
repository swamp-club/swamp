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
import { assert, assertEquals } from "@std/assert";
import {
  computeAnalysisFactors,
  countExports,
  countFencedCodeBlocks,
  countSlowTypeDiagnostics,
  type DocOutput,
  hasFencedCodeBlock,
  hasModuleDoc,
  SLOW_TYPE_CODES,
} from "./analysis.ts";
import { stripAnsi } from "../text.ts";

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

// ═══════════════════════════════════════════════════════════════════════
// Cases ported from swamp-club's tests/domain/analysis-factors_test.ts,
// written when the registry kept its own copy of these functions. They
// stay as the record of the behaviour both sides relied on.
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
