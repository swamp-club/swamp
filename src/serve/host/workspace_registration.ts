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
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { REPO_MARKER_FILE } from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import {
  PREFERENCES_FILE_NAME,
  WorkspacePreferencesFileRepository,
} from "../../infrastructure/persistence/workspace_preferences_file_repository.ts";
import {
  WorkspaceRegistryFileRepository,
  type WorkspaceRegistryLockWait,
} from "../../infrastructure/persistence/workspace_registry_file_repository.ts";
import {
  type HostedRegistration,
  type HostedRegistryDeps,
  registerHostedWorkspaces,
  unregisterHostedWorkspace,
} from "../../libswamp/workspace/hosted_registration.ts";
import { ReasonMemo } from "./workspace_reconciler.ts";

const logger = getSwampLogger(["serve", "host", "workspaces"]);

// passes a workspace command's one read-modify-write, and ends before the next rescan
export const HOST_REGISTRY_LOCK_WAIT: WorkspaceRegistryLockWait = {
  maxWaitMs: 2_000,
  retryIntervalMs: 100,
  contentionLogLevel: "debug",
};

export function hostWorkspaceStore(dirs: {
  readonly dataDir: string;
  readonly configDir: string;
}): HostedRegistryDeps {
  return {
    dataDir: dirs.dataDir,
    registry: new WorkspaceRegistryFileRepository(
      dirs.configDir,
      HOST_REGISTRY_LOCK_WAIT,
    ),
    now: () => new Date(),
    repo: {
      isRepo: async (path) => {
        try {
          return (await Deno.stat(join(path, REPO_MARKER_FILE))).isFile;
        } catch {
          return false;
        }
      },
    },
  };
}

/** workspaces.dir as the host's config dir holds it; undefined for the data dir's own folder */
export function hostConfiguredParent(
  configDir: string,
): () => Promise<string | undefined> {
  const preferences = new WorkspacePreferencesFileRepository(
    join(configDir, PREFERENCES_FILE_NAME),
  );
  return async () => (await preferences.read()).dir;
}

/** one line per reason for a registry the host cannot read, whichever part of the host met it */
export class RegistryProblemLog {
  readonly #reported = new ReasonMemo();
  /** the file the host read is gone; a write would create one without the entries it held */
  fileGone = false;

  unreadable(reason: string): void {
    if (!this.#reported.changed("unreadable", reason)) return;
    logger.warn(
      "The workspace registry cannot be read, so the host leaves it unchanged until it can: {reason}",
      { reason },
    );
  }

  readable(): void {
    this.#reported.clear("unreadable");
  }
}

export interface WorkspaceRegistrar {
  /** registers what `served` names when the run starts; the caller does not wait */
  sync(served: () => readonly string[]): void;
  /** rejects when the write fails, so a removal keeps its wanted file and retries */
  unregister(name: string): Promise<void>;
  /** the entry goes with the next sync, which is tried again until it does */
  forget(name: string): void;
  /** no sync starts after this, queued or not; a removal may still unregister */
  close(): void;
  drain(): Promise<void>;
}

export function createWorkspaceRegistrar(options: {
  readonly workspacesDir: string;
  readonly store: HostedRegistryDeps;
  readonly problems?: RegistryProblemLog;
}): WorkspaceRegistrar {
  const { workspacesDir, store } = options;
  const problems = options.problems ?? new RegistryProblemLog();
  // every write runs in turn, so a sync never registers a name a removal unregistered
  let tail: Promise<void> = Promise.resolve();
  let served: () => readonly string[] = () => [];
  let syncQueued = false;
  let closed = false;
  const forgetting = new Set<string>();
  const reported = new ReasonMemo();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work);
    tail = run.then(() => {}, () => {});
    return run;
  };

  // one key for every write, so a held lock is one line however many names wait on it
  const failed = (error: unknown) => {
    if (!reported.changed("write", errorClassOf(error))) return;
    logger.warn(
      "Writing the workspace registry failed, and is tried again at every rescan: {reason}",
      { reason: reasonOf(error) },
    );
  };

  const report = (workspace: HostedRegistration) => {
    const key = `clash:${workspace.name}`;
    switch (workspace.kind) {
      case "registered":
        logger.info("Registered workspace {name} at {folder}", {
          name: workspace.name,
          folder: workspace.folder,
        });
        reported.clear(key);
        return;
      case "present":
        reported.clear(key);
        return;
      case "name_elsewhere":
        if (!reported.changed(key, `name:${workspace.registeredFolder}`)) {
          return;
        }
        logger.error(
          "Workspace folder {folder} is not served: the name {name} is registered to {registered}, so neither is started. Free the name with swamp workspace remove {name} to serve this folder again, or rename one of them",
          {
            folder: workspace.folder,
            name: workspace.name,
            registered: workspace.registeredFolder,
          },
        );
        return;
      case "folder_elsewhere":
        if (!reported.changed(key, `folder:${workspace.registeredName}`)) {
          return;
        }
        logger.error(
          "Workspace folder {folder} is listed as {registered}, not as {name}: it is registered under that name. Run swamp workspace remove {registered} and the host registers it as {name}",
          {
            folder: workspace.folder,
            name: workspace.name,
            registered: workspace.registeredName,
          },
        );
        return;
    }
  };

  /** false when the registry cannot be read, so the run writes nothing more */
  const forgetPending = async (listed: ReadonlySet<string>) => {
    for (const name of [...forgetting]) {
      if (listed.has(name)) {
        forgetting.delete(name);
        continue;
      }
      const outcome = await unregisterHostedWorkspace(store, {
        workspacesDir,
        name,
      });
      if (outcome.kind === "unreadable") {
        problems.unreadable(outcome.reason);
        return false;
      }
      forgetting.delete(name);
    }
    return true;
  };

  // a write that fails ends the run, so one run waits for the lock at most once
  const runSync = async () => {
    const listed = served();
    try {
      if (!await forgetPending(new Set(listed))) return;
      if (problems.fileGone) return;
      if (listed.length > 0) {
        const result = await registerHostedWorkspaces(store, {
          workspacesDir,
          names: listed,
        });
        if (result.kind === "unreadable") {
          problems.unreadable(result.reason);
          return;
        }
        for (const workspace of result.workspaces) report(workspace);
      }
      problems.readable();
      reported.clear("write");
    } catch (error) {
      failed(error);
    }
  };

  // the run joins the queue drain waits for; it reports its own failures
  const requestSync = () => {
    if (syncQueued || closed) return;
    syncQueued = true;
    tail = tail.then(async () => {
      syncQueued = false;
      if (!closed) await runSync();
    }).catch(failed);
  };

  return {
    sync(next) {
      served = next;
      requestSync();
    },

    unregister(name) {
      return enqueue(async () => {
        forgetting.delete(name);
        const outcome = await unregisterHostedWorkspace(store, {
          workspacesDir,
          name,
        });
        // a corrupt registry never holds up a delete
        if (outcome.kind === "unreadable") problems.unreadable(outcome.reason);
        else problems.readable();
      });
    },

    forget(name) {
      forgetting.add(name);
      requestSync();
    },

    close() {
      closed = true;
    },

    async drain() {
      for (let last = tail;; last = tail) {
        await last;
        if (last === tail) return;
      }
    },
  };
}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// a timeout names the holder and how long it waited, which change every try
function reasonOf(error: unknown): string {
  if (error instanceof LockTimeoutError) {
    return `another process held its lock for longer than ${
      HOST_REGISTRY_LOCK_WAIT.maxWaitMs / 1000
    } s`;
  }
  return error instanceof Error ? error.message : String(error);
}
