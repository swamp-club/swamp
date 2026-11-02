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
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { join as posixJoin } from "@std/path/posix";
import { errorPaths, markErrorPaths, UserError } from "../../domain/errors.ts";
import { escapeControlCharacters } from "../../domain/control_characters.ts";
import type {
  InstallChange,
  InstallRollbackOutcome,
} from "../../domain/extensions/duplicate_type_user_error.ts";
import {
  type ExtensionManifest,
  parseExtensionManifest,
} from "../../domain/extensions/extension_manifest.ts";
import { analyzeExtensionSafety } from "../../domain/extensions/extension_safety_analyzer.ts";
import {
  bundleDependencyWarnings,
  checkBundleRecord,
  describeBundleErrors,
  scanExtractedBundles,
} from "./bundle_safety_scan.ts";
import { DEPENDENCY_AUDIT_RECORD_FILENAME } from "@swamp-club/extension-scoring/dependency-audit";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import { pruneOrphanFiles } from "../../infrastructure/persistence/directory_cleanup.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { pulledExtensionsLock } from "../../infrastructure/persistence/pulled_extensions_lock.ts";
import {
  canonicalLockfilePath,
  lockfileRelative,
  readPublishedChannel,
  type UpstreamExtensionEntry,
} from "../../infrastructure/persistence/upstream_extensions.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import { ProcessBundleProber } from "../../infrastructure/runtime/process_bundle_prober.ts";
import { InstallExtensionService } from "./install_extension_service.ts";
import { findPublishedVersions } from "./published_version_lookup.ts";
import {
  EXTENSION_BUNDLE_KINDS,
  extensionInstallRoots,
  resolvePulledExtensionsRoot,
} from "../../infrastructure/persistence/paths.ts";
import { ExtensionInstallTransaction } from "../../infrastructure/persistence/extension_install_transaction.ts";
import { nestedEntryRelDirs } from "../../domain/extensions/install_journal.ts";
import {
  assertNoBlockingJournal,
  recoverPulledExtensionStagingLocked,
} from "./recover_staging.ts";
import { computeChecksum } from "../../domain/models/checksum.ts";
import {
  ArchiveSizeLimitError,
  extractTarGz,
  listTarGzEntries,
} from "../../infrastructure/archive/tar_archive.ts";
import {
  formatArchiveBytes,
  MAX_EXTENSION_ARCHIVE_BYTES,
  MAX_EXTENSION_ARCHIVE_DECOMPRESSED_BYTES,
} from "../../domain/extensions/extension_archive_limits.ts";
import { readInstalledExtensionDigest } from "../../infrastructure/persistence/installed_extension_digest_reader.ts";
import { readManifestIdentityAt } from "../../infrastructure/persistence/local_manifest_reader.ts";
import {
  type ExtensionIdentity,
  ExtensionReplacement,
  type ReplacementChange,
} from "../../domain/extensions/extension_replacement.ts";
import { ReleaseChannel } from "../../domain/extensions/release_channel.ts";
import { readDirSorted } from "../../infrastructure/persistence/sorted_dir_entries.ts";
import {
  type ArchiveEntry,
  type ArchiveEntryRefusal,
  archiveEntryRefusal,
  archiveRootSourceDirs,
  planArchiveRootSources,
} from "../../domain/extensions/archive_root_sources.ts";
import { firstSymlinkUnder } from "./first_symlink_under.ts";
import {
  assertContainedPath,
  PathTraversalError,
} from "../../infrastructure/persistence/safe_path.ts";
import {
  canonicalClaimPath,
  claimsPath,
  findClaimants,
  pathCovers,
} from "../../domain/extensions/extension_path_claims.ts";
import { verifyChecksum } from "../../domain/update/integrity.ts";
import { resolveLocalImports } from "../../domain/models/local_import_resolver.ts";
import type { Logger } from "@logtape/logtape";
import type { LibSwampContext } from "../context.ts";
import {
  inManagedLockfileTransaction,
  isManagedLockfile,
} from "./managed_lockfile_transaction.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;
const MAX_DEPENDENCY_DEPTH = 10;
const VERSION_CONSTRAINT_PREFIX = /^[><=^~!]/;

export interface ExtensionRef {
  name: string;
  version: string | null;
}

export interface ExtensionSafetyWarning {
  file: string;
  message: string;
}

export interface ExtensionRegistryInfo {
  name: string;
  description: string;
  latestVersion: string | null;
  latestRc?: string | null;
  latestBeta?: string | null;
  deprecatedAt?: string | null;
  deprecationReason?: string | null;
  supersededBy?: string | null;
}

export interface ShadowedTypeInfo {
  readonly type: string;
  readonly kind: string;
  readonly localSourcePath: string;
}

export interface InstallResult {
  name: string;
  version: string;
  description: string | undefined;
  extractedFiles: string[];
  integrityStatus: "verified" | "unverified";
  repository: string | undefined;
  platforms: string[];
  safetyWarnings: ExtensionSafetyWarning[];
  binaries: string[];
  conflicts: string[];
  missingSourceFiles: string[];
  hasSkills: boolean;
  hasSkillScripts: boolean;
  skillFiles: string[];
  dependencies: string[];
  dependencyResults: InstallResult[];
  extendsTypes: Array<{ type: string; methods: string[] }>;
  pruned: string[];
  shadowedTypes?: ShadowedTypeInfo[];
  keepArchiveBundles?: boolean;
  createdPaths: string[];
  channel?: string;
  publishedChannel?: string | null;
  previous?: ExtensionIdentity | null;
  change?: ReplacementChange;
  channelChanged?: boolean;
}

export interface UnoptedPrereleaseNotice {
  name: string;
  version: string;
  publishedChannel: string;
  parent: string | null;
}

/**
 * per-type destination dirs are derived per extension under
 * .swamp/pulled-extensions/<name>/; only skillsDirs is passed, since tool skill
 * dirs belong to the caller.
 */
export interface InstallContext {
  getExtension: (name: string) => Promise<ExtensionRegistryInfo | null>;
  downloadArchive: (
    name: string,
    version: string,
    channel?: string,
  ) => Promise<Uint8Array>;
  getChecksum: (
    name: string,
    version: string,
    channel?: string,
  ) => Promise<string | null>;
  logger?: Logger;
  /**
   * the repository serves reads from a snapshot taken at construction; build a
   * fresh context per install, since another process may have written since.
   */
  lockfileRepository: LockfileRepository;
  skillsDirs: string[];
  /**
   * dependencies never raise skill conflicts, so they may go to the swamp-owned
   * pulled skills dir while the extension itself goes to its lockfile tool
   * dirs; defaults to skillsDirs.
   */
  dependencySkillsDirs?: string[];
  repoDir: string;
  force: boolean;
  alreadyPulled: Set<string>;
  depth: number;
  /**
   * checked against the archive SHA-256 before extraction; set only on the
   * lockfile-restore path, so an explicit pull accepts what the registry
   * serves, and dependencies never inherit it.
   */
  expectedChecksum?: string;
  channel?: string;
  getVersionChannels?: (
    name: string,
    versions: string[],
  ) => Promise<Map<string, string>>;
  onReplacing?: (replacement: ExtensionReplacement) => void;
  onUnoptedPrerelease?: (notice: UnoptedPrereleaseNotice) => void;
  parentName?: string;
}

export class ConflictError extends UserError {
  conflicts: string[];
  /**
   * existing skill dirs the install writes into rather than replaces:
   * same-named files are overwritten, others kept.
   */
  skillDirs: string[];
  replacement: ExtensionReplacement | undefined;
  constructor(
    conflicts: string[],
    skillDirs: string[] = [],
    replacement?: ExtensionReplacement,
  ) {
    const skillSet = new Set(skillDirs);
    const files = conflicts.filter((c) => !skillSet.has(c));
    const lines: string[] = [];
    if (files.length > 0) {
      lines.push(
        "The following files already exist and would be overwritten:",
        ...files.map((c) => `  ${c}`),
      );
    }
    if (skillDirs.length > 0) {
      lines.push(
        "The following skill directories already exist; the extension's " +
          "files would be written into them (same-named files overwritten, " +
          "other files kept):",
        ...skillDirs.map((c) => `  ${c}`),
      );
    }
    lines.push("Use --force to overwrite.");
    super(lines.join("\n"));
    this.conflicts = conflicts;
    this.skillDirs = skillDirs;
    this.replacement = replacement;
  }
}

export type ExtensionPullEvent =
  | { kind: "installing" }
  | {
    kind: "deprecated_warning";
    name: string;
    reason: string | null;
    supersededBy: string | null;
  }
  | {
    kind: "orphans-pruned";
    name: string;
    version: string;
    paths: string[];
  }
  | { kind: "completed"; data: InstallResult }
  | { kind: "error"; error: SwampError };

export interface ExtensionPullInput {
  ref: ExtensionRef;
  force: boolean;
  channel?: string;
}

export interface ExtensionPullDeps {
  getExtension: (name: string) => Promise<ExtensionRegistryInfo | null>;
  getLatestVersion?: (
    name: string,
    channel: string,
  ) => Promise<string | null>;
  downloadArchive: (
    name: string,
    version: string,
    channel?: string,
  ) => Promise<Uint8Array>;
  getChecksum: (
    name: string,
    version: string,
    channel?: string,
  ) => Promise<string | null>;
  lockfileRepository: LockfileRepository;
  skillsDirs: string[];
  repoDir: string;
  alreadyPulled: Set<string>;
  depth: number;
  /**
   * test seam: tests inject a stub; production leaves it unset and gets the
   * real installExtension.
   */
  installExtensionFn?: InstallExtensionFn;
  getVersionChannels?: InstallContext["getVersionChannels"];
  onReplacing?: InstallContext["onReplacing"];
  onUnoptedPrerelease?: InstallContext["onUnoptedPrerelease"];
  /**
   * when both are set, pull routes through InstallExtensionService (catalog
   * save, rollback on DuplicateTypeError); otherwise the catalog is populated
   * lazily by the loader.
   */
  denoRuntime?: DenoRuntime;
  repository?: ExtensionRepository;
}

export function parseExtensionRef(ref: string): ExtensionRef {
  if (!ref.startsWith("@")) {
    throw new UserError(
      `Invalid extension name: "${ref}". Extension names must start with "@" (e.g., @collective/name).`,
    );
  }

  const versionSepIdx = ref.indexOf("@", 1);
  if (versionSepIdx === -1) {
    return { name: ref, version: null };
  }

  const name = ref.slice(0, versionSepIdx);
  const version = ref.slice(versionSepIdx + 1);

  if (!version) {
    throw new UserError(
      `Invalid extension reference: "${ref}". Version cannot be empty after "@".`,
    );
  }

  return { name, version };
}

export function isScopedExtensionName(name: string): boolean {
  return SCOPED_NAME_PATTERN.test(name);
}

export function validateExtensionName(name: string): void {
  if (!isScopedExtensionName(name)) {
    throw new UserError(
      `Invalid extension name: "${name}". Must match @collective/name pattern (lowercase, alphanumeric, hyphens, underscores, additional /segments allowed).`,
    );
  }
}

export function isVersionConstraint(version: string): boolean {
  return VERSION_CONSTRAINT_PREFIX.test(version);
}

export function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

function isMacOsResourceFork(name: string): boolean {
  return name.startsWith("._");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(
  srcDir: string,
  destDir: string,
  repoDir: string,
  recordDir: string = destDir,
): Promise<string[]> {
  const extracted: string[] = [];
  try {
    for await (const entry of Deno.readDir(srcDir)) {
      if (isMacOsResourceFork(entry.name)) continue;

      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);
      const recordPath = join(recordDir, entry.name);
      if (entry.isDirectory) {
        await Deno.mkdir(destPath, { recursive: true });
        const sub = await copyDir(srcPath, destPath, repoDir, recordPath);
        extracted.push(...sub);
      } else if (entry.isFile) {
        await Deno.mkdir(dirname(destPath), { recursive: true });
        await Deno.copyFile(srcPath, destPath);
        extracted.push(lockfileRelative(repoDir, recordPath));
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return extracted;
}

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for (const entry of await readDirSorted(dir)) {
      if (isMacOsResourceFork(entry.name)) continue;

      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        files.push(...await listFiles(path));
      } else if (entry.isFile) {
        files.push(path);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return files;
}

/**
 * does not descend into symlinked dirs; copyFile writes through a destination
 * symlink, so a user's symlink must count as pre-existing or rollback would
 * unlink it.
 */
async function listFilesAndLinks(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (isMacOsResourceFork(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        out.push(...await listFilesAndLinks(path));
      } else {
        out.push(path);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out;
}

/**
 * the entry path is the archive author's text, so control characters are
 * printed as escapes.
 */
function archiveRefusalError(
  name: string,
  version: string,
  refusal: ArchiveEntryRefusal,
): UserError {
  const path = escapeControlCharacters(refusal.path);
  return markErrorPaths(
    new UserError(
      `Extension archive ${name}@${version} cannot be installed: ` +
        `${path} ${refusal.reason}. Ask the extension author to ` +
        `publish a corrected version.`,
    ),
    [path],
  );
}

export async function detectConflicts(
  extractDir: string,
  modelsDir: string,
  workflowsDir: string,
  bundlesDir: string,
  repoDir: string,
  vaultsDir?: string,
  vaultBundlesDir?: string,
  datastoresDir?: string,
  datastoreBundlesDir?: string,
  reportsDir?: string,
  reportBundlesDir?: string,
  filesDir?: string,
  webhooksDir?: string,
  webhookBundlesDir?: string,
): Promise<string[]> {
  const conflicts: string[] = [];

  const modelsSrc = join(extractDir, "models");
  for (const file of await listFiles(modelsSrc)) {
    const relPath = relative(modelsSrc, file);
    const destPath = join(modelsDir, relPath);
    if (await fileExists(destPath)) {
      conflicts.push(lockfileRelative(repoDir, destPath));
    }
  }

  const workflowsSrc = join(extractDir, "workflows");
  for (const file of await listFiles(workflowsSrc)) {
    const destPath = join(workflowsDir, basename(file));
    if (await fileExists(destPath)) {
      conflicts.push(lockfileRelative(repoDir, destPath));
    }
  }

  const bundlesSrc = join(extractDir, "bundles");
  for (const file of await listFiles(bundlesSrc)) {
    const relPath = relative(bundlesSrc, file);
    const destPath = join(bundlesDir, relPath);
    if (await fileExists(destPath)) {
      conflicts.push(lockfileRelative(repoDir, destPath));
    }
  }

  if (vaultsDir) {
    const vaultsSrc = join(extractDir, "vaults");
    for (const file of await listFiles(vaultsSrc)) {
      const relPath = relative(vaultsSrc, file);
      const destPath = join(vaultsDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(lockfileRelative(repoDir, destPath));
      }
    }
  }

  if (vaultBundlesDir) {
    const vaultBundlesSrc = join(extractDir, "vault-bundles");
    for (const file of await listFiles(vaultBundlesSrc)) {
      const relPath = relative(vaultBundlesSrc, file);
      const destPath = join(vaultBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(lockfileRelative(repoDir, destPath));
      }
    }
  }

  if (datastoresDir) {
    const datastoresSrc = join(extractDir, "datastores");
    for (const file of await listFiles(datastoresSrc)) {
      const relPath = relative(datastoresSrc, file);
      const destPath = join(datastoresDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(lockfileRelative(repoDir, destPath));
      }
    }
  }

  if (datastoreBundlesDir) {
    const datastoreBundlesSrc = join(extractDir, "datastore-bundles");
    for (const file of await listFiles(datastoreBundlesSrc)) {
      const relPath = relative(datastoreBundlesSrc, file);
      const destPath = join(datastoreBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(lockfileRelative(repoDir, destPath));
      }
    }
  }

  if (reportsDir) {
    const reportsSrc = join(extractDir, "reports");
    for (const file of await listFiles(reportsSrc)) {
      const relPath = relative(reportsSrc, file);
      const destPath = join(reportsDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(lockfileRelative(repoDir, destPath));
      }
    }
  }

  if (reportBundlesDir) {
    const reportBundlesSrc = join(extractDir, "report-bundles");
    for (const file of await listFiles(reportBundlesSrc)) {
      const relPath = relative(reportBundlesSrc, file);
      const destPath = join(reportBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(lockfileRelative(repoDir, destPath));
      }
    }
  }

  if (webhooksDir) {
    const webhooksSrc = join(extractDir, "webhooks");
    for (const file of await listFiles(webhooksSrc)) {
      const relPath = relative(webhooksSrc, file);
      const destPath = join(webhooksDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(lockfileRelative(repoDir, destPath));
      }
    }
  }

  if (webhookBundlesDir) {
    const webhookBundlesSrc = join(extractDir, "webhook-bundles");
    for (const file of await listFiles(webhookBundlesSrc)) {
      const relPath = relative(webhookBundlesSrc, file);
      const destPath = join(webhookBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(lockfileRelative(repoDir, destPath));
      }
    }
  }

  if (filesDir) {
    const filesSrc = join(extractDir, "files");
    for (const file of await listFiles(filesSrc)) {
      const relPath = relative(filesSrc, file);
      const destPath = join(filesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(lockfileRelative(repoDir, destPath));
      }
    }
  }

  return conflicts;
}

async function detectRootSourceConflicts(
  rootSources: readonly string[],
  extensionRoot: string,
  repoDir: string,
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const source of rootSources) {
    const destPath = join(extensionRoot, ...source.split("/"));
    if (await pathExistsNoFollow(destPath)) {
      conflicts.push(lockfileRelative(repoDir, destPath));
    }
  }
  return conflicts;
}

/** lstat, so a dangling or directory symlink still counts as present. */
async function pathExistsNoFollow(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * skills land in shared tool dirs, so a same-named dir may belong to the user
 * or another extension; a dir is owned only if the prior lockfile entry lists
 * it or a path under it.
 */
export async function detectSkillConflicts(
  extractDir: string,
  skillsDirs: ReadonlyArray<string>,
  oldFiles: ReadonlyArray<string>,
  repoDir: string,
): Promise<string[]> {
  const skillNames: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(extractDir, "skills"))) {
      if (entry.isDirectory) skillNames.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }

  const conflicts: string[] = [];
  for (const skillsDir of skillsDirs) {
    const absoluteSkillsDir = resolve(repoDir, skillsDir);
    for (const name of skillNames) {
      const destSkillDir = join(absoluteSkillsDir, name);
      const rel = lockfileRelative(repoDir, destSkillDir);
      if (
        await pathExistsNoFollow(destSkillDir) && !claimsPath(oldFiles, rel)
      ) {
        conflicts.push(rel);
      }
    }
  }
  return conflicts;
}

async function validateSourceCompleteness(
  ...dirs: string[]
): Promise<string[]> {
  const entryPoints: string[] = [];
  for (const dir of dirs) {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".ts")) {
          entryPoints.push(join(dir, entry.name));
        } else if (entry.isDirectory && !entry.name.startsWith("_")) {
          const subEntries = await collectTsFiles(join(dir, entry.name));
          entryPoints.push(...subEntries);
        }
      }
    } catch {
      // Directory may not exist
    }
  }

  if (entryPoints.length === 0) return [];

  const boundaryDir = dirs[0];
  const result = await resolveLocalImports(entryPoints, boundaryDir);

  const missing: string[] = [];
  for (const resolved of result.resolvedFiles) {
    try {
      await Deno.stat(resolved);
    } catch {
      missing.push(lockfileRelative(boundaryDir, resolved));
    }
  }
  return missing;
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".ts")) {
        files.push(join(dir, entry.name));
      } else if (entry.isDirectory && !entry.name.startsWith("_")) {
        files.push(...await collectTsFiles(join(dir, entry.name)));
      }
    }
  } catch {
    // Directory may not exist
  }
  return files;
}

/**
 * an old path is not an orphan when it lies under a new path or a new path lies
 * under it, since pruning it would delete what this install just wrote.
 */
export function computeOrphanDiff(
  oldFiles: ReadonlyArray<string>,
  extractedFiles: ReadonlyArray<string>,
): string[] {
  // The lockfile reads with forward slashes; `relative()` gives the new
  // paths the OS separator, so compare both in the lockfile's form.
  const newFilesSet = new Set(extractedFiles.map(canonicalLockfilePath));
  const newCanonical = extractedFiles.map(canonicalClaimPath);
  return oldFiles.filter((f) => {
    if (newFilesSet.has(canonicalLockfilePath(f))) return false;
    // Strict containment only: an exact match that differs just in case
    // is a rename, and on a case-sensitive filesystem the old file is a
    // real orphan.
    const old = canonicalClaimPath(f);
    return !newCanonical.some((n) =>
      old.startsWith(n + "/") || n.startsWith(old + "/")
    );
  });
}

export interface InstallOptions {
  /**
   * runs after apply in the same lock section; receives the install uncommitted
   * and must commit or roll it back, and one left pending is committed.
   */
  underLock?: (pending: PendingInstall) => Promise<void>;
}

export type InstallExtensionFn = (
  ref: ExtensionRef,
  ctx: InstallContext,
  options?: InstallOptions,
) => Promise<InstallResult | undefined>;

/**
 * a ConflictError leaves the locked section before reaching the caller, so the
 * lock is never held across the CLI's conflict prompt; the install is committed
 * before the lock is released.
 */
export async function installExtension(
  ref: ExtensionRef,
  ctx: InstallContext,
  options?: InstallOptions,
): Promise<InstallResult | undefined> {
  return await installLocked(ref, ctx, async (pending) => {
    try {
      await options?.underLock?.(pending);
    } finally {
      await pending.commit();
    }
    return pending.result;
  });
}

/**
 * the parent's PendingInstall owns the handle, so rolling back the parent also
 * removes the dependency.
 */
async function installDependencyPending(
  ref: ExtensionRef,
  ctx: InstallContext,
): Promise<PendingInstall | undefined> {
  return await installLocked(ref, ctx, (pending) => Promise.resolve(pending));
}

async function installLocked<T>(
  ref: ExtensionRef,
  ctx: InstallContext,
  withPending: (pending: PendingInstall) => Promise<T>,
): Promise<T | undefined> {
  if (ctx.alreadyPulled.has(ref.name)) {
    return undefined;
  }

  if (ctx.depth > MAX_DEPENDENCY_DEPTH) {
    throw new UserError(
      `Dependency depth exceeds maximum of ${MAX_DEPENDENCY_DEPTH}. Possible circular dependency.`,
    );
  }

  ctx.alreadyPulled.add(ref.name);

  const prepared = await prepareInstall(ref, ctx);
  try {
    // a managed lockfile's transaction takes the datastore global lock and
    // fetches the shared lockfile before the pulled-extensions lock, and
    // publishes after it; without one the section runs directly.
    return await inManagedLockfileTransaction(
      ctx.lockfileRepository.lockfilePath,
      () =>
        pulledExtensionsLock.withLock(ctx.repoDir, async () => {
          await ctx.lockfileRepository.refresh();
          return await withPending(await applyInstall(prepared, ctx));
        }),
    );
  } finally {
    await prepared.dispose();
  }
}

interface PreparedInstallFields {
  ref: ExtensionRef;
  version: string;
  extInfo: ExtensionRegistryInfo;
  localChecksum: string;
  integrityStatus: "verified" | "unverified";
  manifest: ExtensionManifest;
  manifestContent: string;
  tmpDir: string;
  extractDir: string;
  safetyWarnings: ExtensionSafetyWarning[];
  publishedChannel: string | null;
  knownChannels: ReadonlyMap<string, string>;
  rootSources: string[];
  keepArchiveBundles: boolean;
}

/**
 * owns the temp dir, so callers must await dispose. Private fields stop
 * look-alike objects type-checking, so applyInstall only receives an archive
 * that passed prepare's checks.
 */
class PreparedInstall {
  readonly ref: ExtensionRef;
  readonly version: string;
  readonly extInfo: ExtensionRegistryInfo;
  readonly localChecksum: string;
  readonly integrityStatus: "verified" | "unverified";
  readonly manifest: ExtensionManifest;
  readonly manifestContent: string;
  readonly extractDir: string;
  readonly safetyWarnings: ExtensionSafetyWarning[];
  readonly publishedChannel: string | null;
  readonly knownChannels: ReadonlyMap<string, string>;
  readonly rootSources: string[];
  readonly keepArchiveBundles: boolean;
  readonly #tmpDir: string;
  #disposed = false;

  constructor(fields: PreparedInstallFields) {
    this.ref = fields.ref;
    this.version = fields.version;
    this.extInfo = fields.extInfo;
    this.localChecksum = fields.localChecksum;
    this.integrityStatus = fields.integrityStatus;
    this.manifest = fields.manifest;
    this.manifestContent = fields.manifestContent;
    this.#tmpDir = fields.tmpDir;
    this.extractDir = fields.extractDir;
    this.safetyWarnings = fields.safetyWarnings;
    this.publishedChannel = fields.publishedChannel;
    this.knownChannels = fields.knownChannels;
    this.rootSources = fields.rootSources;
    this.keepArchiveBundles = fields.keepArchiveBundles;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      await Deno.remove(this.#tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * copyDir treats a missing source as empty, so applying a vanished archive
   * would record a hollow install and prune the prior version's files. Guards a
   * stale or disposed handle, not a dir removed mid-apply.
   */
  async assertUsable(): Promise<void> {
    if (this.#disposed) {
      throw new Error(
        `Prepared install of ${this.ref.name} was already disposed`,
      );
    }
    try {
      await Deno.stat(this.extractDir);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw markErrorPaths(
          new Error(
            `Prepared install of ${this.ref.name} lost its extract dir ${this.extractDir}`,
          ),
          [this.extractDir],
        );
      }
      throw error;
    }
  }
}

export type { PreparedInstall };

/**
 * a lockfile entry alone is not enough: a managed lockfile can list an
 * extension whose files another checkout holds.
 */
async function isInstalledOnDisk(
  repoDir: string,
  name: string,
): Promise<boolean> {
  return await pathExistsNoFollow(
    extensionInstallRoots(repoDir, name).extensionRoot,
  );
}

/**
 * when the lookup cannot place the incoming version, a replacement fails (what
 * it replaces cannot be stated) and a first install warns and proceeds with the
 * channel unknown; an unresolved channel is never guessed.
 */
async function resolvePublishedChannels(
  ref: ExtensionRef,
  version: string,
  extInfo: ExtensionRegistryInfo,
  ctx: InstallContext,
): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  const fromLatest = (v: string): string | null => {
    if (v === extInfo.latestVersion) return "stable";
    if (v === extInfo.latestRc) return "rc";
    if (v === extInfo.latestBeta) return "beta";
    return null;
  };

  // whether this replaces an install decides if a lookup failure is fatal;
  // applyInstall decides it the same way under the lock.
  const replacing = await isInstalledOnDisk(ctx.repoDir, ref.name);
  const entry = ctx.lockfileRepository.getEntry(ref.name);
  const installedVersion = replacing && entry?.version &&
      !isVersionConstraint(entry.version)
    ? entry.version
    : null;

  const wanted: string[] = [];
  for (const v of installedVersion ? [version, installedVersion] : [version]) {
    const channel = fromLatest(v);
    if (channel) known.set(v, channel);
    else if (!wanted.includes(v)) wanted.push(v);
  }
  if (wanted.length === 0 || !ctx.getVersionChannels) return known;

  let found: Map<string, string> | null = null;
  let reason = "the registry lists it on no release channel";
  try {
    found = await ctx.getVersionChannels(ref.name, wanted);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  for (const [v, channel] of found ?? []) {
    // Registry data is shown to the user: only a channel name counts.
    if (wanted.includes(v) && ReleaseChannel.isValid(channel)) {
      known.set(v, channel);
    }
  }
  if (!known.has(version)) {
    if (replacing) {
      throw new UserError(
        `Could not determine which release channel ${ref.name}@${version} is published on (${reason}), so what it would replace cannot be stated. Nothing was changed. Retry when the registry is reachable, or pull without an exact version to install the latest on a channel.`,
      );
    }
    if (ctx.logger) {
      ctx.logger
        .warn`Could not determine which release channel ${ref.name}@${version} is published on: ${reason}`;
    }
  }
  return known;
}

export async function prepareInstall(
  ref: ExtensionRef,
  ctx: InstallContext,
  opts: { tempRoot?: string } = {},
): Promise<PreparedInstall> {
  const { logger } = ctx;

  const extInfo = await ctx.getExtension(ref.name);
  if (!extInfo) {
    throw new UserError(
      `Extension ${ref.name} not found in the registry.`,
    );
  }

  const version = ref.version ?? extInfo.latestVersion;
  if (!version) {
    const channels: string[] = [];
    if (extInfo.latestRc) channels.push("rc");
    if (extInfo.latestBeta) channels.push("beta");
    if (channels.length > 0) {
      throw new UserError(
        `Extension ${ref.name} has no stable version. Use --channel ${
          channels[0]
        } to pull the latest ${channels[0]}.`,
      );
    }
    throw new UserError(
      `Extension ${ref.name} has no published versions.`,
    );
  }

  const knownChannels = await resolvePublishedChannels(
    ref,
    version,
    extInfo,
    ctx,
  );
  const publishedChannel = knownChannels.get(version) ?? null;

  const archiveBytes = await ctx.downloadArchive(
    ref.name,
    version,
    ctx.channel,
  );
  // Checked here as well as in the HTTP client so every download source is
  // bounded before its bytes reach the temp dir.
  if (archiveBytes.byteLength > MAX_EXTENSION_ARCHIVE_BYTES) {
    throw new UserError(
      `Extension archive ${ref.name}@${version} is ${
        formatArchiveBytes(archiveBytes.byteLength)
      }, over the ${
        formatArchiveBytes(MAX_EXTENSION_ARCHIVE_BYTES)
      } archive size limit. This version cannot be installed; ask the extension author to publish a smaller archive.`,
    );
  }

  const serverChecksum = await ctx.getChecksum(ref.name, version, ctx.channel);
  const localChecksum = await computeChecksum(archiveBytes);
  let integrityStatus: "verified" | "unverified";
  if (serverChecksum !== null) {
    verifyChecksum(serverChecksum, localChecksum);
    integrityStatus = "verified";
  } else {
    integrityStatus = "unverified";
  }

  // lockfile-restore flows only: catches registry content drift since the user
  // originally installed this version.
  if (ctx.expectedChecksum !== undefined) {
    if (ctx.expectedChecksum !== localChecksum) {
      throw new UserError(
        `Checksum mismatch for ${ref.name}@${version} ` +
          `(stored ${ctx.expectedChecksum}, fetched ${localChecksum}). ` +
          `The registry content has changed since your original install. ` +
          `Run 'swamp extension pull ${ref.name}' to accept the current ` +
          `version, or 'swamp extension pull ${ref.name}@<pinned-version>' ` +
          `to hold a specific release.`,
      );
    }
    integrityStatus = "verified";
    if (logger) {
      logger.debug`Lockfile integrity verified for ${ref.name}@${version}`;
    }
  } else if (logger) {
    // entries without a stored checksum skip verification; the next install
    // writes one.
    logger
      .debug`No stored checksum for ${ref.name}@${version}; skipping lockfile-anchored verification`;
  }

  const tmpDir = await Deno.makeTempDir({
    prefix: "swamp_pull_",
    dir: opts.tempRoot,
  });
  const readOptions = {
    maxDecompressedBytes: MAX_EXTENSION_ARCHIVE_DECOMPRESSED_BYTES,
  };
  const archiveReadError = (action: string, error: unknown): UserError => {
    if (error instanceof ArchiveSizeLimitError) {
      return new UserError(
        `Extension archive ${ref.name}@${version} decompresses past the ${
          formatArchiveBytes(error.maxDecompressedBytes)
        } decompressed archive size limit. This version cannot be installed; ask the extension author to publish a smaller archive.`,
      );
    }
    // The extractor's message can name an archive entry, so it is printed
    // with control characters escaped and its paths marked as printed.
    const message = escapeControlCharacters(
      error instanceof Error ? error.message : String(error),
    );
    return markErrorPaths(
      new UserError(`Failed to ${action}: ${message}`),
      errorPaths(error).map(escapeControlCharacters),
    );
  };
  try {
    const archivePath = join(tmpDir, "extension.tar.gz");
    await Deno.writeFile(archivePath, archiveBytes);

    let archiveEntries: string[];
    try {
      const listFile = await Deno.open(archivePath, { read: true });
      archiveEntries = await listTarGzEntries(listFile.readable, readOptions);
    } catch (error: unknown) {
      throw archiveReadError("list archive contents", error);
    }
    for (const entry of archiveEntries) {
      if (entry.includes("..") || entry.startsWith("/")) {
        const path = escapeControlCharacters(entry);
        throw markErrorPaths(
          new UserError(`Archive contains unsafe path: ${path}`),
          [path],
        );
      }
    }

    // Every entry's header, checked before the entry is written: a link
    // or a refused shared source stops extraction, so nothing of it lands
    // in the temp dir.
    const extractedEntries: ArchiveEntry[] = [];
    let refused: UserError | undefined;
    try {
      const extractFile = await Deno.open(archivePath, { read: true });
      await extractTarGz(
        extractFile.readable,
        tmpDir,
        (entry) => {
          const archiveEntry: ArchiveEntry = {
            path: entry.archivePath,
            kind: entry.kind,
          };
          const refusal = archiveEntryRefusal(archiveEntry);
          if (refusal) {
            refused = archiveRefusalError(ref.name, version, refusal);
            throw refused;
          }
          extractedEntries.push(archiveEntry);
        },
        readOptions,
      );
    } catch (error: unknown) {
      if (refused !== undefined && error === refused) throw error;
      throw archiveReadError("extract archive", error);
    }
    const { sources: rootSources } = planArchiveRootSources(extractedEntries);

    const extractDir = join(tmpDir, "extension");

    for (const entry of archiveEntries) {
      if (logger) {
        logger.debug`Archive contains: ${entry}`;
      }
    }

    // the header check refused every link before it was written; this repeats
    // the last check push makes on its staged tree.
    const extractedLink = await firstSymlinkUnder(extractDir);
    if (extractedLink !== undefined) {
      const refusal = archiveEntryRefusal({
        path: relative(tmpDir, extractedLink).split(SEPARATOR).join("/"),
        kind: "symlink",
      });
      if (refusal) throw archiveRefusalError(ref.name, version, refusal);
    }

    let manifestContent: string;
    try {
      manifestContent = await Deno.readTextFile(
        join(extractDir, "manifest.yaml"),
      );
    } catch {
      throw new UserError(
        "Downloaded archive is missing manifest.yaml. The extension may be corrupt.",
      );
    }
    const manifest = parseExtensionManifest(manifestContent);

    const safetyWarnings: ExtensionSafetyWarning[] = [];
    const modelTsFiles = (await listFiles(join(extractDir, "models"))).filter(
      (f) => f.endsWith(".ts"),
    );
    const vaultTsFiles = (await listFiles(join(extractDir, "vaults"))).filter(
      (f) => f.endsWith(".ts"),
    );
    const datastoreTsFiles = (
      await listFiles(join(extractDir, "datastores"))
    ).filter((f) => f.endsWith(".ts"));
    const reportTsFiles = (await listFiles(join(extractDir, "reports"))).filter(
      (f) => f.endsWith(".ts"),
    );
    const webhookTsFiles = (
      await listFiles(join(extractDir, "webhooks"))
    ).filter((f) => f.endsWith(".ts"));
    // archive-root shared sources are scanned whole, data modules included, as
    // push scans them.
    const rootSourceFiles = rootSources.map((source) =>
      join(extractDir, ...source.split("/"))
    );
    const tsFiles = [
      ...modelTsFiles,
      ...vaultTsFiles,
      ...datastoreTsFiles,
      ...reportTsFiles,
      ...webhookTsFiles,
      ...rootSourceFiles,
    ];
    if (tsFiles.length > 0) {
      const safetyResult = await analyzeExtensionSafety(tsFiles);

      if (safetyResult.errors.length > 0) {
        throw markErrorPaths(
          new UserError(
            `Extension has safety errors. Install aborted.\n${
              safetyResult.errors.map((e) => `  ${e.file}: ${e.message}`).join(
                "\n",
              )
            }`,
          ),
          safetyResult.errors.map((e) => e.file),
        );
      }

      safetyWarnings.push(...safetyResult.warnings);
    }

    // the bundles are what runs, so scan them as well as the source copy, which
    // may lack modules a bundle holds.
    const bundleScan = await scanExtractedBundles(extractDir, listFiles);
    if (bundleScan.errors.length > 0) {
      throw markErrorPaths(
        new UserError(
          `Extension bundle has safety errors. Install aborted.\n${
            describeBundleErrors(bundleScan.errors)
          }`,
        ),
        bundleScan.errors.map((e) => e.file),
      );
    }
    for (
      const warning of bundleDependencyWarnings(bundleScan.dependencyIssues)
    ) {
      safetyWarnings.push(warning);
    }

    // the bundles kept are the ones just scanned: check them against the hashes
    // push recorded with them.
    const recordCheck = checkBundleRecord(
      bundleScan.hashes,
      await Deno.readTextFile(
        join(extractDir, DEPENDENCY_AUDIT_RECORD_FILENAME),
      ).catch((error: unknown) => {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      }),
    );
    if (recordCheck.refusals.length > 0) {
      throw new UserError(
        `Extension bundles do not match the archive's dependency audit record. Install aborted.\n${
          recordCheck.refusals.map((r) => `  ${r}`).join("\n")
        }`,
      );
    }

    return new PreparedInstall({
      ref,
      version,
      extInfo,
      localChecksum,
      integrityStatus,
      manifest,
      manifestContent,
      tmpDir,
      extractDir,
      safetyWarnings,
      publishedChannel,
      knownChannels,
      rootSources,
      keepArchiveBundles: recordCheck.keepArchiveBundles,
    });
  } catch (error) {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
    throw error;
  }
}

export interface PendingInstall {
  readonly result: InstallResult;
  /**
   * never throws: whatever it cannot delete, the next install or removal cleans
   * up.
   */
  commit(): Promise<void>;
  /**
   * restores every lockfile entry in one write, then every root with
   * dependencies first; never throws, and the outcome says whether the previous
   * versions are back.
   */
  rollback(): Promise<InstallRollbackOutcome>;
}

class PendingInstallNode implements PendingInstall {
  readonly result: InstallResult;
  readonly #tx: ExtensionInstallTransaction;
  readonly #ctx: InstallContext;
  readonly #priorEntry: UpstreamExtensionEntry | null;
  readonly #writtenEntry: UpstreamExtensionEntry | null;
  readonly #skillCreatedPaths: string[];
  readonly #orphanCandidates: string[];
  readonly #children: PendingInstallNode[];
  readonly #onCommit: () => void;
  #state: "pending" | "committed" | "rolled-back" = "pending";
  #outcome: InstallRollbackOutcome | undefined;

  constructor(args: {
    result: InstallResult;
    tx: ExtensionInstallTransaction;
    ctx: InstallContext;
    priorEntry: UpstreamExtensionEntry | null;
    writtenEntry: UpstreamExtensionEntry | null;
    skillCreatedPaths: string[];
    orphanCandidates: string[];
    children: PendingInstall[];
    onCommit: () => void;
  }) {
    this.result = args.result;
    this.#tx = args.tx;
    this.#ctx = args.ctx;
    this.#priorEntry = args.priorEntry;
    this.#writtenEntry = args.writtenEntry;
    this.#skillCreatedPaths = args.skillCreatedPaths;
    this.#orphanCandidates = args.orphanCandidates;
    this.#children = args.children.filter((c) =>
      c instanceof PendingInstallNode
    );
    this.#onCommit = args.onCommit;
  }

  #pendingNodes(): PendingInstallNode[] {
    if (this.#state !== "pending") return [];
    return [this, ...this.#children.flatMap((c) => c.#pendingNodes())];
  }

  async commit(): Promise<void> {
    // Dependencies first, so the claims the orphan prune reads are final.
    for (const node of this.#pendingNodes().reverse()) {
      await node.#commitOwn();
    }
  }

  async #commitOwn(): Promise<void> {
    this.#state = "committed";
    await this.#tx.commit();
    this.#onCommit();
    try {
      for (
        const path of await pruneSkillOrphans(
          this.#orphanCandidates,
          this.result.name,
          this.#ctx,
        )
      ) {
        this.result.pruned.push(path);
      }
    } catch (error) {
      const { logger } = this.#ctx;
      if (logger) {
        logger
          .warn`Could not prune the skill files ${this.result.name} no longer ships: ${error}`;
      }
    }
  }

  async rollback(): Promise<InstallRollbackOutcome> {
    if (this.#outcome) return this.#outcome;
    const nodes = this.#pendingNodes();
    if (nodes.length === 0) {
      return { status: "kept", kept: this.#allNodes().map((n) => n.#change()) };
    }
    this.#outcome = await this.#rollbackNodes(nodes);
    return this.#outcome;
  }

  #allNodes(): PendingInstallNode[] {
    return [this, ...this.#children.flatMap((c) => c.#allNodes())];
  }

  #change(): InstallChange {
    return {
      name: this.result.name,
      version: this.result.version,
      priorVersion: this.#priorEntry?.version ?? null,
    };
  }

  async #rollbackNodes(
    nodes: PendingInstallNode[],
  ): Promise<InstallRollbackOutcome> {
    const lockfile = this.#ctx.lockfileRepository;
    const restore: Record<string, UpstreamExtensionEntry | null> = {};
    for (const node of nodes) restore[node.result.name] = node.#priorEntry;

    // The entries go back before any root does: from then on every
    // journal sees an entry that is not its install's, so a crash part-way
    // is recovered back too.
    let restored: "all" | "none" | "unknown";
    try {
      await lockfile.refresh();
      await lockfile.restoreEntries(restore);
      restored = "all";
    } catch (error) {
      const { logger } = this.#ctx;
      if (logger) {
        logger
          .warn`Could not restore the lockfile entries of ${this.result.name}: ${error}`;
      }
      // A throw does not prove nothing was written (releasing the lock
      // runs after the write), so read back what landed.
      restored = await PendingInstallNode.#readRestoreState(
        lockfile.lockfilePath,
        nodes,
        restore,
      );
    }

    if (restored === "none") {
      for (const node of [...nodes].reverse()) await node.#commitOwn();
      return { status: "kept", kept: nodes.map((node) => node.#change()) };
    }
    if (restored === "unknown") {
      for (const node of nodes) {
        node.#state = "rolled-back";
        node.#tx.release();
      }
      return { status: "unsettled", lockfilePath: lockfile.lockfilePath };
    }

    let settled = true;
    for (const node of [...nodes].reverse()) {
      node.#state = "rolled-back";
      if (!await node.#tx.rollback()) settled = false;
      await deleteCreatedPaths(node.#skillCreatedPaths, this.#ctx);
    }
    return settled
      ? { status: "rolled-back", reverted: nodes.map((node) => node.#change()) }
      : { status: "unsettled", lockfilePath: lockfile.lockfilePath };
  }

  static async #readRestoreState(
    lockfilePath: string,
    nodes: PendingInstallNode[],
    restore: Record<string, UpstreamExtensionEntry | null>,
  ): Promise<"all" | "none" | "unknown"> {
    let onDisk: LockfileRepository;
    try {
      onDisk = await LockfileRepository.create(lockfilePath);
    } catch {
      return "unknown";
    }
    const holds = (name: string, entry: UpstreamExtensionEntry | null) =>
      JSON.stringify(onDisk.getEntry(name)) === JSON.stringify(entry);
    if (nodes.every((n) => holds(n.result.name, restore[n.result.name]))) {
      return "all";
    }
    if (nodes.every((n) => holds(n.result.name, n.#writtenEntry))) {
      return "none";
    }
    return "unknown";
  }
}

/**
 * unlinks a symlink rather than following it; best-effort, since the caller is
 * undoing an install.
 */
async function deleteCreatedPaths(
  paths: ReadonlyArray<string>,
  ctx: InstallContext,
): Promise<void> {
  for (const file of paths) {
    const absolutePath = join(ctx.repoDir, file);
    try {
      const stat = await Deno.lstat(absolutePath);
      await Deno.remove(absolutePath, { recursive: stat.isDirectory });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        if (ctx.logger) {
          ctx.logger.warn`Could not remove ${absolutePath}: ${error}`;
        }
      }
    }
  }
}

/**
 * claims are the other entries' as the lockfile holds them now, so a dependency
 * that merged files into a dropped skill dir keeps them. The walk never
 * descends a symlink, so it cannot leave the repo.
 */
async function pruneSkillOrphans(
  candidates: ReadonlyArray<string>,
  selfName: string,
  ctx: InstallContext,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  await ctx.lockfileRepository.refresh();
  const listed = Object.entries(ctx.lockfileRepository.getAllEntries())
    .filter(([name]) => name !== selfName)
    .flatMap(([, entry]) => entry.files ?? []);
  const claimedWhole = (path: string) =>
    listed.some((f) => pathCovers(f, path));
  const claimedUnder = (path: string) =>
    listed.some((f) => pathCovers(path, f));

  const unclaimedUnder = async (dir: string): Promise<string[]> => {
    const absolute = join(ctx.repoDir, dir);
    const stat = await lstatOrNull(absolute);
    if (!stat?.isDirectory) return [];
    const out: string[] = [];
    for await (const entry of Deno.readDir(absolute)) {
      const path = posixJoin(dir, entry.name);
      if (claimedWhole(path)) continue;
      if (!claimedUnder(path)) {
        out.push(path);
      } else {
        for (const inner of await unclaimedUnder(path)) out.push(inner);
      }
    }
    return out;
  };

  const toPrune: string[] = [];
  for (const candidate of candidates) {
    if (claimedWhole(candidate)) continue;
    if (!claimedUnder(candidate)) {
      toPrune.push(candidate);
    } else {
      for (const path of await unclaimedUnder(candidate)) toPrune.push(path);
    }
  }
  return await pruneOrphanFiles(toPrune, ctx.repoDir);
}

function installedIdentity(
  name: string,
  entry: UpstreamExtensionEntry | null,
  extensionRoot: string,
  knownChannels: ReadonlyMap<string, string>,
): ExtensionIdentity | null {
  if (entry) {
    return {
      version: entry.version,
      channel: entry.channel ?? "stable",
      publishedChannel: knownChannels.get(entry.version) ??
        readPublishedChannel(entry),
    };
  }
  const manifest = readManifestIdentityAt(join(extensionRoot, "manifest.yaml"));
  if (manifest && manifest.name === name) {
    return { version: manifest.version, channel: null, publishedChannel: null };
  }
  return null;
}

const EXTENSION_ROOT_ENTRIES = new Set([
  "models",
  "workflows",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
  "files",
  "manifest.yaml",
]);

/**
 * a journal written first lets a crash at any point be put right. The swap
 * replaces roots whole, carrying user-added files forward; a failure after
 * staging is rolled back unless its lockfile entry landed.
 */
export async function applyInstall(
  prepared: PreparedInstall,
  ctx: InstallContext,
): Promise<PendingInstall> {
  if (!(prepared instanceof PreparedInstall)) {
    throw new Error(
      "applyInstall requires a PreparedInstall from prepareInstall",
    );
  }
  await prepared.assertUsable();

  const { logger, repoDir } = ctx;
  const {
    ref,
    version,
    extInfo,
    localChecksum,
    integrityStatus,
    manifest,
    manifestContent,
    extractDir,
    safetyWarnings,
  } = prepared;

  // Put right any install a crashed process left half done before this
  // one reads the tree it replaces.
  const recovery = await recoverPulledExtensionStagingLocked(repoDir, {
    lockfilePaths: [ctx.lockfileRepository.lockfilePath],
  });
  assertNoBlockingJournal(recovery, repoDir, ref.name, "install");

  const oldEntry = ctx.lockfileRepository.getEntry(ref.name);
  const oldFiles = oldEntry?.files ?? [];

  // each extension owns a subtree under .swamp/pulled-extensions/<name>/, which
  // prevents cross-extension filename collisions; skills fan out to
  // ctx.skillsDirs.
  const installRoots = extensionInstallRoots(repoDir, ref.name);
  const absoluteExtRoot = installRoots.extensionRoot;
  const absoluteModelsDir = join(absoluteExtRoot, "models");
  const absoluteWorkflowsDir = join(absoluteExtRoot, "workflows");
  const absoluteVaultsDir = join(absoluteExtRoot, "vaults");
  const absoluteDatastoresDir = join(absoluteExtRoot, "datastores");
  const absoluteReportsDir = join(absoluteExtRoot, "reports");
  const absoluteWebhooksDir = join(absoluteExtRoot, "webhooks");
  const absoluteFilesDir = join(absoluteExtRoot, "files");
  const bundleRootOf = (sourceKind: string): string => {
    const root = installRoots.bundleRoots.find((r) =>
      r.sourceKind === sourceKind
    );
    if (!root) throw new Error(`No bundle root for ${sourceKind}`);
    return root.live;
  };
  const bundlesDir = bundleRootOf("models");
  const vaultBundlesDir = bundleRootOf("vaults");
  const datastoreBundlesDir = bundleRootOf("datastores");
  const reportBundlesDir = bundleRootOf("reports");
  const webhookBundlesDir = bundleRootOf("webhooks");

  const conflicts = await detectConflicts(
    extractDir,
    absoluteModelsDir,
    absoluteWorkflowsDir,
    bundlesDir,
    repoDir,
    absoluteVaultsDir,
    vaultBundlesDir,
    absoluteDatastoresDir,
    datastoreBundlesDir,
    absoluteReportsDir,
    reportBundlesDir,
    absoluteFilesDir,
    absoluteWebhooksDir,
    webhookBundlesDir,
  );
  for (
    const conflict of await detectRootSourceConflicts(
      prepared.rootSources,
      absoluteExtRoot,
      repoDir,
    )
  ) {
    conflicts.push(conflict);
  }
  // only the top-level extension raises skill conflicts: a dependency installs
  // after its parent's lockfile entry is written, so failing there would leave
  // the operation half done.
  const skillConflicts = ctx.depth === 0
    ? await detectSkillConflicts(
      extractDir,
      ctx.skillsDirs,
      oldFiles,
      repoDir,
    )
    : [];
  conflicts.push(...skillConflicts);

  const followedChannel = ctx.channel ?? "stable";
  // Conflicts alone (a user's skill dir, stray files) do not make this a
  // replacement: nothing of this extension is installed to describe.
  const replacement = await isInstalledOnDisk(repoDir, ref.name)
    ? ExtensionReplacement.create({
      name: ref.name,
      current: installedIdentity(
        ref.name,
        oldEntry,
        absoluteExtRoot,
        prepared.knownChannels,
      ),
      incoming: {
        version,
        channel: followedChannel,
        publishedChannel: prepared.publishedChannel,
      },
    })
    : null;

  if (conflicts.length > 0 && !ctx.force) {
    throw new ConflictError(
      conflicts,
      skillConflicts,
      replacement ?? undefined,
    );
  }

  if (replacement) ctx.onReplacing?.(replacement);
  if (
    prepared.publishedChannel !== null &&
    ReleaseChannel.isPrereleaseName(prepared.publishedChannel) &&
    followedChannel === "stable"
  ) {
    ctx.onUnoptedPrerelease?.({
      name: ref.name,
      version,
      publishedChannel: prepared.publishedChannel,
      parent: ctx.parentName ?? null,
    });
  }

  // Entries nested under this one keep their own roots inside ours.
  // The swap replaces this root whole, so each one on disk is copied
  // into the new root unchanged.
  const nestedRelDirs = nestedEntryRelDirs(
    ref.name,
    Object.keys(ctx.lockfileRepository.getAllEntries()),
  );
  const nestedToCopy: string[] = [];
  // The other direction: installed under an extension whose root it
  // lives in, this one must not land on that extension's kind dir, or
  // the swap would move the parent's files aside and commit would delete
  // them.
  for (const ancestor of await installedAncestors(ref.name, ctx)) {
    const first = ref.name.slice(ancestor.length + 1).split("/")[0];
    if (EXTENSION_ROOT_ENTRIES.has(first)) {
      throw new UserError(
        `Cannot install ${ref.name}: its files would go to ` +
          `${ancestor}/${first}/, where the installed extension ` +
          `${ancestor} keeps its own files. Run ` +
          `\`swamp extension rm ${ancestor}\` first.`,
      );
    }
    if (await ancestorKeepsSourcesAt(ancestor, first, ctx)) {
      throw new UserError(
        `Cannot install ${ref.name}: its files would go to ` +
          `${ancestor}/${first}/, where the installed extension ` +
          `${ancestor} keeps its shared sources. Run ` +
          `\`swamp extension rm ${ancestor}\` first.`,
      );
    }
  }
  const rootSourceDirs = new Set(archiveRootSourceDirs(prepared.rootSources));
  for (const relDir of nestedRelDirs) {
    const first = relDir.split("/")[0];
    if (EXTENSION_ROOT_ENTRIES.has(first)) {
      throw new UserError(
        `Cannot install ${ref.name}: the installed extension ` +
          `${ref.name}/${relDir} lives at ${first}/ inside its root, where ` +
          `${ref.name} keeps its own files. Run ` +
          `\`swamp extension rm ${ref.name}/${relDir}\` first.`,
      );
    }
    if (rootSourceDirs.has(first)) {
      throw new UserError(
        `Cannot install ${ref.name}: the installed extension ` +
          `${ref.name}/${relDir} lives at ${first}/ inside its root, where ` +
          `${ref.name} keeps its shared sources. Run ` +
          `\`swamp extension rm ${ref.name}/${relDir}\` first.`,
      );
    }
    if (nestedToCopy.some((outer) => relDir.startsWith(`${outer}/`))) {
      continue;
    }
    if (await isPlainDir(join(absoluteExtRoot, relDir))) {
      nestedToCopy.push(relDir);
    }
  }

  const manifestWithHeader =
    "# Read-only; regenerate via 'swamp extension pull'\n" + manifestContent;
  const bundleHasNew = new Map<string, boolean>();
  for (const { bundleKind, sourceKind } of EXTENSION_BUNDLE_KINDS) {
    bundleHasNew.set(
      bundleRootOf(sourceKind),
      (await listFiles(join(extractDir, bundleKind))).length > 0,
    );
  }
  // A symlinked extension root is replaced by the swap, not written
  // through; its target is left as it is.
  const replacedLinkTarget = await readLinkOrNull(absoluteExtRoot);
  const tx = await ExtensionInstallTransaction.begin({
    repoDir: resolve(repoDir),
    pulledRoot: resolvePulledExtensionsRoot(resolve(repoDir)),
    extensionName: ref.name,
    lockfilePath: ctx.lockfileRepository.lockfilePath,
    newChecksum: localChecksum,
    newManifestDigest: await computeChecksum(
      new TextEncoder().encode(manifestWithHeader),
    ),
    roots: [
      { role: "extension", live: absoluteExtRoot, hasNew: true },
      ...installRoots.bundleRoots.map((r) => ({
        role: "bundle" as const,
        live: r.live,
        hasNew: bundleHasNew.get(r.live) ?? false,
      })),
    ],
    nestedRoots: nestedToCopy.map((relDir) => ({
      relDir,
      strategy: "copied" as const,
    })),
  });

  // set once this install's own lockfile write completes: a same-version
  // reinstall finds the prior entry already carrying its checksum, so only this
  // flag says the entry landed.
  let lockfileWritten = false;
  const dependencies: PendingInstall[] = [];
  try {
    const stagedExtRoot = tx.newPathOf(absoluteExtRoot);
    const extractedFiles: string[] = [];
    const stage = async (archiveDir: string, liveDir: string) => {
      const stagedDir = liveDir.startsWith(absoluteExtRoot + SEPARATOR)
        ? join(stagedExtRoot, relative(absoluteExtRoot, liveDir))
        : bundleHasNew.get(liveDir)
        ? tx.newPathOf(liveDir)
        : undefined;
      if (stagedDir === undefined) return;
      await Deno.mkdir(stagedDir, { recursive: true });
      const copied = await copyDir(
        join(extractDir, archiveDir),
        stagedDir,
        repoDir,
        liveDir,
      );
      for (const path of copied) extractedFiles.push(path);
    };
    // sources before their bundles, so staged bundles are never older than the
    // sources they were built from.
    await stage("models", absoluteModelsDir);
    await stage("workflows", absoluteWorkflowsDir);
    await stage("bundles", bundlesDir);
    await stage("vaults", absoluteVaultsDir);
    await stage("vault-bundles", vaultBundlesDir);
    await stage("datastores", absoluteDatastoresDir);
    await stage("datastore-bundles", datastoreBundlesDir);
    await stage("reports", absoluteReportsDir);
    await stage("report-bundles", reportBundlesDir);
    await stage("webhooks", absoluteWebhooksDir);
    await stage("webhook-bundles", webhookBundlesDir);
    await stage("files", absoluteFilesDir);
    // shared sources push placed at the archive root go to the same path under
    // the extension root, so relative imports resolve as they do in the
    // archive.
    for (const source of prepared.rootSources) {
      // The plan refuses `..`, hidden segments and backslashes; check the
      // destination and source lexically as well before copying.
      assertContainedPath(source, stagedExtRoot);
      assertContainedPath(source, extractDir);
      const segments = source.split("/");
      const stagedPath = join(stagedExtRoot, ...segments);
      await Deno.mkdir(dirname(stagedPath), { recursive: true });
      await Deno.copyFile(join(extractDir, ...segments), stagedPath);
      extractedFiles.push(
        lockfileRelative(repoDir, join(absoluteExtRoot, ...segments)),
      );
    }

    if (Deno.build.os !== "windows" && manifest.binaries.length > 0) {
      for (const bin of manifest.binaries) {
        const binPath = join(stagedExtRoot, "files", bin);
        try {
          await Deno.chmod(binPath, 0o755);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          if (logger) {
            logger.debug`Failed to chmod binary ${bin}: ${error}`;
          }
        }
      }
    }

    for (const relDir of nestedToCopy) {
      await copyTreePreservingTimes(
        join(absoluteExtRoot, relDir),
        join(stagedExtRoot, relDir),
      );
    }

    // files the user added under the root are not in the archive, so the swap
    // would drop them; copy them into the new root.
    const extraFiles = await carryForwardUserFiles({
      liveRoot: absoluteExtRoot,
      stagedRoot: stagedExtRoot,
      repoDir,
      priorEntry: oldEntry,
      excludeRelDirs: nestedRelDirs,
    });
    // manifest.yaml is staged on its own and moved in last as a read-only copy,
    // so an installed extension describes itself on disk (extension rm reads it
    // to find dependents).
    await Deno.writeTextFile(tx.stagedManifestPath, manifestWithHeader);
    try {
      await Deno.chmod(tx.stagedManifestPath, 0o444);
    } catch {
      // chmod is advisory on some filesystems/platforms (notably Windows);
      // intent is documented via the file header, enforcement is best-effort.
    }

    await tx.swap();

    // a skill is tracked as its root when this extension owns the dir, else
    // file by file, so rm and orphan prune never delete the user's or another
    // extension's files. skillCreatedPaths is what a rollback may undo.
    let hasSkills = false;
    let hasSkillScripts = false;
    const skillFiles: string[] = [];
    const skillRecordedPaths: string[] = [];
    const skillCreatedPaths: string[] = [];
    const skillsSrc = join(extractDir, "skills");
    try {
      const skillEntries: Deno.DirEntry[] = [];
      for await (const entry of Deno.readDir(skillsSrc)) {
        skillEntries.push(entry);
      }
      if (skillEntries.length > 0) {
        hasSkills = true;
        for (const skillsDir of ctx.skillsDirs) {
          const absoluteSkillsDir = resolve(repoDir, skillsDir);
          await Deno.mkdir(absoluteSkillsDir, { recursive: true });
          for (const entry of skillEntries) {
            if (!entry.isDirectory) continue;
            const srcSkillDir = join(skillsSrc, entry.name);
            const destSkillDir = join(absoluteSkillsDir, entry.name);
            const skillDirRelative = lockfileRelative(repoDir, destSkillDir);
            const preExisted = await pathExistsNoFollow(destSkillDir);
            const filesBefore = preExisted
              ? new Set(
                (await listFilesAndLinks(destSkillDir)).map((f) =>
                  lockfileRelative(repoDir, f)
                ),
              )
              : new Set<string>();
            await Deno.mkdir(destSkillDir, { recursive: true });
            const extracted = await copyDir(
              srcSkillDir,
              destSkillDir,
              repoDir,
            );
            const canonicalRoot = canonicalClaimPath(skillDirRelative);
            const ownsRoot = oldFiles.some((f) =>
              canonicalClaimPath(f) === canonicalRoot
            );
            const recorded = !preExisted || ownsRoot
              ? [skillDirRelative]
              : extracted;
            extractedFiles.push(...recorded);
            skillRecordedPaths.push(...recorded);
            skillCreatedPaths.push(
              ...(preExisted
                ? extracted.filter((f) => !filesBefore.has(f))
                : [skillDirRelative]),
            );
            skillFiles.push(...extracted);
            if (
              logger && preExisted && !claimsPath(oldFiles, skillDirRelative)
            ) {
              logger
                .warn`Skill directory ${skillDirRelative} already existed; ${ref.name} wrote its files into it and may have overwritten some`;
            }

            if (!hasSkillScripts) {
              try {
                const scriptsDir = join(srcSkillDir, "scripts");
                const stat = await Deno.stat(scriptsDir);
                if (stat.isDirectory) {
                  hasSkillScripts = true;
                }
              } catch {
                // No scripts/ directory
              }
            }
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    const missingSourceFiles = await validateSourceCompleteness(
      absoluteModelsDir,
      absoluteVaultsDir,
      absoluteDatastoresDir,
      absoluteReportsDir,
      absoluteWebhooksDir,
    );

    extractedFiles.push(
      lockfileRelative(repoDir, join(absoluteExtRoot, "manifest.yaml")),
    );

    const includeFiles = manifest.include.length > 0
      ? manifest.include.map((inc) =>
        relative(repoDir, resolve(absoluteModelsDir, inc))
      )
      : undefined;

    // digest of exactly what the install produced, leaving out nested entries'
    // roots, computed before the lockfile write; auto-update uses it to refuse
    // overwriting local edits.
    const filesChecksum = await readInstalledExtensionDigest(absoluteExtRoot, {
      excludeRelDirs: nestedRelDirs,
    });

    // orphans under a swapped root are already gone and only reported; the rest
    // (skills) are pruned at commit. A path another lockfile entry also claims
    // is kept.
    const otherEntries = ctx.lockfileRepository.getAllEntries();
    const orphanDiff = computeOrphanDiff(oldFiles, extractedFiles).filter(
      (f) => findClaimants(f, ref.name, otherEntries).length === 0,
    );
    const swappedRoots = tx.journal.roots.map((r) => ({
      live: canonicalClaimPath(relative(repoDir, r.live)),
      liveAbs: r.live,
      old: r.old,
      // A moved-aside link still points at its untouched target, so
      // nothing under it was removed.
      liveExisted: r.liveExisted && !r.liveIsLink,
    }));
    const swappedRootOf = (f: string) => {
      const c = canonicalClaimPath(f);
      return swappedRoots.find((r) =>
        c === r.live || c.startsWith(r.live + "/")
      );
    };
    const pruned: string[] = [];
    const toPrune: string[] = [];
    for (const f of orphanDiff) {
      const root = swappedRootOf(f);
      if (!root) {
        toPrune.push(f);
      } else if (
        root.liveExisted &&
        await pathExistsNoFollow(
          join(root.old, relative(root.liveAbs, join(repoDir, f))),
        )
      ) {
        pruned.push(f);
      }
    }
    await ctx.lockfileRepository.writeEntry(
      ref.name,
      version,
      extractedFiles,
      {
        include: includeFiles,
        checksum: localChecksum,
        filesChecksum: filesChecksum ?? undefined,
        serverUrl: resolveServerUrl(),
        channel: ctx.channel,
        // A restore cannot always look the channel up; the same version
        // keeps the channel it was recorded with.
        publishedChannel: prepared.publishedChannel ??
          (oldEntry?.version === version
            ? readPublishedChannel(oldEntry) ?? undefined
            : undefined),
        pulledAt: oldEntry?.version === version ? oldEntry.pulledAt : undefined,
      },
    );
    lockfileWritten = true;
    const writtenEntry = ctx.lockfileRepository.getEntry(ref.name);

    // Reported when the install commits: a rollback puts the previous
    // root back, and with it whatever these say was replaced or removed.
    const reportCommitted = () => {
      const extRootRel = lockfileRelative(repoDir, absoluteExtRoot);
      if (logger && replacedLinkTarget !== null) {
        logger
          .warn`Replaced the symlink ${extRootRel} (to ${replacedLinkTarget}) with an installed copy of ${ref.name}@${version}; the link's target was not changed. Re-create the link to keep using it.`;
      }
      if (logger && extraFiles.unattributed.length > 0) {
        logger
          .warn`Removed ${extraFiles.unattributed.length} file(s) under ${extRootRel} that ${ref.name}@${version} does not ship. The lockfile entry does not describe the installed version, so they could not be told apart from files an earlier version shipped: ${
          extraFiles.unattributed.join(", ")
        }`;
      }
      if (logger && extraFiles.unkept.length > 0) {
        logger
          .warn`Removed ${extraFiles.unkept.length} path(s) under ${extRootRel} that could not be carried into ${ref.name}@${version}, being a symlink or under a file it ships: ${
          extraFiles.unkept.join(", ")
        }`;
      }
      if (logger && extraFiles.carried.length > 0) {
        logger
          .debug`Kept ${extraFiles.carried.length} file(s) added under ${extRootRel}: ${
          extraFiles.carried.join(", ")
        }`;
      }
    };

    // Skill orphans are pruned when the install commits, not here: a
    // rollback then finds the previous version's skill files still there.
    // A kill before the prune leaves only untracked orphan files, never
    // an entry claiming deleted ones.

    // A dependency cycle must not reinstall this extension over the tree
    // just written. installExtension() marks it before prepare; mark it
    // here too so a caller running prepare and apply directly is covered.
    ctx.alreadyPulled.add(ref.name);

    // dependency installs do network I/O inside apply, under this install's
    // lease: whether a dependency is needed is only known from the lockfile
    // read under the lock, so preparing earlier would download speculatively.
    const dependencyResults: InstallResult[] = [];
    if (manifest.dependencies.length > 0) {
      for (const dep of manifest.dependencies) {
        const depRef = parseExtensionRef(dep);
        if (ctx.alreadyPulled.has(depRef.name)) {
          continue;
        }

        // the repository reflects earlier writes in this loop. A managed
        // lockfile can list a dependency another checkout installed, so install
        // it at its pinned version; other lockfiles only list local installs.
        const lockedEntry = ctx.lockfileRepository.getEntry(depRef.name);
        const isInstalled = lockedEntry !== null &&
          (!isManagedLockfile(ctx.lockfileRepository.lockfilePath) ||
            await lockedFilesPresent(lockedEntry.files ?? [], ctx.repoDir));

        if (!isInstalled && lockedEntry !== null) {
          // Owned by this install like any other dependency: rolling it
          // back restores the pinned entry it replaced.
          const depPending = await installDependencyPending(
            { name: depRef.name, version: lockedEntry.version },
            {
              ...ctx,
              skillsDirs: ctx.dependencySkillsDirs ?? ctx.skillsDirs,
              depth: ctx.depth + 1,
              channel: lockedEntry.channel,
              expectedChecksum: lockedEntry.checksum,
              parentName: ref.name,
            },
          );
          if (depPending) {
            dependencies.push(depPending);
            dependencyResults.push(depPending.result);
          }
        } else if (!isInstalled) {
          // strip version constraints and pass null so the registry's latest
          // resolves; with no stable version, resolve from beta/rc so beta-only
          // extensions can satisfy a dependency.
          const hasConstraint = depRef.version != null &&
            isVersionConstraint(depRef.version);
          let depVersion: string | null = hasConstraint ? null : depRef.version;
          let depChannel: string | undefined = undefined;

          if (depVersion === null) {
            const depInfo = await ctx.getExtension(depRef.name);
            if (depInfo) {
              if (depInfo.latestVersion) {
                depVersion = depInfo.latestVersion;
              } else if (depInfo.latestBeta) {
                depVersion = depInfo.latestBeta;
                depChannel = "beta";
              } else if (depInfo.latestRc) {
                depVersion = depInfo.latestRc;
                depChannel = "rc";
              }
            }
          }

          const resolvedRef: ExtensionRef = {
            name: depRef.name,
            version: depVersion,
          };
          // expectedChecksum anchors the parent's archive only; a dependency
          // has no lockfile entry, so it is checked against the registry
          // checksum.
          const depPending = await installDependencyPending(resolvedRef, {
            ...ctx,
            skillsDirs: ctx.dependencySkillsDirs ?? ctx.skillsDirs,
            depth: ctx.depth + 1,
            channel: depChannel,
            expectedChecksum: undefined,
            parentName: ref.name,
          });
          if (depPending) {
            dependencies.push(depPending);
            dependencyResults.push(depPending.result);
          }
        }
      }
    }

    const extendsTypes = await scanForExtensionGrafts(absoluteModelsDir);
    const skillRecorded = new Set(skillRecordedPaths);

    const result: InstallResult = {
      name: ref.name,
      version,
      description: extInfo.description,
      extractedFiles,
      integrityStatus,
      repository: manifest.repository,
      platforms: manifest.platforms,
      safetyWarnings,
      binaries: manifest.binaries,
      conflicts,
      missingSourceFiles,
      hasSkills,
      hasSkillScripts,
      skillFiles,
      dependencies: manifest.dependencies,
      dependencyResults,
      extendsTypes,
      pruned,
      shadowedTypes: [],
      createdPaths: [
        ...extractedFiles.filter((f) => !skillRecorded.has(f)),
        ...skillCreatedPaths,
      ],
      channel: followedChannel,
      publishedChannel: prepared.publishedChannel,
      keepArchiveBundles: prepared.keepArchiveBundles,
      previous: replacement?.current ?? null,
      ...(replacement
        ? {
          change: replacement.change,
          channelChanged: replacement.channelChanged,
        }
        : {}),
    };
    return new PendingInstallNode({
      result,
      tx,
      ctx,
      priorEntry: oldEntry,
      writtenEntry,
      skillCreatedPaths,
      orphanCandidates: toPrune,
      children: dependencies,
      onCommit: reportCommitted,
    });
  } catch (error) {
    // Dependencies already applied stay installed, as the parent rolls
    // forward below once its entry has landed; a dependency whose own
    // apply failed has settled itself.
    for (const dependency of dependencies) await dependency.commit();
    // roll the swap back, or forward when the lockfile entry already landed.
    // Read from disk, except when the prior entry has the same checksum: then
    // only this install's completed write says it landed.
    await tx.settle(error, async () => {
      if (!lockfileWritten && oldEntry?.checksum === localChecksum) {
        return null;
      }
      return (await LockfileRepository.create(
        ctx.lockfileRepository.lockfilePath,
      )).getEntry(ref.name)?.checksum ?? null;
    });
    throw error;
  }
}

/** a path outside the repo is never read; such an entry is treated as present. */
async function lockedFilesPresent(
  files: readonly string[],
  repoDir: string,
): Promise<boolean> {
  for (const file of files) {
    try {
      assertContainedPath(file, repoDir);
    } catch (error) {
      if (error instanceof PathTraversalError) return true;
      throw error;
    }
    if (!await pathExistsNoFollow(join(repoDir, file))) return false;
  }
  return true;
}

async function installedAncestors(
  name: string,
  ctx: InstallContext,
): Promise<string[]> {
  const entries = new Set(Object.keys(ctx.lockfileRepository.getAllEntries()));
  const pulledRoot = resolvePulledExtensionsRoot(ctx.repoDir);
  const segments = name.split("/");
  const ancestors: string[] = [];
  for (let i = 2; i < segments.length; i++) {
    const ancestor = segments.slice(0, i).join("/");
    if (
      entries.has(ancestor) ||
      await pathExistsNoFollow(join(pulledRoot, ancestor, "manifest.yaml"))
    ) {
      ancestors.push(ancestor);
    }
  }
  return ancestors;
}

/**
 * keeps access and modification times so the nested entry's sources stay no
 * newer than its pre-built bundles; symlinks are skipped.
 */
async function copyTreePreservingTimes(
  srcDir: string,
  destDir: string,
): Promise<void> {
  await Deno.mkdir(destDir, { recursive: true });
  for await (const entry of Deno.readDir(srcDir)) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory) {
      await copyTreePreservingTimes(srcPath, destPath);
    } else if (entry.isFile) {
      await Deno.copyFile(srcPath, destPath);
      await copyTimes(srcPath, destPath);
    }
  }
  await copyTimes(srcDir, destDir);
}

/**
 * a file is the user's when the new archive does not ship it and the prior
 * entry does not list it. When the entry cannot describe the tree, nothing is
 * copied and such files are returned in unattributed.
 */
async function carryForwardUserFiles(opts: {
  liveRoot: string;
  stagedRoot: string;
  repoDir: string;
  priorEntry: UpstreamExtensionEntry | null;
  excludeRelDirs: ReadonlyArray<string>;
}): Promise<{ carried: string[]; unattributed: string[]; unkept: string[] }> {
  const { liveRoot, stagedRoot, repoDir, priorEntry, excludeRelDirs } = opts;
  const carried: string[] = [];
  const unattributed: string[] = [];
  const unkept: string[] = [];
  const result = { carried, unattributed, unkept };
  if (!await isPlainDir(liveRoot)) return result;

  const priorFiles = priorEntry?.files ?? [];
  const installed = readManifestIdentityAt(join(liveRoot, "manifest.yaml"));
  const attributable = priorFiles.length > 0 &&
    installed?.version === priorEntry?.version;
  const shippedBefore = new Set(priorFiles.map(canonicalClaimPath));
  const excluded = new Set(excludeRelDirs);

  // `blocked` is set once the staged tree has a non-directory where
  // this directory would go: nothing under it can be copied.
  const walk = async (relDir: string, blocked: boolean): Promise<void> => {
    for await (const entry of Deno.readDir(join(liveRoot, relDir))) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (rel === "manifest.yaml" || excluded.has(rel)) continue;
      const livePath = join(liveRoot, rel);
      const stagedPath = join(stagedRoot, rel);
      if (entry.isDirectory) {
        const staged = blocked ? null : await lstatOrNull(stagedPath);
        await walk(rel, blocked || (staged !== null && !staged.isDirectory));
        continue;
      }
      const repoRel = lockfileRelative(repoDir, livePath);
      if (!blocked && await lstatOrNull(stagedPath) !== null) continue;
      if (shippedBefore.has(canonicalClaimPath(repoRel))) continue;
      if (blocked || !entry.isFile) {
        unkept.push(repoRel);
        continue;
      }
      if (!attributable) {
        unattributed.push(repoRel);
        continue;
      }
      await Deno.mkdir(dirname(stagedPath), { recursive: true });
      await Deno.copyFile(livePath, stagedPath);
      await copyTimes(livePath, stagedPath);
      carried.push(repoRel);
    }
  };
  await walk("", false);
  return result;
}

async function readLinkOrNull(path: string): Promise<string | null> {
  const stat = await lstatOrNull(path);
  return stat?.isSymlink ? await Deno.readLink(path) : null;
}

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function copyTimes(src: string, dest: string): Promise<void> {
  const stat = await Deno.lstat(src);
  if (!stat.mtime) return;
  const atime = stat.atime ?? stat.mtime;
  try {
    await Deno.utime(dest, atime, stat.mtime);
  } catch (error) {
    // Windows refuses to set times on a read-only file, and copyFile
    // carries the attribute over (a nested entry's manifest.yaml is
    // installed 0o444). Lift it for the call, then put it back.
    if (
      Deno.build.os !== "windows" ||
      !(error instanceof Deno.errors.PermissionDenied) ||
      stat.isDirectory
    ) {
      throw error;
    }
    await Deno.chmod(dest, 0o666);
    try {
      await Deno.utime(dest, atime, stat.mtime);
    } finally {
      await Deno.chmod(dest, 0o444);
    }
  }
}

/**
 * without a lockfile entry only the tree can say: a dir there with no
 * manifest.yaml and no other entry under it is the ancestor's.
 */
async function ancestorKeepsSourcesAt(
  ancestor: string,
  first: string,
  ctx: InstallContext,
): Promise<boolean> {
  const dir = join(resolvePulledExtensionsRoot(ctx.repoDir), ancestor, first);
  const entry = ctx.lockfileRepository.getEntry(ancestor);
  if (entry) {
    return claimsPath(entry.files ?? [], relative(ctx.repoDir, dir));
  }
  const nested = `${ancestor}/${first}`;
  if (
    Object.keys(ctx.lockfileRepository.getAllEntries()).some((name) =>
      name === nested || name.startsWith(`${nested}/`)
    )
  ) {
    return false;
  }
  return await isPlainDir(dir) &&
    !await pathExistsNoFollow(join(dir, "manifest.yaml"));
}

async function isPlainDir(path: string): Promise<boolean> {
  try {
    const stat = await Deno.lstat(path);
    return stat.isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
export async function* extensionPull(
  ctx: LibSwampContext,
  deps: ExtensionPullDeps,
  input: ExtensionPullInput,
): AsyncIterable<ExtensionPullEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.pull",
    { "extension.name": input.ref.name },
    (async function* () {
      yield { kind: "installing" } as const;

      const prefetchedInfo = await deps.getExtension(input.ref.name);
      if (prefetchedInfo?.deprecatedAt != null) {
        yield {
          kind: "deprecated_warning" as const,
          name: input.ref.name,
          reason: prefetchedInfo.deprecationReason ?? null,
          supersededBy: prefetchedInfo.supersededBy ?? null,
        };
      }

      // the resolved ref always carries an explicit version, so
      // installExtension needs no channel awareness.
      let resolvedRef = input.ref;
      if (input.channel && !input.ref.version) {
        if (!deps.getLatestVersion) {
          throw new UserError(
            "Channel-aware pull requires getLatestVersion support.",
          );
        }
        const channelVersion = await deps.getLatestVersion(
          input.ref.name,
          input.channel,
        );
        if (!channelVersion) {
          throw new UserError(
            `Extension ${input.ref.name} has no published ${input.channel} versions.`,
          );
        }
        resolvedRef = { name: input.ref.name, version: channelVersion };
      }

      const installCtx: InstallContext = {
        getExtension: (name) =>
          name === input.ref.name && prefetchedInfo
            ? Promise.resolve(prefetchedInfo)
            : deps.getExtension(name),
        downloadArchive: deps.downloadArchive,
        getChecksum: deps.getChecksum,
        logger: ctx.logger,
        lockfileRepository: deps.lockfileRepository,
        skillsDirs: deps.skillsDirs,
        repoDir: deps.repoDir,
        force: input.force,
        alreadyPulled: deps.alreadyPulled,
        depth: deps.depth,
        channel: input.channel,
        getVersionChannels: deps.getVersionChannels,
        onReplacing: deps.onReplacing,
        onUnoptedPrerelease: deps.onUnoptedPrerelease,
      };

      // ConflictError propagates for the CLI's two-phase prompt. Routing: the
      // installExtensionFn test seam, then InstallExtensionService when
      // denoRuntime and repository are both set, else the free function.
      const denoRt = deps.denoRuntime;
      const repo = deps.repository;
      const install = deps.installExtensionFn ??
        (denoRt !== undefined && repo !== undefined
          ? (r: ExtensionRef, c: InstallContext) =>
            new InstallExtensionService({
              denoRuntime: denoRt,
              repository: repo,
              bundleProber: new ProcessBundleProber(),
            }).execute(r, c)
          : installExtension);
      const result = await install(resolvedRef, installCtx);
      if (result) {
        if (result.pruned.length > 0) {
          yield {
            kind: "orphans-pruned" as const,
            name: result.name,
            version: result.version,
            paths: result.pruned,
          };
        }
        yield { kind: "completed" as const, data: result };
      }
    })(),
  );
}

async function scanForExtensionGrafts(
  modelsDir: string,
): Promise<Array<{ type: string; methods: string[] }>> {
  const results: Array<{ type: string; methods: string[] }> = [];
  try {
    for await (const entry of Deno.readDir(modelsDir)) {
      if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
      try {
        const content = await Deno.readTextFile(join(modelsDir, entry.name));
        const extMatch = content.match(
          /export\s+const\s+extension\s*=\s*\{/,
        );
        if (!extMatch) continue;

        const typeMatch = content.match(
          /export\s+const\s+extension\s*=\s*\{[\s\S]*?type:\s*["']([^"']+)["']/,
        );
        if (!typeMatch) continue;

        const methodNames: string[] = [];
        const methodPattern =
          /(\w+)\s*:\s*\{[^}]*?description:\s*(?:"[^"]*?"|'[^']*?'|`[^`]*?`)/g;
        let match;
        while ((match = methodPattern.exec(content)) !== null) {
          methodNames.push(match[1]);
        }

        results.push({ type: typeMatch[1], methods: methodNames });
      } catch {
        // Non-fatal: skip unreadable files
      }
    }
  } catch {
    // modelsDir may not exist (e.g., extension has no models)
  }
  return results;
}

/**
 * captures a fresh lockfile snapshot, so use the returned deps for one install
 * only. denoRuntime and repository together activate InstallExtensionService
 * routing.
 */
export async function createExtensionPullDeps(
  serverUrl: string,
  lockfilePath: string,
  skillsDirs: string[],
  repoDir: string,
  args?: {
    denoRuntime?: DenoRuntime;
    repository?: ExtensionRepository;
    identity?: ClientIdentity;
  },
): Promise<ExtensionPullDeps> {
  const client = new ExtensionApiClient(serverUrl, args?.identity);
  const apiKey = args?.identity?.bearerToken;
  const lockfileRepository = await LockfileRepository.create(lockfilePath);
  return {
    getExtension: (name) => client.getExtension(name, apiKey),
    getLatestVersion: async (name, channel) => {
      const info = await client.getLatestVersion(name, apiKey, channel);
      return info?.version ?? null;
    },
    downloadArchive: (name, version, channel) =>
      client.downloadArchive(name, version, apiKey, channel),
    getChecksum: (name, version, channel) =>
      client.getChecksum(name, version, apiKey, channel),
    getVersionChannels: async (name, versions) => {
      const found = await findPublishedVersions(client, name, versions, apiKey);
      return new Map([...found].map(([v, p]) => [v, p.channel]));
    },
    lockfileRepository,
    skillsDirs,
    repoDir,
    alreadyPulled: new Set(),
    depth: 0,
    denoRuntime: args?.denoRuntime,
    repository: args?.repository,
  };
}

/** captures a fresh lockfile snapshot, so the returned context is single-use. */
export async function createInstallContext(
  serverUrl: string,
  opts: {
    lockfilePath: string;
    skillsDirs: string[];
    repoDir: string;
    force: boolean;
    logger?: Logger;
    identity?: ClientIdentity;
    channel?: string;
  },
): Promise<InstallContext> {
  const client = new ExtensionApiClient(serverUrl, opts.identity);
  const apiKey = opts.identity?.bearerToken;
  const lockfileRepository = await LockfileRepository.create(opts.lockfilePath);
  return {
    getExtension: (name) => client.getExtension(name, apiKey),
    downloadArchive: (name, version, channel) =>
      client.downloadArchive(name, version, apiKey, channel),
    getChecksum: (name, version, channel) =>
      client.getChecksum(name, version, apiKey, channel),
    logger: opts.logger,
    lockfileRepository,
    skillsDirs: opts.skillsDirs,
    repoDir: opts.repoDir,
    force: opts.force,
    alreadyPulled: new Set(),
    depth: 0,
    channel: opts.channel,
  };
}
