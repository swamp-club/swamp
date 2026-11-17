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
import type {
  HostedWorkspace,
  HostedWorkspaceRead,
  HostedWorkspaceRepository,
} from "../../domain/serve/hosted_workspace.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import {
  removeHostedWorkspaceStatus,
  writeHostedWorkspaceStatus,
} from "../../infrastructure/persistence/hosted_workspace_status_file.ts";
import type { ServeChildSpec } from "./serve_process.ts";
import type { StatusWriter } from "./status_writer.ts";
import type { ServeSupervisor } from "./supervisor.ts";
import {
  deletingFolderName,
  deletingFolderOwner,
  type WorkspaceScan,
} from "./workspace_folder.ts";

const logger = getSwampLogger(["serve", "host", "workspaces"]);

export type WantedRead = HostedWorkspaceRead | { readonly kind: "vanished" };
export type WantedReads = ReadonlyMap<string, WantedRead>;

export interface WorkspaceReconcilerOptions {
  readonly workspacesDir: string;
  readonly supervisor: Pick<
    ServeSupervisor,
    "add" | "setWanted" | "resume" | "lookup" | "whenStopped"
  >;
  readonly specOf: (name: string) => ServeChildSpec;
  readonly repository: HostedWorkspaceRepository;
  readonly statusWriter: Pick<StatusWriter, "setProblem" | "forget" | "track">;
}

export interface WorkspaceReconciler {
  /** at startup, after the bind: nothing here awaits, so every add lands before a request */
  begin(scan: WorkspaceScan, reads: WantedReads): readonly string[];
  reconcile(scan: WorkspaceScan): Promise<void>;
  /** waits for every removal, including one waiting for its serve to stop */
  drain(): Promise<void>;
}

interface Known {
  folder: boolean;
  /** the last wanted record read whole; null for no file */
  record: HostedWorkspace | null;
  problem: string | null;
  removing: boolean;
  /** bumped when the workspace is added again or removed, so stale cleanup stands down */
  generation: number;
  ignoredLogged: boolean;
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
  const { workspacesDir, supervisor, specOf, repository, statusWriter } =
    options;
  const known = new Map<string, Known>();
  const pending = new Set<Promise<void>>();
  // hidden folders a removal of ours is working on, so the sweep leaves them
  const sweeping = new Set<string>();
  const sweeps = new Map<string, Promise<void>>();
  // a scan listed before a removal finished still shows its folder
  const removedAt = new Map<string, number>();
  const removalFailures = new ReasonMemo();
  const sweepFailures = new ReasonMemo();

  const track = (work: Promise<void>) => {
    const settled = work.finally(() => pending.delete(settled));
    pending.add(settled);
  };

  const knownOf = (name: string): Known => {
    let entry = known.get(name);
    if (entry === undefined) {
      entry = {
        folder: false,
        record: null,
        problem: null,
        removing: false,
        generation: 0,
        ignoredLogged: false,
      };
      known.set(name, entry);
    }
    return entry;
  };

  const apply = (scan: WorkspaceScan, reads: WantedReads) => {
    const folders = new Set(scan.workspaces);
    const names = new Set([
      ...scan.workspaces,
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
      step(name, folders.has(name), read);
    }
    sweepFailures.retain(new Set(scan.leftovers));
    for (const leftover of scan.leftovers) sweep(leftover);
  };

  const step = (name: string, folder: boolean, read: HostedWorkspaceRead) => {
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
    else if (read.kind === "absent") record = null;
    else problem = read.reason;
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
    const hadFolder = entry.folder;
    entry.record = record;
    entry.folder = folder;

    if (record?.wanted === "deleted") {
      startRemoval(name, entry);
      return;
    }
    const id = workspaceServe(name);
    const status = supervisor.lookup(id);
    if (!folder) {
      // a wanted file without a folder may be a workspace still being set up
      if (status !== undefined && status.wanted !== "deleted") {
        supervisor.setWanted(id, "deleted");
        clearStatusWhenStopped(name, entry);
      }
      return;
    }
    const wanted = record?.toServeWanted() ?? "running";
    if (status === undefined || !hadFolder || status.wanted === "deleted") {
      entry.generation++;
      statusWriter.track(name);
      if (status === undefined) supervisor.add(specOf(name), wanted);
      // resume, not wanted running: a re-added folder also clears failed
      else if (wanted === "running") supervisor.resume(id);
      else supervisor.setWanted(id, wanted);
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
        if (removalFailures.changed(name, messageOf(error))) {
          logger.error(
            "Removing workspace {name} failed, and is tried again at every rescan: {error}",
            { name, error },
          );
        }
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
      await removeData(name);
    } catch (error) {
      await reportRemovalFailure(name, error);
      throw error;
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
  const removeData = async (name: string) => {
    const folder = join(workspacesDir, name);
    if (await exists(folder)) {
      // a rename never follows a link, so a linked folder loses only its link
      const hidden = deletingFolderName(name);
      sweeping.add(hidden);
      try {
        await Deno.rename(folder, join(workspacesDir, hidden));
      } finally {
        sweeping.delete(hidden);
      }
    }
    for await (const { name: entry } of Deno.readDir(workspacesDir)) {
      if (deletingFolderOwner(entry) !== name) continue;
      // a sweep that began before this removal may still be on it
      await sweeps.get(entry);
      sweeping.add(entry);
      try {
        await Deno.remove(join(workspacesDir, entry), { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      } finally {
        sweeping.delete(entry);
      }
    }
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

  return {
    begin(scan, reads) {
      apply(scan, reads);
      return scan.workspaces.filter((name) =>
        known.get(name)?.removing !== true &&
        supervisor.lookup(workspaceServe(name)) !== undefined
      );
    },

    async reconcile(scan) {
      apply(scan, await readWantedFiles(repository, scan));
    },

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

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
