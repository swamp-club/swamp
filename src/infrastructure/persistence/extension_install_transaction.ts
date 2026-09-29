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

import { getLogger } from "@logtape/logtape";
import { dirname, join } from "@std/path";
import { computeChecksum } from "../../domain/models/checksum.ts";
import {
  BUNDLE_STAGING_PREFIX,
  INSTALL_JOURNAL_FILE,
  type InstallJournal,
  type InstallJournalBounds,
  installJournalPath,
  type InstallRootRole,
  isStagingId,
  type NestedRoot,
  type ObservedInstall,
  type ObservedPath,
  type ObservedRoot,
  parseInstallJournal,
  planRecovery,
  type RecoveryPlan,
  rootDiscardPath,
  rootStagingPaths,
  STAGED_MANIFEST_FILE,
  STAGING_DIR_NAME,
} from "../../domain/extensions/install_journal.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";

const logger = getLogger(["swamp", "extensions", "install-transaction"]);

/**
 * Journal-less staging left behind longer than this is swept. A live
 * install writes its journal before any other staging exists, so only a
 * crash between creating its staging dir and writing the journal leaves
 * one; the age keeps a sweep from racing an install on a shared volume.
 */
export const STAGING_SWEEP_AGE_MS = 60 * 60 * 1000;

/**
 * Filesystem operations the transaction uses. A seam so tests can fail
 * any step or record the order of calls; production uses
 * {@link defaultInstallFsOps}.
 */
export interface InstallFsOps {
  /** What is at `path`, without following a symlink. */
  lstat(path: string): Promise<ObservedPath>;
  /** Modification time of `path` (not following a symlink), or null. */
  mtime(path: string): Promise<Date | null>;
  rename(from: string, to: string): Promise<void>;
  /** Creates `path` and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Removes `path` recursively; a missing path is not an error. */
  remove(path: string): Promise<void>;
  /** Removes the dir `path` only when it is empty; otherwise a no-op. */
  removeIfEmpty(path: string): Promise<void>;
  writeJournal(path: string, text: string): Promise<void>;
  readText(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  readDir(path: string): Promise<string[]>;
  /**
   * Test seam: true when `error` models the process dying at the step
   * that threw it. The transaction then neither undoes its renames nor
   * settles, and drops its owner id, leaving the journal exactly as a
   * crash would for {@link recoverInstallStaging}. Production ops leave
   * it unset.
   */
  isSimulatedCrash?(error: unknown): boolean;
}

/** The real filesystem. */
export const defaultInstallFsOps: InstallFsOps = {
  async lstat(path) {
    try {
      const stat = await Deno.lstat(path);
      if (stat.isSymlink) return "other";
      if (stat.isDirectory) return "dir";
      if (stat.isFile) return "file";
      return "other";
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return "absent";
      throw error;
    }
  },
  async mtime(path) {
    try {
      return (await Deno.lstat(path)).mtime;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  },
  rename: (from, to) => Deno.rename(from, to),
  mkdir: (path) => Deno.mkdir(path, { recursive: true }),
  async remove(path) {
    try {
      await Deno.remove(path, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  },
  async removeIfEmpty(path) {
    try {
      for await (const _ of Deno.readDir(path)) return;
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  },
  writeJournal: (path, text) => atomicWriteTextFile(path, text),
  readText: (path) => Deno.readTextFile(path),
  readFile: (path) => Deno.readFile(path),
  async readDir(path) {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(path)) names.push(entry.name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return names;
  },
};

/**
 * Owner ids of the installs this process is running. Recovery leaves
 * their journals alone: a dependency install runs its own recovery while
 * its parent's swap is still uncommitted. No pid checks: containers
 * reuse pids.
 */
const activeOwners = new Set<string>();

/** True while this process's install `ownerId` is uncommitted. */
export function isActiveInstallOwner(ownerId: string): boolean {
  return activeOwners.has(ownerId);
}

/** One root an install asks to swap. */
export interface InstallRootSpec {
  role: InstallRootRole;
  live: string;
  /** Whether the new version has anything for this root. */
  hasNew: boolean;
}

/** Arguments to {@link ExtensionInstallTransaction.begin}. */
export interface BeginInstallArgs {
  pulledRoot: string;
  extensionName: string;
  /** The lockfile this install writes its entry to. */
  lockfilePath: string;
  /** Checksum of the archive being installed. */
  newChecksum: string;
  /** Checksum of the manifest.yaml this install writes. */
  newManifestDigest: string;
  /** The extension root first, then every candidate bundle root. */
  roots: ReadonlyArray<InstallRootSpec>;
  nestedRoots: ReadonlyArray<NestedRoot>;
  ops?: InstallFsOps;
}

/**
 * One install's stage-and-swap. {@link begin} writes the journal, then
 * creates the staging dirs the caller fills; {@link swap} moves the live
 * roots aside and the new ones in; {@link commit} deletes the old roots.
 * On any failure after begin, the caller runs {@link settle}.
 *
 * Between the first phase-1 rename and the `swapped` journal write, a
 * root is briefly absent to readers that do not take the pulled-extensions
 * lock. Only renames, lstats and journal reads and writes happen there,
 * to keep that window short.
 */
export class ExtensionInstallTransaction {
  readonly #ops: InstallFsOps;
  #journal: InstallJournal;
  #done = false;

  private constructor(journal: InstallJournal, ops: InstallFsOps) {
    this.#journal = journal;
    this.#ops = ops;
  }

  /**
   * Writes the journal, then creates every staging dir the install will
   * fill (and every parent a rename needs). Nothing is created before
   * the journal except the dir that holds it.
   *
   * A bundle root is kept only when the new version has files for it or
   * a live one exists. Throws when a live root is not a plain directory.
   */
  static async begin(
    args: BeginInstallArgs,
  ): Promise<ExtensionInstallTransaction> {
    const ops = args.ops ?? defaultInstallFsOps;
    const stagingId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();

    const roots: InstallJournal["roots"] = [];
    for (const spec of args.roots) {
      const live = await ops.lstat(spec.live);
      if (live !== "absent" && live !== "dir") {
        throw new Error(
          `Cannot install ${args.extensionName}: ${spec.live} is not a directory`,
        );
      }
      const liveExisted = live === "dir";
      if (spec.role === "bundle" && !liveExisted && !spec.hasNew) continue;
      const paths = rootStagingPaths({
        pulledRoot: args.pulledRoot,
        stagingId,
        role: spec.role,
        live: spec.live,
        index: roots.length,
      });
      roots.push({
        index: roots.length,
        role: spec.role,
        live: spec.live,
        stagingDir: paths.stagingDir,
        old: paths.old,
        new: paths.new,
        liveExisted,
        hasNew: spec.role === "extension" ? true : spec.hasNew,
      });
    }
    const extRoot = roots.find((r) => r.role === "extension");
    if (!extRoot) {
      throw new Error("An install transaction needs an extension root");
    }

    const liveManifest = join(extRoot.live, "manifest.yaml");
    const journal: InstallJournal = {
      schemaVersion: 1,
      ownerId,
      stagingId,
      extensionName: args.extensionName,
      phase: "staged",
      lockfilePath: args.lockfilePath,
      newChecksum: args.newChecksum,
      oldManifestDigest: await digestIfFile(ops, liveManifest),
      newManifestDigest: args.newManifestDigest,
      roots,
      manifest: {
        staged: join(extRoot.stagingDir, STAGED_MANIFEST_FILE),
        live: liveManifest,
      },
      nestedRoots: [...args.nestedRoots],
    };

    const tx = new ExtensionInstallTransaction(journal, ops);
    activeOwners.add(ownerId);
    try {
      await ops.mkdir(extRoot.stagingDir);
      await tx.#writeJournal();
      for (const root of roots) {
        if (root.liveExisted) await ops.mkdir(dirname(root.old));
        if (root.hasNew) {
          await ops.mkdir(root.new);
          await ops.mkdir(dirname(root.live));
          if (root.role === "bundle") {
            await ops.mkdir(dirname(supersededPath(root)));
          }
        }
      }
    } catch (error) {
      if (!tx.#isCrash(error)) await tx.#deleteStaging().catch(() => {});
      activeOwners.delete(ownerId);
      tx.#done = true;
      throw error;
    }
    return tx;
  }

  /** A copy of the journal as last written. */
  get journal(): InstallJournal {
    return structuredClone(this.#journal);
  }

  /** Where the new version of the root at `live` is staged. */
  newPathOf(live: string): string {
    const root = this.#journal.roots.find((r) => r.live === live);
    if (!root || !root.hasNew) {
      throw new Error(`${live} is not a root this install stages`);
    }
    return root.new;
  }

  /** Where the new manifest.yaml is staged until it is moved in last. */
  get stagedManifestPath(): string {
    return this.#journal.manifest.staged;
  }

  /**
   * Phase 1 moves each live root to `old/<i>`; phase 2 moves each new
   * root into place, the extension root after the bundles and
   * manifest.yaml last; then the journal records `swapped`. Ownership is
   * re-checked before each phase. On failure every completed rename is
   * undone in reverse order and the error is rethrown.
   */
  async swap(): Promise<void> {
    const done: Array<{ from: string; to: string }> = [];
    const move = async (from: string, to: string, kind: ObservedPath) => {
      await this.#checkedRename(from, to, kind);
      done.push({ from, to });
    };
    try {
      await this.#assertOwner();
      for (const root of this.#journal.roots) {
        if (root.liveExisted) await move(root.live, root.old, "dir");
      }
      await this.#assertOwner();
      const incoming = [
        ...this.#journal.roots.filter((r) => r.role === "bundle"),
        ...this.#journal.roots.filter((r) => r.role === "extension"),
      ];
      for (const root of incoming) {
        if (!root.hasNew) continue;
        // A bundle cache dir is rebuilt by loaders that do not take the
        // lock. One recreated since phase 1 (or since begin, for a root
        // that did not exist) is superseded, not a reason to abort.
        if (
          root.role === "bundle" && await this.#ops.lstat(root.live) === "dir"
        ) {
          await move(root.live, supersededPath(root), "dir");
        }
        await move(root.new, root.live, "dir");
      }
      await move(
        this.#journal.manifest.staged,
        this.#journal.manifest.live,
        "file",
      );
      this.#journal = { ...this.#journal, phase: "swapped" };
      try {
        await this.#writeJournal();
      } catch (error) {
        this.#journal = { ...this.#journal, phase: "staged" };
        throw error;
      }
    } catch (error) {
      if (!this.#isCrash(error)) {
        // Every step undone that can be: the roots are independent, so
        // one that cannot move back (a bundle dir a loader recreated)
        // must not leave the others, the extension root above all, in
        // staging. settle() resolves whatever is left.
        for (const step of done.reverse()) {
          try {
            await this.#ops.rename(step.to, step.from);
          } catch (undoError) {
            logger
              .warn`Could not yet restore part of ${this.#journal.extensionName}'s previous files; the rollback will retry`;
            logger
              .debug`Undo of ${step.from} -> ${step.to} failed: ${undoError}`;
          }
        }
      }
      throw error;
    }
  }

  /**
   * Deletes the staging dirs, and with them the old roots. The journal
   * goes first, so a crash mid-commit can never restore a half-deleted
   * old root; what is left is swept once stale. Never throws: the install
   * is complete.
   */
  async commit(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    try {
      await this.#deleteStaging();
    } catch (error) {
      logger
        .warn`Could not delete the install staging of ${this.#journal.extensionName}: ${error}; the next install or removal cleans it up`;
    } finally {
      activeOwners.delete(this.#journal.ownerId);
    }
  }

  /**
   * Puts things right after a failure anywhere past {@link begin}: rolls
   * forward when the journal reached `swapped` and the lockfile entry
   * landed, otherwise back. Never throws, so the caller always rethrows
   * the original error; a settle that fails, or a disk state it cannot
   * account for, leaves the journal for crash recovery. The owner id is
   * released after the attempt, so a later recovery in this process can
   * pick the journal up.
   */
  async settle(
    error: unknown,
    readLockfileChecksum: () => Promise<string | null>,
  ): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    try {
      if (this.#isCrash(error)) return;
      const outcome = await settleJournal(
        this.#journal,
        await readLockfileChecksum(),
        this.#ops,
      );
      if (outcome.direction === "leave") {
        logger
          .warn`Left the install journal ${this.#journalPath()} in place: ${outcome.reason}`;
      }
    } catch (settleError) {
      logger
        .warn`Could not settle the install of ${this.#journal.extensionName} (journal ${this.#journalPath()}): ${settleError}`;
    } finally {
      activeOwners.delete(this.#journal.ownerId);
    }
  }

  #isCrash(error: unknown): boolean {
    return this.#ops.isSimulatedCrash?.(error) ?? false;
  }

  #journalPath(): string {
    return join(
      extensionRootOf(this.#journal).stagingDir,
      INSTALL_JOURNAL_FILE,
    );
  }

  async #writeJournal(): Promise<void> {
    await this.#ops.writeJournal(
      this.#journalPath(),
      JSON.stringify(this.#journal, null, 2) + "\n",
    );
  }

  /** Throws unless the journal on disk is still this install's. */
  async #assertOwner(): Promise<void> {
    const { ownerId } = this.#journal;
    let onDisk: unknown;
    try {
      onDisk = JSON.parse(await this.#ops.readText(this.#journalPath()));
    } catch (error) {
      if (this.#isCrash(error)) throw error;
      throw new Error(
        `Install journal ${this.#journalPath()} is unreadable: ${error}`,
      );
    }
    const owner = (onDisk as { ownerId?: unknown } | null)?.ownerId;
    if (owner !== ownerId || !activeOwners.has(ownerId)) {
      throw new Error(
        `Install journal ${this.#journalPath()} is no longer owned by this install`,
      );
    }
  }

  async #checkedRename(
    from: string,
    to: string,
    kind: ObservedPath,
  ): Promise<void> {
    await checkedRename(this.#ops, from, to, kind);
  }

  async #deleteStaging(): Promise<void> {
    await deleteStaging(this.#journal, this.#ops);
  }
}

function extensionRootOf(journal: InstallJournal) {
  const ext = journal.roots.find((r) => r.role === "extension");
  if (!ext) throw new Error("journal has no extension root");
  return ext;
}

/**
 * Where phase 2 moves a bundle cache dir a loader recreated mid-swap.
 * Outside the slots recovery reads; deleted with the staging.
 */
function supersededPath(root: InstallJournal["roots"][number]): string {
  return join(root.stagingDir, "superseded", String(root.index));
}

/** Renames `from` to `to` only when `from` is a `kind` and `to` is free. */
async function checkedRename(
  ops: InstallFsOps,
  from: string,
  to: string,
  kind: ObservedPath,
): Promise<void> {
  const source = await ops.lstat(from);
  if (source !== kind) {
    throw new Error(
      `Refusing to move ${from}: expected a ${kind}, found ${source}`,
    );
  }
  const target = await ops.lstat(to);
  if (target !== "absent") {
    throw new Error(`Refusing to move ${from} onto existing ${to}`);
  }
  await ops.rename(from, to);
}

async function digestIfFile(
  ops: InstallFsOps,
  path: string,
): Promise<string | null> {
  if (await ops.lstat(path) !== "file") return null;
  return await computeChecksum(await ops.readFile(path));
}

/**
 * Deletes an install's staging once its renames are settled. The journal
 * goes first: from then on staging holds only superseded copies, and a
 * crash part-way through leaves journal-less staging that the stale sweep
 * removes, never a journal that recovery would act on again. Then the
 * bundle staging dirs, the journal's dir, and the `.swamp-staging` parent
 * once no other install's journal is in it.
 */
async function deleteStaging(
  journal: InstallJournal,
  ops: InstallFsOps,
): Promise<void> {
  const journalDir = extensionRootOf(journal).stagingDir;
  await ops.remove(join(journalDir, INSTALL_JOURNAL_FILE));
  const bundleDirs = new Set(
    journal.roots.filter((r) => r.role === "bundle").map((r) => r.stagingDir),
  );
  for (const dir of bundleDirs) await ops.remove(dir);
  await ops.remove(journalDir);
  await ops.removeIfEmpty(dirname(journalDir));
}

/** Reads what {@link planRecovery} needs from disk. */
export async function observeInstall(
  journal: InstallJournal,
  ops: InstallFsOps,
): Promise<ObservedInstall> {
  const roots = new Map<number, ObservedRoot>();
  for (const root of journal.roots) {
    const discard = rootDiscardPath(root);
    roots.set(root.index, {
      old: await ops.lstat(root.old),
      new: await ops.lstat(root.new),
      live: await ops.lstat(root.live),
      discard: await ops.lstat(discard),
    });
  }
  const liveManifest = await ops.lstat(journal.manifest.live);
  return {
    roots,
    stagedManifest: await ops.lstat(journal.manifest.staged),
    liveManifest,
    liveManifestDigest: liveManifest === "file"
      ? await computeChecksum(await ops.readFile(journal.manifest.live))
      : null,
    unsafeDir: await findUnsafeDir(journal, ops),
  };
}

/**
 * The first dir a recovery rename passes through that is neither a plain
 * directory nor absent: each staging dir and its `old`, `new` and
 * `discard` dirs, and every dir between a root's container (the pulled
 * root, or its bundle kind dir) and its live path. A symlink there would
 * send a rename, or the recursive mkdir before one, outside the repo.
 */
async function findUnsafeDir(
  journal: InstallJournal,
  ops: InstallFsOps,
): Promise<string | null> {
  const extStaging = extensionRootOf(journal).stagingDir;
  const pulledRoot = dirname(dirname(extStaging));
  const dirs = new Set<string>([dirname(extStaging)]);
  for (const root of journal.roots) {
    for (const slot of ["", "old", "new", "discard"]) {
      dirs.add(slot ? join(root.stagingDir, slot) : root.stagingDir);
    }
    const container = root.role === "extension"
      ? pulledRoot
      : dirname(root.stagingDir);
    for (
      let dir = dirname(root.live);
      dir !== container && dir.startsWith(container);
      dir = dirname(dir)
    ) {
      dirs.add(dir);
    }
  }
  for (const dir of dirs) {
    const kind = await ops.lstat(dir);
    if (kind !== "dir" && kind !== "absent") return dir;
  }
  return null;
}

/**
 * Observes, plans and carries out the recovery of one journal: the
 * renames of a roll-back, then the staging delete. A `leave` plan moves
 * nothing and keeps the journal.
 */
async function settleJournal(
  journal: InstallJournal,
  lockfileEntryChecksum: string | null,
  ops: InstallFsOps,
): Promise<RecoveryPlan> {
  const plan = planRecovery(
    journal,
    await observeInstall(journal, ops),
    lockfileEntryChecksum,
  );
  if (plan.direction === "leave") return plan;
  if (plan.direction === "back") {
    for (const rename of plan.renames) {
      await ops.mkdir(dirname(rename.to));
      await checkedRename(ops, rename.from, rename.to, "dir");
    }
  }
  await deleteStaging(journal, ops);
  return plan;
}

/** A journal recovery left in place. */
export interface LeftJournal {
  journalPath: string;
  /**
   * The extension it names, when the journal says: an install or removal
   * of that extension (or of one nested in or above it) must not go
   * ahead, or this journal could later act on its roots.
   */
  extensionName: string | null;
  reason: string;
}

/** What one {@link recoverInstallStaging} pass did. */
export interface StagingRecoveryReport {
  rolledForward: string[];
  rolledBack: string[];
  /** Journals left in place (invalid, or a state recovery cannot fix). */
  left: LeftJournal[];
  /** Journal-less staging dirs past the age threshold that were removed. */
  swept: string[];
}

/** Arguments to {@link recoverInstallStaging}. */
export interface RecoverInstallStagingArgs {
  bounds: InstallJournalBounds;
  /** Every bundle kind dir (`.swamp/<kind>-bundles`) to sweep. */
  bundleKindDirs: ReadonlyArray<string>;
  /** The checksum of `name`'s entry in the lockfile at `lockfilePath`. */
  readLockfileChecksum: (
    lockfilePath: string,
    name: string,
  ) => Promise<string | null>;
  now?: () => number;
  ops?: InstallFsOps;
}

/**
 * Puts right every install a crashed process left behind: each journal
 * under `<pulledRoot>/.swamp-staging/` whose owner is not an install
 * running in this process is validated, then rolled forward or back from
 * what is on disk. An invalid journal, one whose disk state recovery
 * cannot account for, or one whose recovery failed (a rename refused on
 * Windows, say) is left alone with a warning naming it, and reported so
 * the caller can refuse to change that extension. Journal-less staging is
 * removed only once older than {@link STAGING_SWEEP_AGE_MS}.
 *
 * A failure on one entry is logged and never stops the pass, so a
 * leftover that cannot be deleted does not block every install.
 *
 * The caller must hold the pulled-extensions lock.
 */
export async function recoverInstallStaging(
  args: RecoverInstallStagingArgs,
): Promise<StagingRecoveryReport> {
  const ops = args.ops ?? defaultInstallFsOps;
  const now = args.now ?? Date.now;
  const report: StagingRecoveryReport = {
    rolledForward: [],
    rolledBack: [],
    left: [],
    swept: [],
  };
  const sweep = async (path: string) => {
    try {
      const mtime = await ops.mtime(path);
      if (mtime === null || now() - mtime.getTime() <= STAGING_SWEEP_AGE_MS) {
        return;
      }
      await ops.remove(path);
      report.swept.push(path);
    } catch (error) {
      logger.warn`Could not remove stale install staging ${path}: ${error}`;
    }
  };
  const leave = (
    journalPath: string,
    extensionName: string | null,
    reason: string,
  ) => {
    logger.warn`Left the install journal ${journalPath} in place: ${reason}`;
    report.left.push({ journalPath, extensionName, reason });
  };
  const readNames = async (dir: string): Promise<string[]> => {
    try {
      return (await ops.readDir(dir)).sort();
    } catch (error) {
      logger.warn`Could not list ${dir} for install recovery: ${error}`;
      return [];
    }
  };

  const stagingParent = join(args.bounds.pulledRoot, STAGING_DIR_NAME);
  const journalIds = new Set<string>();
  if (await ops.lstat(stagingParent) === "dir") {
    for (const name of await readNames(stagingParent)) {
      if (!isStagingId(name)) continue;
      const dir = join(stagingParent, name);
      const journalPath = installJournalPath(args.bounds.pulledRoot, name);
      try {
        if (await ops.lstat(dir) !== "dir") {
          await sweep(dir);
          continue;
        }
        const journalKind = await ops.lstat(journalPath);
        if (journalKind === "absent") {
          await sweep(dir);
          continue;
        }
        journalIds.add(name);

        let raw: unknown;
        try {
          if (journalKind !== "file") throw new Error("not a regular file");
          raw = JSON.parse(await ops.readText(journalPath));
        } catch (error) {
          leave(journalPath, null, `the journal cannot be read (${error})`);
          continue;
        }
        const rawName = (raw as { extensionName?: unknown } | null)
          ?.extensionName;
        const namedAs = typeof rawName === "string" ? rawName : null;
        const parsed = parseInstallJournal(raw, args.bounds, name);
        if (!parsed.ok) {
          leave(journalPath, namedAs, `invalid journal: ${parsed.reason}`);
          continue;
        }
        const journal = parsed.journal;
        if (activeOwners.has(journal.ownerId)) continue;

        const plan = await settleJournal(
          journal,
          await args.readLockfileChecksum(
            journal.lockfilePath,
            journal.extensionName,
          ),
          ops,
        );
        if (plan.direction === "leave") {
          leave(journalPath, journal.extensionName, plan.reason);
        } else if (plan.direction === "forward") {
          logger
            .info`Finished the interrupted install of ${journal.extensionName}`;
          report.rolledForward.push(journal.extensionName);
        } else {
          logger
            .info`Rolled back the interrupted install of ${journal.extensionName}`;
          report.rolledBack.push(journal.extensionName);
        }
      } catch (error) {
        journalIds.add(name);
        let namedAs: string | null = null;
        try {
          const raw = JSON.parse(await ops.readText(journalPath));
          if (typeof raw?.extensionName === "string") {
            namedAs = raw.extensionName;
          }
        } catch {
          // Journal already gone or unreadable: nothing to attribute.
        }
        leave(journalPath, namedAs, `recovery failed (${error})`);
      }
    }
    try {
      await ops.removeIfEmpty(stagingParent);
    } catch (error) {
      logger.debug`Could not remove empty ${stagingParent}: ${error}`;
    }
  }

  for (const kindDir of args.bundleKindDirs) {
    if (await ops.lstat(kindDir) !== "dir") continue;
    for (const name of await readNames(kindDir)) {
      if (!name.startsWith(BUNDLE_STAGING_PREFIX)) continue;
      const id = name.slice(BUNDLE_STAGING_PREFIX.length);
      if (!isStagingId(id) || journalIds.has(id)) continue;
      await sweep(join(kindDir, name));
    }
  }
  return report;
}

/**
 * The journals in `report` that block changing extension `name`: those
 * naming `name`, an extension nested in it, or one it is nested in. Their
 * roots overlap `name`'s, so changing `name` first would let a later
 * recovery act on files it did not write.
 */
export function blockingLeftJournals(
  report: StagingRecoveryReport,
  name: string,
): LeftJournal[] {
  return report.left.filter(({ extensionName: other }) =>
    other !== null &&
    (other === name || other.startsWith(`${name}/`) ||
      name.startsWith(`${other}/`))
  );
}
