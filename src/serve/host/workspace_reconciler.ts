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

import { dirname, join } from "@std/path";
import { workspaceServe } from "../../domain/serve/managed_serve.ts";
import {
  type HostedWorkspace,
  type HostedWorkspaceRead,
  type HostedWorkspaceRepository,
  serveWantedOfRecord,
} from "../../domain/serve/hosted_workspace.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { wantedFileName } from "../../infrastructure/persistence/hosted_workspace_file_repository.ts";
import {
  removeHostedWorkspaceStatus,
  writeHostedWorkspaceStatus,
} from "../../infrastructure/persistence/hosted_workspace_status_file.ts";
import type { ServeChildSpec } from "./serve_process.ts";
import type { StatusWriter } from "./status_writer.ts";
import type { ServeSupervisor } from "./supervisor.ts";
import type { WorkspaceFolders } from "./workspace_roster.ts";
import type { HostedWorkspaceFolder } from "../../libswamp/workspace/hosted_roster.ts";
import {
  creatingFolderOwner,
  deletingFolderName,
  deletingFolderOwner,
  REPO_MARKER_FILE,
  type WorkspaceScan,
} from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import { createdOwnership } from "../../libswamp/workspace/hosted_roster.ts";

const logger = getSwampLogger(["serve", "host", "workspaces"]);

export type WantedRead = HostedWorkspaceRead | { readonly kind: "vanished" };
export type WantedReads = ReadonlyMap<string, WantedRead>;

export interface WorkspaceReconcilerOptions {
  readonly workspacesDir: string;
  readonly supervisor: Pick<
    ServeSupervisor,
    "add" | "setWanted" | "resume" | "setSpec" | "lookup" | "whenStopped"
  >;
  readonly specOf: (name: string, folder: string) => ServeChildSpec;
  readonly repository: HostedWorkspaceRepository;
  readonly statusWriter: Pick<StatusWriter, "setProblem" | "forget" | "track">;
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** what removing a workspace a request created needs */
  readonly created: CreatedWorkspaceRemoval;
  /** whether a workspace's folder holds the OAuth client's secret file */
  readonly holdsOAuthSecret?: (folder: string) => boolean;
}

export interface CreatedWorkspaceRemoval {
  /** the folder the registry, read afresh, names for `name`, as written and real; null for none; rejects when unreadable */
  registeredFolder(
    name: string,
  ): Promise<{ readonly path: string; readonly real: string } | null>;
  /** removes the entry only while it names `path`, as registeredFolder gave it; rejects when it cannot be written */
  unregister(name: string, path: string): Promise<void>;
  /** where a create puts its hidden folder: the workspace location and the data dir's own; never rejects */
  locations(): Promise<readonly string[]>;
  /** runs `fn` holding the name's create lock, or answers busy while a create or change holds it */
  whileIdle<T>(name: string, fn: () => Promise<T>): Promise<T | "busy">;
}

export interface WorkspaceReconciler {
  /** at startup, after the bind: nothing here awaits, so every add lands before a request */
  begin(
    scan: WorkspaceScan,
    reads: WantedReads,
    folders: WorkspaceFolders,
  ): readonly string[];
  reconcile(
    scan: WorkspaceScan,
    reads: WantedReads,
    folders: WorkspaceFolders,
  ): void;
  /** the workspaces last reconciled that the host serves: none being removed or wanted deleted */
  served(): readonly string[];
  /** waits for every removal, including one waiting for its serve to stop */
  drain(): Promise<void>;
}

interface Known {
  folder: string | null;
  /** the operator's own as last listed, so an unlisted name is never removed on a guess */
  operator: boolean;
  /** where it was last listed from; a registry listing that ends is leaving the registry */
  listedFrom: "registry" | "wanted_file" | null;
  /** the folder the supervisor's spec names, so a changed folder reaches the next start */
  specFolder: string | null;
  /** the last wanted record read whole; null for no file */
  record: HostedWorkspace | null;
  /** whether that record was written for the folder it would act on */
  recordMatches: boolean;
  /** the folder that match was decided for; a record never acts on another */
  recordFolder: string | null;
  problem: string | null;
  /** why the host holds it stopped whatever the record says; null when it does not */
  held: string | null;
  removing: boolean;
  /** bumped when the workspace is added again or removed, so stale cleanup stands down */
  generation: number;
  /** ends a wait for a stop that a listing again may never bring */
  standDown: (() => void) | null;
  ignoredLogged: boolean;
  /** a stopped create's leftovers are being removed */
  settling: boolean;
  /** one hidden name per removal, so a retry neither scatters folders nor changes its error */
  hiddenName: string | null;
}

type RemovalStep = "read" | "rename" | "list" | "remove" | "unregister";

class RemovalStepError extends Error {
  constructor(readonly step: RemovalStep, override readonly cause: unknown) {
    super(messageOf(cause), { cause });
  }

  /** stable across retries, unlike a message that may name a path */
  get key(): string {
    return `${this.step}:${errorClassOf(this.cause)}`;
  }
}

/** the folder another workspace has, which ends a removal rather than failing it */
class FolderClaimedError extends Error {
  constructor(readonly claim: string) {
    super(`its folder is not removed: ${claim}`);
  }
}

/** a retry every rescan logs once per reason, not once per attempt */
export class ReasonMemo {
  readonly #reasons = new Map<string, string>();

  /** true the first time a key reports a reason, and again only when it changes */
  changed(key: string, reason: string): boolean {
    if (this.#reasons.get(key) === reason) return false;
    this.#reasons.set(key, reason);
    return true;
  }

  clear(key: string): void {
    this.#reasons.delete(key);
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of [...this.#reasons.keys()]) {
      if (!keys.has(key)) this.#reasons.delete(key);
    }
  }
}

/**
 * a wanted file is read only for a name the scan saw one for; one gone by the
 * read, as while an editor saves by removing and recreating it, is "vanished"
 */
export async function readWantedFiles(
  repository: HostedWorkspaceRepository,
  scan: WorkspaceScan,
): Promise<Map<string, WantedRead>> {
  const reads = new Map<string, WantedRead>();
  for (const name of scan.wantedFiles) {
    const read = await repository.findByName(name);
    reads.set(name, read.kind === "absent" ? { kind: "vanished" } : read);
  }
  return reads;
}

export function createWorkspaceReconciler(
  options: WorkspaceReconcilerOptions,
): WorkspaceReconciler {
  const {
    workspacesDir,
    supervisor,
    specOf,
    repository,
    statusWriter,
    created,
  } = options;
  const rename = options.rename ?? Deno.rename;
  const known = new Map<string, Known>();
  const pending = new Set<Promise<void>>();
  // a scan listed before a removal finished still shows its folder
  const removedAt = new Map<string, number>();
  const removalFailures = new ReasonMemo();
  const dropLog = new ReasonMemo();
  let applied: ReadonlyMap<string, HostedWorkspaceFolder> = new Map();
  let registered: ReadonlySet<string> = new Set();

  const track = (work: Promise<void>) => {
    const settled = work.finally(() => pending.delete(settled));
    pending.add(settled);
  };

  const knownOf = (name: string): Known => {
    let entry = known.get(name);
    if (entry === undefined) {
      entry = {
        folder: null,
        operator: false,
        listedFrom: null,
        specFolder: null,
        record: null,
        recordMatches: true,
        recordFolder: null,
        problem: null,
        held: null,
        standDown: null,
        removing: false,
        generation: 0,
        ignoredLogged: false,
        settling: false,
        hiddenName: null,
      };
      known.set(name, entry);
    }
    return entry;
  };

  const apply = (
    scan: WorkspaceScan,
    reads: WantedReads,
    folders: WorkspaceFolders,
  ) => {
    applied = folders.workspaces;
    registered = folders.registered;
    const names = new Set([
      ...folders.workspaces.keys(),
      ...scan.wantedFiles,
      ...known.keys(),
    ]);
    for (const [name, at] of removedAt) {
      if (at < scan.startedAt) removedAt.delete(name);
    }
    for (const name of [...names].sort()) {
      if (removedAt.has(name)) continue;
      const read = reads.get(name) ?? { kind: "absent" };
      // the next scan, listed after the save, decides
      if (read.kind === "vanished") continue;
      step(
        name,
        folders.workspaces.get(name) ?? null,
        folders.wantedMatches.get(name),
        read,
      );
    }
  };

  // the host's own, wanted deleted by a file written for the folder it would remove
  const removable = (entry: Known, folder: string | null) =>
    !entry.operator && entry.record?.wanted === "deleted" &&
    entry.recordMatches && entry.recordFolder === folder;

  const step = (
    name: string,
    listing: HostedWorkspaceFolder | null,
    readMatches: boolean | undefined,
    read: HostedWorkspaceRead,
  ) => {
    const entry = knownOf(name);
    if (listing !== null) entry.operator = listing.owner === "operator";
    // deleted is never left: an edit after removal began is not obeyed, and a
    // removal that failed is tried again whatever the file now says
    if (entry.removing || removable(entry, listing?.folder ?? null)) {
      if (
        read.kind === "found" && read.workspace.wanted !== "deleted" &&
        !entry.ignoredLogged
      ) {
        entry.ignoredLogged = true;
        logger.warn(
          "Workspace {name} is being removed; the change to its wanted file is ignored",
          { name },
        );
      }
      if (!entry.removing) startRemoval(name, entry);
      return;
    }

    const folder = listing?.folder ?? null;
    let record = entry.record;
    let recordMatches = entry.recordMatches;
    let problem: string | null = null;
    if (read.kind === "found") {
      record = read.workspace;
      recordMatches = readMatches ?? record.folder === null;
    } // a folder keeps its last record across an absent file, as while an editor saves
    else if (read.kind === "absent") {
      if (folder === null) {
        record = null;
        recordMatches = true;
      }
    } else problem = read.reason;
    // a record kept from another folder was never written for this one
    if (
      read.kind !== "found" && record !== null && entry.recordFolder !== folder
    ) {
      recordMatches = false;
    }
    // never left waiting: freeing the name, as the host advises, would carry it out
    if (
      read.kind === "found" && record?.wanted === "deleted" &&
      !recordMatches
    ) {
      dropDeleted(name, read.workspace);
      record = null;
      recordMatches = true;
    }
    // a creator written for a folder the registry no longer names would make the next folder written the host's own;
    // one over another repo would carry its old wanted state to that repo
    const replaced = listing?.replaced === true;
    if (
      read.kind === "found" && record !== null &&
      record.creator !== null && (!recordMatches || replaced) &&
      listing?.owner === "operator"
    ) {
      dropCreatedElsewhere(name, read.workspace, replaced);
      record = null;
      recordMatches = true;
    }
    if (problem !== entry.problem) {
      if (problem !== null) {
        logger.warn("{reason}; workspace {name} is left as it is", {
          reason: problem,
          name,
        });
      }
      entry.problem = problem;
    }
    const held = listing === null
      ? null
      : heldReason(name, listing, record, recordMatches);
    if (held !== entry.held && held !== null) {
      logger.warn("Workspace {name} is not started: {reason}", {
        name,
        reason: held,
      });
    }
    const changed = !sameRecord(record, entry.record) || held !== entry.held;
    statusWriter.setProblem(name, problem ?? held);
    const hadFolder = entry.folder !== null;
    entry.record = record;
    entry.recordMatches = recordMatches;
    entry.recordFolder = folder;
    entry.held = held;
    entry.folder = folder;

    if (removable(entry, folder)) {
      startRemoval(name, entry);
      return;
    }
    const id = workspaceServe(name);
    const status = supervisor.lookup(id);
    if (listing === null) {
      // one still registered, as under a second spelling of a folder, keeps its files
      if (entry.listedFrom === "registry" && !registered.has(name)) {
        entry.listedFrom = null;
        leaveRegistry(name, entry);
        return;
      }
      entry.listedFrom = null;
      // a creator with no entry is a create that stopped before it registered, once no create holds the name
      if (
        read.kind === "found" && record !== null && record.creator !== null &&
        record.folder !== null && record.wanted !== "deleted" &&
        !entry.settling
      ) {
        settleStoppedCreate(name, entry, record);
      }
      // a wanted file without a folder may be a workspace still being set up
      if (status !== undefined && status.wanted !== "deleted") {
        supervisor.setWanted(id, "deleted");
        clearStatusWhenStopped(name, entry);
      }
      return;
    }
    entry.listedFrom = listing.fromWantedFile ? "wanted_file" : "registry";
    if (status !== undefined && entry.specFolder !== listing.folder) {
      // a live serve keeps its folder; its next start runs in this one
      supervisor.setSpec(specOf(name, listing.folder));
      entry.specFolder = listing.folder;
    }
    const wanted = held === null ? serveWantedOfRecord(record) : "suspended";
    if (status === undefined || !hadFolder || status.wanted === "deleted") {
      entry.generation++;
      entry.standDown?.();
      entry.standDown = null;
      statusWriter.track(name);
      if (status === undefined) {
        supervisor.add(specOf(name, listing.folder), wanted);
        entry.specFolder = listing.folder;
      } else if (wanted === "running") {
        // resume, not wanted running: a re-added folder also clears failed
        supervisor.resume(id);
      } else supervisor.setWanted(id, wanted);
      // an unreadable file or a held workspace has already said why
      if (wanted !== "running" && problem === null && held === null) {
        logNotStarted(name, listing);
      }
      return;
    }
    if (!changed) return;
    // a changed active record is how an operator takes a workspace out of failed
    if (wanted === "running") supervisor.resume(id);
    else supervisor.setWanted(id, wanted);
  };

  const dropDeleted = (name: string, deleted: HostedWorkspace) => {
    if (dropLog.changed(name, deleted.changedAt ?? "")) {
      logger.warn(
        "Workspace {name}'s wanted file says deleted, but its folder is another workspace's or its name is held by a registered repo, so the host removes that wanted file and deletes nothing. Delete it again once the name is the host's own",
        { name },
      );
    }
    track(
      (async () => {
        // a wanted file written since is kept
        const now = await repository.findByName(name);
        if (now.kind === "found" && sameRecord(now.workspace, deleted)) {
          await repository.remove(name);
        }
      })().catch((error) => {
        logger.warn(
          "Removing the wanted file of workspace {name}, which says deleted, failed, and is tried again at every rescan: {error}",
          { name, error },
        );
      }),
    );
  };

  // left alone, its creator and folder would make a later repo at that folder the host's own
  const settleStoppedCreate = (
    name: string,
    entry: Known,
    stopped: HostedWorkspace,
  ) => {
    entry.settling = true;
    track(
      (async () => {
        const settled = await created.whileIdle(name, async () => {
          const now = await repository.findByName(name);
          if (now.kind !== "found" || !sameRecord(now.workspace, stopped)) {
            return false;
          }
          // registered since: a workspace, listed at the next rescan
          if (await created.registeredFolder(name) !== null) return false;
          await sweepHidden(name, await created.locations());
          await repository.remove(name);
          return true;
        });
        if (settled === true) {
          logger.info(
            "Workspace {name} was left by a create that stopped before it registered; the host removed its wanted file and set-up folder",
            { name },
          );
        }
      })().catch((error) => {
        if (!dropLog.changed(name, `settle:${errorClassOf(error)}`)) return;
        logger.warn(
          "Removing what a stopped create of workspace {name} left failed, and is tried again at every rescan: {error}",
          { name, error },
        );
      }).finally(() => entry.settling = false),
    );
  };

  const dropCreatedElsewhere = (
    name: string,
    stale: HostedWorkspace,
    replaced: boolean,
  ) => {
    if (dropLog.changed(name, `created:${stale.changedAt ?? ""}`)) {
      logger.warn(
        replaced
          ? "Workspace {name}'s wanted file was written for a repo a request created, and its folder now holds another repo, so the host removes that wanted file; the workspace is the operator's own"
          : "Workspace {name}'s wanted file was written for a folder a request created, and the registry now names another folder, so the host removes that wanted file; the workspace is the operator's own",
        { name },
      );
    }
    track(
      (async () => {
        // a wanted file written since is kept
        const now = await repository.findByName(name);
        if (now.kind === "found" && sameRecord(now.workspace, stale)) {
          await repository.remove(name);
        }
      })().catch((error) => {
        logger.warn(
          "Removing the stale wanted file of workspace {name} failed, and is tried again at every rescan: {error}",
          { name, error },
        );
      }),
    );
  };

  const heldReason = (
    name: string,
    listing: HostedWorkspaceFolder,
    record: HostedWorkspace | null,
    recordMatches: boolean,
  ): string | null => {
    if (record?.wanted === "deleted" && listing.owner === "operator") {
      return `Its wanted file says deleted, but no request created ${listing.folder}, so nothing was removed. Run swamp workspace remove ${name} on the host to stop listing it`;
    }
    if (record !== null && !recordMatches) {
      const written = record.folder === null
        ? "Its wanted file names no folder"
        : `Its wanted file was written for ${record.folder}, not for ${listing.folder}`;
      return `${written}, so it is not started. Write folder: ${listing.folder} in ${
        join(workspacesDir, wantedFileName(name))
      } to start it`;
    }
    if (!listing.isRepo) {
      return `${listing.folder} is not a swamp repo: it is gone or has no ${REPO_MARKER_FILE}, so it is not started`;
    }
    if (options.holdsOAuthSecret?.(listing.folder) === true) {
      return `${listing.folder} holds the OAuth client's secret file named by oauth-client.secret-file in host.yaml, so it is not started: a repo's own git, sync or team can copy it. Move the file outside every repo the host runs`;
    }
    return null;
  };

  const logNotStarted = (name: string, listing: HostedWorkspaceFolder) => {
    const path = join(workspacesDir, wantedFileName(name));
    if (listing.owner === "operator") {
      logger.info(
        "Workspace {name} at {folder} is listed and not started; write wanted: active and folder: {folder} to {path} to start it",
        { name, folder: listing.folder, path },
      );
      return;
    }
    logger.info(
      "Workspace {name} is listed and not started; write wanted: active to {path} to start it",
      { name, path },
    );
  };

  // the folder is the operator's and is never touched; a re-listing stands this down
  const leaveRegistry = (name: string, entry: Known) => {
    const id = workspaceServe(name);
    const generation = ++entry.generation;
    const left = entry.record;
    const stale = () => entry.generation !== generation || entry.removing;
    const status = supervisor.lookup(id);
    if (status !== undefined && status.wanted !== "deleted") {
      supervisor.setWanted(id, "deleted");
    }
    logger.info(
      "Workspace {name} left the workspace registry; its serve is stopped and its folder is kept",
      { name },
    );
    const relisted = new Promise<void>((resolve) => entry.standDown = resolve);
    track(
      (async () => {
        if (status !== undefined) {
          await Promise.race([supervisor.whenStopped(id), relisted]);
        }
        if (stale()) return;
        await statusWriter.forget(name);
        if (stale()) return;
        await removeHostedWorkspaceStatus(workspacesDir, name);
        // a wanted file written since, as by a resume after a new import, is kept
        const now = await repository.findByName(name);
        if (stale()) return;
        if (now.kind === "found" && sameRecord(now.workspace, left)) {
          await repository.remove(name);
        }
        statusWriter.setProblem(name, null);
        entry.record = null;
        entry.recordMatches = true;
        entry.held = null;
      })().catch((error) => {
        logger.warn(
          "Removing the files of workspace {name}, which left the workspace registry, failed: {error}",
          { name, error },
        );
      }),
    );
  };

  const startRemoval = (name: string, entry: Known) => {
    entry.removing = true;
    track(
      remove(name, entry).catch((error) => {
        if (!removalFailures.changed(name, `before:${errorClassOf(error)}`)) {
          return;
        }
        logger.error(
          "Removing workspace {name} failed, and is tried again at every rescan: {error}",
          { name, error },
        );
      }).finally(() => entry.removing = false),
    );
  };

  // the wanted file goes last, so a host stopped partway finishes at its next start
  const remove = async (name: string, entry: Known) => {
    const id = workspaceServe(name);
    if (supervisor.lookup(id) !== undefined) {
      supervisor.setWanted(id, "deleted");
      await supervisor.whenStopped(id);
    }
    await statusWriter.forget(name);
    // only a folder a request created is the host's to remove
    try {
      await removeCreated(name, entry);
    } catch (error) {
      if (error instanceof FolderClaimedError) {
        abandonRemoval(name, entry);
        return;
      }
      if (!(error instanceof RemovalStepError)) throw error;
      // a status write wakes the folder watcher, so one per reason, not per try
      if (!removalFailures.changed(name, error.key)) return;
      logger.error(
        "Removing workspace {name} failed, and is tried again at every rescan: {error}",
        { name, error: error.cause },
      );
      await reportRemovalFailure(name, error.cause);
      return;
    }
    await removeHostedWorkspaceStatus(workspacesDir, name);
    await repository.remove(name);
    statusWriter.setProblem(name, null);
    removalFailures.clear(name);
    // a cleanup still holding this entry stands down; the name starts afresh
    entry.generation++;
    known.delete(name);
    removedAt.set(name, performance.now());
    logger.info("Removed workspace {name}", { name });
  };

  // dropped, not retried: a retry after the name is freed would remove the folder
  const abandonRemoval = (name: string, entry: Known) => {
    const deleted = entry.record;
    entry.record = null;
    entry.recordMatches = true;
    removalFailures.clear(name);
    if (deleted !== null) dropDeleted(name, deleted);
  };

  // only the folder the wanted file records, and only while the registry, read afresh, names it
  const removeCreated = async (name: string, removing: Known) => {
    const record = removing.record;
    const folder = record?.folder ?? null;
    // never a folder named only by the wanted file, which an operator can edit
    const dirs = new Set(await created.locations());
    let registered: { path: string; real: string } | null = null;
    if (folder !== null) {
      try {
        registered = await created.registeredFolder(name);
      } catch (error) {
        throw new RemovalStepError("read", error);
      }
    }
    if (record === null || folder === null || registered === null) {
      await sweepHidden(name, dirs);
      return;
    }
    const ownership = await createdOwnership(record, registered.real);
    // retried, so a marker that cannot be read for a moment never ends an accepted delete
    if (ownership === "unknown") {
      throw new RemovalStepError(
        "read",
        new Error("its folder's .swamp.yaml cannot be read"),
      );
    }
    if (ownership === "replaced") {
      throw new FolderClaimedError(
        "it holds another repo than the one the workspace was created with",
      );
    }
    if (ownership !== "host") {
      throw new FolderClaimedError(
        "it is registered at another folder, or holds no repo the workspace was created with",
      );
    }
    const parent = dirname(folder);
    dirs.add(parent);
    if (await exists(folder)) {
      // a rename never follows a link, so a linked folder loses only its link
      const hidden = removing.hiddenName ??= deletingFolderName(name);
      try {
        await rename(folder, join(parent, hidden));
        removing.hiddenName = null;
      } catch (error) {
        throw new RemovalStepError("rename", error);
      }
    }
    await sweepHidden(name, dirs);
    // before the wanted file, so a host stopped here still finishes the removal
    // the spelling read before the rename, which no longer resolves once the folder is gone
    await created.unregister(name, registered.path).catch((error) => {
      throw new RemovalStepError("unregister", error);
    });
  };

  // no live create owns a set-up folder: create refuses while a wanted file exists
  const sweepHidden = async (name: string, dirs: Iterable<string>) => {
    let failure: RemovalStepError | null = null;
    for (const dir of dirs) {
      let entries: Deno.DirEntry[];
      try {
        entries = await Array.fromAsync(Deno.readDir(dir));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        failure ??= new RemovalStepError("list", error);
        continue;
      }
      for (const { name: entry } of entries) {
        if (
          deletingFolderOwner(entry) !== name &&
          creatingFolderOwner(entry) !== name
        ) continue;
        try {
          await Deno.remove(join(dir, entry), { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            failure ??= new RemovalStepError("remove", error);
          }
        }
      }
    }
    if (failure !== null) throw failure;
  };

  // the status writer has forgotten the name, so this write cannot race it
  const reportRemovalFailure = async (name: string, error: unknown) => {
    const status = supervisor.lookup(workspaceServe(name));
    try {
      await writeHostedWorkspaceStatus(workspacesDir, name, {
        state: status?.observed ?? "stopped",
        wanted: "deleted",
        restarts: status?.restarts ?? 0,
        reason:
          `Removing the workspace failed, and is tried again at every rescan: ${
            messageOf(error)
          }`,
        updatedAt: new Date().toISOString(),
      });
    } catch (writeError) {
      logger.warn("Writing the status of workspace {name} failed: {error}", {
        name,
        error: writeError,
      });
    }
  };

  const clearStatusWhenStopped = (name: string, entry: Known) => {
    const generation = entry.generation;
    const stale = () => entry.generation !== generation || entry.removing;
    track(
      (async () => {
        await supervisor.whenStopped(workspaceServe(name));
        if (stale()) return;
        await statusWriter.forget(name);
        if (stale()) return;
        await removeHostedWorkspaceStatus(workspacesDir, name);
      })().catch((error) => {
        logger.warn(
          "Removing the status file of workspace {name} failed: {error}",
          {
            name,
            error,
          },
        );
      }),
    );
  };

  // the supervisor never forgets a serve, so a deleted one is told by its wanted state
  const served = (): readonly string[] =>
    [...applied.keys()].filter((name) => {
      const entry = known.get(name);
      if (entry?.removing === true || entry?.record?.wanted === "deleted") {
        return false;
      }
      const status = supervisor.lookup(workspaceServe(name));
      return status !== undefined && status.wanted !== "deleted";
    });

  return {
    begin(scan, reads, folders) {
      apply(scan, reads, folders);
      return served();
    },

    reconcile(scan, reads, folders) {
      apply(scan, reads, folders);
    },

    served,

    async drain() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

function sameRecord(
  a: HostedWorkspace | null,
  b: HostedWorkspace | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
