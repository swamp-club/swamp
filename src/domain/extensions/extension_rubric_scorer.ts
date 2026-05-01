// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { join, resolve, SEPARATOR } from "@std/path";
import type { ExtensionManifest } from "./extension_manifest.ts";

/**
 * Client-side scorer for the Swamp Club extension quality rubric.
 *
 * Mirrors swamp-club's server-side scorecard pipeline byte-for-byte
 * (`lib/domain/scorecard/analysis-factors.ts` and
 * `lib/domain/scorecard/score.ts` in the swamp-club repo) so local
 * `swamp extension quality` results match the score the registry will
 * compute after publish.
 *
 * Distinct from `extension_quality_checker.ts` in this directory —
 * that module runs `deno fmt` / `deno lint` / dynamic-import checks as
 * part of packaging (bundle safety). This module computes the
 * authoring-quality rubric (README, LICENSE, JSDoc coverage, manifest
 * completeness, repository URL).
 *
 * Pipeline:
 *   1. Extract the pre-built tarball to a temp directory.
 *   2. Strip attacker-controlled config files (matches server's
 *      hermeticity stripping) and write a controlled deno.json so
 *      `deno doc` resolves npm/jsr specifiers consistently.
 *   3. Collect entrypoints from the manifest, prefixing with the
 *      field name the way the server does.
 *   4. Run `deno doc --json` and `deno doc --lint` with CWD at the
 *      extraction root. `--lint` exits 0 regardless of diagnostics;
 *      we parse stdout/stderr for `error[<code>]` patterns.
 *   5. Compute the 5 per-version factors and the 4 per-package
 *      factors + `repository-verified`, then compose a rubric v2
 *      score.
 */

/** Schema version. Matches swamp-club's RUBRIC_VERSION. */
export const RUBRIC_VERSION = 2;

/**
 * Slow-type diagnostic codes emitted by `deno doc --lint`. When any of
 * these appear the package fails the `fast-check` factor. Mirrors
 * swamp-club's SLOW_TYPE_CODES set exactly.
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

/** Hosts recognised as publicly-verifiable for `repository-verified`. */
const VERIFIED_REPO_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "gitlab.com",
  "codeberg.org",
  "bitbucket.org",
]);

/** Entrypoint-bearing manifest fields the analyzer runs `deno doc` against. */
const ENTRYPOINT_FIELDS = [
  "models",
  "drivers",
  "vaults",
  "datastores",
  "reports",
] as const;

const RICH_README_MIN_LENGTH = 500;
const RICH_README_MIN_CODE_BLOCKS = 2;
const SYMBOLS_DOCS_FULL_THRESHOLD = 0.8;

// ── Pure helpers (mirror analysis-factors.ts) ──────────────────────────

// deno-lint-ignore no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

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

/** Per-version analysis factors, mirrors server's AnalysisFactors. */
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

/**
 * Compose all per-version factors from subprocess output plus README
 * text. Pure — no I/O, no subprocess calls. Mirrors
 * analysis-factors.ts#computeAnalysisFactors verbatim.
 */
export function computeAnalysisFactors(input: {
  entrypointUrls: string[];
  readme: string | null;
  hasLicenseFile: boolean;
  doc: DocOutput;
  rawLintOutput: string;
}): AnalysisFactors {
  const { entrypointUrls, readme, hasLicenseFile, doc, rawLintOutput } = input;

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
  const ratio = totalSymbols === 0 ? 1 : documentedSymbols / totalSymbols;
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

// ── Score composition (mirror score.ts) ────────────────────────────────

/** Status of one scorecard row. */
export type FactorStatus = "earned" | "partial" | "missing";

/** One row of the scorecard. */
export interface RubricFactor {
  id: string;
  label: string;
  earnedPoints: number;
  maxPoints: number;
  status: FactorStatus;
  remediation?: string;
}

/** Complete rubric score. */
export interface RubricScore {
  rubricVersion: number;
  factors: RubricFactor[];
  earnedPoints: number;
  maxEarnablePoints: number;
  percentage: number;
  allPassed: boolean;
}

/**
 * Structural check for repository verification. The server does an
 * additional HTTP HEAD to confirm the URL is live and public — the CLI
 * reports the structural result optimistically, noting that the final
 * verdict comes from the server after publish. Returns:
 *   true  → URL is HTTPS and on an allowlisted host (will earn the
 *           factor if the repo is public at publish time)
 *   false → URL is missing, malformed, non-HTTPS, or on a host the
 *           server does not accept for verification
 */
export function repositoryLikelyVerifiable(
  repository: string | undefined,
): boolean {
  if (!repository) return false;
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return VERIFIED_REPO_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * Compose a RubricScore from the per-version analysis factors and the
 * manifest. Mirrors score.ts#composeScore but restricted to the
 * signals the CLI can observe (no access to server-side `license`
 * SPDX string or the server's HTTP-HEAD repository verification).
 *
 * `verified-by-swamp` is not in the rubric — it's an editorial badge
 * that does not move the percentage. Provenance is currently gated
 * off on the server and is omitted here for parity.
 */
export function composeScore(
  factors: AnalysisFactors,
  manifest: ExtensionManifest,
): RubricScore {
  const rows: RubricFactor[] = [
    boolRow("has-readme", "Has README or module doc", 2, factors.hasReadme, {
      remediation:
        "Add `README.md` to `additionalFiles:` as a bare basename — the " +
        "entry is copied verbatim to `extension/files/<entry>` in the " +
        "archive, so nested paths like `docs/README.md` won't earn the " +
        "factor. For per-directory layouts (manifest beside README), opt " +
        "in with `paths.base: manifest`. Or add a module-level JSDoc at " +
        "the top of every entrypoint file.",
    }),
    boolRow(
      "readme-example",
      "README has a code example",
      1,
      factors.hasReadmeExamples,
      {
        remediation:
          "Add at least one fenced code block (``` … ```) to README showing usage.",
      },
    ),
    richReadmeRow(factors.readmeLength, factors.readmeCodeBlockCount),
    symbolsRow(factors.percentageDocumentedSymbols),
    boolRow("fast-check", "No slow types", 1, factors.allFastCheck, {
      remediation:
        "Run `deno doc --lint <entrypoint>` — add explicit return types and " +
        "avoid leaking private types in public exports.",
    }),
    boolRow(
      "description",
      "Has description",
      1,
      typeof manifest.description === "string" &&
        manifest.description.trim().length > 0,
      { remediation: "Fill `description:` in manifest.yaml." },
    ),
    boolRow(
      "platforms-one",
      "At least one platform tag (or universal)",
      1,
      manifest.platforms.length === 0 || manifest.platforms.length >= 1,
      {
        remediation:
          "Leave `platforms:` empty (= universal) or add at least one entry.",
      },
    ),
    boolRow(
      "platforms-two",
      "Two or more platform tags (or universal)",
      1,
      manifest.platforms.length === 0 || manifest.platforms.length >= 2,
      {
        remediation:
          "Leave `platforms:` empty (= universal) or add ≥2 entries.",
      },
    ),
    boolRow(
      "has-license",
      "License declared",
      1,
      factors.hasLicenseFile,
      {
        remediation:
          "Add a LICENSE / LICENSE.md / LICENSE.txt / COPYING entry to " +
          "`additionalFiles:` as a bare basename — entries are copied " +
          "verbatim to `extension/files/<entry>` in the archive, so " +
          "nested paths won't earn the factor. For per-directory layouts " +
          "(manifest beside LICENSE), opt in with `paths.base: manifest`.",
      },
    ),
    boolRow(
      "repository-verified",
      "Verified public repository (server confirms on publish)",
      2,
      repositoryLikelyVerifiable(manifest.repository),
      {
        remediation:
          "Set `repository:` to a public HTTPS URL on github.com, gitlab.com, " +
          "codeberg.org, or bitbucket.org. Server will verify it resolves publicly.",
      },
    ),
  ];

  const earned = rows.reduce((s, r) => s + r.earnedPoints, 0);
  const max = rows.reduce((s, r) => s + r.maxPoints, 0);
  const percentage = max === 0 ? 0 : Math.floor((earned * 100) / max);

  return {
    rubricVersion: RUBRIC_VERSION,
    factors: rows,
    earnedPoints: earned,
    maxEarnablePoints: max,
    percentage,
    allPassed: rows.every((r) => r.status === "earned"),
  };
}

function boolRow(
  id: string,
  label: string,
  maxPoints: number,
  earned: boolean,
  extra: { remediation?: string } = {},
): RubricFactor {
  return {
    id,
    label,
    earnedPoints: earned ? maxPoints : 0,
    maxPoints,
    status: earned ? "earned" : "missing",
    remediation: earned ? undefined : extra.remediation,
  };
}

function richReadmeRow(
  readmeLength: number | null,
  readmeCodeBlockCount: number | null,
): RubricFactor {
  if (readmeLength === null || readmeCodeBlockCount === null) {
    return {
      id: "rich-readme",
      label: "README is substantive",
      earnedPoints: 0,
      maxPoints: 1,
      status: "missing",
      remediation:
        `Add a README ≥${RICH_README_MIN_LENGTH} characters with ≥${RICH_README_MIN_CODE_BLOCKS} fenced code blocks.`,
    };
  }
  const earned = readmeLength >= RICH_README_MIN_LENGTH &&
    readmeCodeBlockCount >= RICH_README_MIN_CODE_BLOCKS;
  return {
    id: "rich-readme",
    label: "README is substantive",
    earnedPoints: earned ? 1 : 0,
    maxPoints: 1,
    status: earned ? "earned" : "missing",
    remediation: earned
      ? undefined
      : `Expand README to ≥${RICH_README_MIN_LENGTH} chars with ≥${RICH_README_MIN_CODE_BLOCKS} fenced blocks.`,
  };
}

function symbolsRow(pct: number): RubricFactor {
  const earned = pct >= SYMBOLS_DOCS_FULL_THRESHOLD;
  return {
    id: "symbols-docs",
    label: "Most symbols documented",
    earnedPoints: earned ? 1 : 0,
    maxPoints: 1,
    status: earned ? "earned" : "missing",
    remediation: earned
      ? undefined
      : `Add JSDoc to ≥${
        Math.round(SYMBOLS_DOCS_FULL_THRESHOLD * 100)
      }% of exported symbols in entrypoints (current: ${
        Math.round(pct * 100)
      }%).`,
  };
}

// ── Tarball extraction + deno doc orchestrator ─────────────────────────

/**
 * Extracts a `.tar.gz` byte stream into the given directory. Domain owns
 * the port; the libswamp layer wires in `extractTarGz` from
 * `infrastructure/archive/tar_archive.ts` so this module doesn't reach
 * across layers. Tests inject a fake.
 */
export type ExtractTarball = (
  source: ReadableStream<Uint8Array>,
  destDir: string,
) => Promise<void>;

/** Injected subprocess deps — makes tests hermetic. */
export interface RubricScoreDeps {
  runDeno: (
    args: string[],
    cwd: string,
  ) => Promise<{ success: boolean; stdout: string; stderr: string }>;
  extractTarball: ExtractTarball;
}

/** Default deps: real `deno` subprocess plus the supplied tarball extractor. */
export function createRubricScoreDeps(
  denoPath: string,
  extractTarball: ExtractTarball,
): RubricScoreDeps {
  return {
    runDeno: async (args, cwd) => {
      const cmd = new Deno.Command(denoPath, {
        args,
        cwd,
        stdout: "piped",
        stderr: "piped",
        env: { ...Deno.env.toObject(), NO_COLOR: "1" },
      });
      const out = await cmd.output();
      return {
        success: out.success,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    },
    extractTarball,
  };
}

const CONTROLLED_DENO_JSON = JSON.stringify(
  { nodeModulesDir: "auto" },
  null,
  2,
) + "\n";

const STRIPPED_CONFIG_FILES = [
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "package.json",
  "package-lock.json",
  ".npmrc",
] as const;

const README_FILENAMES = ["README.md", "README.MD", "readme.md", "Readme.md"];

const LICENSE_FILENAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENSE.MD",
  "LICENSE.TXT",
  "License",
  "License.md",
  "License.txt",
  "license",
  "license.md",
  "license.txt",
  "COPYING",
  "COPYING.md",
  "COPYING.txt",
];

/**
 * Score a pre-built extension tarball against the rubric. Extracts
 * the tarball to a temp dir, strips hermetic configs, writes a
 * controlled deno.json, runs `deno doc`, and composes the score —
 * mirroring swamp-club's DenoDocExtensionTarballAnalyzer +
 * composeScore pipeline.
 */
export async function scoreExtensionTarball(
  tarballBytes: Uint8Array,
  manifest: ExtensionManifest,
  deps: RubricScoreDeps,
): Promise<RubricScore> {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_quality_" });
  try {
    const tarballPath = join(tmpDir, "archive.tar.gz");
    const extractDir = join(tmpDir, "extract");
    await Deno.writeFile(tarballPath, tarballBytes);
    await Deno.mkdir(extractDir);

    // Extract via the injected tarball extractor (libswamp wires in
    // `extractTarGz` from infrastructure/archive). The CLI built this
    // tarball itself, so we skip the server-side Zip-Slip / type checks —
    // we trust our own output.
    try {
      const tarFile = await Deno.open(tarballPath, { read: true });
      await deps.extractTarball(tarFile.readable, extractDir);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to extract tarball for scoring: ${message}`);
    }

    // Locate the directory that holds manifest.yaml. Swamp CLI's
    // archives put everything under `extension/`, so the common case
    // is extractDir/extension/manifest.yaml.
    const logicalRoot = await findManifestRoot(extractDir);

    // Strip any config files the packager might have included, then
    // write our controlled deno.json so `deno doc` resolves npm/jsr
    // specifiers consistently. Mirrors server hermeticity.
    for (const name of STRIPPED_CONFIG_FILES) {
      await Deno.remove(join(logicalRoot, name)).catch(() => {});
    }
    await Deno.remove(join(logicalRoot, "node_modules"), { recursive: true })
      .catch(() => {});
    await Deno.writeTextFile(
      join(logicalRoot, "deno.json"),
      CONTROLLED_DENO_JSON,
    );

    const rootAbs = resolve(logicalRoot);
    const entrypointPaths = collectEntrypoints(logicalRoot, rootAbs, manifest);

    const readme = await findReadme(logicalRoot);
    const hasLicenseFile = await findLicenseFile(logicalRoot);

    let doc: DocOutput = { version: 1, nodes: {} };
    let lintOutput = "";
    if (entrypointPaths.length > 0) {
      doc = await runDenoDocJson(entrypointPaths, logicalRoot, deps);
      lintOutput = await runDenoDocLint(entrypointPaths, logicalRoot, deps);
    }

    const entrypointUrls = entrypointPaths.map(toFileUrl);
    const analysisFactors = computeAnalysisFactors({
      entrypointUrls,
      readme,
      hasLicenseFile,
      doc,
      rawLintOutput: lintOutput,
    });

    return composeScore(analysisFactors, manifest);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

export async function findManifestRoot(extractDir: string): Promise<string> {
  try {
    await Deno.stat(join(extractDir, "manifest.yaml"));
    return extractDir;
  } catch {
    // Not at top level — check one level down (CLI packages under `extension/`).
  }
  for await (const entry of Deno.readDir(extractDir)) {
    if (!entry.isDirectory) continue;
    const candidate = join(extractDir, entry.name);
    try {
      await Deno.stat(join(candidate, "manifest.yaml"));
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error(
    `No manifest.yaml found in extracted tarball at ${extractDir}`,
  );
}

/** Walk manifest fields for entrypoints; prefix each with its field directory. */
export function collectEntrypoints(
  root: string,
  rootAbs: string,
  manifest: ExtensionManifest,
): string[] {
  const eps: string[] = [];
  for (const field of ENTRYPOINT_FIELDS) {
    const list = manifest[field];
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (typeof p !== "string") continue;
      const normalized = p.replace(/^\.\//, "");
      const prefixed = normalized.startsWith(`${field}/`)
        ? normalized
        : `${field}/${normalized}`;
      const entryAbs = resolve(root, prefixed);
      if (entryAbs !== rootAbs && !entryAbs.startsWith(rootAbs + SEPARATOR)) {
        throw new Error(`Entrypoint escapes extraction root: ${p}`);
      }
      eps.push(entryAbs);
    }
  }
  return eps;
}

/** README lookup at logical root AND files/ subdirectory. */
async function findReadme(root: string): Promise<string | null> {
  const dirs = [root, join(root, "files")];
  for (const dir of dirs) {
    for (const name of README_FILENAMES) {
      try {
        return await Deno.readTextFile(join(dir, name));
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/** LICENSE file lookup at logical root AND files/ subdirectory. */
async function findLicenseFile(root: string): Promise<boolean> {
  const dirs = [root, join(root, "files")];
  for (const dir of dirs) {
    for (const name of LICENSE_FILENAMES) {
      try {
        await Deno.stat(join(dir, name));
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

function toFileUrl(abs: string): string {
  return new URL("file://" + abs).href;
}

async function runDenoDocJson(
  entrypoints: string[],
  cwd: string,
  deps: RubricScoreDeps,
): Promise<DocOutput> {
  const result = await deps.runDeno(
    ["doc", "--json", ...entrypoints],
    cwd,
  );
  if (!result.success) {
    throw new Error(
      `deno doc --json failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as DocOutput;
  } catch (err) {
    throw new Error(`deno doc --json returned invalid JSON: ${String(err)}`);
  }
}

async function runDenoDocLint(
  entrypoints: string[],
  cwd: string,
  deps: RubricScoreDeps,
): Promise<string> {
  // `deno doc --lint` exits 0 even with diagnostics; we parse the text.
  const result = await deps.runDeno(
    ["doc", "--lint", ...entrypoints],
    cwd,
  );
  return result.stdout + result.stderr;
}
