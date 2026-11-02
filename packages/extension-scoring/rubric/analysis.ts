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

import { stripAnsi } from "../text.ts";

export const SLOW_TYPE_CODES: ReadonlySet<string> = new Set([
  "missing-return-type",
  "missing-explicit-type",
  "private-type-ref",
  "unsupported-ambient-module",
  "unsupported-complex-reference",
  "unsupported-default-export-expr",
  "unsupported-destructuring",
  "unsupported-global-module",
  "unsupported-require",
  "unsupported-ts-export-assignment",
  "unsupported-ts-instantiation-expression",
  "unsupported-ts-namespace-export",
  "unsupported-using-stmt",
]);

export function hasFencedCodeBlock(md: string): boolean {
  return /^```[\w-]*\s*\n[\s\S]*?\n```/m.test(md);
}

export function countFencedCodeBlocks(md: string): number {
  const matches = md.match(/^```[\w-]*\s*\n[\s\S]*?\n```/gm);
  return matches ? matches.length : 0;
}

/**
 * deno doc --lint exits 0 even with errors printed, so the caller must not rely
 * on exit status; this count is the source of truth
 */
export function countSlowTypeDiagnostics(rawLintOutput: string): number {
  const plain = stripAnsi(rawLintOutput);
  const codes = [...plain.matchAll(/error\[([a-z-]+)\]/g)].map((m) => m[1]);
  let count = 0;
  for (const code of codes) {
    if (SLOW_TYPE_CODES.has(code)) count++;
  }
  return count;
}

export interface DocNode {
  module_doc?: { doc?: string };
  symbols?: Array<{
    name: string;
    declarations?: Array<{
      declarationKind: string;
      jsDoc?: { doc?: string };
      kind: string;
    }>;
  }>;
}

export interface DocOutput {
  version: number;
  nodes: Record<string, DocNode>;
}

/**
 * Module-level doc check for a single entrypoint. The entrypointUrl is
 * a `file://` URL — that's how `deno doc` keys its output nodes.
 */
export function hasModuleDoc(doc: DocOutput, entrypointUrl: string): boolean {
  const node = doc.nodes[entrypointUrl];
  return !!(node?.module_doc?.doc && node.module_doc.doc.trim());
}

export function countExports(
  doc: DocOutput,
  entrypointUrl: string,
): { total: number; documented: number } {
  const node = doc.nodes[entrypointUrl];
  let total = 0;
  let documented = 0;
  for (const sym of node?.symbols ?? []) {
    for (const d of sym.declarations ?? []) {
      if (d.declarationKind !== "export") continue;
      total++;
      if (d.jsDoc?.doc?.trim()) documented++;
    }
  }
  return { total, documented };
}

export interface AnalysisFactors {
  hasReadme: boolean;
  hasReadmeExamples: boolean;
  allEntrypointsDocs: boolean;
  percentageDocumentedSymbols: number;
  allFastCheck: boolean;
  readmeLength: number | null;
  readmeCodeBlockCount: number | null;
  hasLicenseFile: boolean;
}

export function computeAnalysisFactors(input: {
  entrypointUrls: string[];
  readme: string | null;
  hasLicenseFile: boolean;
  doc: DocOutput;
  rawLintOutput: string;
  docFailed?: boolean;
}): AnalysisFactors {
  const { entrypointUrls, readme, hasLicenseFile, doc, rawLintOutput } = input;
  const docFailed = input.docFailed === true;

  const moduleDocs = entrypointUrls.map((ep) => ({
    ep,
    hasDoc: hasModuleDoc(doc, ep),
  }));

  let totalSymbols = 0;
  let documentedSymbols = 0;
  for (const ep of entrypointUrls) {
    const { total, documented } = countExports(doc, ep);
    totalSymbols += total;
    documentedSymbols += documented;
  }

  const hasReadmeFile = readme !== null;
  const hasReadme = hasReadmeFile || moduleDocs.some((m) => m.hasDoc);
  const hasReadmeExamples = readme ? hasFencedCodeBlock(readme) : false;
  const allEntrypointsDocs = moduleDocs.length > 0 &&
    moduleDocs.every((m) => m.hasDoc);
  // an unanalysed source documents nothing; the empty doc would otherwise read as 100%
  const ratio = docFailed
    ? 0
    : totalSymbols === 0
    ? 1
    : documentedSymbols / totalSymbols;
  const percentageDocumentedSymbols = Number(ratio.toFixed(4));
  const allFastCheck = countSlowTypeDiagnostics(rawLintOutput) === 0;

  const readmeLength = readme === null ? null : readme.length;
  const readmeCodeBlockCount = readme === null
    ? null
    : countFencedCodeBlocks(readme);

  return {
    hasReadme,
    hasReadmeExamples,
    allEntrypointsDocs,
    percentageDocumentedSymbols,
    allFastCheck,
    readmeLength,
    readmeCodeBlockCount,
    hasLicenseFile,
  };
}
