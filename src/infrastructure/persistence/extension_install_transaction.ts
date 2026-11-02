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
import { dirname, join, resolve } from "@std/path";
import { computeChecksum } from "../../domain/models/checksum.ts";
import {
  BUNDLE_STAGING_PREFIX,
  INSTALL_JOURNAL_FILE,
  type InstallJournal,
  type InstallJournalBounds,
  installJournalPath,
  type InstallRootRole,
  isExtensionName,
  isStagingId,
  type NestedRoot,
  type ObservedInstall,
  type ObservedPath,
  type ObservedRoot,
  parseInstallJournal,
  planRecovery,
  type RecoveryPlan,
  type RecoveryRename,
  rootDiscardPath,
  rootStagingPaths,
  STAGED_MANIFEST_FILE,
  STAGING_DIR_NAME,
} from "../../domain/extensions/install_journal.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { errorPaths, markErrorPaths } from "../../domain/errors.ts";

const logger = getLogger(["swamp", "extensions", "install-transaction"]);

/**
 * journal-less staging older than this is swept: a live install writes its
 * journal first, so only a crash before that leaves one; the age keeps a sweep
 * from racing an install on a shared volume
 */
export const STAGING_SWEEP_AGE_MS = 60 * 60 * 1000;

export interface InstallFsOps {
  lstat(path: string): Promise<ObservedPath>;
  mtime(path: string): Promise<Date | null>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  removeIfEmpty(path: string): Promise<void>;
  writeJournal(path: string, text: string): Promise<void>;
  readText(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  readDir(path: string): Promise<string[]>;
  /**
   * test seam: true when error models the process dying at that step; the
   * transaction then neither undoes its renames nor settles, leaving the
   * journal as a crash would
   */
  isSimulatedCrash?(error: unknown): boolean;
}

export const defaultInstallFsOps: InstallFsOps = {
  async lstat(path) {
    try {
      const stat = await Deno.lstat(path);
      if (stat.isSymlink) return "symlink";
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
 * recovery leaves these journals alone, since a dependency install runs its own
 * recovery while its parent's swap is uncommitted; no pid checks because
 * containers reuse pids
 */
const activeOwners = new Set<string>();

export function isActiveInstallOwner(ownerId: string): boolean {
  return activeOwners.has(ownerId);
}

export interface InstallRootSpec {
  role: InstallRootRole;
  live: string;
  hasNew: boolean;
}

export interface BeginInstallArgs {
  repoDir: string;
  pulledRoot: string;
  extensionName: string;
  lockfilePath: string;
  newChecksum: string;
  newManifestDigest: string;
  roots: ReadonlyArray<InstallRootSpec>;
  nestedRoots: ReadonlyArray<NestedRoot>;
  ops?: InstallFsOps;
}

/**
 * between the first phase-1 rename and the swapped journal write a root is
 * briefly absent to readers that skip the pulled-extensions lock, so only
 * renames, lstats and journal I/O happen there
 */
export class ExtensionInstallTransaction {
  readonly #ops: InstallFsOps;
  #journal: InstallJournal;
  #done = false;

  private constructor(journal: InstallJournal, ops: InstallFsOps) {
    this.#journal = journal;
    this.#ops = ops;
  }

  static async begin(
    args: BeginInstallArgs,
  ): Promise<ExtensionInstallTransaction> {
    const ops = args.ops ?? defaultInstallFsOps;
    const stagingId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();

    const roots: InstallJournal["roots"] = [];
    for (const spec of args.roots) {
      const live = await ops.lstat(spec.live);
      // A symlinked extension root is replaced, not written through:
      // phase 1 moves the link aside like a directory.
      const liveIsLink = spec.role === "extension" && live === "symlink";
      if (live !== "absent" && live !== "dir" && !liveIsLink) {
        throw new Error(
          `Cannot install ${args.extensionName}: ${spec.live} is not a directory`,
        );
      }
      const liveExisted = live === "dir" || liveIsLink;
      // Every bundle root is journaled, even one that did not exist and
      // gets nothing from the archive: the catalog save's loaders write
      // bundles into it after the swap, and a roll-back must remove them.
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
        ...(liveIsLink ? { liveIsLink } : {}),
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
      repoDir: resolve(args.repoDir),
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

  get journal(): InstallJournal {
    return structuredClone(this.#journal);
  }

  newPathOf(live: string): string {
    const root = this.#journal.roots.find((r) => r.live === live);
    if (!root || !root.hasNew) {
      throw new Error(`${live} is not a root this install stages`);
    }
    return root.new;
  }

  get stagedManifestPath(): string {
    return this.#journal.manifest.staged;
  }

  /**
   * ownership is re-checked before each phase; the extension root moves after
   * the bundles and manifest.yaml last; on failure completed renames are undone
   * in reverse order
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
        if (root.liveExisted) {
          await move(root.live, root.old, root.liveIsLink ? "symlink" : "dir");
        }
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
   * the journal goes first so a crash mid-commit never restores a half-deleted
   * old root; leftovers are swept once stale. Never throws: the install is
   * complete
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
   * the caller restores the lockfile entry first, so a crash part-way leaves a
   * journal recovery rolls back; never throws: an unaccountable disk state or
   * failed rename leaves the journal and returns false
   */
  async rollback(): Promise<boolean> {
    if (this.#done) return false;
    this.#done = true;
    try {
      const plan = planRecovery(
        this.#journal,
        await observeInstall(this.#journal, this.#ops),
        null,
      );
      if (plan.direction === "leave") {
        logger
          .warn`Left the install journal ${this.#journalPath()} in place: ${plan.reason}`;
        return false;
      }
      await applyRecoveryRenames(this.#journal, plan, this.#ops, {
        onTargetOccupied: (rename, error) =>
          this.#supersedeRecreatedBundle(rename, error),
      });
      return true;
    } catch (error) {
      if (!this.#isCrash(error)) {
        logger
          .warn`Could not roll back the install of ${this.#journal.extensionName} (journal ${this.#journalPath()}): ${error}`;
      }
      return false;
    } finally {
      activeOwners.delete(this.#journal.ownerId);
    }
  }

  /**
   * stops without moving anything: the journal stays for the next recovery,
   * which decides roll forward or back from the lockfile entry; the owner id is
   * released so recovery may act
   */
  release(): void {
    if (this.#done) return;
    this.#done = true;
    activeOwners.delete(this.#journal.ownerId);
    logger
      .warn`Left the install journal ${this.#journalPath()} in place for the next extension install or removal to settle`;
  }

  /**
   * when an old bundle root cannot move back because a loader recreated the
   * live dir, move that dir to a free path under its staging dir, which the
   * staging delete removes
   */
  async #supersedeRecreatedBundle(
    rename: RecoveryRename,
    error: unknown,
  ): Promise<boolean> {
    if (this.#isCrash(error)) return false;
    const root = this.#journal.roots.find((r) =>
      r.role === "bundle" && r.live === rename.to && r.old === rename.from
    );
    if (!root) return false;
    if (await this.#ops.lstat(root.old) !== "dir") return false;
    if (await this.#ops.lstat(root.live) !== "dir") return false;
    let aside = "";
    for (let n = 0;; n++) {
      aside = join(
        root.stagingDir,
        "superseded",
        `${root.index}-rollback-${n}`,
      );
      if (await this.#ops.lstat(aside) === "absent") break;
    }
    await this.#ops.mkdir(dirname(aside));
    await checkedRename(this.#ops, root.live, aside, "dir");
    logger
      .debug`Moved ${root.live}, recreated during the roll-back, aside to ${aside}`;
    return true;
  }

  /**
   * rolls forward when the journal reached swapped and the lockfile entry
   * landed, otherwise back; never throws so the caller rethrows the original
   * error; a failure leaves the journal for crash recovery
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

  async #assertOwner(): Promise<void> {
    const { ownerId } = this.#journal;
    let onDisk: unknown;
    try {
      onDisk = JSON.parse(await this.#ops.readText(this.#journalPath()));
    } catch (error) {
      if (this.#isCrash(error)) throw error;
      throw markErrorPaths(
        new Error(
          `Install journal ${this.#journalPath()} is unreadable: ${error}`,
        ),
        [this.#journalPath(), ...errorPaths(error)],
      );
    }
    const owner = (onDisk as { ownerId?: unknown } | null)?.ownerId;
    if (owner !== ownerId || !activeOwners.has(ownerId)) {
      throw markErrorPaths(
        new Error(
          `Install journal ${this.#journalPath()} is no longer owned by this install`,
        ),
        [this.#journalPath()],
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

/** outside the slots recovery reads; deleted with the staging */
function supersededPath(root: InstallJournal["roots"][number]): string {
  return join(root.stagingDir, "superseded", String(root.index));
}

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
 * the journal goes first: a crash part-way then leaves journal-less staging for
 * the stale sweep, never a journal recovery would act on again
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
 * a symlink in any dir a recovery rename passes through would send a rename, or
 * the recursive mkdir before it, outside the repo
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
  await applyRecoveryRenames(journal, plan, ops);
  return plan;
}

interface RecoveryRenameHooks {
  onTargetOccupied?(rename: RecoveryRename, error: unknown): Promise<boolean>;
}

/** every error is rethrown unchanged unless a hook asks for one retry */
async function applyRecoveryRenames(
  journal: InstallJournal,
  plan: Exclude<RecoveryPlan, { direction: "leave" }>,
  ops: InstallFsOps,
  hooks: RecoveryRenameHooks = {},
): Promise<void> {
  if (plan.direction === "back") {
    for (const rename of plan.renames) {
      await ops.mkdir(dirname(rename.to));
      const kind = rename.kind ?? "dir";
      try {
        await checkedRename(ops, rename.from, rename.to, kind);
      } catch (error) {
        if (!(await hooks.onTargetOccupied?.(rename, error))) throw error;
        await checkedRename(ops, rename.from, rename.to, kind);
      }
    }
  }
  await deleteStaging(journal, ops);
}

export interface LeftJournal {
  journalPath: string;
  /**
   * an install or removal of that extension (or one nested in or above it) must
   * not go ahead, or this journal could later act on its roots
   */
  extensionName: string | null;
  reason: string;
  extensionRoot?: ExtensionRootCopies;
}

export interface ExtensionRootCopies {
  live: string;
  liveState: ObservedPath;
  old: string;
  oldState: ObservedPath;
}

export interface StagingRecoveryReport {
  rolledForward: string[];
  rolledBack: string[];
  left: LeftJournal[];
  swept: string[];
}

export interface RecoverInstallStagingArgs {
  bounds: InstallJournalBounds;
  bundleKindDirs: ReadonlyArray<string>;
  readLockfileChecksum: (
    lockfilePath: string,
    name: string,
  ) => Promise<string | null>;
  now?: () => number;
  ops?: InstallFsOps;
}

/**
 * an entry that fails is logged and never stops the pass; journals recovery
 * cannot fix are left and reported so callers refuse to change that extension.
 * Caller must hold the pulled-extensions lock
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
  const leave = async (
    stagingId: string,
    extensionName: string | null,
    reason: string,
    journal?: InstallJournal,
  ) => {
    const journalPath = installJournalPath(args.bounds.pulledRoot, stagingId);
    logger.warn`Left the install journal ${journalPath} in place: ${reason}`;
    const left: LeftJournal = { journalPath, extensionName, reason };
    const extensionRoot = await observeExtensionRootCopies(
      args.bounds,
      ops,
      stagingId,
      extensionName,
      journal,
    );
    if (extensionRoot) left.extensionRoot = extensionRoot;
    report.left.push(left);
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
          await leave(name, null, `the journal cannot be read (${error})`);
          continue;
        }
        const rawName = (raw as { extensionName?: unknown } | null)
          ?.extensionName;
        const namedAs = typeof rawName === "string" ? rawName : null;
        const parsed = parseInstallJournal(raw, args.bounds, name);
        if (!parsed.ok) {
          await leave(name, namedAs, `invalid journal: ${parsed.reason}`);
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
          await leave(name, journal.extensionName, plan.reason, journal);
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
        await leave(name, namedAs, `recovery failed (${error})`);
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
 * the slot comes from the journal only when it was validated, else from the
 * layout (the extension root is always slot 0), never from an unchecked journal
 */
async function observeExtensionRootCopies(
  bounds: InstallJournalBounds,
  ops: InstallFsOps,
  stagingId: string,
  name: string | null,
  journal: InstallJournal | undefined,
): Promise<ExtensionRootCopies | null> {
  if (name === null || !isExtensionName(name)) return null;
  const root = journal ? extensionRootOf(journal) : undefined;
  const live = root?.live ?? bounds.expectedLivePaths(name).extensionRoot;
  const old = root?.old ?? rootStagingPaths({
    pulledRoot: bounds.pulledRoot,
    stagingId,
    role: "extension",
    live,
    index: 0,
  }).old;
  try {
    return {
      live,
      liveState: await ops.lstat(live),
      old,
      oldState: await ops.lstat(old),
    };
  } catch (error) {
    logger.debug`Could not check the copies of ${name} for recovery: ${error}`;
    return null;
  }
}

/**
 * journals naming name or a nested or enclosing extension overlap its roots, so
 * changing name first would let a later recovery act on files it did not write
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
