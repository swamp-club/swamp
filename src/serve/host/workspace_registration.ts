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
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { REPO_MARKER_FILE } from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
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

/** the host writes the registry and never reads it to decide what it serves */
export interface WorkspaceRegistrar {
  /** registers what `served` names when the run starts; the caller does not wait */
  sync(served: () => readonly string[]): void;
  /** rejects when the write fails, so a removal keeps its wanted file and retries */
  unregister(name: string): Promise<void>;
  /** the entry goes with the next sync, which is tried again until it does */
  forget(name: string): void;
  drain(): Promise<void>;
}

export function createWorkspaceRegistrar(options: {
  readonly workspacesDir: string;
  readonly store: HostedRegistryDeps;
}): WorkspaceRegistrar {
  const { workspacesDir, store } = options;
  // every write runs in turn, so a sync never registers a name a removal unregistered
  let tail: Promise<void> = Promise.resolve();
  let served: () => readonly string[] = () => [];
  let syncQueued = false;
  const forgetting = new Set<string>();
  const reported = new ReasonMemo();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work);
    tail = run.then(() => {}, () => {});
    return run;
  };

  const unreadable = (reason: string) => {
    if (!reported.changed("unreadable", reason)) return;
    logger.warn(
      "The workspace registry cannot be read, so the host leaves it unchanged until it can: {reason}",
      { reason },
    );
  };

  const failed = (key: string, what: string, error: unknown) => {
    if (!reported.changed(key, errorClassOf(error))) return;
    logger.warn(
      "{what} in the workspace registry failed, and is tried again at every rescan: {error}",
      { what, error },
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
          "Workspace folder {folder} cannot be registered: the name {name} is registered to {registered}. A later release stops serving this folder until that is resolved; free the name with swamp workspace remove {name}, or rename the folder",
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
          "Workspace folder {folder} cannot be registered as {name}: it is registered as {registered}. A later release stops serving this folder until that is resolved; run swamp workspace remove {registered} and the host registers it as {name}",
          {
            folder: workspace.folder,
            name: workspace.name,
            registered: workspace.registeredName,
          },
        );
        return;
    }
  };

  const forgetPending = async (listed: ReadonlySet<string>) => {
    for (const name of [...forgetting]) {
      if (listed.has(name)) {
        forgetting.delete(name);
        continue;
      }
      try {
        const outcome = await unregisterHostedWorkspace(store, {
          workspacesDir,
          name,
        });
        if (outcome.kind === "unreadable") {
          unreadable(outcome.reason);
          continue;
        }
        forgetting.delete(name);
        reported.clear(`forget:${name}`);
      } catch (error) {
        failed(`forget:${name}`, `Removing workspace ${name}`, error);
      }
    }
  };

  const runSync = async () => {
    const listed = served();
    await forgetPending(new Set(listed));
    if (listed.length === 0) return;
    try {
      const result = await registerHostedWorkspaces(store, {
        workspacesDir,
        names: listed,
      });
      if (result.kind === "unreadable") {
        unreadable(result.reason);
        return;
      }
      reported.clear("unreadable");
      reported.clear("register");
      for (const workspace of result.workspaces) report(workspace);
    } catch (error) {
      failed("register", "Registering the host's workspaces", error);
    }
  };

  // the run joins the queue drain waits for; it reports its own failures
  const requestSync = () => {
    if (syncQueued) return;
    syncQueued = true;
    tail = tail.then(async () => {
      syncQueued = false;
      await runSync();
    }).catch((error) => {
      failed("register", "Registering the host's workspaces", error);
    });
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
        if (outcome.kind === "unreadable") unreadable(outcome.reason);
      });
    },

    forget(name) {
      forgetting.add(name);
      requestSync();
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
