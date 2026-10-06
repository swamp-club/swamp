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
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
  SEPARATOR,
} from "@std/path";
import type { Logger } from "@logtape/logtape";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { markErrorPaths, UserError } from "../domain/errors.ts";
import {
  type ExtensionManifest,
  isSafeRelativePath,
  parseExtensionManifest,
} from "../domain/extensions/extension_manifest.ts";
import { resolveLocalImports } from "../domain/extensions/extension_import_resolver.ts";
import { resolveWorkflowDependencies } from "../domain/extensions/extension_dependency_resolver.ts";
import { resolveModelsDir } from "./resolve_models_dir.ts";
import { resolveVaultsDir } from "./resolve_vaults_dir.ts";
import { resolveWorkflowsDir } from "./resolve_workflows_dir.ts";
import { resolveDatastoresDir } from "./resolve_datastores_dir.ts";
import { resolveReportsDir } from "./resolve_reports_dir.ts";
import { resolveWebhooksDir } from "./resolve_webhooks_dir.ts";
import { SKILL_DIRS } from "../domain/repo/skill_dirs.ts";
import { resolveManifestArgument } from "./resolve_manifest_path.ts";

export interface ResolveExtensionFilesContext {
  repoDir: string;
  manifestPath: string;
  repoContext: RepositoryContext;
  logger: Logger;
  extensionsDir?: string;
}

export interface ResolvedExtensionFiles {
  manifest: ExtensionManifest;
  absoluteManifestPath: string;
  /**
   * The extensions root: the directory swamp appends `extensions/<kind>`
   * (the configured typed directories) to. `--extensions-dir` when given,
   * else chosen by {@link selectExtensionsRoot}. Commands bound their
   * `deno.json` walk-up here so a manifest outside the repo never walks to
   * the filesystem root.
   */
  extensionsRoot: string;
  /**
   * Effective base for `models` and `include`. Equals the configured
   * `modelsDir` from the repo marker under `paths.base: typedDir`
   * (default), and equals the manifest's own directory under
   * `paths.base: manifest`. Push uses this base for the archive
   * layout so archive sub-paths match the manifest entries verbatim.
   */
  modelsDir: string;
  modelEntryPoints: string[];
  allModelFiles: string[];
  /** Effective base for `vaults` — see {@link modelsDir}. */
  vaultsDir: string;
  vaultEntryPoints: string[];
  allVaultFiles: string[];
  /** Effective base for `datastores` — see {@link modelsDir}. */
  datastoresDir: string;
  datastoreEntryPoints: string[];
  allDatastoreFiles: string[];
  /** Effective base for `reports` — see {@link modelsDir}. */
  reportsDir: string;
  reportEntryPoints: string[];
  allReportFiles: string[];
  /** Effective base for `webhooks` — see {@link modelsDir}. */
  webhooksDir: string;
  webhookEntryPoints: string[];
  allWebhookFiles: string[];
  workflowFiles: Array<{ sourcePath: string; archiveName: string }>;
  skillDirs: Array<{ name: string; absolutePath: string }>;
  allSkillFiles: string[];
  includeFilePaths: string[];
  additionalFilePaths: string[];
  binaryFilePaths: string[];
}

/**
 * Normalize an additionalFiles entry so equivalent paths compare equal:
 * Unicode NFC form, forward slashes, collapse `./` segments, strip trailing
 * slash, case-fold. The NFC step ensures macOS APFS (decomposed) and Linux
 * ext4 (composed) don't mask true collisions.
 */
function normalizeAdditionalFileEntry(entry: string): string {
  const nfc = entry.normalize("NFC");
  const forwardSlashed = nfc.replace(/\\/g, "/");
  const segments = forwardSlashed.split("/").filter((s) =>
    s !== "." && s !== ""
  );
  return segments.join("/").toLowerCase();
}

/** A manifest `workflows` entry together with the file it resolved to. */
export interface WorkflowManifestEntry {
  /** The entry as written in the manifest. */
  ref: string;
  /** The resolved, symlink-free path of the workflow file. */
  realPath: string;
}

/** The archive and lookup names decided for one manifest workflow entry. */
export interface PlannedWorkflowFile {
  ref: string;
  sourcePath: string;
  /** File name under `extension/workflows/` in the archive. */
  archiveName: string;
  /** Name the dependency resolver looks the workflow up by. */
  lookupName: string;
}

/**
 * Decide the archive file name and dependency-lookup name of every manifest
 * workflow entry.
 *
 * An entry whose manifest directory holds exactly one listed workflow is
 * named after that directory — the one-workflow-per-folder layout
 * (`namespace-debug/workflow.yaml` → `namespace-debug.yaml`), where file
 * basenames would all collide. A directory listed more than once keeps each
 * file's basename, as a bare entry always does. Two entries that still map to
 * the same archive name (compared NFC-normalized and case-insensitively, like
 * additionalFiles) are rejected: push writes every workflow to
 * `extension/workflows/<archiveName>`, and a clash would silently drop all
 * but the last file (swamp-club#2613). A file listed twice is rejected as a
 * duplicate entry rather than reported as a clash with itself.
 */
export function planWorkflowArchiveNames(
  entries: readonly WorkflowManifestEntry[],
): PlannedWorkflowFile[] {
  const dirKeyOf = (ref: string) => normalizeAdditionalFileEntry(dirname(ref));
  const entriesPerDir = new Map<string, number>();
  for (const entry of entries) {
    const key = dirKeyOf(entry.ref);
    entriesPerDir.set(key, (entriesPerDir.get(key) ?? 0) + 1);
  }

  const taken = new Map<string, string>();
  const seenFiles = new Map<string, string>();
  const planned: PlannedWorkflowFile[] = [];
  for (const entry of entries) {
    const listedAs = seenFiles.get(entry.realPath);
    if (listedAs !== undefined) {
      throw markErrorPaths(
        new UserError(
          `Workflow entry ${entry.ref} is listed twice in the manifest ` +
            `(also as ${listedAs}). Remove one of the entries.`,
        ),
        [entry.ref, listedAs, entry.realPath],
      );
    }
    seenFiles.set(entry.realPath, entry.ref);

    const refDir = dirname(entry.ref);
    const dirKey = dirKeyOf(entry.ref);
    const ownsDirectory = dirKey !== "" && entriesPerDir.get(dirKey) === 1;
    // The raw directory keeps the names of already-published archives
    // stable (a lone `./ns/workflow.yaml` has always become `.-ns.yaml`).
    const archiveName = ownsDirectory
      ? `${refDir.replace(/\//g, "-")}.yaml`
      : basename(entry.realPath);
    const lookupName = ownsDirectory
      ? refDir.replace(/_/g, "-")
      : basename(entry.ref, extname(entry.ref)).replace(/_/g, "-");

    const archiveKey = normalizeAdditionalFileEntry(archiveName);
    const existing = taken.get(archiveKey);
    if (existing !== undefined) {
      throw markErrorPaths(
        new UserError(
          `Workflow entries ${existing} and ${entry.ref} would both be ` +
            `packaged as ${archiveName}, so one would overwrite the other. ` +
            `Rename one of the files, or move it into its own directory ` +
            `so it is named after that directory.`,
        ),
        [existing, entry.ref, archiveName],
      );
    }
    taken.set(archiveKey, entry.ref);
    planned.push({
      ref: entry.ref,
      sourcePath: entry.realPath,
      archiveName,
      lookupName,
    });
  }
  return planned;
}

/** Manifest fields whose entries resolve from a typed directory. */
type TypedField =
  | "models"
  | "vaults"
  | "datastores"
  | "reports"
  | "webhooks"
  | "include";

const TYPED_KIND: Record<TypedField, string> = {
  models: "Model file",
  vaults: "Vault file",
  datastores: "Datastore file",
  reports: "Report file",
  webhooks: "Webhook file",
  include: "Include file",
};

/** What a typed-key lookup needs to find a file and to explain a miss. */
interface TypedLookup {
  extensionsRoot: string;
  /** True when `--extensions-dir` named the root; the author chose it. */
  explicitRoot: boolean;
  manifestDir: string;
  /** Configured typed directory per field, relative to the root. */
  typedDirs: Record<TypedField, string>;
  useManifestBase: boolean;
}

interface SelectExtensionsRootOptions {
  repoDir: string;
  manifestDir: string;
  explicitRoot: string | undefined;
  manifest: ExtensionManifest;
  typedDirs: Record<TypedField, string>;
  useManifestBase: boolean;
  logger: Logger;
}

function isSameOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + SEPARATOR);
}

/**
 * Where the `deno.json` / `package.json` walk up from the manifest stops.
 * A manifest inside the repo walks to the repo dir, as it always has, so a
 * monorepo's root config still applies to an extension pushed with
 * `--extensions-dir` at a sub-directory. A manifest outside the repo walks
 * to the extensions root that contains it, never further; the manifest's
 * own directory when neither contains it.
 */
export function projectConfigBoundary(
  manifestDir: string,
  extensionsRoot: string,
  repoDir: string,
): string {
  const dir = resolve(manifestDir);
  const root = resolve(extensionsRoot);
  const repo = resolve(repoDir);
  if (isSameOrUnder(dir, repo)) return repo;
  if (isSameOrUnder(dir, root)) return root;
  return dir;
}

/**
 * Walks up from `startDir` to `boundaryDir` (inclusive) and returns the path
 * of the first `fileName` found, or undefined when none exists in between.
 */
async function findUpward(
  startDir: string,
  boundaryDir: string,
  fileName: string,
): Promise<string | undefined> {
  let current = resolve(startDir);
  const boundary = resolve(boundaryDir);
  while (true) {
    const candidate = join(current, fileName);
    if (await isFile(candidate)) return candidate;
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * The project `deno.json` for an extension: the first one walking up from
 * `startDir` to `boundaryDir` (see {@link projectConfigBoundary}). Push,
 * quality and fmt all use it, so they format, lint and bundle under the same
 * config.
 */
export function findDenoConfig(
  startDir: string,
  boundaryDir: string,
): Promise<string | undefined> {
  return findUpward(startDir, boundaryDir, "deno.json");
}

/**
 * The directory of the first `package.json` walking up from `startDir` to
 * `boundaryDir` (inclusive), or undefined when there is none.
 */
export async function findPackageJsonDir(
  startDir: string,
  boundaryDir: string,
): Promise<string | undefined> {
  const path = await findUpward(startDir, boundaryDir, "package.json");
  return path === undefined ? undefined : dirname(path);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}

/**
 * The nearest directory, from the manifest's own directory upward, that
 * looks like an extension root: it holds an `extensions/` directory or a
 * `.swamp.yaml` marker. An in-repo walk stops at the repo dir, so a
 * manifest under `<repo>/extensions/models/x/` yields the repo dir; outside
 * the repo the walk stops at the filesystem root and falls back to the
 * manifest directory. The user's home directory is never a root, even when
 * it holds `~/extensions` or a marker: `~/.claude/skills` would otherwise
 * become a skill candidate again.
 */
export async function inferExtensionsRoot(
  manifestDir: string,
  repoDir: string,
): Promise<string> {
  const repo = resolve(repoDir);
  const home = homeDirectoryOrNull();
  let current = resolve(manifestDir);
  while (true) {
    if (current === repo) return repo;
    if (current === home) return resolve(manifestDir);
    if (
      await isDirectory(join(current, "extensions")) ||
      await isFile(join(current, ".swamp.yaml"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(manifestDir);
    current = parent;
  }
}

function homeDirectoryOrNull(): string | null {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  return home ? resolve(home) : null;
}

/**
 * Choose the extensions root, strictly additively (swamp-club#3018):
 *
 * - `--extensions-dir` wins outright, as it always has.
 * - Otherwise the root is inferred from the manifest's location
 *   ({@link inferExtensionsRoot}). When that is the repo dir, nothing
 *   changes.
 * - When it differs, the typed entries are probed under both. An entry
 *   present under both at different real paths is an error: the archive
 *   would silently come from one of two places. Otherwise, if any entry
 *   resolves under the repo dir, the repo dir stays the root, so every
 *   manifest that resolved before still resolves identically; only a
 *   manifest that found nothing under the repo dir moves to the inferred
 *   root.
 *
 * Under `paths.base: manifest` the typed entries resolve next to the
 * manifest regardless, so the inferred root is used as-is; it only adds
 * workflow and skill candidates after the manifest directory.
 *
 * The inferred root needs none of the `--extensions-dir` preflight in
 * mod.ts: it is an existing directory by construction, and an in-repo walk
 * can only yield the repo dir or an ancestor of the manifest, never a
 * directory under `.swamp/`, because a manifest there is a pulled extension
 * and refused earlier.
 */
async function selectExtensionsRoot(
  options: SelectExtensionsRootOptions,
): Promise<string> {
  const { repoDir, manifestDir, manifest, typedDirs, logger } = options;
  if (options.explicitRoot !== undefined) {
    logger.debug`Extensions root ${options.explicitRoot} from --extensions-dir`;
    return options.explicitRoot;
  }
  const inferred = await inferExtensionsRoot(manifestDir, repoDir);
  const repo = resolve(repoDir);
  if (inferred === repo) {
    logger.debug`Extensions root ${repo} (repo dir)`;
    return repo;
  }
  if (options.useManifestBase) {
    logger
      .debug`Extensions root ${inferred} inferred from the manifest (paths.base: manifest)`;
    return inferred;
  }

  let anyUnderRepo = false;
  const fields: TypedField[] = [
    "models",
    "vaults",
    "datastores",
    "reports",
    "webhooks",
    "include",
  ];
  for (const field of fields) {
    for (const ref of manifest[field]) {
      const underRepo = resolve(repo, typedDirs[field], ref);
      const underInferred = resolve(inferred, typedDirs[field], ref);
      const repoReal = await realPathOrNull(underRepo);
      const inferredReal = await realPathOrNull(underInferred);
      if (
        repoReal !== null && inferredReal !== null && repoReal !== inferredReal
      ) {
        throw twoRootsError(TYPED_KIND[field], ref, underRepo, underInferred);
      }
      if (repoReal !== null) anyUnderRepo = true;
    }
  }
  if (anyUnderRepo) {
    logger
      .debug`Extensions root ${repo} (repo dir; typed entries resolve there)`;
    return repo;
  }
  logger.debug`Extensions root ${inferred} inferred from the manifest location`;
  return inferred;
}

function twoRootsError(
  kind: string,
  ref: string,
  repoPath: string,
  rootPath: string,
): UserError {
  return markErrorPaths(
    new UserError(
      `${kind} ${ref} exists under two roots: ${repoPath} and ${rootPath}. ` +
        `Pass --extensions-dir <dir> to choose the root, or add paths.base: manifest to resolve ${ref} next to the manifest.`,
    ),
    [ref, repoPath, rootPath],
  );
}

/**
 * Refuse a bundled entry (workflow or skill) found under both the inferred
 * extensions root and the repo dir at different real paths. The check is
 * skipped when `--extensions-dir` named the root (the author chose it, and
 * a git worktree holds every tracked file in both trees by design) and when
 * the entry was found in the manifest-relative candidate itself under
 * `paths.base: manifest` (neither contested copy is the one packaged). With
 * root == repoDir the two lists coincide and nothing can be ambiguous.
 */
async function assertSingleRoot(
  lookup: TypedLookup,
  kind: string,
  ref: string,
  foundIn: string,
  manifestCandidates: readonly string[],
  underRoot: readonly string[],
  underRepo: readonly string[],
  directories = false,
): Promise<void> {
  if (lookup.explicitRoot) return;
  if (manifestCandidates.includes(foundIn)) return;
  const exists = directories ? isDirectory : isFile;
  const firstReal = async (paths: readonly string[]) => {
    for (const path of paths) {
      if (await exists(path)) return { path, real: await realPathOrNull(path) };
    }
    return null;
  };
  const root = await firstReal(underRoot);
  const repo = await firstReal(underRepo);
  if (root && repo && root.real !== repo.real) {
    throw twoRootsError(kind, ref, repo.path, root.path);
  }
}

/** The sentence naming the flag or setting that fixes a typed-key miss. */
function bundledHint(
  lookup: TypedLookup,
  field: string,
  typedDir: string,
  ref: string,
): string {
  if (lookup.useManifestBase) {
    return `\nWith paths.base: manifest, entries under ${field} resolve next to the manifest; place ${ref} there, or remove paths.base to resolve from the extensions root.`;
  }
  return `\nEntries under ${field} resolve from ${
    resolve(lookup.extensionsRoot, typedDir)
  }. Pass --extensions-dir <dir> naming the directory that contains ${
    join(typedDir, ref)
  }, or add paths.base: manifest to resolve ${ref} next to the manifest.`;
}

/** A further line when the missing entry sits next to the manifest. */
async function nextToManifestHint(
  lookup: TypedLookup,
  ref: string,
): Promise<string> {
  if (lookup.useManifestBase) return "";
  const nextTo = resolve(lookup.manifestDir, ref);
  if (!(await isFile(nextTo))) return "";
  return `\n${ref} exists next to the manifest at ${nextTo}; add paths.base: manifest to package it from there.`;
}

/** Resolve one typed-key entry under `base`, or explain where it was sought. */
async function findTypedEntry(
  lookup: TypedLookup,
  field: TypedField,
  base: string,
  ref: string,
): Promise<string> {
  const path = resolve(base, ref);
  try {
    await Deno.stat(path);
    return path;
  } catch {
    throw markErrorPaths(
      new UserError(
        `${TYPED_KIND[field]} not found: ${ref} (looked in ${path})` +
          bundledHint(lookup, field, lookup.typedDirs[field], ref) +
          await nextToManifestHint(lookup, ref),
      ),
      [ref, path, lookup.extensionsRoot, lookup.manifestDir],
    );
  }
}

export function isPulledExtensionManifest(
  repoDir: string,
  manifestPath: string,
): boolean {
  const absolute = isAbsolute(manifestPath)
    ? manifestPath
    : resolve(repoDir, manifestPath);
  const resolved = resolve(absolute);
  const repoResolved = resolve(repoDir);
  const pulledRoot = join(repoResolved, ".swamp", "pulled-extensions");
  const managedPulledRoot = join(
    repoResolved,
    ".swamp",
    "config",
    "pulled-extensions",
  );
  return resolved.startsWith(pulledRoot + "/") ||
    resolved.startsWith(pulledRoot + "\\") ||
    resolved.startsWith(managedPulledRoot + "/") ||
    resolved.startsWith(managedPulledRoot + "\\");
}

export async function resolveExtensionFiles(
  ctx: ResolveExtensionFilesContext,
): Promise<ResolvedExtensionFiles> {
  const { repoDir, manifestPath, repoContext, logger } = ctx;

  // 1. Find and parse the manifest. The argument may be a file or an
  // extension directory, relative to --extensions-dir, cwd or the repo dir
  // (swamp-club#3018); the helper stats every candidate and never reads a
  // directory, and an absolute file path comes back unchanged.
  const { absoluteManifestPath } = await resolveManifestArgument({
    argument: manifestPath,
    cwd: Deno.cwd(),
    repoDir,
    extensionsDir: ctx.extensionsDir,
  });
  const manifest = parseExtensionManifest(
    await Deno.readTextFile(absoluteManifestPath),
  );

  // 1b. Defensive path traversal check (belt-and-suspenders with Zod schema)
  const allManifestPaths = [
    ...manifest.models.map((p) => ({ field: "models", path: p })),
    ...manifest.workflows.map((p) => ({ field: "workflows", path: p })),
    ...manifest.vaults.map((p) => ({ field: "vaults", path: p })),
    ...manifest.datastores.map((p) => ({ field: "datastores", path: p })),
    ...manifest.reports.map((p) => ({ field: "reports", path: p })),
    ...manifest.webhooks.map((p) => ({ field: "webhooks", path: p })),
    ...manifest.skills.map((p) => ({ field: "skills", path: p })),
    ...manifest.include.map((p) => ({ field: "include", path: p })),
    ...manifest.additionalFiles.map((p) => ({
      field: "additionalFiles",
      path: p,
    })),
    ...manifest.binaries.map((p) => ({ field: "binaries", path: p })),
  ];
  for (const { field, path } of allManifestPaths) {
    if (!isSafeRelativePath(path)) {
      throw markErrorPaths(
        new UserError(
          `Manifest field '${field}' contains unsafe path: ${path}. ` +
            `Paths must be relative and must not contain '..' components or start with '/'.`,
        ),
        [path],
      );
    }
  }

  // 2. Resolve effective base for each typed-key category. Default mode
  // (`paths.base: typedDir`) uses the configured directory from the repo
  // marker — historical behavior, what every published manifest sees.
  // Opt-in mode (`paths.base: manifest`) uses the manifest's own directory
  // for typed keys plus `additionalFiles`, so authors with a per-extension-
  // subdir layout can write bare basenames and the archive layout (which
  // mirrors `relative(<typedDir>, file)` in push.ts) produces sub-paths
  // matching the manifest entries verbatim.
  const repoPath = RepoPath.create(repoDir);
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(repoPath);
  const manifestDir = dirname(absoluteManifestPath);
  const useManifestBase = manifest.paths.base === "manifest";
  const typedDirs: Record<TypedField, string> = {
    models: resolveModelsDir(marker),
    vaults: resolveVaultsDir(marker),
    datastores: resolveDatastoresDir(marker),
    reports: resolveReportsDir(marker),
    webhooks: resolveWebhooksDir(marker),
    include: resolveModelsDir(marker),
  };
  const extensionsRoot = await selectExtensionsRoot({
    repoDir,
    manifestDir,
    explicitRoot: ctx.extensionsDir,
    manifest,
    typedDirs,
    useManifestBase,
    logger,
  });
  const typedBase = (field: TypedField): string =>
    useManifestBase ? manifestDir : resolve(extensionsRoot, typedDirs[field]);
  const modelsDir = typedBase("models");
  const vaultsDir = typedBase("vaults");
  const datastoresDir = typedBase("datastores");
  const reportsDir = typedBase("reports");
  const webhooksDir = typedBase("webhooks");
  const lookup: TypedLookup = {
    extensionsRoot,
    explicitRoot: ctx.extensionsDir !== undefined,
    manifestDir,
    typedDirs,
    useManifestBase,
  };

  // 2b. When paths.base=manifest, reject entries that start with their own
  // archive directory prefix — the archive places each typed-key file under
  // its directory name, so `models: [models/foo.ts]` would land at
  // `extension/models/models/foo.ts` instead of `extension/models/foo.ts`.
  if (useManifestBase) {
    const typedFieldPrefixes: Array<{ field: string; prefix: string }> = [
      { field: "models", prefix: "models/" },
      { field: "vaults", prefix: "vaults/" },
      { field: "datastores", prefix: "datastores/" },
      { field: "reports", prefix: "reports/" },
      { field: "webhooks", prefix: "webhooks/" },
      { field: "include", prefix: "models/" },
    ];
    for (const { field, prefix } of typedFieldPrefixes) {
      const entries = manifest[field as keyof typeof manifest];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry !== "string") continue;
        const normalized = entry.replace(/^\.\//, "");
        if (normalized.startsWith(prefix)) {
          throw markErrorPaths(
            new UserError(
              `Manifest field '${field}' entry '${entry}' starts with '${prefix}', ` +
                `which would double the archive path to ${prefix}${normalized}. ` +
                `With paths.base: manifest, use the bare filename (e.g. '${
                  normalized.slice(prefix.length)
                }') ` +
                `and place the file next to the manifest, or remove paths.base to resolve from the repository's typed directory.`,
            ),
            [
              entry,
              normalized,
              `${prefix}${normalized}`,
              normalized.slice(prefix.length),
            ],
          );
        }
      }
    }
  }

  // 3. Collect model files from manifest
  const modelEntryPoints: string[] = [];
  for (const modelRef of manifest.models) {
    modelEntryPoints.push(
      await findTypedEntry(lookup, "models", modelsDir, modelRef),
    );
  }

  // 4. Resolve local imports for each model entry point
  const importResult = await resolveLocalImports(modelEntryPoints, modelsDir);
  const allModelFiles = [...importResult.resolvedFiles];

  // 5. Resolve workflow dependencies if workflows present
  const workflowFiles: Array<{ sourcePath: string; archiveName: string }> = [];
  if (manifest.workflows.length > 0) {
    const wfCandidateDirs: string[] = [];
    const seenWfDir = new Set<string>();
    const addWfCandidate = (dir: string) => {
      if (!seenWfDir.has(dir)) {
        seenWfDir.add(dir);
        wfCandidateDirs.push(dir);
      }
    };
    // The extensions root comes before the repo dir so one flag relocates
    // the whole extension (swamp-club#3031); with root == repoDir the list
    // is exactly the historical one.
    const workflowsDir = resolveWorkflowsDir(marker);
    if (useManifestBase) addWfCandidate(manifestDir);
    const rootWfDirs = [
      resolve(extensionsRoot, "workflows"),
      resolve(extensionsRoot, workflowsDir),
    ];
    const repoWfDirs = [
      resolve(repoDir, "workflows"),
      resolve(repoDir, workflowsDir),
    ];
    for (const dir of [...rootWfDirs, ...repoWfDirs]) addWfCandidate(dir);

    // Validate workflow files exist and resolve symlinks
    const wfEntries: WorkflowManifestEntry[] = [];
    for (const wfRef of manifest.workflows) {
      let realPath: string | null = null;
      let foundIn = "";

      for (const candidateDir of wfCandidateDirs) {
        try {
          realPath = await Deno.realPath(resolve(candidateDir, wfRef));
          foundIn = candidateDir;
          break;
        } catch { /* not found here */ }
      }

      if (!realPath) {
        throw markErrorPaths(
          new UserError(
            `Workflow file not found: ${wfRef} (looked in ${
              wfCandidateDirs.join(", ")
            })` +
              bundledHint(lookup, "workflows", workflowsDir, wfRef) +
              await nextToManifestHint(lookup, wfRef),
          ),
          [wfRef, ...wfCandidateDirs, manifestDir],
        );
      }
      await assertSingleRoot(
        lookup,
        "Workflow file",
        wfRef,
        foundIn,
        useManifestBase ? [manifestDir] : [],
        rootWfDirs.map((d) => resolve(d, wfRef)),
        repoWfDirs.map((d) => resolve(d, wfRef)),
      );
      wfEntries.push({ ref: wfRef, realPath });
    }

    // Push writes every workflow to extension/workflows/<archiveName>, so
    // archive names must be pairwise distinct or files are silently lost
    // (swamp-club#2613). planWorkflowArchiveNames rejects clashes between
    // manifest entries; takenArchiveNames extends the check to the
    // dependency-resolved workflows merged below.
    const wfNames: string[] = [];
    const takenArchiveNames = new Map<string, string>();
    for (const planned of planWorkflowArchiveNames(wfEntries)) {
      workflowFiles.push({
        sourcePath: planned.sourcePath,
        archiveName: planned.archiveName,
      });
      wfNames.push(planned.lookupName);
      takenArchiveNames.set(
        normalizeAdditionalFileEntry(planned.archiveName),
        planned.ref,
      );
    }

    // Also resolve models referenced by workflows
    const depResult = await resolveWorkflowDependencies(wfNames, {
      workflowRepo: repoContext.workflowRepo,
      definitionRepo: repoContext.definitionRepo,
      modelsDir,
    });

    // Merge auto-resolved model files (dedup, skip non-existent)
    const existingSet = new Set(allModelFiles);
    for (const mf of depResult.modelFiles) {
      if (existingSet.has(mf)) continue;
      try {
        await Deno.stat(mf);
        allModelFiles.push(mf);
        existingSet.add(mf);
      } catch {
        // Model source not at conventional path — it may already be
        // included in the manifest under a different filename.
        logger.debug`Skipping auto-resolved model (not found): ${mf}`;
      }
    }

    // Merge workflow files from dependency resolution.
    // Use realPath on dep-resolver paths so they match the manifest paths
    // (which were already realPath'd). Without this, symlinks in the repo
    // path itself (e.g. /tmp → /private/tmp on macOS) cause mismatches.
    const wfSet = new Set(workflowFiles.map((wf) => wf.sourcePath));
    for (const wf of depResult.workflowFiles) {
      let realWf: string;
      try {
        realWf = await Deno.realPath(wf);
      } catch {
        continue; // Skip if the file doesn't exist
      }
      if (!wfSet.has(realWf)) {
        const archiveName = basename(realWf);
        const archiveKey = normalizeAdditionalFileEntry(archiveName);
        const takenBy = takenArchiveNames.get(archiveKey);
        if (takenBy !== undefined) {
          throw markErrorPaths(
            new UserError(
              `Workflow ${realWf}, referenced by a workflow step, would be ` +
                `packaged as ${archiveName}, the same archive name as ` +
                `${takenBy}. Rename one of the files so each workflow in the ` +
                `package has a distinct file name.`,
            ),
            [realWf, archiveName, takenBy],
          );
        }
        takenArchiveNames.set(archiveKey, realWf);
        workflowFiles.push({ sourcePath: realWf, archiveName });
        wfSet.add(realWf);
      }
    }
  }

  // 6. Collect vault files from manifest
  const vaultEntryPoints: string[] = [];
  for (const vaultRef of manifest.vaults) {
    const vaultPath = await findTypedEntry(
      lookup,
      "vaults",
      vaultsDir,
      vaultRef,
    );
    vaultEntryPoints.push(vaultPath);
  }

  // 7. Resolve local imports for vault entry points
  const allVaultFiles: string[] = [];
  if (vaultEntryPoints.length > 0) {
    const vaultImportResult = await resolveLocalImports(
      vaultEntryPoints,
      vaultsDir,
    );
    allVaultFiles.push(...vaultImportResult.resolvedFiles);
  }

  // 8. Collect datastore files from manifest
  const datastoreEntryPoints: string[] = [];
  for (const datastoreRef of manifest.datastores) {
    const datastorePath = await findTypedEntry(
      lookup,
      "datastores",
      datastoresDir,
      datastoreRef,
    );
    datastoreEntryPoints.push(datastorePath);
  }

  // 11. Resolve local imports for datastore entry points
  const allDatastoreFiles: string[] = [];
  if (datastoreEntryPoints.length > 0) {
    const datastoreImportResult = await resolveLocalImports(
      datastoreEntryPoints,
      datastoresDir,
    );
    allDatastoreFiles.push(...datastoreImportResult.resolvedFiles);
  }

  // 12. Collect report files from manifest
  const reportEntryPoints: string[] = [];
  for (const reportRef of manifest.reports) {
    const reportPath = await findTypedEntry(
      lookup,
      "reports",
      reportsDir,
      reportRef,
    );
    reportEntryPoints.push(reportPath);
  }

  // 13. Resolve local imports for report entry points
  const allReportFiles: string[] = [];
  if (reportEntryPoints.length > 0) {
    const reportImportResult = await resolveLocalImports(
      reportEntryPoints,
      reportsDir,
    );
    allReportFiles.push(...reportImportResult.resolvedFiles);
  }

  // 13a. Collect webhook files from manifest
  const webhookEntryPoints: string[] = [];
  for (const webhookRef of manifest.webhooks) {
    const webhookPath = await findTypedEntry(
      lookup,
      "webhooks",
      webhooksDir,
      webhookRef,
    );
    webhookEntryPoints.push(webhookPath);
  }

  // 13b. Resolve local imports for webhook entry points
  const allWebhookFiles: string[] = [];
  if (webhookEntryPoints.length > 0) {
    const webhookImportResult = await resolveLocalImports(
      webhookEntryPoints,
      webhooksDir,
    );
    allWebhookFiles.push(...webhookImportResult.resolvedFiles);
  }

  // 14. Resolve skill directories from manifest
  const skillDirs: Array<{ name: string; absolutePath: string }> = [];
  const allSkillFiles: string[] = [];
  if (manifest.skills.length > 0) {
    const tools = marker?.tools?.length ? marker.tools : ["claude"];

    // Build deduplicated candidate base directories in priority order:
    // manifest-relative (if paths.base=manifest) > extensions root >
    // repo dir. The user's home skill directories are deliberately not
    // searched: a skill is never packaged from a globally installed copy
    // just because it has the same name (swamp-club#3018).
    const seen = new Set<string>();
    const candidateBases: string[] = [];
    const addCandidate = (dir: string) => {
      if (!seen.has(dir)) {
        seen.add(dir);
        candidateBases.push(dir);
      }
    };
    const skillRels = tools.map((tool) => SKILL_DIRS[tool]).filter((
      rel,
    ): rel is string => rel !== undefined);

    const manifestSkillDirs = useManifestBase
      ? skillRels.map((rel) => resolve(manifestDir, rel))
      : [];
    for (const dir of manifestSkillDirs) addCandidate(dir);
    // Belt and braces with inferExtensionsRoot: a home skill directory is
    // never a candidate, whatever root was chosen.
    const home = homeDirectoryOrNull();
    const notHome = (dir: string) =>
      home === null || !skillRels.some((rel) => resolve(home, rel) === dir);
    const rootSkillDirs = skillRels.map((rel) => resolve(extensionsRoot, rel))
      .filter(notHome);
    const repoSkillDirs = skillRels.map((rel) => resolve(repoDir, rel)).filter(
      notHome,
    );
    for (const dir of [...rootSkillDirs, ...repoSkillDirs]) addCandidate(dir);

    if (candidateBases.length === 0) {
      throw new UserError(
        `Cannot package skills: no enrolled tools have skill directories. Set a tool with: swamp repo upgrade --tool <claude|cursor|kiro|opencode|codex|pi|antigravity>`,
      );
    }

    for (const skillName of manifest.skills) {
      let skillPath: string | null = null;
      let foundIn = "";

      for (const base of candidateBases) {
        const candidate = join(base, skillName);
        try {
          const stat = await Deno.stat(candidate);
          if (stat.isDirectory) {
            skillPath = candidate;
            foundIn = base;
            break;
          }
        } catch { /* not found here */ }
      }

      if (!skillPath) {
        const skillRel = skillRels[0] ?? SKILL_DIRS.claude;
        const rootSkillPath = join(extensionsRoot, skillRel, skillName);
        throw markErrorPaths(
          new UserError(
            `Skill directory not found: ${skillName} (looked in ${
              candidateBases.join(", ")
            })\n` +
              `Place the skill under ${rootSkillPath}, or next to the manifest under ${skillRel} with paths.base: manifest. ` +
              `swamp does not package a skill from your home directory by name.`,
          ),
          [skillName, ...candidateBases, rootSkillPath],
        );
      }
      await assertSingleRoot(
        lookup,
        "Skill directory",
        skillName,
        foundIn,
        manifestSkillDirs,
        rootSkillDirs.map((d) => join(d, skillName)),
        repoSkillDirs.map((d) => join(d, skillName)),
        true,
      );

      skillDirs.push({ name: skillName, absolutePath: skillPath });

      // Recursively collect all files
      const collectSkillFiles = async (dir: string): Promise<void> => {
        for await (const entry of Deno.readDir(dir)) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory) {
            await collectSkillFiles(fullPath);
          } else if (entry.isFile) {
            allSkillFiles.push(fullPath);
          }
        }
      };
      await collectSkillFiles(skillPath);
    }
  }

  // 15. Validate include files (resolved relative to modelsDir)
  const includeFilePaths: string[] = [];
  for (const inc of manifest.include) {
    includeFilePaths.push(
      await findTypedEntry(lookup, "include", modelsDir, inc),
    );
  }

  // 15. Validate additional files: uniqueness, symlink rejection, existence.
  const additionalFilePaths: string[] = [];
  const seenNormalized = new Map<string, string>();
  for (const af of manifest.additionalFiles) {
    const normalized = normalizeAdditionalFileEntry(af);
    const existing = seenNormalized.get(normalized);
    if (existing !== undefined) {
      throw markErrorPaths(
        new UserError(
          `Duplicate additionalFiles entries: "${existing}" and "${af}" ` +
            `resolve to the same archive path (case-insensitive, normalized). ` +
            `Remove one entry from the manifest, or rename the file.`,
        ),
        [existing, af],
      );
    }
    seenNormalized.set(normalized, af);

    const afPath = resolve(dirname(absoluteManifestPath), af);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(afPath);
    } catch {
      throw markErrorPaths(
        new UserError(
          `Additional file not found: ${af} (looked in ${afPath})`,
        ),
        [af, afPath],
      );
    }
    if (info.isSymlink) {
      throw markErrorPaths(
        new UserError(
          `Additional file is a symlink: ${af} (at ${afPath}). ` +
            `Symlinks in additionalFiles are rejected to prevent archive ` +
            `bloat and path escapes — copy the target file into the ` +
            `extension tree instead.`,
        ),
        [af, afPath],
      );
    }
    additionalFilePaths.push(afPath);
  }

  // 16. Validate binary files: uniqueness, symlink rejection, existence.
  // Also check for overlap with additionalFiles — both land in files/.
  const binaryFilePaths: string[] = [];
  const seenBinNormalized = new Map<string, string>();
  for (const bf of manifest.binaries) {
    const normalized = normalizeAdditionalFileEntry(bf);
    const existingBin = seenBinNormalized.get(normalized);
    if (existingBin !== undefined) {
      throw markErrorPaths(
        new UserError(
          `Duplicate binaries entries: "${existingBin}" and "${bf}" ` +
            `resolve to the same archive path (case-insensitive, normalized). ` +
            `Remove one entry from the manifest, or rename the file.`,
        ),
        [existingBin, bf],
      );
    }
    const existingAdditional = seenNormalized.get(normalized);
    if (existingAdditional !== undefined) {
      throw markErrorPaths(
        new UserError(
          `Path "${bf}" appears in both binaries and additionalFiles ` +
            `(as "${existingAdditional}"). Use one or the other — both ` +
            `land in the same files/ directory in the archive.`,
        ),
        [bf, existingAdditional],
      );
    }
    seenBinNormalized.set(normalized, bf);

    const bfPath = resolve(dirname(absoluteManifestPath), bf);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(bfPath);
    } catch {
      throw markErrorPaths(
        new UserError(
          `Binary file not found: ${bf} (looked in ${bfPath})`,
        ),
        [bf, bfPath],
      );
    }
    if (info.isSymlink) {
      throw markErrorPaths(
        new UserError(
          `Binary file is a symlink: ${bf} (at ${bfPath}). ` +
            `Symlinks in binaries are rejected to prevent archive ` +
            `bloat and path escapes — copy the target file into the ` +
            `extension tree instead.`,
        ),
        [bf, bfPath],
      );
    }
    binaryFilePaths.push(bfPath);
  }

  return {
    manifest,
    absoluteManifestPath,
    extensionsRoot,
    modelsDir,
    modelEntryPoints,
    allModelFiles,
    vaultsDir,
    vaultEntryPoints,
    allVaultFiles,
    datastoresDir,
    datastoreEntryPoints,
    allDatastoreFiles,
    reportsDir,
    reportEntryPoints,
    allReportFiles,
    webhooksDir,
    webhookEntryPoints,
    allWebhookFiles,
    workflowFiles,
    skillDirs,
    allSkillFiles,
    includeFilePaths,
    additionalFilePaths,
    binaryFilePaths,
  };
}
