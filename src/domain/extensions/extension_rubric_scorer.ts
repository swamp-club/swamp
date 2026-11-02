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
  join,
  resolve,
  SEPARATOR,
  toFileUrl as pathToFileUrl,
} from "@std/path";
import type {
  ExtensionManifest,
  PublishVisibility,
} from "./extension_manifest.ts";
import {
  describeDocFailure,
  describeUnpublishedSpecifiers,
  DOC_FAILURE_FALLBACK,
} from "@swamp-club/extension-scoring/doc-failure";
import {
  type AnalysisFactors,
  composeScore,
  computeAnalysisFactors,
  dependencyTrustEarnedPoints,
  type DocOutput,
  type FactorStatus,
  gradeForPercentage,
  type NotAuditedFix,
  percentageIfProvisionalEarned,
  type PrivateSourceStanding,
  RUBRIC_VERSION,
  type ScoreGrade,
} from "@swamp-club/extension-scoring/rubric";
import {
  CONTROLLED_DENO_JSON,
  denoDocJsonArgs,
  denoDocLintArgs,
  DOC_FILE_DIRS,
  EntrypointEscapesRootError,
  entrypointPaths,
  findManifestRoot as findManifestRootIn,
  LICENSE_FILENAMES,
  presentInOrder,
  README_FILENAMES,
  STRIPPED_CONFIG_DIRS,
  STRIPPED_CONFIG_FILES,
} from "@swamp-club/extension-scoring/archive";
import { isValidManifestLicense } from "@swamp-club/extension-scoring/licensing";
import { markErrorPaths } from "../errors.ts";
import { plainDenoEnv } from "../runtime/deno_plain_env.ts";

/**
 * rubric rules live in @swamp-club/extension-scoring, shared with the registry;
 * repository-verified is provisional for a public repo URL (only the registry
 * calls the host API) but earned for an attested private source
 */

export interface RubricFactor {
  id: string;
  label: string;
  earnedPoints: number;
  maxPoints: number;
  status: FactorStatus;
  remediation?: string;
}

export interface RubricScore {
  rubricVersion: number;
  factors: RubricFactor[];
  earnedPoints: number;
  maxEarnablePoints: number;
  /** floor(earned × 100 / maxEarnablePoints): the registry's formula. */
  percentage: number;
  grade: ScoreGrade;
  ifProvisionalEarned: { percentage: number; grade: ScoreGrade } | null;
  allPassed: boolean;
  provisionalPoints: number;
  maxClientEarnablePoints: number;
  /**
   * Why `deno doc` could not analyse the source, or null when it could.
   * When set, the documentation factors score 0, as on the registry.
   */
  docAnalysisError: string | null;
}

export interface LocalScoreOptions {
  dependencyTrustBlockerCount?: number;
  dependencyNotAuditedCount?: number;
  dependencyNotAuditedFixes?: readonly NotAuditedFix[];
  dependencyLooseCount?: number;
  secretSafeDocs?: boolean;
  privateSource?: PrivateSourceStanding;
}

/**
 * without a dependency audit or secret-docs check those two factors are
 * unearned, as nothing vouched for them
 */
export function composeLocalScore(
  analysis: AnalysisFactors,
  manifest: ExtensionManifest,
  options: LocalScoreOptions = {},
  docAnalysisError: string | null = null,
): RubricScore {
  const counts = {
    blockerCount: options.dependencyTrustBlockerCount ?? 0,
    notAuditedCount: options.dependencyNotAuditedCount ?? 0,
    looseCount: options.dependencyLooseCount ?? 0,
  };
  const score = composeScore({
    scoredWith: RUBRIC_VERSION,
    analysis,
    licenseDeclared: isValidManifestLicense(manifest.license),
    dependencyTrust: {
      ...counts,
      earnedPoints: options.dependencyTrustBlockerCount === undefined
        ? 0
        : dependencyTrustEarnedPoints(counts),
      notAuditedFixes: options.dependencyNotAuditedFixes ?? [],
    },
    secretSafeDocs: options.secretSafeDocs ?? false,
    description: manifest.description,
    platforms: manifest.platforms,
    repository: {
      kind: "predicted",
      repository: manifest.repository,
      privateSource: options.privateSource ?? { kind: "unknown" },
    },
    docAnalysisError,
  });
  const factors = score.factors.map((f): RubricFactor => ({
    id: f.id,
    label: f.label,
    earnedPoints: f.earnedPoints,
    maxPoints: f.maxPoints,
    status: f.status,
    ...(f.remediation === undefined ? {} : { remediation: f.remediation }),
  }));
  const ifEarned = percentageIfProvisionalEarned(score);
  return {
    rubricVersion: score.rubricVersion,
    factors,
    earnedPoints: score.earnedPoints,
    maxEarnablePoints: score.maxPoints,
    percentage: score.percentage,
    grade: gradeForPercentage(score.percentage),
    ifProvisionalEarned: score.provisionalPoints === 0 ? null : {
      percentage: ifEarned,
      grade: gradeForPercentage(ifEarned),
    },
    allPassed: factors.every((r) =>
      r.status === "earned" || r.status === "provisional"
    ),
    provisionalPoints: score.provisionalPoints,
    maxClientEarnablePoints: score.maxPoints - score.provisionalPoints,
    docAnalysisError,
  };
}

/**
 * mirrors the registry's confirm-push: a republish keeps the stored visibility;
 * a first publish is private when the manifest asks or the collective's
 * namespace is private, whatever the manifest says otherwise
 */
export function predictPublishedPrivate(
  existing: { isPrivate: boolean } | null,
  manifestVisibility: PublishVisibility | undefined,
  privateNamespace: boolean,
): boolean {
  if (existing) return existing.isPrivate;
  return manifestVisibility === "private" || privateNamespace;
}

/**
 * domain owns the port so this module does not reach across layers; libswamp
 * wires the real extractor and tests inject a fake
 */
export type ExtractTarball = (
  source: ReadableStream<Uint8Array>,
  destDir: string,
) => Promise<void>;

export interface RubricScoreDeps {
  /**
   * Runs `deno`. `denoDir`, when given, is an empty cache directory the run
   * must use instead of the usual one.
   */
  runDeno: (
    args: string[],
    cwd: string,
    denoDir?: string,
  ) => Promise<{ success: boolean; stdout: string; stderr: string }>;
  extractTarball: ExtractTarball;
  /**
   * Run `deno doc` as the registry does: an empty cache and only the
   * environment deno needs, so no registry token, npm config or warm cache
   * can make the local score differ from the registry's.
   */
  isolated?: boolean;
}

/**
 * The variables an isolated `deno doc` keeps: what deno needs to run and
 * reach the network on each platform, never a registry token or npm
 * config.
 */
const ISOLATED_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "DENO_CERT",
  "DENO_TLS_CA_STORE",
  "SSL_CERT_FILE",
];

export function isolatedDenoEnv(
  baseEnv: Record<string, string>,
  denoDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ISOLATED_ENV_KEYS) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  env.DENO_DIR = denoDir;
  env.NO_COLOR = "1";
  return env;
}

export function createRubricScoreDeps(
  denoPath: string,
  extractTarball: ExtractTarball,
  denoEnv?: Record<string, string>,
  isolated = false,
): RubricScoreDeps {
  const baseEnv = denoEnv ?? Deno.env.toObject();
  const plainEnv = plainDenoEnv(baseEnv);
  return {
    isolated,
    runDeno: async (args, cwd, denoDir) => {
      const cmd = new Deno.Command(denoPath, {
        args,
        cwd,
        stdout: "piped",
        stderr: "piped",
        ...(denoDir === undefined ? { env: plainEnv } : {
          env: isolatedDenoEnv(Deno.env.toObject(), denoDir),
          clearEnv: true,
        }),
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

export async function scoreExtensionTarball(
  tarballBytes: Uint8Array,
  manifest: ExtensionManifest,
  deps: RubricScoreDeps,
  options?: LocalScoreOptions & {
    /**
     * Specifiers npm publishes no version for, from the dependency audit:
     * they name the cause when deno's own output does not.
     */
    unpublishedSpecifiers?: string[];
  },
): Promise<RubricScore> {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_quality_" });
  try {
    const extractDir = join(tmpDir, "extract");
    await Deno.mkdir(extractDir);

    try {
      await deps.extractTarball(
        ReadableStream.from([tarballBytes]),
        extractDir,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to extract tarball for scoring: ${message}`);
    }

    // Swamp CLI's archives put everything under `extension/`, so the
    // common case is extractDir/extension/manifest.yaml.
    const logicalRoot = await findManifestRoot(extractDir);

    for (const name of STRIPPED_CONFIG_FILES) {
      await Deno.remove(join(logicalRoot, name)).catch(() => {});
    }
    for (const name of STRIPPED_CONFIG_DIRS) {
      await Deno.remove(join(logicalRoot, name), { recursive: true })
        .catch(() => {});
    }
    await Deno.writeTextFile(
      join(logicalRoot, "deno.json"),
      CONTROLLED_DENO_JSON,
    );

    const rootAbs = resolve(logicalRoot);
    const entrypoints = collectEntrypoints(logicalRoot, rootAbs, manifest);

    const readme = await findReadme(logicalRoot);
    const hasLicenseFile = await findLicenseFile(logicalRoot);

    let denoDir: string | undefined;
    if (deps.isolated) {
      denoDir = join(tmpDir, "deno_dir");
      await Deno.mkdir(denoDir);
    }

    let doc: DocOutput = { version: 1, nodes: {} };
    let lintOutput = "";
    let docAnalysisError: string | null = null;
    if (entrypoints.length > 0) {
      try {
        doc = await runDenoDocJson(entrypoints, logicalRoot, deps, denoDir);
      } catch (err) {
        if (!(err instanceof DenoDocFailedError)) throw err;
        docAnalysisError = describeDocFailure(
          err.output,
          await fileUrlRoots(rootAbs),
        );
        const unpublished = options?.unpublishedSpecifiers ?? [];
        if (
          docAnalysisError === DOC_FAILURE_FALLBACK && unpublished.length > 0
        ) {
          docAnalysisError = describeUnpublishedSpecifiers(unpublished);
        }
      }
      if (docAnalysisError === null) {
        lintOutput = await runDenoDocLint(
          entrypoints,
          logicalRoot,
          deps,
          denoDir,
        );
      }
    }

    const analysis = computeAnalysisFactors({
      entrypointUrls: entrypoints.map(toFileUrl),
      readme,
      hasLicenseFile,
      doc,
      rawLintOutput: lintOutput,
      docFailed: docAnalysisError !== null,
    });

    return composeLocalScore(
      analysis,
      manifest,
      options,
      docAnalysisError,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

export async function findManifestRoot(extractDir: string): Promise<string> {
  const found = await findManifestRootIn({
    hasManifest: async (dir) => {
      try {
        return (await Deno.stat(join(extractDir, dir, "manifest.yaml")))
          .isFile;
      } catch {
        return false;
      }
    },
    subdirectories: async (dir) => {
      const names: string[] = [];
      for await (const entry of Deno.readDir(join(extractDir, dir))) {
        if (entry.isDirectory) names.push(entry.name);
      }
      return names;
    },
  });
  if (found === null) {
    throw markErrorPaths(
      new Error(
        `No manifest.yaml found in extracted tarball at ${extractDir}`,
      ),
      [extractDir],
    );
  }
  return found === "" ? extractDir : join(extractDir, ...found.split("/"));
}

export function collectEntrypoints(
  root: string,
  rootAbs: string,
  manifest: ExtensionManifest,
): string[] {
  let paths: string[];
  try {
    paths = entrypointPaths(manifest as unknown as Record<string, unknown>);
  } catch (err) {
    if (err instanceof EntrypointEscapesRootError) {
      throw markErrorPaths(new Error(err.message), [err.entry]);
    }
    throw err;
  }
  return paths.map((p) => {
    const entryAbs = resolve(root, ...p.split("/"));
    if (entryAbs !== rootAbs && !entryAbs.startsWith(rootAbs + SEPARATOR)) {
      throw markErrorPaths(
        new Error(`Entrypoint escapes extraction root: ${p}`),
        [p],
      );
    }
    return entryAbs;
  });
}

async function listNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  } catch {
    // no such directory
  }
  return names;
}

async function findReadme(root: string): Promise<string | null> {
  for (const dir of DOC_FILE_DIRS) {
    const abs = join(root, dir);
    for (const name of presentInOrder(README_FILENAMES, await listNames(abs))) {
      try {
        return await Deno.readTextFile(join(abs, name));
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

async function findLicenseFile(root: string): Promise<boolean> {
  for (const dir of DOC_FILE_DIRS) {
    const abs = join(root, dir);
    for (
      const name of presentInOrder(LICENSE_FILENAMES, await listNames(abs))
    ) {
      try {
        const info = await Deno.stat(join(abs, name));
        if (info.isFile && info.size > 0) return true;
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

/**
 * The extraction root as deno's `file://` URLs spell it — the resolved
 * path and, where it differs (a symlinked temp dir), the real path.
 */
async function fileUrlRoots(rootAbs: string): Promise<string[]> {
  const spellings = [rootAbs];
  try {
    const real = await Deno.realPath(rootAbs);
    if (real !== rootAbs) spellings.push(real);
  } catch {
    // the resolved spelling alone
  }
  return spellings.map((p) => decodeURIComponent(pathToFileUrl(p).pathname));
}

class DenoDocFailedError extends Error {
  constructor(readonly output: string) {
    super("deno doc --json failed");
    this.name = "DenoDocFailedError";
  }
}

async function runDenoDocJson(
  entrypoints: string[],
  cwd: string,
  deps: RubricScoreDeps,
  denoDir: string | undefined,
): Promise<DocOutput> {
  const result = await deps.runDeno(denoDocJsonArgs(entrypoints), cwd, denoDir);
  if (!result.success) {
    throw new DenoDocFailedError(result.stderr + "\n" + result.stdout);
  }
  try {
    return JSON.parse(result.stdout) as DocOutput;
  } catch {
    // scored as a failure to analyse, as the registry does
    throw new DenoDocFailedError("");
  }
}

async function runDenoDocLint(
  entrypoints: string[],
  cwd: string,
  deps: RubricScoreDeps,
  denoDir: string | undefined,
): Promise<string> {
  // `deno doc --lint` exits 0 even with diagnostics; we parse the text.
  const result = await deps.runDeno(denoDocLintArgs(entrypoints), cwd, denoDir);
  return result.stdout + result.stderr;
}
