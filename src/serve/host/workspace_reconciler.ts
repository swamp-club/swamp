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
import {
  deletingFolderName,
  deletingFolderOwner,
  type WorkspaceScan,
} from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";

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
}

export interface WorkspaceReconciler {
  /** at startup, after the bind: nothing here awaits, so every add lands before a request */
  begin(
    scan: WorkspaceScan,
    reads: WantedReads,
    folders: WorkspaceFolders,
  ): readonly string[];
  reconcile(scan: WorkspaceScan, folders: WorkspaceFolders): Promise<void>;
  /** the workspaces last reconciled that the host serves: none being removed or wanted deleted */
  served(): readonly string[];
  /** waits for every removal, including one waiting for its serve to stop */
  drain(): Promise<void>;
}

interface Known {
  folder: string | null;
  /** the folder the supervisor's spec names, so a changed folder reaches the next start */
  specFolder: string | null;
  /** the last wanted record read whole; null for no file */
  record: HostedWorkspace | null;
  problem: string | null;
  removing: boolean;
  /** bumped when the workspace is added again or removed, so stale cleanup stands down */
  generation: number;
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
  let applied: WorkspaceFolders = new Map();
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
        specFolder: null,
        record: null,
        problem: null,
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
    applied = folders;
    const names = new Set([
      ...folders.keys(),
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
      step(name, folders.get(name) ?? null, read);
    }
    sweepFailures.retain(new Set(scan.leftovers));
    for (const leftover of scan.leftovers) sweep(leftover);
  };

  const step = (
    name: string,
    folder: string | null,
    read: HostedWorkspaceRead,
  ) => {
    const entry = knownOf(name);
    // deleted is never left: an edit after removal began is not obeyed, and a
    // removal that failed is tried again whatever the file now says
    if (entry.removing || entry.record?.wanted === "deleted") {
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

    let record = entry.record;
    let problem: string | null = null;
    if (read.kind === "found") record = read.workspace;
    // a folder keeps its last record across an absent file, as while an editor saves
    else if (read.kind === "absent") {
      if (folder === null) record = null;
    } else problem = read.reason;
    if (problem !== entry.problem) {
      if (problem !== null) {
        logger.warn("{reason}; workspace {name} is left as it is", {
          reason: problem,
          name,
        });
      }
      entry.problem = problem;
      statusWriter.setProblem(name, problem);
    }
    const changed = !sameRecord(record, entry.record);
    const hadFolder = entry.folder !== null;
    entry.record = record;
    entry.folder = folder;

    if (record?.wanted === "deleted") {
      startRemoval(name, entry);
      return;
    }
    const id = workspaceServe(name);
    const status = supervisor.lookup(id);
    if (folder === null) {
      // a wanted file without a folder may be a workspace still being set up
      if (status !== undefined && status.wanted !== "deleted") {
        supervisor.setWanted(id, "deleted");
        clearStatusWhenStopped(name, entry);
      }
      return;
    }
    if (status !== undefined && entry.specFolder !== folder) {
      // a live serve keeps its folder; its next start runs in this one
      supervisor.setSpec(specOf(name, folder));
      entry.specFolder = folder;
    }
    const wanted = serveWantedOfRecord(record);
    if (status === undefined || !hadFolder || status.wanted === "deleted") {
      entry.generation++;
      statusWriter.track(name);
      if (status === undefined) {
        supervisor.add(specOf(name, folder), wanted);
        entry.specFolder = folder;
      } else if (wanted === "running") {
        // resume, not wanted running: a re-added folder also clears failed
        supervisor.resume(id);
      } else supervisor.setWanted(id, wanted);
      // an unreadable file has already said why, naming the file
      if (wanted !== "running" && problem === null) {
        logger.info(
          "Workspace {name} is listed and not started; write wanted: active to {path} to start it",
          { name, path: join(workspacesDir, wantedFileName(name)) },
        );
      }
      return;
    }
    if (!changed) return;
    // a changed active record is how an operator takes a workspace out of failed
    if (wanted === "running") supervisor.resume(id);
    else supervisor.setWanted(id, wanted);
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

  // the files stay until no folder of the name is left, renamed by an earlier try or not
  const removeData = async (name: string, removing: Known) => {
    const folder = join(workspacesDir, name);
    if (await exists(folder)) {
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

  // the registrar reads what was last reconciled when its run starts
  const register = () => {
    registrar.sync(served);
  };

  return {
    begin(scan, reads, folders) {
      apply(scan, reads, folders);
      register();
      return served();
    },

    async reconcile(scan, folders) {
      apply(scan, await readWantedFiles(repository, scan), folders);
      register();
    },

    served,

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
