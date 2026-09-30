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
import { errorPaths, markErrorPaths, UserError } from "../../domain/errors.ts";
import type {
  InstallChange,
  InstallRollbackOutcome,
} from "../../domain/extensions/duplicate_type_user_error.ts";
import {
  type ExtensionManifest,
  parseExtensionManifest,
} from "../../domain/extensions/extension_manifest.ts";
import { analyzeExtensionSafety } from "../../domain/extensions/extension_safety_analyzer.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import { pruneOrphanFiles } from "../../infrastructure/persistence/directory_cleanup.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { pulledExtensionsLock } from "../../infrastructure/persistence/pulled_extensions_lock.ts";
import type { UpstreamExtensionEntry } from "../../infrastructure/persistence/upstream_extensions.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import { InstallExtensionService } from "./install_extension_service.ts";
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
import { assertContainedPath } from "../../infrastructure/persistence/safe_path.ts";
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
import { inManagedLockfileTransaction } from "./managed_lockfile_transaction.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;
const MAX_DEPENDENCY_DEPTH = 10;
const VERSION_CONSTRAINT_PREFIX = /^[><=^~!]/;

/** Parsed extension reference from CLI argument. */
export interface ExtensionRef {
  name: string;
  version: string | null;
}

/** Safety warning from extension analysis. */
export interface ExtensionSafetyWarning {
  file: string;
  message: string;
}

/** Extension metadata returned by the registry. */
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

/** Result of installing a single extension (no rendering). */
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
  /**
   * Foreign types this extension grafts methods onto via
   * `export const extension`. Each entry names the target type and
   * the methods added to it. Empty when the extension defines only
   * its own types or when source files are unavailable.
   */
  extendsTypes: Array<{ type: string; methods: string[] }>;
  /**
   * Repo-relative paths that were declared in the prior version's
   * lockfile entry but absent from the current version's
   * `extractedFiles`, and which were actually removed from disk by this
   * install: skill paths when it commits, the rest with the previous
   * root. Empty for first-installs
   * (no prior entry) and re-installs of the same version (no diff).
   * Reflects ground truth — paths skipped due to NotFound are NOT
   * included.
   */
  pruned: string[];
  /**
   * Types whose pulled catalog entry was cleared by
   * {@link resolveOriginConflicts} because a local source claims the
   * same `(kind, type_normalized)` pair. Populated by
   * {@link InstallExtensionService} after the catalog save. Absent or
   * empty when no local source shadows the pulled extension's types.
   */
  shadowedTypes?: ShadowedTypeInfo[];
  /**
   * Repo-relative paths this install created. Equals `extractedFiles`
   * except for skills: a skill dir that already existed before
   * extraction is never listed, only the files this install newly wrote
   * inside it. Files it overwrote there are not listed either. A
   * rollback deletes the skill ones; the rest are under the swapped
   * roots, which it moves back whole.
   */
  createdPaths: string[];
}

/**
 * Context for the headless install function (internal, used by
 * extension_update, extensionInstall, and extensionPull).
 *
 * Per-type destination dirs (models/workflows/vaults/
 * datastores/reports/webhooks) are deliberately NOT fields on this context —
 * `installExtension` derives them itself as
 * `.swamp/pulled-extensions/<ref.name>/<type>/` so filesystem state is
 * strictly per-extension (issue 120). Only `skillsDirs` remains because
 * skills land in tool-specific dirs (`.claude/skills/`, `.kiro/skills/`,
 * etc.) that the caller owns — one per enrolled tool.
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
   * Lockfile repository owning read+write of upstream_extensions.json.
   *
   * **Single-use semantics.** The repository captures a snapshot at
   * construction time (per its own JSDoc); reads serve from that snapshot.
   * A given InstallContext therefore embeds a snapshot taken at the moment
   * the context was constructed. DO NOT reuse the same context across
   * multiple install operations — a sibling process or a prior
   * installExtension() call may have written between constructions, and
   * the snapshot would be stale relative to disk. Construct a fresh
   * context per install via `createInstallContext` /
   * `createExtensionPullDeps`. installExtension() refreshes the
   * snapshot from disk under the pulled-extensions lock just before
   * applyInstall() reads it (swamp-club#2709), so the prior entry apply
   * prunes against is the one on disk.
   */
  lockfileRepository: LockfileRepository;
  /**
   * Tool-aware skills destinations — one per unique enrolled tool
   * (e.g. `["/repo/.claude/skills", "/repo/.kiro/skills"]`). Skills are
   * extracted to every directory in this array; all paths are tracked in
   * the lockfile so orphan pruning and extension rm handle multi-tool
   * repos correctly.
   */
  skillsDirs: string[];
  repoDir: string;
  force: boolean;
  alreadyPulled: Set<string>;
  depth: number;
  /**
   * Optional lockfile-anchored integrity check. When set, installExtension
   * verifies the downloaded archive's SHA-256 matches this value BEFORE
   * extraction and throws a UserError on mismatch. Scoped strictly to the
   * lockfile-restore path (extensionInstall, migration re-pull) — explicit
   * `swamp extension pull` leaves this unset so the user opts into
   * whatever bytes the registry currently serves. It anchors the top-level
   * ref only; dependency installs never inherit it.
   */
  expectedChecksum?: string;
  /** Release channel to record in the lockfile entry. */
  channel?: string;
}

/** Thrown when file conflicts are detected and force is false. */
export class ConflictError extends UserError {
  /** Every conflicting path, skill dirs included. */
  conflicts: string[];
  /**
   * The subset of `conflicts` that are existing skill dirs. The install
   * writes its files into them rather than replacing them: same-named
   * files are overwritten, other files are kept.
   */
  skillDirs: string[];
  constructor(conflicts: string[], skillDirs: string[] = []) {
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

/** Input for the extension pull operation. */
export interface ExtensionPullInput {
  ref: ExtensionRef;
  force: boolean;
  channel?: string;
}

/** Dependencies for the extension pull operation. */
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
  /**
   * Lockfile repository owning read+write of upstream_extensions.json.
   * See {@link InstallContext.lockfileRepository} for snapshot semantics
   * and the single-use rule.
   */
  lockfileRepository: LockfileRepository;
  /**
   * Tool-aware skills destinations — one per unique enrolled tool.
   * See {@link InstallContext.skillsDirs}.
   */
  skillsDirs: string[];
  repoDir: string;
  alreadyPulled: Set<string>;
  depth: number;
  /**
   * Test seam (W2 Pin 2). Defaults to the real {@link installExtension}
   * from this module; tests inject a stub so the
   * {@link ExtensionPullEvent} stream can be exercised without a real
   * registry, tarball, or filesystem write. Production callers always
   * leave this unset — `extensionPull` falls back to the real
   * `installExtension` automatically.
   */
  installExtensionFn?: InstallExtensionFn;
  /**
   * W2 service deps. When BOTH are provided, `extensionPull` routes
   * through {@link InstallExtensionService} — phase 8 fires (synchronous
   * type extraction + `repository.save` + rollback on
   * `DuplicateTypeError`). When either is missing, falls back to the
   * pre-W2 free-function path (catalog rows populated lazily by the
   * loader's next pass — same behavior as W1b shipped).
   *
   * Production paths that want the W2 contract (I-Repo-1 fires at install
   * time) MUST pass both. Migrating callers is plan v4 commit 3 (CONVERT
   * callsites) and the wrapper-internal swap for KEEP callsites.
   */
  denoRuntime?: DenoRuntime;
  repository?: ExtensionRepository;
}

/**
 * Parses an extension reference string into name and optional version.
 *
 * Examples:
 * - `@ns/name` → `{ name: "@ns/name", version: null }`
 * - `@ns/name@2026.02.26.1` → `{ name: "@ns/name", version: "2026.02.26.1" }`
 */
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

/**
 * Validates a scoped extension name matches the expected pattern.
 */
export function validateExtensionName(name: string): void {
  if (!SCOPED_NAME_PATTERN.test(name)) {
    throw new UserError(
      `Invalid extension name: "${name}". Must match @collective/name pattern (lowercase, alphanumeric, hyphens, underscores, additional /segments allowed).`,
    );
  }
}

/**
 * Returns true if a version string is a semver constraint rather than
 * an exact version. Constraints start with >=, <=, >, <, ^, ~, !, or =.
 */
export function isVersionConstraint(version: string): boolean {
  return VERSION_CONSTRAINT_PREFIX.test(version);
}

/**
 * Resolves the registry server URL.
 * Priority: SWAMP_CLUB_URL env var > DEFAULT_SWAMP_CLUB_URL
 */
export function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

/** Returns true if the filename is a macOS resource fork (AppleDouble) file. */
function isMacOsResourceFork(name: string): boolean {
  return name.startsWith("._");
}

/**
 * Checks if a file exists at the given path.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively copies a directory's contents, returning the repo-relative
 * path of each file copied. `recordDir` is where `destDir` will end up
 * (a staging dir's live location); the paths are reported under it.
 * Defaults to `destDir`.
 */
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
        extracted.push(relative(repoDir, recordPath));
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return extracted;
}

/**
 * Lists all files recursively under a directory.
 */
async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
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
 * Lists files and symlinks under a directory without descending into
 * symlinked directories. Used to snapshot a skill dir before merging
 * into it: `copyFile` writes through a symlink at the destination, so a
 * user's symlink must count as pre-existing or rollback would unlink it.
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
 * Recursively validates that no symlink under `path` resolves to a target
 * outside `resolvedTmpDir`. Throws a UserError if a symlink escapes.
 */
async function validateNoSymlinkEscape(
  path: string,
  resolvedTmpDir: string,
): Promise<void> {
  const stat = await Deno.lstat(path);
  if (stat.isSymlink) {
    const linkTarget = await Deno.readLink(path);
    const resolvedTarget = resolve(join(path, "..", linkTarget));
    if (!resolvedTarget.startsWith(resolvedTmpDir + SEPARATOR)) {
      throw markErrorPaths(
        new UserError(
          `Archive contains a symlink that escapes the temp directory: ${path}`,
        ),
        [path],
      );
    }
  } else if (stat.isDirectory) {
    for await (const entry of Deno.readDir(path)) {
      await validateNoSymlinkEscape(join(path, entry.name), resolvedTmpDir);
    }
  }
}

/**
 * Detects files that already exist at target paths.
 *
 * Under the extension-first layout, every dir passed in is per-extension,
 * so a non-empty return means this extension is being re-installed on top
 * of itself (resolved by --force) — it never means a collision with a
 * different extension.
 */
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
      conflicts.push(relative(repoDir, destPath));
    }
  }

  const workflowsSrc = join(extractDir, "workflows");
  for (const file of await listFiles(workflowsSrc)) {
    const destPath = join(workflowsDir, basename(file));
    if (await fileExists(destPath)) {
      conflicts.push(relative(repoDir, destPath));
    }
  }

  const bundlesSrc = join(extractDir, "bundles");
  for (const file of await listFiles(bundlesSrc)) {
    const relPath = relative(bundlesSrc, file);
    const destPath = join(bundlesDir, relPath);
    if (await fileExists(destPath)) {
      conflicts.push(relative(repoDir, destPath));
    }
  }

  if (vaultsDir) {
    const vaultsSrc = join(extractDir, "vaults");
    for (const file of await listFiles(vaultsSrc)) {
      const relPath = relative(vaultsSrc, file);
      const destPath = join(vaultsDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (vaultBundlesDir) {
    const vaultBundlesSrc = join(extractDir, "vault-bundles");
    for (const file of await listFiles(vaultBundlesSrc)) {
      const relPath = relative(vaultBundlesSrc, file);
      const destPath = join(vaultBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (datastoresDir) {
    const datastoresSrc = join(extractDir, "datastores");
    for (const file of await listFiles(datastoresSrc)) {
      const relPath = relative(datastoresSrc, file);
      const destPath = join(datastoresDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (datastoreBundlesDir) {
    const datastoreBundlesSrc = join(extractDir, "datastore-bundles");
    for (const file of await listFiles(datastoreBundlesSrc)) {
      const relPath = relative(datastoreBundlesSrc, file);
      const destPath = join(datastoreBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (reportsDir) {
    const reportsSrc = join(extractDir, "reports");
    for (const file of await listFiles(reportsSrc)) {
      const relPath = relative(reportsSrc, file);
      const destPath = join(reportsDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (reportBundlesDir) {
    const reportBundlesSrc = join(extractDir, "report-bundles");
    for (const file of await listFiles(reportBundlesSrc)) {
      const relPath = relative(reportBundlesSrc, file);
      const destPath = join(reportBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (webhooksDir) {
    const webhooksSrc = join(extractDir, "webhooks");
    for (const file of await listFiles(webhooksSrc)) {
      const relPath = relative(webhooksSrc, file);
      const destPath = join(webhooksDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (webhookBundlesDir) {
    const webhookBundlesSrc = join(extractDir, "webhook-bundles");
    for (const file of await listFiles(webhookBundlesSrc)) {
      const relPath = relative(webhookBundlesSrc, file);
      const destPath = join(webhookBundlesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  if (filesDir) {
    const filesSrc = join(extractDir, "files");
    for (const file of await listFiles(filesSrc)) {
      const relPath = relative(filesSrc, file);
      const destPath = join(filesDir, relPath);
      if (await fileExists(destPath)) {
        conflicts.push(relative(repoDir, destPath));
      }
    }
  }

  return conflicts;
}

/**
 * Checks whether anything exists at `path` without following a
 * symlink, so a dangling or directory symlink still counts as present.
 */
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
 * Detects skill directories the archive would merge into that the
 * extension does not own. Skills land in shared tool dirs
 * (`.claude/skills/<name>`, ...), the one place the extension-first
 * layout does not isolate extensions, so a same-named dir may belong to
 * the user or to another extension. A dir is owned when the prior
 * lockfile entry (`oldFiles`) lists it or a path under it.
 *
 * Returns repo-relative skill roots.
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
      const rel = relative(repoDir, destSkillDir);
      if (
        await pathExistsNoFollow(destSkillDir) && !claimsPath(oldFiles, rel)
      ) {
        conflicts.push(rel);
      }
    }
  }
  return conflicts;
}

/**
 * Validates that all source files referenced by imports are present.
 * Returns paths of missing files (relative to the base directory).
 */
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
      missing.push(relative(boundaryDir, resolved));
    }
  }
  return missing;
}

/** Recursively collects .ts files from a directory, skipping _-prefixed dirs. */
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
 * Computes which paths from a prior version's lockfile entry are
 * orphans relative to a new version's extracted file set — i.e. paths
 * declared by the old version but absent from the new one. Pure
 * function; the caller hands the result to `pruneOrphanFiles` to
 * remove them from disk.
 *
 * Both lists are repo-relative paths. Exact matches go through a Set;
 * only paths absent from it are checked for the containment cases
 * below.
 *
 * A skill can be recorded as its root (`.claude/skills/foo`) or, when
 * it was merged into a dir the extension does not own, as the files it
 * wrote there. An old path is not an orphan when it lies under a path
 * the new version records (files → root), or when a new path lies
 * under it (root → files): pruning it would recursively delete what
 * this install just wrote.
 *
 * Exported for direct unit testing — production callers go through
 * `installExtension`.
 */
export function computeOrphanDiff(
  oldFiles: ReadonlyArray<string>,
  extractedFiles: ReadonlyArray<string>,
): string[] {
  const newFilesSet = new Set(extractedFiles);
  const newCanonical = extractedFiles.map(canonicalClaimPath);
  return oldFiles.filter((f) => {
    if (newFilesSet.has(f)) return false;
    // Strict containment only: an exact match that differs just in case
    // is a rename, and on a case-sensitive filesystem the old file is a
    // real orphan.
    const old = canonicalClaimPath(f);
    return !newCanonical.some((n) =>
      old.startsWith(n + "/") || n.startsWith(old + "/")
    );
  });
}

/** Options for {@link installExtension}. */
export interface InstallOptions {
  /**
   * Runs after a successful apply, in the same pulled-extensions lock
   * section, so a caller can extend that section (e.g. the catalog save
   * in InstallExtensionService) without holding the lock across
   * prepare. It receives the install uncommitted, with the previous
   * version still kept, and ends it: {@link PendingInstall.commit} or
   * {@link PendingInstall.rollback}. One it leaves pending, by throwing
   * or otherwise, is committed. Not passed to dependency installs.
   */
  underLock?: (pending: PendingInstall) => Promise<void>;
}

/** Signature of {@link installExtension}, for callers' test seams. */
export type InstallExtensionFn = (
  ref: ExtensionRef,
  ctx: InstallContext,
  options?: InstallOptions,
) => Promise<InstallResult | undefined>;

/**
 * Core install logic: download, verify, extract, copy, track.
 * No rendering — returns structured data for callers to present.
 * Throws ConflictError when !force and conflicts exist.
 * Recursively installs dependencies.
 *
 * Runs {@link prepareInstall} (network I/O and a private temp dir only),
 * then, holding the checkout's pulled-extensions lock, refreshes the
 * lockfile snapshot and runs {@link applyInstall} (changes to the repo
 * and lockfile) and `options.underLock`. Always disposes the prepared
 * install afterwards. A ConflictError leaves the locked section before
 * it reaches the caller, so the lock is never held across the CLI's
 * conflict prompt (swamp-club#2709).
 *
 * The install is committed before the lock is released: by
 * `options.underLock` (which may roll it back instead), or here when
 * there is none or it left the install pending.
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
 * Installs a dependency from inside its parent's apply, leaving it
 * uncommitted: the parent's {@link PendingInstall} owns the handle, so a
 * rollback of the parent also removes the dependency.
 */
async function installDependencyPending(
  ref: ExtensionRef,
  ctx: InstallContext,
): Promise<PendingInstall | undefined> {
  return await installLocked(ref, ctx, (pending) => Promise.resolve(pending));
}

/**
 * The shared install sequence: the dependency-cycle and depth checks,
 * {@link prepareInstall} outside the lock, then {@link applyInstall} and
 * `withPending` in one pulled-extensions lock section. Returns undefined
 * when `ref` is already being installed in this operation.
 */
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
    // A managed lockfile's transaction takes the datastore global lock and
    // fetches the shared lockfile before the pulled-extensions lock, and
    // publishes the change after it (swamp-club#2838). Without one this
    // runs the section directly.
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

/** Fields a {@link PreparedInstall} is built from. */
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
}

/**
 * An extension archive that {@link prepareInstall} downloaded, verified,
 * extracted into a private temp dir and safety-checked, ready for
 * {@link applyInstall}. Owns the temp dir: callers must await
 * {@link PreparedInstall.dispose} once they are done with it.
 *
 * Only exported as a type, and its private fields keep structurally
 * similar objects from type-checking as one, so applyInstall only ever
 * receives an archive that went through prepare's checks.
 */
class PreparedInstall {
  readonly ref: ExtensionRef;
  readonly version: string;
  readonly extInfo: ExtensionRegistryInfo;
  readonly localChecksum: string;
  readonly integrityStatus: "verified" | "unverified";
  readonly manifest: ExtensionManifest;
  readonly manifestContent: string;
  /** The extracted `extension/` dir inside the temp dir. */
  readonly extractDir: string;
  readonly safetyWarnings: ExtensionSafetyWarning[];
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
  }

  /** Removes the temp dir. Idempotent and best-effort. */
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
   * Throws when this install was disposed or its extract dir is gone.
   * copyDir treats a missing source as empty, so applying a vanished
   * archive would record a hollow install and prune every file of the
   * prior version. The stat leaves a window before the copies; this
   * guards against a stale or disposed handle, not a dir removed
   * mid-apply.
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
 * Resolves, downloads, verifies, extracts and safety-checks an extension
 * without touching the repo: nothing is written outside a private temp
 * dir, which the returned {@link PreparedInstall} owns. On failure the
 * temp dir is removed before the error propagates.
 *
 * Does not apply the alreadyPulled or dependency-depth guards — those
 * live in {@link installExtension}.
 *
 * @param opts.tempRoot Parent dir for the temp dir. For tests only;
 *   production callers leave it unset to use the system temp dir.
 */
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

  // Lockfile-anchored integrity check. When expectedChecksum is provided
  // (lockfile-restore flows: extensionInstall, migration re-pull), verify
  // the freshly-downloaded bytes match what was recorded when the user
  // originally installed this version. This catches registry content drift
  // between the user's original install and their upgrade/reinstall and
  // lets us restore authentic per-extension content during migration.
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
    // Pre-checksum-tracking lockfile entries (pre-f4dfc083) have no stored
    // checksum; verification is skipped. Subsequent installs write a fresh
    // checksum so future restores gain full integrity coverage.
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
    const message = error instanceof Error ? error.message : String(error);
    return markErrorPaths(
      new UserError(`Failed to ${action}: ${message}`),
      errorPaths(error),
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
        throw markErrorPaths(
          new UserError(
            `Archive contains unsafe path: ${entry}`,
          ),
          [entry],
        );
      }
    }

    try {
      const extractFile = await Deno.open(archivePath, { read: true });
      // The Deno-native extractor doesn't shell out to BSD tar, so the macOS
      // `COPYFILE_DISABLE=1` env var that suppressed AppleDouble files in
      // the previous implementation is no longer needed: AppleDouble entries
      // are filtered out at extraction time as a defensive measure.
      await extractTarGz(
        extractFile.readable,
        tmpDir,
        undefined,
        readOptions,
      );
    } catch (error: unknown) {
      throw archiveReadError("extract archive", error);
    }

    const extractDir = join(tmpDir, "extension");

    for (const entry of archiveEntries) {
      if (logger) {
        logger.debug`Archive contains: ${entry}`;
      }
    }

    const resolvedTmpDir = resolve(tmpDir);
    for await (const entry of Deno.readDir(extractDir)) {
      await validateNoSymlinkEscape(
        join(extractDir, entry.name),
        resolvedTmpDir,
      );
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
    const tsFiles = [
      ...modelTsFiles,
      ...vaultTsFiles,
      ...datastoreTsFiles,
      ...reportTsFiles,
      ...webhookTsFiles,
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

/**
 * What {@link applyInstall} returns: the install's result, with the new
 * version swapped in and the previous one kept in staging until it is
 * committed or rolled back. It covers the extension and every dependency
 * installed with it. Exactly one of commit and rollback takes effect;
 * calling either again, or the other afterwards, does nothing.
 */
export interface PendingInstall {
  readonly result: InstallResult;
  /**
   * Deletes the install's staging, and with it the previous versions,
   * then prunes the skill files the previous version shipped and this
   * one does not. Never throws: whatever it cannot delete, the next
   * install or removal cleans up.
   */
  commit(): Promise<void>;
  /**
   * Puts the previous versions back: first every lockfile entry this
   * install wrote, in one write, then every root, dependencies first;
   * then deletes the skill files this install created. Never throws;
   * the outcome says whether the previous versions are back.
   */
  rollback(): Promise<InstallRollbackOutcome>;
}

/** One extension of a {@link PendingInstall} and its dependencies. */
class PendingInstallNode implements PendingInstall {
  readonly result: InstallResult;
  readonly #tx: ExtensionInstallTransaction;
  readonly #ctx: InstallContext;
  /** The lockfile entry before apply; null when there was none. */
  readonly #priorEntry: UpstreamExtensionEntry | null;
  /** The entry apply wrote. */
  readonly #writtenEntry: UpstreamExtensionEntry | null;
  /** Skill paths apply created, which a rollback deletes. */
  readonly #skillCreatedPaths: string[];
  /** Skill paths the previous version shipped and this one does not. */
  readonly #orphanCandidates: string[];
  readonly #children: PendingInstallNode[];
  /** Reports what the install changed, once it can no longer roll back. */
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

  /** This node and its pending dependencies, in install order. */
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
      // Already committed: everything in it stays on the new version.
      return { status: "kept", kept: this.#allNodes().map((n) => n.#change()) };
    }
    this.#outcome = await this.#rollbackNodes(nodes);
    return this.#outcome;
  }

  /** This node and every dependency under it, in install order. */
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

  /**
   * After a restore that threw: `all` when the lockfile on disk holds
   * every restored entry, `none` when it still holds every entry apply
   * wrote, `unknown` when it cannot be read or holds neither.
   */
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
 * Deletes paths an install created, unlinking a symlink rather than
 * following it. Best-effort: a path already gone is skipped, and any
 * other failure is logged, since the caller is undoing an install.
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
 * Prunes the skill paths an install's previous version shipped and this
 * one does not, once the install commits. The claims are the other
 * entries' as the lockfile holds them now, so a dependency installed in
 * the same call that merged files into a dropped skill dir keeps them:
 *
 * - a candidate no entry lists, or lists anything under, goes whole (a
 *   symlink as the link itself);
 * - one an entry lists, or lists a dir above, is kept;
 * - a dir an entry lists only files under is walked, and only the files,
 *   links and wholly unclaimed dirs under it go. The walk descends plain
 *   dirs only, never a symlink, so it cannot reach outside the repo.
 *
 * Returns the paths removed. Files the user added to a pruned dir go
 * with it, as they always have.
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
      const path = join(dir, entry.name);
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

/** Top-level names in an extension root that a nested entry cannot use. */
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
 * Installs a {@link PreparedInstall} into the repo: conflict detection
 * against the live tree (throws ConflictError when !force), then a
 * stage-and-swap of the extension root and its bundle namespace dirs,
 * the merge copy into the skills dirs, skill orphan pruning, the
 * lockfile entry, and dependency installs. Does not dispose `prepared`.
 *
 * The new version is built in staging, the live roots are moved aside
 * and the new ones moved in (see {@link ExtensionInstallTransaction}); a
 * journal written first lets a crash at any point be put right. The
 * swap replaces the roots whole: a file the prior version shipped and
 * this one does not is gone afterwards, while a file the user added
 * under the extension root is copied into the new root (see
 * {@link carryForwardUserFiles}). Entries nested under this one
 * (`@a/b/c` inside `@a/b`) are copied into the new root unchanged.
 *
 * Any failure after staging starts is settled before it propagates: the
 * swap is rolled back unless its lockfile entry already landed. The
 * caller commits the returned handle once it no longer needs the prior
 * version.
 *
 * Runs crash recovery first, under the pulled-extensions lock the caller
 * holds.
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

  // Snapshot the prior lockfile entry's `files[]` BEFORE the swap.
  // Used afterwards to compute the orphan diff (paths declared by the
  // prior version but absent from the new version). Empty when this is
  // a first-install (no prior entry). installExtension refreshed the
  // snapshot from disk under the lock just before calling apply.
  const oldEntry = ctx.lockfileRepository.getEntry(ref.name);
  const oldFiles = oldEntry?.files ?? [];

  // Extension-first on-disk layout: each installed extension owns a
  // dedicated subtree under .swamp/pulled-extensions/<ext-name>/. Prevents
  // cross-extension filename collisions (e.g. _lib/aws.ts shared between
  // @swamp/aws/ec2 and @swamp/aws/eks, or README.md across unrelated
  // extensions). Skills fan out to ctx.skillsDirs — one per enrolled tool.
  // Bundle cache is namespaced by source dir path, so each extension gets
  // its own bundle namespace dirs automatically.
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
  // Skill dirs are shared across extensions and with the user. Only
  // the top-level extension raises them as conflicts: a dependency
  // installs after its parent's lockfile entry is written, so failing
  // there would leave the operation half done. Dependencies merge
  // with the overwrite warning below instead.
  const skillConflicts = ctx.depth === 0
    ? await detectSkillConflicts(
      extractDir,
      ctx.skillsDirs,
      oldFiles,
      repoDir,
    )
    : [];
  conflicts.push(...skillConflicts);

  if (conflicts.length > 0 && !ctx.force) {
    throw new ConflictError(conflicts, skillConflicts);
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
  }
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
    // A nested entry inside another one is copied with it.
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

  // Set once this install's own lockfile write completes. A same-version
  // reinstall finds the prior entry already carrying its checksum, so
  // only this flag says the entry landed for a failure after the swap.
  let lockfileWritten = false;
  // Dependencies applied inside this install, still uncommitted.
  const dependencies: PendingInstall[] = [];
  try {
    const stagedExtRoot = tx.newPathOf(absoluteExtRoot);
    const extractedFiles: string[] = [];
    // Copies one archive dir into staging, recording the paths it will
    // have once swapped in. Kind dirs are created even when empty, as
    // before; a bundle root the archive has nothing for is not staged.
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
    // Sources before their bundles, as before, so staged bundles are
    // never older than the sources they were built from.
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

    // Restore executable bits for declared binaries
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

    // Files the user added under the root are not in the archive, so
    // the swap would drop them. Copy them into the new root, as the
    // merge copy kept them.
    const extraFiles = await carryForwardUserFiles({
      liveRoot: absoluteExtRoot,
      stagedRoot: stagedExtRoot,
      repoDir,
      priorEntry: oldEntry,
      excludeRelDirs: nestedRelDirs,
    });
    // manifest.yaml is staged on its own and moved in last, into the
    // new per-extension root, as a read-only copy. Makes each installed
    // extension self-describing on disk so downstream consumers (e.g.
    // findDependents in extension rm) can resolve the manifest without
    // re-parsing the archive.
    await Deno.writeTextFile(tx.stagedManifestPath, manifestWithHeader);
    try {
      await Deno.chmod(tx.stagedManifestPath, 0o444);
    } catch {
      // chmod is advisory on some filesystems/platforms (notably Windows);
      // intent is documented via the file header, enforcement is best-effort.
    }

    await tx.swap();

    // Extract skills to every enrolled tool's skill directory.
    // The lockfile tracks a skill as its root when this extension owns
    // the dir (created it now, or its prior entry recorded the root), so
    // extension rm can delete it in one shot. A skill merged into a dir
    // that already existed and is not owned is tracked file by file, so
    // rm and orphan prune never delete the user's or another
    // extension's files. `skillCreatedPaths` is what a rollback may
    // undo: a created root whole, or only the new files in a merged one.
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
            const skillDirRelative = relative(repoDir, destSkillDir);
            const preExisted = await pathExistsNoFollow(destSkillDir);
            const filesBefore = preExisted
              ? new Set(
                (await listFilesAndLinks(destSkillDir)).map((f) =>
                  relative(repoDir, f)
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

            // Check for scripts/ directory (once per skill, not per tool)
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
      relative(repoDir, join(absoluteExtRoot, "manifest.yaml")),
    );

    // Record include files from manifest for loader skip logic
    const includeFiles = manifest.include.length > 0
      ? manifest.include.map((inc) =>
        relative(repoDir, resolve(absoluteModelsDir, inc))
      )
      : undefined;

    // Per-extension on-disk digest anchor, over exactly what the install
    // produced and leaving out nested entries' roots. Computed BEFORE the
    // lockfile write. Auto-update consults this on the next version bump
    // to refuse overwrites when the user has local edits (issue #126).
    const filesChecksum = await readInstalledExtensionDigest(absoluteExtRoot, {
      excludeRelDirs: nestedRelDirs,
    });

    // Orphans: paths declared by the prior version's lockfile entry that
    // are NOT in the new version's extractedFiles[]. Those under a
    // swapped root are already out of the live tree (the swap replaced
    // the root whole) and are only reported. The rest (skills) are
    // pruned when the install commits (see pruneSkillOrphans). A path
    // another lockfile entry also claims (a shared skill dir) is kept.
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
        pulledAt: oldEntry?.version === version ? oldEntry.pulledAt : undefined,
      },
    );
    lockfileWritten = true;
    const writtenEntry = ctx.lockfileRepository.getEntry(ref.name);

    // Reported when the install commits: a rollback puts the previous
    // root back, and with it whatever these say was replaced or removed.
    const reportCommitted = () => {
      const extRootRel = relative(repoDir, absoluteExtRoot);
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

    // Dependency installs do network I/O from inside apply, at two
    // points: the ctx.getExtension() call that resolves an unpinned
    // dependency's version and channel, and the nested installExtension()
    // call, whose prepareInstall() fetches registry info, the archive and
    // its checksum. Both run under this install's pulled-extensions lease,
    // and the nested apply runs inline in it. Whether a dependency needs
    // installing is only known from the lockfile read under the lock, so
    // preparing dependencies before taking it would download speculatively
    // (swamp-club#2709).
    const dependencyResults: InstallResult[] = [];
    if (manifest.dependencies.length > 0) {
      for (const dep of manifest.dependencies) {
        const depRef = parseExtensionRef(dep);
        if (ctx.alreadyPulled.has(depRef.name)) {
          continue;
        }

        // ctx.lockfileRepository reflects writes the parent install has
        // made — writeEntry updates the cache on every commit, and child
        // installs in this loop reuse the same repository instance, so
        // their writes are visible too. A managed lockfile fetched from
        // the datastore can also list a dependency another checkout
        // installed, whose files are not on this one (swamp-club#2838);
        // that dependency is installed at the version it pins.
        const lockedEntry = ctx.lockfileRepository.getEntry(depRef.name);
        const isInstalled = lockedEntry !== null &&
          await lockedFilesPresent(lockedEntry.files ?? [], ctx.repoDir);

        if (!isInstalled && lockedEntry !== null) {
          // Owned by this install like any other dependency: rolling it
          // back restores the pinned entry it replaced.
          const depPending = await installDependencyPending(
            { name: depRef.name, version: lockedEntry.version },
            {
              ...ctx,
              depth: ctx.depth + 1,
              channel: lockedEntry.channel,
              expectedChecksum: lockedEntry.checksum,
            },
          );
          if (depPending) {
            dependencies.push(depPending);
            dependencyResults.push(depPending.result);
          }
        } else if (!isInstalled) {
          // Strip version constraints (>=, ^, ~, etc.) — pass version: null
          // so installExtension resolves to the registry's latest version.
          // When the dep has no stable version, resolve from beta/rc channels
          // so beta-only extensions can satisfy dependency requirements.
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
          // expectedChecksum anchors the parent's archive, not this one. A
          // dependency reached here has no lockfile entry, so it has no
          // anchor of its own: it installs like a fresh pull, still checked
          // against the registry's server checksum.
          // The dependency stays uncommitted, owned by this install, so
          // rolling this install back removes it too.
          const depPending = await installDependencyPending(resolvedRef, {
            ...ctx,
            depth: ctx.depth + 1,
            channel: depChannel,
            expectedChecksum: undefined,
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
    // Roll the swap back, or forward when the lockfile entry already
    // landed (e.g. a dependency failed after it). Read from disk, so a
    // write that failed after reaching the file still counts, except
    // when the prior entry had the same checksum: then only this
    // install's completed write says it landed.
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

/**
 * Whether every file a lockfile entry tracks exists on this checkout.
 * Paths are validated first: a lockfile fetched from the datastore is not
 * trusted to stay inside the repo.
 */
async function lockedFilesPresent(
  files: readonly string[],
  repoDir: string,
): Promise<boolean> {
  for (const file of files) {
    assertContainedPath(file, repoDir);
    if (!await pathExistsNoFollow(join(repoDir, file))) return false;
  }
  return true;
}

/**
 * Installed extensions whose root contains `name`'s: lockfile entries,
 * and dirs on disk holding a manifest.yaml, whose name is a prefix of
 * `name` at a segment boundary.
 */
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
 * Copies a nested entry's root into a staged parent root, keeping each
 * file's and dir's access and modification times so the nested
 * entry's sources stay no newer than its pre-built bundles. Symlinks are
 * skipped, as an install never writes one.
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
 * Copies the files a user added under a live extension root into its
 * staged replacement, keeping their times. A file is the user's when
 * the new archive does not ship it (nothing is staged at its path) and
 * the prior lockfile entry does not list it; a file the entry lists is
 * one the prior version shipped and the new one dropped, and goes with
 * the old root.
 *
 * The entry's list only describes the tree when the installed
 * manifest.yaml is the entry's version. When it is not (a lockfile
 * restored from git after an upgrade), or the entry has no list, or
 * there is no entry, the files cannot be told apart from ones an older
 * version shipped. Nothing is copied then, and each such file is
 * returned in `unattributed` for the caller to name. A symlink, or a
 * path under one where the new archive ships a file, cannot be copied
 * and is returned in `unkept`.
 *
 * `excludeRelDirs` are nested entries' roots (forward-slash, relative
 * to `liveRoot`), which the install copies itself. Paths returned are
 * repo-relative.
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
      const repoRel = relative(repoDir, livePath);
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

/** The target of the symlink at `path`, or null when it is not one. */
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

/** True when `path` is a directory itself, not a symlink to one. */
async function isPlainDir(path: string): Promise<boolean> {
  try {
    const stat = await Deno.lstat(path);
    return stat.isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
/** Async generator wrapping installExtension for the stream pattern. */
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

      // Resolve channel-specific version when --channel is set and
      // no explicit version is pinned. The resolved ref always carries
      // an explicit version so installExtension doesn't need channel
      // awareness — it just installs the pinned version.
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
      };

      // Let ConflictError propagate — CLI catches it for the two-phase prompt
      // flow. Routing precedence:
      //   1. deps.installExtensionFn (test seam — Pin 2 stubs)
      //   2. InstallExtensionService when deps.denoRuntime + deps.repository
      //      are both provided (W2 contract: phase 8 fires, I-Repo-1 fires
      //      at install time, rollback on DuplicateTypeError)
      //   3. Free-function installExtension (pre-W2 fallback — catalog rows
      //      populated lazily on next loader pass)
      const denoRt = deps.denoRuntime;
      const repo = deps.repository;
      const install = deps.installExtensionFn ??
        (denoRt !== undefined && repo !== undefined
          ? (r: ExtensionRef, c: InstallContext) =>
            new InstallExtensionService({
              denoRuntime: denoRt,
              repository: repo,
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
 * Wires real infrastructure into ExtensionPullDeps. Constructs a fresh
 * {@link LockfileRepository} that captures a snapshot at this moment —
 * the returned deps object is therefore single-use per the
 * {@link InstallContext.lockfileRepository} JSDoc. Construct fresh deps
 * per install operation; do not reuse across multiple installs.
 *
 * **W2 service deps.** Optional `denoRuntime` and `repository` activate
 * the {@link InstallExtensionService} routing inside `extensionPull`.
 * When BOTH are passed, phase 8 fires (catalog populated synchronously,
 * I-Repo-1 fires on `(kind, type)` collision, rollback on conflict).
 * When either is missing, the deps fall back to the pre-W2 free-function
 * path (catalog populated lazily on next loader pass) — same behavior
 * as before W2.
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
    lockfileRepository,
    skillsDirs,
    repoDir,
    alreadyPulled: new Set(),
    depth: 0,
    denoRuntime: args?.denoRuntime,
    repository: args?.repository,
  };
}

/**
 * Creates an InstallContext from an ExtensionApiClient (for
 * extension_update compatibility). Like {@link createExtensionPullDeps},
 * constructs a fresh snapshot-captured {@link LockfileRepository}; the
 * returned context is single-use per the
 * {@link InstallContext.lockfileRepository} JSDoc.
 */
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
