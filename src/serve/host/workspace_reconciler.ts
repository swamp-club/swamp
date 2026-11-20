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

import { join } from "@std/path";
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
import type { WorkspaceRegistrar } from "./workspace_registration.ts";
import type { WorkspaceFolders } from "./workspace_roster.ts";
import type { HostedWorkspaceFolder } from "../../libswamp/workspace/hosted_roster.ts";
import {
  deletingFolderName,
  deletingFolderOwner,
  REPO_MARKER_FILE,
  type WorkspaceScan,
} from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import {
  hostFolderClaimedBy,
  wantedFolderOf,
} from "../../libswamp/workspace/hosted_roster.ts";

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
  readonly registrar: WorkspaceRegistrar;
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** why the registry, read afresh, forbids removing `workspaces/<name>`; null when it does not */
  readonly freshClaim?: (name: string) => Promise<string | null>;
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
  /** the served workspaces of the host's own, which are the ones it registers */
  servedOwn(): readonly string[];
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
  /** one hidden name per removal, so a retry neither scatters folders nor changes its error */
  hiddenName: string | null;
}

type RemovalStep = "rename" | "list" | "remove" | "unregister";

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
    registrar,
  } = options;
  const rename = options.rename ?? Deno.rename;
  const known = new Map<string, Known>();
  const pending = new Set<Promise<void>>();
  // hidden folders a removal of ours is working on, so the sweep leaves them
  const sweeping = new Set<string>();
  const sweeps = new Map<string, Promise<void>>();
  // a scan listed before a removal finished still shows its folder
  const removedAt = new Map<string, number>();
  const removalFailures = new ReasonMemo();
  const dropLog = new ReasonMemo();
  let applied: ReadonlyMap<string, HostedWorkspaceFolder> = new Map();
  let passedOver: readonly string[] = [];
  let registered: ReadonlySet<string> = new Set();
  const sweepFailures = new ReasonMemo();

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
    passedOver = folders.passedOver;
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
    for (const name of folders.gone) registrar.forget(name);
    sweepFailures.retain(new Set(scan.leftovers));
    for (const leftover of scan.leftovers) sweep(leftover);
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
      (!recordMatches || listing?.shadows === true)
    ) {
      dropDeleted(name, read.workspace);
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
      if (
        entry.operator && entry.listedFrom === "registry" &&
        !registered.has(name)
      ) {
        entry.listedFrom = null;
        leaveRegistry(name, entry);
        return;
      }
      entry.listedFrom = null;
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

  const heldReason = (
    name: string,
    listing: HostedWorkspaceFolder,
    record: HostedWorkspace | null,
    recordMatches: boolean,
  ): string | null => {
    // never "write its folder": that would serve another repo at this address
    if (listing.shadows) {
      return `${
        join(workspacesDir, name)
      } and ${listing.folder} are both named ${name}, and the registry gives the name to ${listing.folder}, so neither is started. Run swamp workspace remove ${name} on the host to serve ${
        join(workspacesDir, name)
      } again, or rename one of them`;
    }
    if (record?.wanted === "deleted" && listing.owner === "operator") {
      return `Its wanted file says deleted, but ${listing.folder} is not in the host's workspaces folder, so nothing was removed. Run swamp workspace remove ${name} on the host to stop listing it`;
    }
    if (record !== null && !recordMatches) {
      return `Its wanted file was written for ${
        wantedFolderOf(workspacesDir, record)
      }, not for ${listing.folder}, so it is not started. Write folder: ${listing.folder} in ${
        join(workspacesDir, wantedFileName(name))
      } to start it`;
    }
    if (!listing.isRepo) {
      return `${listing.folder} is not a swamp repo: it is gone or has no ${REPO_MARKER_FILE}, so it is not started`;
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
    try {
      await removeData(name, entry);
      // before the wanted file, so a host stopped here still finishes the removal
      await registrar.unregister(name).catch((error) => {
        throw new RemovalStepError("unregister", error);
      });
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

  // the files stay until no folder of the name is left, renamed by an earlier try or not
  const removeData = async (name: string, removing: Known) => {
    const folder = join(workspacesDir, name);
    if (await exists(folder)) {
      // the last check before a folder goes: one another workspace has is never removed
      const claimedBy = await hostFolderClaimedBy({
        workspacesDir,
        name,
        workspaces: applied.values(),
      });
      const claim = claimedBy !== null
        ? `it is registered as ${claimedBy}`
        : await options.freshClaim?.(name) ?? null;
      if (claim !== null) throw new FolderClaimedError(claim);
      // a rename never follows a link, so a linked folder loses only its link
      const hidden = removing.hiddenName ??= deletingFolderName(name);
      sweeping.add(hidden);
      try {
        await rename(folder, join(workspacesDir, hidden));
        // kept only while the rename itself fails; a later folder gets its own
        removing.hiddenName = null;
      } catch (error) {
        throw new RemovalStepError("rename", error);
      } finally {
        sweeping.delete(hidden);
      }
    }
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(workspacesDir));
    } catch (error) {
      throw new RemovalStepError("list", error);
    }
    // every folder gets its try, so one that cannot go never shields another
    let failure: RemovalStepError | null = null;
    for (const { name: entry } of entries) {
      if (deletingFolderOwner(entry) !== name) continue;
      // a sweep that began before this removal may still be on it
      await sweeps.get(entry);
      sweeping.add(entry);
      try {
        await Deno.remove(join(workspacesDir, entry), { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          failure ??= new RemovalStepError("remove", error);
        }
      } finally {
        sweeping.delete(entry);
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
        if (!stale()) registrar.forget(name);
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

  const sweep = (leftover: string) => {
    if (sweeping.has(leftover)) return;
    // a removal still pending for its workspace owns it, and reports through the status file
    const owner = known.get(deletingFolderOwner(leftover) ?? "");
    if (owner?.removing || owner?.record?.wanted === "deleted") return;
    sweeping.add(leftover);
    const work = Deno.remove(join(workspacesDir, leftover), { recursive: true })
      .then(
        () => sweepFailures.clear(leftover),
        (error) => {
          if (error instanceof Deno.errors.NotFound) {
            sweepFailures.clear(leftover);
            return;
          }
          if (!sweepFailures.changed(leftover, messageOf(error))) return;
          logger.warn(
            "Removing {folder}, left by an interrupted removal, failed, and is tried again at every rescan: {error}",
            { folder: leftover, error },
          );
        },
      ).finally(() => {
        sweeping.delete(leftover);
        sweeps.delete(leftover);
      });
    sweeps.set(leftover, work);
    track(work);
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

  const servedOwn = (): readonly string[] =>
    served().filter((name) => applied.get(name)?.owner === "host");

  // a folder an entry passed over is offered too, so the registrar meets and logs its clash
  const toRegister = (): readonly string[] => [
    ...servedOwn(),
    ...passedOver,
  ];

  // the registrar reads what was last reconciled when its run starts
  const register = () => {
    registrar.sync(toRegister);
  };

  return {
    begin(scan, reads, folders) {
      apply(scan, reads, folders);
      register();
      return served();
    },

    reconcile(scan, reads, folders) {
      apply(scan, reads, folders);
      register();
    },

    served,
    servedOwn,

    async drain() {
      do {
        while (pending.size > 0) await Promise.all([...pending]);
        await registrar.drain();
      } while (pending.size > 0);
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
