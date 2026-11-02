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
 * written before an install changes anything so a crash can be put right;
 * repo-controlled data, so parseInstallJournal checks every path against the
 * layout derived from the extension name
 */

import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { z } from "zod";

export const STAGING_DIR_NAME = ".swamp-staging";

export const BUNDLE_STAGING_PREFIX = ".swamp-staging-";

export const INSTALL_JOURNAL_FILE = "journal.json";

export const STAGED_MANIFEST_FILE = "manifest.yaml";

export function bundleStagingDirName(stagingId: string): string {
  return `${BUNDLE_STAGING_PREFIX}${stagingId}`;
}

/** every reader that lists the pulled root or a bundle kind dir skips these */
export function isStagingEntryName(name: string): boolean {
  return name === STAGING_DIR_NAME || name.startsWith(BUNDLE_STAGING_PREFIX);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isStagingId(name: string): boolean {
  return UUID_PATTERN.test(name);
}

// Mirrors SCOPED_NAME_PATTERN in src/libswamp/extensions/pull.ts. The
// domain cannot import libswamp; the journal only needs to be sure the
// name is a plain relative path with no dots.
const EXTENSION_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

export function isExtensionName(name: string): boolean {
  return EXTENSION_NAME_PATTERN.test(name);
}

export type InstallRootRole = "extension" | "bundle";

export type InstallJournalPhase = "staged" | "swapped";

const InstallRootSchema = z.object({
  index: z.number().int().nonnegative(),
  role: z.enum(["extension", "bundle"]),
  live: z.string().min(1),
  stagingDir: z.string().min(1),
  old: z.string().min(1),
  new: z.string().min(1),
  liveExisted: z.boolean(),
  /**
   * The extension root was a symlink. Phase 1 moves the link itself
   * aside, so the install replaces it with a directory and never writes
   * through it; a roll-back puts the link back.
   */
  liveIsLink: z.boolean().optional(),
  hasNew: z.boolean(),
}).strict();

const NestedRootSchema = z.object({
  relDir: z.string().min(1),
  strategy: z.literal("copied"),
}).strict();

const InstallJournalSchema = z.object({
  schemaVersion: z.literal(1),
  ownerId: z.string().regex(UUID_PATTERN),
  stagingId: z.string().regex(UUID_PATTERN),
  /**
   * The absolute repo dir the install ran in. Every other path is under
   * it unless the lockfile lives outside the repo.
   */
  repoDir: z.string().min(1),
  extensionName: z.string().regex(EXTENSION_NAME_PATTERN),
  phase: z.enum(["staged", "swapped"]),
  lockfilePath: z.string().min(1),
  newChecksum: z.string().min(1),
  oldManifestDigest: z.string().min(1).nullable(),
  newManifestDigest: z.string().min(1),
  roots: z.array(InstallRootSchema).min(1),
  manifest: z.object({
    staged: z.string().min(1),
    live: z.string().min(1),
  }).strict(),
  nestedRoots: z.array(NestedRootSchema),
}).strict();

export type InstallRoot = z.infer<typeof InstallRootSchema>;

export type NestedRoot = z.infer<typeof NestedRootSchema>;

export type InstallJournal = z.infer<typeof InstallJournalSchema>;

export interface RootStagingPaths {
  stagingDir: string;
  old: string;
  new: string;
  discard: string;
}

/**
 * the single source of the layout: installs build their journal from it and
 * parseInstallJournal requires every path to match it
 */
export function rootStagingPaths(args: {
  pulledRoot: string;
  stagingId: string;
  role: InstallRootRole;
  live: string;
  index: number;
}): RootStagingPaths {
  const stagingDir = args.role === "extension"
    ? join(args.pulledRoot, STAGING_DIR_NAME, args.stagingId)
    : join(dirname(args.live), bundleStagingDirName(args.stagingId));
  const slot = String(args.index);
  return {
    stagingDir,
    old: join(stagingDir, "old", slot),
    new: join(stagingDir, "new", slot),
    discard: join(stagingDir, "discard", slot),
  };
}

export function rootDiscardPath(root: InstallRoot): string {
  return join(root.stagingDir, "discard", String(root.index));
}

export function installJournalPath(
  pulledRoot: string,
  stagingId: string,
): string {
  return join(pulledRoot, STAGING_DIR_NAME, stagingId, INSTALL_JOURNAL_FILE);
}

export interface ExpectedLivePaths {
  extensionRoot: string;
  bundleRoots: ReadonlyArray<string>;
}

export interface InstallJournalBounds {
  repoDir: string;
  pulledRoot: string;
  allowedLockfilePaths: ReadonlyArray<string>;
  /**
   * The live roots of `extensionName`. Injected so this module does not
   * import the infrastructure path helpers.
   */
  expectedLivePaths: (extensionName: string) => ExpectedLivePaths;
}

export type ParseInstallJournalResult =
  | { ok: true; journal: InstallJournal }
  | { ok: false; reason: string };

/**
 * every path must be the one derived from the extension name and staging id, so
 * a planted journal cannot aim a rename elsewhere; a journal from a moved repo
 * is rebased onto bounds.repoDir first
 */
export function parseInstallJournal(
  raw: unknown,
  bounds: InstallJournalBounds,
  journalDirName: string,
): ParseInstallJournalResult {
  const parsed = InstallJournalSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `does not match the journal schema: ${
        parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")
      }`,
    };
  }
  if (parsed.data.stagingId !== journalDirName) {
    return {
      ok: false,
      reason:
        `stagingId ${parsed.data.stagingId} does not match its dir ${journalDirName}`,
    };
  }
  if (!isAbsolute(parsed.data.repoDir)) {
    return {
      ok: false,
      reason: `repo dir ${parsed.data.repoDir} is not an absolute path`,
    };
  }
  const journal = resolve(parsed.data.repoDir) === resolve(bounds.repoDir)
    ? parsed.data
    : rebaseJournal(parsed.data, resolve(bounds.repoDir));

  const allowed = bounds.allowedLockfilePaths.map((p) => resolve(p));
  if (!allowed.includes(resolve(journal.lockfilePath))) {
    return {
      ok: false,
      reason:
        `lockfile path ${journal.lockfilePath} is not a lockfile of this repository`,
    };
  }

  const expected = bounds.expectedLivePaths(journal.extensionName);
  const seenIndexes = new Set<number>();
  const seenLive = new Set<string>();
  let extensionRoots = 0;
  for (const root of journal.roots) {
    if (seenIndexes.has(root.index)) {
      return { ok: false, reason: `root index ${root.index} repeats` };
    }
    seenIndexes.add(root.index);
    if (seenLive.has(root.live)) {
      return { ok: false, reason: `root ${root.live} repeats` };
    }
    seenLive.add(root.live);

    if (root.role === "extension") {
      extensionRoots++;
      if (root.live !== expected.extensionRoot) {
        return {
          ok: false,
          reason:
            `extension root ${root.live} is not ${expected.extensionRoot}`,
        };
      }
      if (!root.hasNew) {
        return { ok: false, reason: "extension root has no new version" };
      }
    } else if (!expected.bundleRoots.includes(root.live)) {
      return {
        ok: false,
        reason:
          `bundle root ${root.live} is not a bundle dir of ${journal.extensionName}`,
      };
    }
    // a bundle root may have had nothing before and get nothing from the
    // archive: it is journaled so a roll-back removes the bundles loaders write
    // into it after the swap
    if (root.liveIsLink && (root.role !== "extension" || !root.liveExisted)) {
      return {
        ok: false,
        reason: `root ${root.live} cannot have been a symlink`,
      };
    }

    const paths = rootStagingPaths({
      pulledRoot: bounds.pulledRoot,
      stagingId: journal.stagingId,
      role: root.role,
      live: root.live,
      index: root.index,
    });
    if (
      root.stagingDir !== paths.stagingDir || root.old !== paths.old ||
      root.new !== paths.new
    ) {
      return {
        ok: false,
        reason: `staging paths of root ${root.live} do not match its layout`,
      };
    }
  }
  if (extensionRoots !== 1) {
    return {
      ok: false,
      reason: "journal must have exactly one extension root",
    };
  }

  const extensionStaging = join(
    bounds.pulledRoot,
    STAGING_DIR_NAME,
    journal.stagingId,
  );
  if (
    journal.manifest.staged !== join(extensionStaging, STAGED_MANIFEST_FILE) ||
    journal.manifest.live !== join(expected.extensionRoot, "manifest.yaml")
  ) {
    return { ok: false, reason: "manifest paths do not match their layout" };
  }

  for (const nested of journal.nestedRoots) {
    const segments = nested.relDir.split("/");
    if (
      segments.some((s) => !/^[a-z0-9_-]+$/.test(s))
    ) {
      return {
        ok: false,
        reason: `nested root ${nested.relDir} is not a relative entry path`,
      };
    }
  }

  return { ok: true, journal };
}

/**
 * a path outside the recorded repo dir (a lockfile kept outside the repo) is
 * kept as is
 */
function rebaseJournal(journal: InstallJournal, to: string): InstallJournal {
  const from = resolve(journal.repoDir);
  const rebase = (path: string): string => {
    const rel = relative(from, path);
    const outside = rel === ".." || rel.startsWith(`..${SEPARATOR}`) ||
      isAbsolute(rel);
    return outside ? path : join(to, rel);
  };
  return {
    ...journal,
    repoDir: to,
    lockfilePath: rebase(journal.lockfilePath),
    roots: journal.roots.map((root) => ({
      ...root,
      live: rebase(root.live),
      stagingDir: rebase(root.stagingDir),
      old: rebase(root.old),
      new: rebase(root.new),
    })),
    manifest: {
      staged: rebase(journal.manifest.staged),
      live: rebase(journal.manifest.live),
    },
  };
}

export type ObservedPath = "absent" | "dir" | "file" | "symlink" | "other";

export interface ObservedRoot {
  old: ObservedPath;
  new: ObservedPath;
  live: ObservedPath;
  discard: ObservedPath;
}

export interface ObservedInstall {
  roots: ReadonlyMap<number, ObservedRoot>;
  stagedManifest: ObservedPath;
  liveManifest: ObservedPath;
  liveManifestDigest: string | null;
  /**
   * a staging dir, or one between a root's container and its live path, that is
   * not a plain directory, since a symlink could send a rename outside the
   * repository
   */
  unsafeDir: string | null;
}

/** One rename recovery performs. The planner never deletes anything. */
export interface RecoveryRename {
  from: string;
  to: string;
  kind?: "symlink";
}

/**
 * forward: nothing moves, staging is deleted; back: renames restore every root
 * first; leave: disk matches no state an install produces, so nothing moves and
 * no root's only copy is lost
 */
export type RecoveryPlan =
  | { direction: "forward" }
  | { direction: "back"; renames: RecoveryRename[] }
  | { direction: "leave"; reason: string };

/**
 * judges each root by where its original copy is, so a crash anywhere stays
 * recoverable; rolls forward only if the journal reached swapped and the
 * lockfile entry has the new checksum, else back
 */
export function planRecovery(
  journal: InstallJournal,
  observed: ObservedInstall,
  lockfileEntryChecksum: string | null,
): RecoveryPlan {
  if (observed.unsafeDir !== null) {
    return {
      direction: "leave",
      reason: `${observed.unsafeDir} is not a plain directory`,
    };
  }
  const forward = journal.phase === "swapped" &&
    lockfileEntryChecksum === journal.newChecksum;

  const renames: RecoveryRename[] = [];
  for (const root of journal.roots) {
    const seen = observed.roots.get(root.index);
    if (!seen) {
      return { direction: "leave", reason: `root ${root.live} not observed` };
    }
    // The original's kind: a link may stand in the old and live slots.
    const original: ObservedPath = root.liveIsLink ? "symlink" : "dir";
    for (const [slot, state] of Object.entries(seen)) {
      const linkSlot = slot === "old" || slot === "live";
      if (
        state !== "absent" && state !== "dir" &&
        !(linkSlot && state === original)
      ) {
        return {
          direction: "leave",
          reason: `${slot} of root ${root.live} is not a plain directory`,
        };
      }
    }
    const o = seen.old === original;
    const l = seen.live === "dir";
    // The original still live: a moved-aside link never comes back as a
    // directory, so only the link itself counts.
    const originalLive = seen.live === original;

    if (forward) {
      // Nothing moves forward. A bundle root is a cache that loaders
      // outside the lock rebuild or evict, so only the extension root's
      // presence says whether the swap completed.
      const liveMismatch = root.role === "extension" && l !== root.hasNew;
      if (seen.new === "dir" || liveMismatch) {
        return {
          direction: "leave",
          reason: `root ${root.live} does not hold its new version`,
        };
      }
      continue;
    }

    const discardFree = seen.discard === "absent";
    const discard = rootDiscardPath(root);
    const restore: RecoveryRename = root.liveIsLink
      ? { from: root.old, to: root.live, kind: "symlink" }
      : { from: root.old, to: root.live };
    if (root.liveExisted) {
      if (!o && originalLive) continue;
      if (o && seen.live === "absent") {
        renames.push(restore);
        continue;
      }
      if (o && l && discardFree) {
        renames.push({ from: root.live, to: discard });
        renames.push(restore);
        continue;
      }
    } else if (!o) {
      if (!l) continue;
      if (discardFree) {
        renames.push({ from: root.live, to: discard });
        continue;
      }
    }
    return {
      direction: "leave",
      reason: `root ${root.live} is in a state recovery cannot resolve ` +
        `(old ${seen.old}, new ${seen.new}, discard ${seen.discard}, live ${seen.live})`,
    };
  }

  if (forward) {
    if (
      observed.stagedManifest !== "absent" ||
      observed.liveManifest !== "file" ||
      observed.liveManifestDigest !== journal.newManifestDigest
    ) {
      return {
        direction: "leave",
        reason: "the live manifest.yaml is not the one this install wrote",
      };
    }
    return { direction: "forward" };
  }
  return { direction: "back", renames };
}

/**
 * a nested entry's root lives inside its parent's, so the parent's digest and
 * swap must treat it as someone else's files
 */
export function nestedEntryRelDirs(
  name: string,
  entryNames: Iterable<string>,
): string[] {
  const prefix = `${name}/`;
  const out: string[] = [];
  for (const other of entryNames) {
    if (other.startsWith(prefix)) out.push(other.slice(prefix.length));
  }
  return out.sort();
}
