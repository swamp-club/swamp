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

import type { GraphDependencies } from "../domain/extensions/dependency_resolution/package_versions.ts";
import { readPackageLockValidity } from "../infrastructure/runtime/package_lock_reader.ts";
import {
  basename,
  dirname,
  extname,
  fromFileUrl,
  isAbsolute,
  join,
  resolve,
  SEPARATOR,
  toFileUrl,
} from "@std/path";
import type { Logger } from "@logtape/logtape";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { readDirSorted } from "../infrastructure/persistence/sorted_dir_entries.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { markErrorPaths, UserError } from "../domain/errors.ts";
import {
  type ExtensionManifest,
  isSafeRelativePath,
  parseExtensionManifest,
} from "../domain/extensions/extension_manifest.ts";
import type {
  LocalModule,
  LocalModuleKind,
  MissingLocalModule,
  ModuleGraphProject,
  ModuleGraphReader,
  SourceModuleGraph,
  SymlinkFreeGraph,
} from "../domain/extensions/extension_source_graph.ts";
import {
  mergeSourceGraphs,
  withoutSymlinkedModules,
} from "../domain/extensions/extension_source_graph.ts";
import { firstSymlinkedComponent } from "../domain/extensions/extension_path_symlinks.ts";
import {
  planSourceArchive,
  type SourceArchiveKind,
  type SourceArchiveKindInput,
  type SourceArchivePlan,
} from "../domain/extensions/source_archive_plan.ts";
import {
  denoInfoEntryPoint,
  groupStaleLockfiles,
  type StaleLockfile,
  StaleLockfileError,
} from "../domain/models/bundle.ts";
import {
  detectExtensionProject,
  type ExtensionProject,
  ignoredMemberLockPath,
  projectConfigBoundary,
} from "../domain/extensions/dependency_resolution/extension_project.ts";
import {
  ancestorConfigRefusal,
  ancestorConfigResolves,
  ancestorNodeModulesRefusal,
  nodeModulesAboveBoundary,
} from "../domain/extensions/dependency_resolution/ancestor_config.ts";
import type { DistTaggedJsrImport } from "../domain/extensions/extension_source_graph.ts";
import type {
  ResolvedBareImport,
  StaleInstalledImport,
} from "../domain/extensions/bare_import_resolution.ts";
import { DenoInfoModuleGraphReader } from "../infrastructure/runtime/deno_info_module_graph_reader.ts";
import { EmbeddedDenoRuntime } from "../infrastructure/runtime/embedded_deno_runtime.ts";
import { resolveWorkflowDependencies } from "../domain/extensions/extension_dependency_resolver.ts";
import { resolveBehaviorsDir, resolveModelsDir } from "./resolve_models_dir.ts";
import { resolveVaultsDir } from "./resolve_vaults_dir.ts";
import { resolveWorkflowsDir } from "./resolve_workflows_dir.ts";
import { resolveDatastoresDir } from "./resolve_datastores_dir.ts";
import { resolveReportsDir } from "./resolve_reports_dir.ts";
import { resolveWebhooksDir } from "./resolve_webhooks_dir.ts";
import { SKILL_DIRS } from "../domain/repo/skill_dirs.ts";
import {
  resolveManifestArgument,
  respellUnderRepoDir,
} from "./resolve_manifest_path.ts";

export interface ResolveExtensionFilesContext {
  repoDir: string;
  manifestPath: string;
  repoContext: RepositoryContext;
  logger: Logger;
  extensionsDir?: string;
  moduleGraphReader: ModuleGraphReader;
  /**
   * for commands that only read the extension's files (`extension fmt`):
   * unreadable or missing modules do not fail resolution and no archive is
   * planned; push and quality leave this unset so they fail as a push would
   */
  lenientSources?: boolean;
}

export interface ResolvedExtensionFiles {
  manifest: ExtensionManifest;
  absoluteManifestPath: string;
  /**
   * commands bound their `deno.json` walk-up here so a manifest outside the
   * repo never walks to the filesystem root
   */
  extensionsRoot: string;
  /**
   * push uses this base for the archive layout so archive sub-paths match the
   * manifest entries verbatim
   */
  modelsDir: string;
  /**
   * base for model entry points listed under `behaviors:`; undefined for a
   * `models:` manifest. Push packs files under it at `models/` by their path
   * from it
   */
  behaviorsDir?: string;
  modelEntryPoints: string[];
  allModelFiles: string[];
  vaultsDir: string;
  vaultEntryPoints: string[];
  allVaultFiles: string[];
  datastoresDir: string;
  datastoreEntryPoints: string[];
  allDatastoreFiles: string[];
  reportsDir: string;
  reportEntryPoints: string[];
  allReportFiles: string[];
  webhooksDir: string;
  webhookEntryPoints: string[];
  allWebhookFiles: string[];
  workflowFiles: Array<{ sourcePath: string; archiveName: string }>;
  skillDirs: Array<{ name: string; absolutePath: string }>;
  allSkillFiles: string[];
  includeFilePaths: string[];
  additionalFilePaths: string[];
  binaryFilePaths: string[];
  /**
   * local data modules each kind reaches: packaged, hashed and safety-scanned,
   * but never sent to fmt, lint or the TypeScript review rules
   */
  dataFilesByKind: Record<SourceArchiveKind, string[]>;
  sourcePlan: SourceArchivePlan;
  missingModules: MissingLocalModule[];
  /**
   * never bundled: the bundler would follow the symlink and quote its target in
   * its errors
   */
  entryPointsReachingSymlinks: string[];
  /**
   * they stay in their lists, unread, so the safety gate refuses each by the
   * symlink rule; a symlinked skill directory, or a symlink inside one, is
   * listed here only
   */
  symlinkedPaths: Map<string, string>;
  /**
   * fmt's graph read never rewrites the lock, so each entry point the lock
   * refused is formatted alone; push and quality fail on a stale lock instead
   */
  staleLockfiles?: StaleLockfile[];
  denoConfigPath?: string;
  packageJsonDir?: string;
  workspaceRootConfigPath?: string;
  /**
   * bundle with `--no-config`: the extension has no Deno config inside the
   * repository, so none above it may apply
   */
  noConfig?: boolean;
  /** a workspace member's own lock, which Deno ignores */
  ignoredMemberLock?: string;
  bareImports: ResolvedBareImport[];
  graphDependencies: GraphDependencies;
}

/**
 * NFC form so macOS APFS (decomposed) and Linux ext4 (composed) do not mask
 * true collisions
 */
function normalizeAdditionalFileEntry(entry: string): string {
  const nfc = entry.normalize("NFC");
  const forwardSlashed = nfc.replace(/\\/g, "/");
  const segments = forwardSlashed.split("/").filter((s) =>
    s !== "." && s !== ""
  );
  return segments.join("/").toLowerCase();
}

export interface WorkflowManifestEntry {
  ref: string;
  /**
   * The resolved path of the workflow file, or its own path when a symlink
   * on it refuses it, so the link is never followed.
   */
  realPath: string;
  /**
   * the workflow file under the spelling of the directory it was found in,
   * which is what push reports; `realPath` when absent
   */
  path?: string;
}

export interface PlannedWorkflowFile {
  ref: string;
  sourcePath: string;
  archiveName: string;
  lookupName: string;
}

/**
 * entries mapping to the same archive name (NFC-normalized, case-insensitive)
 * are rejected: push writes each workflow to
 * `extension/workflows/<archiveName>`, so a clash would silently drop all but
 * the last
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
    // the raw directory keeps the names of already-published archives stable
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
      sourcePath: entry.path ?? entry.realPath,
      archiveName,
      lookupName,
    });
  }
  return planned;
}

type TypedField =
  | "models"
  | "behaviors"
  | "vaults"
  | "datastores"
  | "reports"
  | "webhooks"
  | "include";

const TYPED_KIND: Record<TypedField, string> = {
  models: "Model file",
  behaviors: "Behavior file",
  vaults: "Vault file",
  datastores: "Datastore file",
  reports: "Report file",
  webhooks: "Webhook file",
  include: "Include file",
};

interface TypedLookup {
  extensionsRoot: string;
  explicitRoot: boolean;
  manifestDir: string;
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

/**
 * model entry points are listed under `models` or `behaviors`, never both, so
 * each field holds them only when the author used it
 */
function typedEntries(
  manifest: ExtensionManifest,
  field: TypedField,
): readonly string[] {
  const behaviorsKey = manifest.modelsKey === "behaviors";
  if (field === "models") return behaviorsKey ? [] : manifest.models;
  if (field === "behaviors") return behaviorsKey ? manifest.models : [];
  return manifest[field];
}

function isSameOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + SEPARATOR);
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
 * the user's home directory is never a root, even with `~/extensions` or a
 * marker, or `~/.claude/skills` would become a skill candidate
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
 * `--extensions-dir` wins; otherwise the inferred root is used only when no
 * entry resolves under the repo dir, so manifests that resolved before still
 * do. An entry under both at different real paths is an error
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
    "behaviors",
    "vaults",
    "datastores",
    "reports",
    "webhooks",
    "include",
  ];
  for (const field of fields) {
    for (const ref of typedEntries(manifest, field)) {
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
 * an entry found under both roots at different real paths is refused, unless
 * `--extensions-dir` named the root (a git worktree holds tracked files in both
 * trees by design) or it came from the manifest-relative candidate
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

async function nextToManifestHint(
  lookup: TypedLookup,
  ref: string,
): Promise<string> {
  if (lookup.useManifestBase) return "";
  const nextTo = resolve(lookup.manifestDir, ref);
  if (!(await isFile(nextTo))) return "";
  return `\n${ref} exists next to the manifest at ${nextTo}; add paths.base: manifest to package it from there.`;
}

/**
 * packaging copies each entry as a file, so a directory would crash there with
 * IsADirectory instead of failing here with the entry's name
 */
function assertRegularFile(
  label: string,
  field: string,
  entry: string,
  path: string,
  info: Deno.FileInfo,
): void {
  if (info.isFile) return;
  const message = info.isDirectory
    ? `${label} is a directory: ${entry} (at ${path}). ${field} lists ` +
      `files, not directories; list each file under ${entry}/ individually.`
    : `${label} is not a regular file: ${entry} (at ${path}). ${field} ` +
      `lists regular files only.`;
  throw markErrorPaths(new UserError(message), [entry, path]);
}

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

/**
 * the embedded deno, run with the environment the bundler gets; `readOnlyLock`
 * keeps the read from writing the extension's lockfile
 */
export async function createModuleGraphReader(
  options?: { readOnlyLock?: boolean },
): Promise<ModuleGraphReader> {
  const runtime = new EmbeddedDenoRuntime();
  return new DenoInfoModuleGraphReader(
    await runtime.ensureDeno(),
    runtime.getDenoEnv(),
    options,
  );
}

export async function resolveExtensionFiles(
  ctx: ResolveExtensionFilesContext,
): Promise<ResolvedExtensionFiles> {
  const { repoDir, manifestPath, repoContext, logger } = ctx;

  const { absoluteManifestPath } = await resolveManifestArgument({
    argument: manifestPath,
    cwd: Deno.cwd(),
    repoDir,
    extensionsDir: ctx.extensionsDir,
  });
  const manifest = parseExtensionManifest(
    await Deno.readTextFile(absoluteManifestPath),
  );

  // defensive path traversal check on top of the Zod schema; messages name the
  // field the author wrote (`models` or `behaviors`)
  const modelsField: "models" | "behaviors" = manifest.modelsKey === "behaviors"
    ? "behaviors"
    : "models";
  const allManifestPaths = [
    ...manifest.models.map((p) => ({ field: modelsField, path: p })),
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

  // under `paths.base: manifest` typed keys resolve from the manifest's own
  // directory so archive sub-paths (`relative(<typedDir>, file)` in push.ts)
  // match manifest entries verbatim; the default uses the configured directory
  const repoPath = RepoPath.create(repoDir);
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(repoPath);
  const manifestDir = dirname(absoluteManifestPath);
  const useManifestBase = manifest.paths.base === "manifest";
  // `behaviors:` entries resolve from the behaviors directory while the models
  // directory is the default, else from the configured models directory;
  // include files sit beside the model entry points and follow it
  const behaviorsRel = resolveBehaviorsDir(marker) ?? resolveModelsDir(marker);
  const typedDirs: Record<TypedField, string> = {
    models: resolveModelsDir(marker),
    behaviors: behaviorsRel,
    vaults: resolveVaultsDir(marker),
    datastores: resolveDatastoresDir(marker),
    reports: resolveReportsDir(marker),
    webhooks: resolveWebhooksDir(marker),
    include: modelsField === "behaviors"
      ? behaviorsRel
      : resolveModelsDir(marker),
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
  const behaviorsDir = modelsField === "behaviors"
    ? typedBase("behaviors")
    : undefined;
  const modelEntryDir = behaviorsDir ?? modelsDir;
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
  // every file push collects is checked for a symlink on its path before
  // anything reads it
  const probe = createSymlinkProbe([repoDir, extensionsRoot, manifestDir]);

  // under paths.base=manifest, reject entries starting with their own archive
  // directory prefix: `models: [models/foo.ts]` would land at
  // `extension/models/models/foo.ts`
  if (useManifestBase) {
    const typedFieldPrefixes: Array<{ field: string; prefix: string }> = [
      { field: "models", prefix: "models/" },
      // Behavior entries are packed under models/ too.
      { field: "behaviors", prefix: "behaviors/" },
      { field: "behaviors", prefix: "models/" },
      { field: "vaults", prefix: "vaults/" },
      { field: "datastores", prefix: "datastores/" },
      { field: "reports", prefix: "reports/" },
      { field: "webhooks", prefix: "webhooks/" },
      { field: "include", prefix: "models/" },
    ];
    for (const { field, prefix } of typedFieldPrefixes) {
      const entries = typedEntries(manifest, field as TypedField);
      for (const entry of entries) {
        if (typeof entry !== "string") continue;
        const normalized = entry.replace(/^\.\//, "");
        if (normalized.startsWith(prefix)) {
          throw markErrorPaths(
            new UserError(
              `Manifest field '${field}' entry '${entry}' starts with '${prefix}', ` +
                (field === "behaviors"
                  // behavior files pack under models/, so nothing doubles; the
                  // prefix names a typed directory the manifest base does not
                  // use
                  ? `a typed directory, but paths.base: manifest resolves entries from the manifest's own directory. `
                  : `which would double the archive path to ${prefix}${normalized}. `) +
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

  const modelEntryPoints: string[] = [];
  for (const modelRef of manifest.models) {
    modelEntryPoints.push(
      await findTypedEntry(lookup, modelsField, modelEntryDir, modelRef),
    );
  }

  const modelRoots = [...modelEntryPoints];

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
    // the extensions root comes before the repo dir so one flag relocates the
    // whole extension
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

    const wfEntries: WorkflowManifestEntry[] = [];
    // Real paths of the manifest's workflows, so the dependency resolver
    // cannot add a symlinked one's target as a second entry.
    const manifestWfReal = new Set<string>();
    for (const wfRef of manifest.workflows) {
      let realPath: string | null = null;
      let foundIn = "";
      let path = "";

      for (const candidateDir of wfCandidateDirs) {
        const candidate = resolve(candidateDir, wfRef);
        try {
          realPath = await Deno.realPath(candidate);
          manifestWfReal.add(realPath);
          foundIn = candidateDir;
          path = candidate;
          // A symlinked workflow is listed by its own path, never parsed.
          if (await probe.check(candidate) !== undefined) realPath = candidate;
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
      wfEntries.push({ ref: wfRef, realPath, path });
    }

    // Archive names must be distinct or files are silently lost;
    // takenArchiveNames extends the manifest clash check to dependency-resolved
    // workflows.
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

    const depResult = await resolveWorkflowDependencies(wfNames, {
      workflowRepo: repoContext.workflowRepo,
      definitionRepo: repoContext.definitionRepo,
      modelsDir,
    });

    const existingSet = new Set(modelRoots);
    for (const mf of depResult.modelFiles) {
      if (existingSet.has(mf)) continue;
      try {
        await Deno.stat(mf);
        modelRoots.push(mf);
        existingSet.add(mf);
      } catch {
        // Model source not at conventional path — it may already be
        // included in the manifest under a different filename.
        logger.debug`Skipping auto-resolved model (not found): ${mf}`;
      }
    }

    // respell each dep-resolver path under the repo dir push was given before
    // probing, so the symlink check sees the listed path; match by real path
    // since /tmp may be /private/tmp on macOS
    const wfSet = new Set<string>();
    for (const wf of depResult.workflowFiles) {
      const spelled = resolve(await respellUnderRepoDir(wf, repoDir));
      let realWf: string;
      try {
        realWf = await Deno.realPath(spelled);
      } catch {
        continue;
      }
      if (manifestWfReal.has(realWf)) continue;
      const symlinked = await probe.check(spelled) !== undefined;
      if (symlinked) realWf = spelled;
      const sourcePath = symlinked || isSameOrUnder(spelled, resolve(repoDir))
        ? spelled
        : realWf;
      if (!wfSet.has(realWf)) {
        const archiveName = basename(realWf);
        const archiveKey = normalizeAdditionalFileEntry(archiveName);
        const takenBy = takenArchiveNames.get(archiveKey);
        if (takenBy !== undefined) {
          throw markErrorPaths(
            new UserError(
              `Workflow ${sourcePath}, referenced by a workflow step, would be ` +
                `packaged as ${archiveName}, the same archive name as ` +
                `${takenBy}. Rename one of the files so each workflow in the ` +
                `package has a distinct file name.`,
            ),
            [sourcePath, archiveName, takenBy],
          );
        }
        takenArchiveNames.set(archiveKey, sourcePath);
        workflowFiles.push({ sourcePath, archiveName });
        wfSet.add(realWf);
      }
    }
  }

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

  const skillDirs: Array<{ name: string; absolutePath: string }> = [];
  const allSkillFiles: string[] = [];
  const refusedSkillPaths = new Set<string>();
  if (manifest.skills.length > 0) {
    const tools = marker?.tools?.length ? marker.tools : ["claude"];

    // Candidate bases in priority order: manifest-relative, extensions root,
    // repo dir; home skill directories are not searched.
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
      if (await probe.check(skillPath) !== undefined) {
        refusedSkillPaths.add(skillPath);
        continue;
      }

      skillDirs.push({ name: skillName, absolutePath: skillPath });

      const collectSkillFiles = async (dir: string): Promise<void> => {
        for (const entry of await readDirSorted(dir)) {
          const fullPath = join(dir, entry.name);
          if (entry.isSymlink) {
            // Refused by the safety gate, never followed or copied.
            await probe.check(fullPath);
            refusedSkillPaths.add(fullPath);
          } else if (entry.isDirectory) {
            await collectSkillFiles(fullPath);
          } else if (entry.isFile) {
            allSkillFiles.push(fullPath);
          }
        }
      };
      await collectSkillFiles(skillPath);
    }
  }

  const includeFilePaths: string[] = [];
  for (const inc of manifest.include) {
    const incPath = await findTypedEntry(
      lookup,
      "include",
      typedBase("include"),
      inc,
    );
    if (await probe.check(incPath) !== undefined) {
      if (!ctx.lenientSources) includeFilePaths.push(incPath);
      continue;
    }
    assertRegularFile(
      "Include file",
      "include",
      inc,
      incPath,
      await Deno.stat(incPath),
    );
    includeFilePaths.push(incPath);
  }

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
    // Listed unread for the safety gate, which refuses it by the symlink
    // rule; fmt (lenient) leaves it out so it never writes through it.
    if (await probe.check(afPath) !== undefined) {
      if (!ctx.lenientSources) additionalFilePaths.push(afPath);
      continue;
    }
    assertRegularFile(
      "Additional file",
      "additionalFiles",
      af,
      afPath,
      info,
    );
    additionalFilePaths.push(afPath);
  }

  // binaries and additionalFiles both land in files/, so their entries are also
  // checked for overlap
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
    if (await probe.check(bfPath) !== undefined) {
      if (!ctx.lenientSources) binaryFilePaths.push(bfPath);
      continue;
    }
    assertRegularFile("Binary file", "binaries", bf, bfPath, info);
    binaryFilePaths.push(bfPath);
  }

  // symlinked entry points are found before anything reads them: the
  // bare-specifier scan, graph reader and bundler never follow one to its
  // target
  const symlinkedRoots = new Set<string>();
  for (
    const ep of new Set([
      ...modelRoots,
      ...vaultEntryPoints,
      ...datastoreEntryPoints,
      ...reportEntryPoints,
      ...webhookEntryPoints,
    ])
  ) {
    if (await probe.check(ep) !== undefined) symlinkedRoots.add(ep);
  }

  // the module graph is read under the same project config push bundles under,
  // so it is the bundle's graph
  const project = await detectExtensionProject({
    manifestDir,
    extensionsRoot,
    repoDir,
    entryPoints: [
      ...modelEntryPoints,
      ...vaultEntryPoints,
      ...datastoreEntryPoints,
      ...reportEntryPoints,
      ...webhookEntryPoints,
    ],
    skip: symlinkedRoots,
  });
  const { denoConfigPath, packageJsonDir, workspaceRootConfigPath, noConfig } =
    project;
  const graphProject = {
    ...(denoConfigPath ? { denoConfigPath } : {}),
    ...(packageJsonDir ? { packageJsonDir } : {}),
    ...(workspaceRootConfigPath ? { workspaceRootConfigPath } : {}),
    ...(noConfig ? { noConfig } : {}),
  };
  if (packageJsonDir && !ctx.lenientSources) {
    await requireNodeModules(packageJsonDir);
  }

  // local modules come from each entry point's module graph, which the bundler
  // follows, so the source copy holds every module the bundle was built from,
  // wherever it lives
  const sources = await resolveSourceModules({
    reader: ctx.moduleGraphReader,
    symlinkedRoots,
    probe,
    lenient: ctx.lenientSources ?? false,
    logger,
    project: graphProject,
    repoDir,
    extensionsRoot,
    kinds: [
      {
        kind: "models",
        dir: modelEntryDir,
        extraDirs: modelEntryDir === modelsDir ? [] : [modelsDir],
        roots: modelRoots,
      },
      { kind: "vaults", dir: vaultsDir, roots: vaultEntryPoints },
      { kind: "datastores", dir: datastoresDir, roots: datastoreEntryPoints },
      { kind: "reports", dir: reportsDir, roots: reportEntryPoints },
      { kind: "webhooks", dir: webhooksDir, roots: webhookEntryPoints },
    ],
  });
  if (!ctx.lenientSources) {
    await refuseInputsFromAbove({
      project,
      boundary: projectConfigBoundary(manifestDir, extensionsRoot, repoDir),
      bareImports: sources.bareImports,
      nodeModulesPackageDirs: sources.nodeModulesPackageDirs,
      jsrDistTags: sources.jsrDistTags,
    });
  }
  const ignoredMemberLock = await ignoredMemberLockPath(project);

  const allModelFiles = sources.codeFilesByKind.models;
  const allVaultFiles = sources.codeFilesByKind.vaults;
  const allDatastoreFiles = sources.codeFilesByKind.datastores;
  const allReportFiles = sources.codeFilesByKind.reports;
  const allWebhookFiles = sources.codeFilesByKind.webhooks;
  const listed = new Set([
    ...modelEntryPoints,
    ...vaultEntryPoints,
    ...datastoreEntryPoints,
    ...reportEntryPoints,
    ...webhookEntryPoints,
    ...Object.values(sources.codeFilesByKind).flat(),
    ...Object.values(sources.dataFilesByKind).flat(),
    ...workflowFiles.map((wf) => wf.sourcePath),
    ...includeFilePaths,
    ...additionalFilePaths,
    ...binaryFilePaths,
  ]);

  return {
    manifest,
    absoluteManifestPath,
    extensionsRoot,
    modelsDir,
    ...(behaviorsDir !== undefined ? { behaviorsDir } : {}),
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
    dataFilesByKind: sources.dataFilesByKind,
    sourcePlan: sources.plan,
    missingModules: sources.missing,
    entryPointsReachingSymlinks: sources.entryPointsReachingSymlinks,
    // only paths push lists: a module only a symlink reaches was found by
    // reading the target, so it is never named
    symlinkedPaths: new Map(
      [...probe.found].filter(([path]) =>
        listed.has(path) || refusedSkillPaths.has(path)
      ),
    ),
    ...(sources.staleLockfiles.length > 0
      ? { staleLockfiles: sources.staleLockfiles }
      : {}),
    ...(denoConfigPath ? { denoConfigPath } : {}),
    ...(packageJsonDir ? { packageJsonDir } : {}),
    ...(workspaceRootConfigPath ? { workspaceRootConfigPath } : {}),
    ...(noConfig ? { noConfig } : {}),
    ...(ignoredMemberLock ? { ignoredMemberLock } : {}),
    bareImports: sources.bareImports,
    graphDependencies: sources.graphDependencies,
  };
}

/**
 * refuses what Deno would take from above swamp's boundary: an ancestor config,
 * an ancestor workspace root, a node_modules above the repository; also a JSR
 * dist-tag, with the fix instead of the bundler's error
 */
async function refuseInputsFromAbove(options: {
  project: ExtensionProject;
  boundary: string;
  bareImports: readonly ResolvedBareImport[];
  nodeModulesPackageDirs: readonly string[];
  jsrDistTags: readonly DistTaggedJsrImport[];
}): Promise<void> {
  const unresolved = options.bareImports
    .filter((b) => b.target === undefined && b.installedFile === undefined)
    .map((b) => b.specifier);
  for (const ancestor of options.project.ancestorConfigs ?? []) {
    const resolves = await ancestorConfigResolves(ancestor, unresolved);
    if (ancestor.kind !== "workspace-root" && resolves.length === 0) continue;
    throw markErrorPaths(
      new UserError(
        ancestorConfigRefusal(ancestor, resolves, options.boundary),
      ),
      [ancestor.path, options.boundary],
    );
  }
  // Deno names an installed package by its real path, so a repository
  // reached through a symlink is checked by its real path too.
  const above = nodeModulesAboveBoundary(options.nodeModulesPackageDirs, [
    options.boundary,
    await realPathOr(options.boundary),
  ]);
  if (above.length > 0) {
    throw markErrorPaths(
      new UserError(
        ancestorNodeModulesRefusal(
          above,
          options.boundary,
          options.project.packageJsonDir,
        ),
      ),
      [...above, options.boundary],
    );
  }
  if (options.jsrDistTags.length > 0) {
    const lines = options.jsrDistTags.map((j) =>
      `  ${j.specifier} (imported from ${j.importer})`
    );
    throw markErrorPaths(
      new UserError(
        `JSR has no dist-tags, so Deno cannot resolve:\n${lines.join("\n")}\n` +
          `Drop the tag (an unpinned jsr: import resolves to the newest ` +
          `version, and push ships it pinned exact), or pin a version.`,
      ),
      options.jsrDistTags.map((j) => j.importer),
    );
  }
}

async function requireNodeModules(projectDir: string): Promise<void> {
  const nodeModulesPath = join(projectDir, "node_modules");
  try {
    const stat = await Deno.stat(nodeModulesPath);
    if (!stat.isDirectory) {
      throw markErrorPaths(
        new UserError(
          `Expected node_modules/ to be a directory at ${nodeModulesPath}. ` +
            `Run 'npm install' or 'deno install' in ${projectDir} first.`,
        ),
        [nodeModulesPath, projectDir],
      );
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw markErrorPaths(
      new UserError(
        `No node_modules/ found at ${projectDir}. ` +
          `Run 'npm install' or 'deno install' to install dependencies before pushing.`,
      ),
      [projectDir],
    );
  }
}

interface SourceModuleKindRoots {
  kind: SourceArchiveKind;
  dir: string;
  extraDirs?: string[];
  roots: string[];
}

interface ResolvedSourceModules {
  missing: MissingLocalModule[];
  entryPointsReachingSymlinks: string[];
  bareImports: ResolvedBareImport[];
  codeFilesByKind: Record<SourceArchiveKind, string[]>;
  dataFilesByKind: Record<SourceArchiveKind, string[]>;
  plan: SourceArchivePlan;
  staleLockfiles: StaleLockfile[];
  graphDependencies: GraphDependencies;
  nodeModulesPackageDirs: string[];
  jsrDistTags: DistTaggedJsrImport[];
}

async function realPathOr(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

/**
 * resolves the nearest existing ancestor when the file is missing: a missing
 * module under a repository reached through a symlinked parent (macOS /tmp)
 * still resolves inside it, one behind a symlinked directory outside
 */
async function realPathThroughAncestors(path: string): Promise<string> {
  const rest: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      return join(await Deno.realPath(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

interface SymlinkProbe {
  check(path: string): Promise<string | undefined>;
  found: Map<string, string>;
}

/**
 * A probe over `roots` that lstats each path component once, never
 * following a link; a component that cannot be read is not a symlink, and
 * is reported by the step that needs the file.
 */
function createSymlinkProbe(roots: readonly string[]): SymlinkProbe {
  const known = new Map<string, Promise<boolean>>();
  const isSymlink = (component: string): Promise<boolean> => {
    let answer = known.get(component);
    if (answer === undefined) {
      answer = Deno.lstat(component).then((s) => s.isSymlink, () => false);
      known.set(component, answer);
    }
    return answer;
  };
  const found = new Map<string, string>();
  return {
    found,
    async check(path) {
      const link = await firstSymlinkedComponent(path, roots, isSymlink);
      if (link !== undefined) found.set(path, link);
      return link;
    },
  };
}

/**
 * symlinks are taken out of each graph before it is used: a symlinked entry
 * point is never read, and the safety gate refuses every symlink by the symlink
 * rule
 */
async function resolveSourceModules(options: {
  reader: ModuleGraphReader;
  symlinkedRoots: ReadonlySet<string>;
  probe: SymlinkProbe;
  project: ModuleGraphProject;
  repoDir: string;
  extensionsRoot: string;
  kinds: SourceModuleKindRoots[];
  lenient: boolean;
  logger: Logger;
}): Promise<ResolvedSourceModules> {
  const graphOf = new Map<string, SymlinkFreeGraph>();
  const reachingSymlinks = new Set<string>();
  const staleLocks: StaleLockfileError[] = [];
  const kindGraphs: Array<
    {
      k: SourceModuleKindRoots;
      graph: SourceModuleGraph;
      symlinked: LocalModule[];
    }
  > = [];
  for (const k of options.kinds) {
    const graphs: SourceModuleGraph[] = [];
    const symlinked: LocalModule[] = [];
    for (const root of k.roots) {
      let free = graphOf.get(root);
      if (!free) {
        free = await readSymlinkFreeGraph(root, { ...options, staleLocks });
        graphOf.set(root, free);
      }
      graphs.push(free.graph);
      for (const m of free.symlinked) symlinked.push(m);
      if (free.symlinked.length > 0) reachingSymlinks.add(root);
    }
    kindGraphs.push({ k, graph: mergeSourceGraphs(graphs), symlinked });
  }
  const graph = mergeSourceGraphs(kindGraphs.map((g) => g.graph));

  // a module the graph cannot load is not packaged; push reports it as a
  // compilation error, as the bundler would, and imports of it are left out of
  // the plan
  const missingPaths = new Set(graph.missing.map((m) => m.path));
  graph.edges = graph.edges.filter((e) => !missingPaths.has(e.target));

  // Containment on real paths: a symlink anywhere on a module's path must
  // not carry the archive outside the repository and the extensions root.
  const realRoots = [
    await realPathOr(resolve(options.repoDir)),
    await realPathOr(resolve(options.extensionsRoot)),
  ];
  const importerOf = new Map(graph.edges.map((e) => [e.target, e.importer]));
  // A missing module is checked too: behind a symlinked directory, its
  // recorded error would quote a file outside the repository.
  const outside = new Set<string>();
  const checked = [
    ...graph.modules.map((m) => ({
      path: m.path,
      importer: importerOf.get(m.path),
    })),
    ...graph.missing.map((m) => ({ path: m.path, importer: m.importer })),
  ];
  for (const m of checked) {
    const real = await realPathThroughAncestors(m.path);
    if (!realRoots.some((root) => isSameOrUnder(real, root) && real !== root)) {
      if (options.lenient) {
        outside.add(m.path);
        continue;
      }
      const importer = m.importer;
      throw markErrorPaths(
        new UserError(
          `Local module ${m.path}${
            importer ? ` (imported from ${importer})` : ""
          } resolves to ${real}, outside the repository and the extensions ` +
            `root, so push cannot include it in the archive. Move it inside ` +
            `the repository.`,
        ),
        importer ? [m.path, real, importer] : [m.path, real],
      );
    }
  }

  const kindOf = new Map(graph.modules.map((m) => [m.path, m.kind]));
  const codeFilesByKind = {} as Record<SourceArchiveKind, string[]>;
  const dataFilesByKind = {} as Record<SourceArchiveKind, string[]>;
  const planKinds: SourceArchiveKindInput[] = [];
  const listedBy = kindGraphs.map(({ k, graph: g }) => ({
    k,
    paths: new Set(g.modules.map((m) => m.path)),
  }));
  // a module outside a kind's own directory is listed (hashed, sent to each
  // gate) once: with the kind whose directory holds it, else the first kind
  // that reaches it
  const insideKind = (k: SourceModuleKindRoots, path: string) =>
    [k.dir, ...(k.extraDirs ?? [])].some((d) =>
      isSameOrUnder(resolve(path), resolve(d))
    );
  const ownedElsewhere = (k: SourceModuleKindRoots, path: string) => {
    if (insideKind(k, path)) return false;
    const holder = listedBy.find((o) =>
      o.paths.has(path) && insideKind(o.k, path)
    );
    const owner = holder ?? listedBy.find((o) => o.paths.has(path));
    return owner !== undefined && owner.k.kind !== k.kind;
  };
  // Symlinks are listed, once, for the safety gate to refuse, but never
  // planned into the archive; fmt (lenient) leaves them out, so it never
  // writes through one.
  const symlinksListed = new Set<string>();
  for (const { k, graph: g, symlinked } of kindGraphs) {
    const paths = g.modules.map((m) => m.path).filter((p) => !outside.has(p))
      .sort();
    const listed = paths.filter((p) => !ownedElsewhere(k, p));
    if (options.lenient) {
      for (const m of symlinked) {
        options.logger.debug`Skipping symlink ${m.path}`;
      }
    }
    const links = options.lenient ? [] : symlinked.filter((m) => {
      if (symlinksListed.has(m.path)) return false;
      symlinksListed.add(m.path);
      return true;
    });
    const linked = (kind: LocalModuleKind) =>
      links.filter((m) => m.kind === kind).map((m) => m.path);
    codeFilesByKind[k.kind] = [
      ...listed.filter((p) => kindOf.get(p) === "code"),
      ...linked("code"),
    ].sort();
    dataFilesByKind[k.kind] = [
      ...listed.filter((p) => kindOf.get(p) === "data"),
      ...linked("data"),
    ].sort();
    planKinds.push({
      kind: k.kind,
      dir: k.dir,
      ...(k.extraDirs?.length ? { extraDirs: k.extraDirs } : {}),
      modules: paths,
    });
  }

  const bareImports = (graph.bareImports ?? []).filter((b) =>
    !outside.has(b.importer)
  );
  const graphDependencies: GraphDependencies = {
    packageVersions: graph.packageVersions ?? {},
    unaudited: graph.unaudited ?? [],
  };
  const nodeModulesPackageDirs = graph.nodeModulesPackageDirs ?? [];
  const jsrDistTags = (graph.jsrDistTags ?? []).filter((j) =>
    !outside.has(j.importer)
  );
  if (options.lenient) {
    return {
      missing: graph.missing.filter((m) => !outside.has(m.path)),
      entryPointsReachingSymlinks: [...reachingSymlinks].sort(),
      bareImports,
      codeFilesByKind,
      dataFilesByKind,
      plan: { entries: [] },
      staleLockfiles: groupStaleLockfiles(staleLocks),
      graphDependencies,
      nodeModulesPackageDirs,
      jsrDistTags,
    };
  }
  const staleInstalls = (graph.staleInstalls ?? []).filter((s) =>
    !outside.has(s.importer)
  );
  if (staleInstalls.length > 0 && options.project.packageJsonDir) {
    throw staleInstallError(options.project.packageJsonDir, staleInstalls);
  }
  if (options.project.packageJsonDir && !options.project.denoConfigPath) {
    // a package-lock.json counts as a lock only when node_modules matches it,
    // so it describes what the bundle holds
    const lock = await readPackageLockValidity(
      options.project.packageJsonDir,
      graph.installedPackages ?? [],
    );
    graphDependencies.packageLock = lock.valid
      ? { valid: true }
      : lock.lockPath === null
      ? { valid: false }
      : { valid: false, warning: lock.reason };
  }
  const plan = planSourceArchive({
    kinds: planKinds,
    graph,
    extensionsRoot: resolve(options.extensionsRoot),
    allowedRoots: [resolve(options.repoDir), resolve(options.extensionsRoot)],
  });
  return {
    missing: graph.missing,
    entryPointsReachingSymlinks: [...reachingSymlinks].sort(),
    bareImports,
    codeFilesByKind,
    dataFilesByKind,
    plan,
    staleLockfiles: [],
    graphDependencies,
    nodeModulesPackageDirs,
    jsrDistTags,
  };
}

/** push and quality read node_modules as installed and never install into it */
function staleInstallError(
  projectDir: string,
  stale: readonly StaleInstalledImport[],
): UserError {
  const packages = new Map<string, string>();
  for (const s of stale) {
    if (packages.has(s.packageName)) continue;
    packages.set(
      s.packageName,
      s.installedVersion === undefined
        ? `${s.packageName} (${s.declaredRange}) is not installed`
        : s.installedName !== undefined
        ? `${s.packageName} is installed as ${s.installedName} ` +
          `${s.installedVersion}, but package.json declares it as ` +
          `npm:${s.declaredName}@${s.declaredRange}`
        : `${s.packageName} ${s.installedVersion} is installed, outside ` +
          `the declared ${s.declaredRange}`,
    );
  }
  const nodeModules = join(projectDir, "node_modules");
  return markErrorPaths(
    new UserError(
      `${nodeModules} is out of date with package.json, and push and ` +
        `quality never install into it: ${
          [...packages.values()].join("; ")
        }. ` +
        `Run 'npm install' or 'deno install' in ${projectDir} and try again.`,
    ),
    [nodeModules, projectDir],
  );
}

/**
 * below a node_modules deno info reports modules by real path, so a repo dir
 * given through a symlink (macOS /var) would see its own modules as outside it;
 * only the prefix naming the root is swapped
 */
async function respellGraphUnderRoots(
  graph: SourceModuleGraph,
  roots: readonly string[],
): Promise<SourceModuleGraph> {
  const spelled = new Map<string, Promise<string>>();
  const respell = (path: string): Promise<string> => {
    let answer = spelled.get(path);
    if (answer === undefined) {
      answer = (async () => {
        for (const root of roots) {
          const next = await respellUnderRepoDir(path, root);
          if (next !== path) return next;
        }
        return path;
      })();
      spelled.set(path, answer);
    }
    return answer;
  };
  const respellUrl = async (url: string | undefined) =>
    url?.startsWith("file:")
      ? toFileUrl(await respell(fromFileUrl(url))).href
      : url;
  const optional = async (path: string | undefined) =>
    path === undefined ? undefined : await respell(path);
  return {
    ...graph,
    modules: await Promise.all(
      graph.modules.map(async (m) => ({ ...m, path: await respell(m.path) })),
    ),
    edges: await Promise.all(graph.edges.map(async (e) => ({
      ...e,
      importer: await respell(e.importer),
      target: await respell(e.target),
    }))),
    missing: await Promise.all(graph.missing.map(async (m) => {
      const importer = await optional(m.importer);
      return {
        ...m,
        path: await respell(m.path),
        ...(importer !== undefined ? { importer } : {}),
      };
    })),
    ...(graph.bareImports
      ? {
        bareImports: await Promise.all(graph.bareImports.map(async (b) => {
          const target = await respellUrl(b.target);
          const installedFile = await optional(b.installedFile);
          return {
            ...b,
            importer: await respell(b.importer),
            ...(target !== undefined ? { target } : {}),
            ...(installedFile !== undefined ? { installedFile } : {}),
          };
        })),
      }
      : {}),
    ...(graph.staleInstalls
      ? {
        staleInstalls: await Promise.all(
          graph.staleInstalls.map(async (s) => ({
            ...s,
            importer: await respell(s.importer),
          })),
        ),
      }
      : {}),
  };
}

/**
 * a symlinked entry point is not read at all; any other symlink is removed
 * before the graph is used, with what it alone reaches and any error recorded
 * for it
 */
async function readSymlinkFreeGraph(
  root: string,
  options: {
    reader: ModuleGraphReader;
    symlinkedRoots: ReadonlySet<string>;
    probe: SymlinkProbe;
    project: ModuleGraphProject;
    repoDir: string;
    extensionsRoot: string;
    lenient: boolean;
    logger: Logger;
    staleLocks?: StaleLockfileError[];
  },
): Promise<SymlinkFreeGraph> {
  const empty: SourceModuleGraph = { modules: [], edges: [], missing: [] };
  if (options.symlinkedRoots.has(root)) {
    return withoutSymlinkedModules(empty, root, options.symlinkedRoots);
  }
  let graph: SourceModuleGraph;
  // an entry point reached through a symlink above a node_modules is read by
  // real path and its graph put back in the repo dir's spelling; any other is
  // read and used as given
  const readAt = await denoInfoEntryPoint(root);
  try {
    graph = await options.reader.read(readAt, options.project);
    if (readAt !== root) {
      graph = await respellGraphUnderRoots(graph, [
        options.repoDir,
        options.extensionsRoot,
      ]);
    }
  } catch (error) {
    if (!options.lenient) throw error;
    if (error instanceof StaleLockfileError) options.staleLocks?.push(error);
    options.logger
      .debug`Module graph of ${root} unavailable, using the entry point alone: ${error}`;
    graph = { ...empty, modules: [{ path: root, kind: "code" }] };
  }
  // a module behind a symlinked directory counts as a symlink too: deno info
  // followed it, so its target was read
  const symlinks = new Set<string>();
  for (
    const path of new Set([
      ...graph.modules.map((m) => m.path),
      ...graph.missing.map((m) => m.path),
    ])
  ) {
    if (await options.probe.check(path) !== undefined) symlinks.add(path);
  }
  return withoutSymlinkedModules(graph, root, symlinks);
}
