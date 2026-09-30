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
 * The install journal: the record one extension install writes before it
 * changes anything, so a crash at any point can be put right.
 *
 * An install builds the new version of each root it swaps in a staging
 * dir, moves every live root aside (phase 1), moves every new root into
 * place (phase 2) and only then deletes the old roots. The roots are the
 * extension root (`<pulledRoot>/<name>/`) and each bundle namespace dir
 * (`.swamp/<kind>-bundles/<ns>/`). Each root's `old/` and `new/` live in
 * its own staging dir next to it, so every rename stays on one
 * filesystem:
 *
 * - extension root: `<pulledRoot>/.swamp-staging/<stagingId>/{old,new}/0`
 * - bundle root: `<kindDir>/.swamp-staging-<stagingId>/{old,new}/<i>`
 *
 * The journal sits at `<pulledRoot>/.swamp-staging/<stagingId>/journal.json`.
 *
 * {@link planRecovery} decides, from the journal and what is actually on
 * disk, whether to roll the install forward or back. In-process failure
 * handling and crash recovery both use it, so both follow one rule.
 *
 * Pure: no filesystem access. The journal is repo-controlled data (a
 * `.swamp` dir can be committed), so {@link parseInstallJournal} checks
 * every path against the layout derived from the extension name before
 * recovery acts on it. The journal records the repo dir it was written
 * under, and a journal read from a repo that has since moved is rebased
 * onto the current repo dir before those checks.
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

/** Name of the per-install staging parent inside the pulled root. */
export const STAGING_DIR_NAME = ".swamp-staging";

/** Prefix of a bundle root's staging dir, next to its namespace dir. */
export const BUNDLE_STAGING_PREFIX = ".swamp-staging-";

/** File name of the journal inside the extension root's staging dir. */
export const INSTALL_JOURNAL_FILE = "journal.json";

/** Staged `manifest.yaml`, moved into the new extension root last. */
export const STAGED_MANIFEST_FILE = "manifest.yaml";

/** Name of a bundle root's staging dir for `stagingId`. */
export function bundleStagingDirName(stagingId: string): string {
  return `${BUNDLE_STAGING_PREFIX}${stagingId}`;
}

/**
 * True for a staging entry: `.swamp-staging` in the pulled root, or a
 * `.swamp-staging-<id>` sibling in a bundle kind dir. Every reader that
 * lists the pulled root or a bundle kind dir skips these.
 */
export function isStagingEntryName(name: string): boolean {
  return name === STAGING_DIR_NAME || name.startsWith(BUNDLE_STAGING_PREFIX);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `name` is a staging id (a lowercase or uppercase uuid). */
export function isStagingId(name: string): boolean {
  return UUID_PATTERN.test(name);
}

// Mirrors SCOPED_NAME_PATTERN in src/libswamp/extensions/pull.ts. The
// domain cannot import libswamp; the journal only needs to be sure the
// name is a plain relative path with no dots.
const EXTENSION_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

/**
 * True when `name` is a scoped extension name: a plain relative path with
 * no dots, safe to join onto the pulled root.
 */
export function isExtensionName(name: string): boolean {
  return EXTENSION_NAME_PATTERN.test(name);
}

/** Which kind of root: the extension root or a bundle namespace dir. */
export type InstallRootRole = "extension" | "bundle";

/** Journal phase. `swapped` is written after the last rename. */
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

/** One root the install swaps. */
export type InstallRoot = z.infer<typeof InstallRootSchema>;

/** A nested entry root carried into the new extension root. */
export type NestedRoot = z.infer<typeof NestedRootSchema>;

/** The journal as written to disk. */
export type InstallJournal = z.infer<typeof InstallJournalSchema>;

/** Staging paths for one root, all derived from its live path. */
export interface RootStagingPaths {
  stagingDir: string;
  old: string;
  new: string;
  /** Where recovery moves a superseded root; deleted with staging. */
  discard: string;
}

/**
 * The staging paths for root `index` of `stagingId`. The single source
 * of the layout: installs build their journal from it, and
 * {@link parseInstallJournal} requires every path to match it.
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

/** Where recovery moves a superseded copy of `root`. */
export function rootDiscardPath(root: InstallRoot): string {
  return join(root.stagingDir, "discard", String(root.index));
}

/** The journal's path for `stagingId`. */
export function installJournalPath(
  pulledRoot: string,
  stagingId: string,
): string {
  return join(pulledRoot, STAGING_DIR_NAME, stagingId, INSTALL_JOURNAL_FILE);
}

/** The live roots an install of one extension may swap. */
export interface ExpectedLivePaths {
  extensionRoot: string;
  bundleRoots: ReadonlyArray<string>;
}

/** What {@link parseInstallJournal} checks a journal against. */
export interface InstallJournalBounds {
  /** The absolute repo dir recovery runs in. */
  repoDir: string;
  pulledRoot: string;
  /** Lockfile paths an install in this checkout can write. */
  allowedLockfilePaths: ReadonlyArray<string>;
  /**
   * The live roots of `extensionName`. Injected so this module does not
   * import the infrastructure path helpers.
   */
  expectedLivePaths: (extensionName: string) => ExpectedLivePaths;
}

/** Result of {@link parseInstallJournal}. */
export type ParseInstallJournalResult =
  | { ok: true; journal: InstallJournal }
  | { ok: false; reason: string };

/**
 * Validates a journal read from disk before recovery acts on it. Beyond
 * the schema, every path must be exactly the one derived from the
 * extension name and the staging id, so a hand-edited or planted journal
 * cannot point a rename anywhere else.
 *
 * A journal written under another repo dir (the repo was moved, copied,
 * restored at another path or reached by another spelling) is first
 * rebased onto `bounds.repoDir`: each path under the recorded repo dir is
 * moved under the current one, and any other path is kept. The checks
 * then run on the rebased journal unchanged, so the rebase can only
 * accept a journal that could have been written with the current paths.
 * The returned journal is the rebased one.
 *
 * @param journalDirName Name of the dir the journal was read from; must
 *   equal the journal's stagingId.
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
    // A bundle root may have had nothing before and get nothing from the
    // archive: it is journaled so a roll-back also removes the bundles
    // the catalog save's loaders write into it after the swap. The
    // extension root always has a new version (checked above).
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
 * `journal` with every path under its recorded repo dir moved under `to`.
 * A path outside it (a lockfile kept outside the repo) is kept as is.
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

/** What recovery observed at one path, via lstat (never following links). */
export type ObservedPath = "absent" | "dir" | "file" | "symlink" | "other";

/** What recovery observed for one root. */
export interface ObservedRoot {
  old: ObservedPath;
  new: ObservedPath;
  live: ObservedPath;
  discard: ObservedPath;
}

/** Everything {@link planRecovery} reads from disk. */
export interface ObservedInstall {
  /** Keyed by root index. */
  roots: ReadonlyMap<number, ObservedRoot>;
  stagedManifest: ObservedPath;
  liveManifest: ObservedPath;
  /** Checksum of the live manifest.yaml, or null when it is absent. */
  liveManifestDigest: string | null;
  /**
   * A staging dir, or a dir between a root's container and its live
   * path, that is not a plain directory (a symlink could send a rename
   * outside the repository). Null when every one is a plain dir or
   * absent.
   */
  unsafeDir: string | null;
}

/** One rename recovery performs. The planner never deletes anything. */
export interface RecoveryRename {
  from: string;
  to: string;
  /** Set when the path moved is a symlink rather than a directory. */
  kind?: "symlink";
}

/**
 * The recovery decision.
 *
 * - `forward`: the install finished its renames and its lockfile entry
 *   landed. Nothing moves; the staging dirs (holding the old roots) are
 *   deleted.
 * - `back`: `renames` put every root back as it was before the install;
 *   then the staging dirs (holding the new roots) are deleted.
 * - `leave`: the disk does not match any state the install can produce.
 *   Nothing moves and the journal stays, so no root's only copy is lost.
 */
export type RecoveryPlan =
  | { direction: "forward" }
  | { direction: "back"; renames: RecoveryRename[] }
  | { direction: "leave"; reason: string };

/**
 * Decides how to put an interrupted install right, from the journal and
 * what is on disk. Each root is judged from where its original copy is,
 * never from the extension's manifest: in `old/<i>` once phase 1 moved
 * it aside, otherwise still live. Where the new copy is (`new/<i>`, live,
 * `discard/<i>`, or already deleted by a cleanup that crashed) does not
 * matter for a roll-back, so a crash anywhere, including in `begin` or
 * while deleting staging, stays recoverable.
 *
 * Roll forward only when the journal reached `swapped` and the lockfile
 * entry it names carries the new checksum; otherwise roll back.
 *
 * Rolling back, per root (o = `old/<i>` present, l = live present):
 *
 * | liveExisted | o | l | action                                        |
 * | ----------- | - | - | --------------------------------------------- |
 * | yes         | 0 | 1 | none: the original never left                 |
 * | yes         | 1 | 0 | old → live                                    |
 * | yes         | 1 | 1 | live → discard, old → live                    |
 * | no          | 0 | 1 | live → discard                                |
 * | no          | 0 | 0 | none                                          |
 *
 * An extension root that was a symlink (`liveIsLink`) is judged the
 * same way, with the link standing where the directory would: `old/<i>`
 * or live holds the link, and the link is what goes back.
 *
 * A live root found next to its moved-aside original is superseded
 * whatever it holds: the new version, or a bundle cache dir a loader
 * outside the lock recreated. Rolling forward, nothing may be left in
 * `new/<i>`, the extension root must be live and the live manifest must
 * be the one this install wrote. A bundle root's presence is not checked:
 * it is a cache that loaders outside the lock rebuild or evict.
 *
 * Anything else yields `leave`: an original that is gone (liveExisted,
 * neither copy present), an `old/<i>` for a root that did not exist, an
 * occupied `discard/<i>`, anything that is not a plain directory where a
 * directory belongs (a symlink included), or an unsafe staging dir.
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
 * The entry names nested under `name`, relative to its root: for
 * `@a/b` with an entry `@a/b/c`, returns `["c"]`. A nested entry's root
 * lives inside its parent's root, so the parent's digest and swap must
 * treat it as someone else's files.
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
