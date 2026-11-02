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
 * The per-version analysis factors: what the README and `deno doc` output
 * say about one version of an extension. Pure; the caller runs `deno doc`
 * and reads the README.
 */

import { stripAnsi } from "../text.ts";

/**
 * Slow-type diagnostic codes emitted by `deno doc --lint`. When any of
 * these appear the package fails the `fast-check` analysis factor.
 */
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

/** True if the markdown text contains a fenced code block. */
export function hasFencedCodeBlock(md: string): boolean {
  return /^```[\w-]*\s*\n[\s\S]*?\n```/m.test(md);
}

/** Count fenced code blocks; non-overlapping, same regex as the boolean check. */
export function countFencedCodeBlocks(md: string): number {
  const matches = md.match(/^```[\w-]*\s*\n[\s\S]*?\n```/gm);
  return matches ? matches.length : 0;
}

/**
 * Parse the combined stdout+stderr from `deno doc --lint`, strip ANSI,
 * and count how many diagnostics belong to {@link SLOW_TYPE_CODES}.
 * `deno doc --lint` exits 0 even with errors printed, so the caller
 * does NOT rely on exit status — this is the source of truth.
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

/** A single node in `deno doc --json` output. */
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

/** Full `deno doc --json` shape. */
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

/**
 * Count `(totalExports, documentedExports)` for one entrypoint.
 * An exported declaration is any symbol with `declarationKind === "export"`.
 * Overloaded symbols declare multiple declarations — each counts separately.
 */
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

/** What the README and `deno doc` say about one version. */
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

/** Compose the per-version analysis factors. Pure — no I/O. */
export function computeAnalysisFactors(input: {
  entrypointUrls: string[];
  readme: string | null;
  hasLicenseFile: boolean;
  doc: DocOutput;
  rawLintOutput: string;
  /** `deno doc` could not analyse the source, so `doc` is empty. */
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
