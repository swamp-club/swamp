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

import { ensureDir } from "@std/fs";
import { UserError } from "../../domain/errors.ts";
import type { AuthMode } from "../../domain/access/serve_auth_config.ts";
import {
  HostedWorkspace,
  type HostedWorkspaceRepository,
  type HostedWorkspaceWanted,
} from "../../domain/serve/hosted_workspace.ts";
import type { ObservedServeState } from "../../domain/serve/managed_serve.ts";
import { parseWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import { FileLock } from "../../infrastructure/persistence/file_lock.ts";
import { HostedWorkspaceFileRepository } from "../../infrastructure/persistence/hosted_workspace_file_repository.ts";
import { scanWorkspaces } from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import {
  type HostedWorkspaceStatus,
  readHostedWorkspaceStatus,
} from "../../infrastructure/persistence/hosted_workspace_status_file.ts";
import type { LibSwampContext } from "../context.ts";
import type { HostedRegistryDeps } from "../workspace/hosted_registration.ts";
import type { SwampError } from "../errors.ts";

/** who asks; the services do no authorization of their own */
export interface HostedWorkspaceCaller {
  /** user:<sub> in oauth mode, user:<name> in token mode; recorded as creator */
  readonly principal: string;
  /** the provider username, or null when the root knows the caller only by subject */
  readonly username: string | null;
}

/** the root's own access settings, which a new workspace starts from */
export interface HostedWorkspaceRootAccess {
  readonly mode: AuthMode;
  readonly oauthProvider: string | null;
  readonly allowedUsers: readonly string[];
  readonly allowedCollectives: readonly string[];
  /** the root's oauth-resolved-admins map as it holds it in memory */
  readonly nameCache: Readonly<Record<string, string>>;
}

export interface HostedWorkspaceProvisionSpec {
  readonly access: HostedWorkspaceRootAccess;
  /** the new workspace's one admins entry; null in none mode */
  readonly admin: string | null;
  /** in oauth mode, the subject the admins entry names */
  readonly adminSubject: string | null;
}

export interface HostedWorkspaceProvisioner {
  /** sets a repo up in `dir`, which exists and is empty; rejects when it cannot */
  provision(
    dir: string,
    spec: HostedWorkspaceProvisionSpec,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface HostedWorkspaceDeps {
  readonly workspacesDir: string;
  readonly repository: HostedWorkspaceRepository;
  readonly provisioner: HostedWorkspaceProvisioner;
  readonly addressOf: (name: string) => string;
  readonly now: () => Date;
  /** runs `fn` while no other service changes the named workspace */
  readonly withLock: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  readonly provisionTimeoutMs: number;
  /** the workspace registry a created workspace is registered in */
  readonly workspaceStore: HostedRegistryDeps;
}

export const DEFAULT_PROVISION_TIMEOUT_MS = 120_000;
const LOCK_WAIT_MARGIN_MS = 30_000;

export function createHostedWorkspaceDeps(options: {
  workspacesDir: string;
  provisioner: HostedWorkspaceProvisioner;
  addressOf: (name: string) => string;
  workspaceStore: HostedRegistryDeps;
  provisionTimeoutMs?: number;
  lockWaitMs?: number;
}): HostedWorkspaceDeps {
  const { workspacesDir } = options;
  const provisionTimeoutMs = options.provisionTimeoutMs ??
    DEFAULT_PROVISION_TIMEOUT_MS;
  // a change waits out a create's whole set-up rather than failing beside it
  const lockWaitMs = options.lockWaitMs ??
    provisionTimeoutMs + LOCK_WAIT_MARGIN_MS;
  return {
    workspacesDir,
    repository: new HostedWorkspaceFileRepository(workspacesDir),
    provisioner: options.provisioner,
    addressOf: options.addressOf,
    now: () => new Date(),
    withLock: async (name, fn) => {
      await ensureDir(workspacesDir);
      // hidden, so neither the host's scan nor list sees the lock or its claims
      const lock = new FileLock(workspacesDir, {
        lockKey: `.${parseWorkspaceName(name)}.lock`,
        maxWaitMs: lockWaitMs,
      });
      try {
        await lock.acquire();
      } catch (error) {
        // the timeout's own message names the lock's host path and holder
        if (error instanceof LockTimeoutError) {
          throw new UserError(
            `Workspace ${name} is busy with another change. Retry in a moment.`,
            "busy",
          );
        }
        throw error;
      }
      try {
        return await fn();
      } finally {
        await lock.release();
      }
    },
    provisionTimeoutMs,
    workspaceStore: options.workspaceStore,
  };
}

/** messages reach remote callers, so they name no host path; any other error goes to the host's log */
export function hostedWorkspaceErrorEvent(
  ctx: LibSwampContext,
  error: unknown,
): { kind: "error"; error: SwampError } {
  if (error instanceof UserError) {
    return {
      kind: "error",
      error: {
        code: error.code ?? "user_error",
        message: error.message,
        cause: error,
      },
    };
  }
  ctx.logger.error`A hosted workspace request failed: ${error}`;
  return {
    kind: "error",
    error: {
      code: "host_error",
      message:
        "The host could not complete the request. The host's log has the details.",
      cause: error instanceof Error ? error : new Error(String(error)),
    },
  };
}

export function hostedWorkspaceNotFound(name: string): UserError {
  return new UserError(`No hosted workspace named ${name}.`, "not_found");
}

export interface HostedWorkspaceSummary {
  readonly name: string;
  readonly address: string;
  /** null when the wanted file cannot be read */
  readonly wanted: HostedWorkspaceWanted | null;
  /** what the host last observed; null before the host has written a status */
  readonly state: ObservedServeState | null;
  readonly restarts: number | null;
  /** fixed text per state; the host's own reason stays in its status file */
  readonly reason: string | null;
}

export async function summarizeHostedWorkspace(
  deps: HostedWorkspaceDeps,
  name: string,
): Promise<HostedWorkspaceSummary> {
  const [wanted, status] = await Promise.all([
    deps.repository.findByName(name),
    readHostedWorkspaceStatus(deps.workspacesDir, name),
  ]);
  const found = status.kind === "found" ? status.status : null;
  const reason = wanted.kind === "unreadable"
    ? "Its wanted file cannot be read, so the host leaves it as it is."
    : status.kind === "unreadable"
    ? "Its status file cannot be read."
    : found === null
    ? null
    : reasonShown(found);
  return {
    name,
    address: deps.addressOf(name),
    wanted: wanted.kind === "found"
      ? wanted.workspace.wanted
      : wanted.kind === "absent"
      ? "active"
      : null,
    state: found?.state ?? null,
    restarts: found?.restarts ?? null,
    reason,
  };
}

// the host's reason can hold host paths and the serve's own stderr, which a
// lifecycle caller may not read, so only the state it came with is described
function reasonShown(status: HostedWorkspaceStatus): string | null {
  if (status.reason === null) return null;
  if (status.wanted === "deleted") {
    return "Removing it failed, and the host tries again at every rescan. The host's status file for it has the details.";
  }
  if (status.state === "failed") {
    return "Its serve kept exiting, so the host stopped restarting it. Resume it to try again; the host's status file for it has the details.";
  }
  if (status.state === "backoff") {
    return "Its serve exited, and the host starts it again shortly.";
  }
  return "The host reported a problem with it. The host's status file for it has the details.";
}

/** a folder the host would run, or a wanted file with or without one */
export async function hostedWorkspaceNames(
  workspacesDir: string,
): Promise<{ folders: Set<string>; all: string[] }> {
  const scan = await scanWorkspaces(workspacesDir);
  const folders = new Set(scan.workspaces);
  return {
    folders,
    all: [...new Set([...scan.workspaces, ...scan.wantedFiles])].sort(),
  };
}

/** every change writes a new changedAt; an unreadable wanted file is left for the operator */
export async function changeHostedWorkspace(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
  rawName: string,
  apply: (workspace: HostedWorkspace, at: Date) => HostedWorkspace,
): Promise<HostedWorkspace> {
  const name = parseWorkspaceName(rawName);
  return await deps.withLock(name, async () => {
    const read = await deps.repository.findByName(name);
    let current: HostedWorkspace;
    if (read.kind === "found") {
      current = read.workspace;
    } else if (read.kind === "unreadable") {
      ctx.logger.warn`${read.reason}; workspace ${name} is left as it is`;
      throw new UserError(
        `The wanted file of workspace ${name} cannot be read, so it is left as it is. Fix or remove it on the host, then retry.`,
        "wanted_unreadable",
      );
    } else if (
      (await hostedWorkspaceNames(deps.workspacesDir)).folders.has(name)
    ) {
      current = HostedWorkspace.active(name);
    } else {
      throw hostedWorkspaceNotFound(name);
    }
    const next = apply(current, deps.now());
    if (read.kind === "absent" || !next.equals(current)) {
      await deps.repository.save(next);
    }
    return next;
  });
}
