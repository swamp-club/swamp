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
  type HostedWorkspaceRead,
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
import {
  type HostedWorkspaceFolder,
  hostedWorkspaceFolders,
  type HostedWorkspaceOwner,
  hostFolderClaimedBy,
  readHostedRegistry,
  registryOfRead,
} from "../workspace/hosted_roster.ts";
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

/** where a host with no host folder creates: the location swamp workspace create uses */
export interface HostedWorkspacePlacement {
  /** workspaces.dir as set; undefined for the data dir's own folder */
  readonly configuredParent: () => Promise<string | undefined>;
  /** the lock swamp workspace create holds for the name */
  readonly withCreateLock: <T>(
    name: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

export interface HostedWorkspaceDeps {
  /** the host's state folder: wanted, status and lock files, and with a host folder its own repos */
  readonly workspacesDir: string;
  /** false for a host with no host folder, which lists registered repos and creates in `placement` */
  readonly hostFolder: boolean;
  /** null for a host with a host folder, which creates in its own */
  readonly placement: HostedWorkspacePlacement | null;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly repository: HostedWorkspaceRepository;
  readonly provisioner: HostedWorkspaceProvisioner;
  readonly addressOf: (name: string) => string;
  readonly now: () => Date;
  /** runs `fn` while no other service changes the named workspace */
  readonly withLock: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  readonly provisionTimeoutMs: number;
  readonly workspaceStore: HostedRegistryDeps;
  /** the root's own repo, which is never one of the workspaces */
  readonly rootRepo: string | null;
}

export const DEFAULT_PROVISION_TIMEOUT_MS = 120_000;
const LOCK_WAIT_MARGIN_MS = 30_000;

export function createHostedWorkspaceDeps(options: {
  workspacesDir: string;
  hostFolder?: boolean;
  placement?: HostedWorkspacePlacement | null;
  rename?: (from: string, to: string) => Promise<void>;
  provisioner: HostedWorkspaceProvisioner;
  addressOf: (name: string) => string;
  workspaceStore: HostedRegistryDeps;
  rootRepo?: string | null;
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
    hostFolder: options.hostFolder ?? true,
    placement: options.placement ?? null,
    rename: options.rename ?? Deno.rename,
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
    rootRepo: options.rootRepo ?? null,
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

/** a request refused because the workspace is a repo the host's user registered */
export const OPERATOR_WORKSPACE_CODE = "operator_workspace";

export function operatorWorkspaceUndeletable(name: string): UserError {
  return new UserError(
    `Workspace ${name} is a repo the host's user registered, so no request deletes it. To stop serving it, run swamp workspace remove ${name} on the host; its folder is kept.`,
    OPERATOR_WORKSPACE_CODE,
  );
}

// the other name is not given: the caller may hold no grant on it
export function operatorWorkspaceFolderClaimed(name: string): UserError {
  return new UserError(
    `The folder of workspace ${name} is a repo the host's user registered under another name, so no request deletes it. swamp workspace list on the host shows which; its folder is kept.`,
    OPERATOR_WORKSPACE_CODE,
  );
}

export function registryUnreadableUndeletable(name: string): UserError {
  return new UserError(
    `No workspace can be deleted while the host cannot read its workspace registry, since a registered repo may hold the name or folder of ${name}. Fix the registry on the host, then retry.`,
    OPERATOR_WORKSPACE_CODE,
  );
}

export function ownerUnknownAdminOnly(name: string): UserError {
  return new UserError(
    `The host cannot read its workspace registry, so only the root's admins may suspend or resume workspace ${name} until it can.`,
    OPERATOR_WORKSPACE_CODE,
  );
}

/** not an authorization refusal: it holds for the root's admins too */
export const WORKSPACE_NAME_CLASH_CODE = "workspace_name_clash";

export function nameClashUnstartable(name: string): UserError {
  return new UserError(
    `The name ${name} is held by a repo the host's user registered while a folder of the same name is in the host's workspaces folder, so neither is started. Run swamp workspace remove ${name} on the host to serve the host's folder again, or rename one of them.`,
    WORKSPACE_NAME_CLASH_CODE,
  );
}

/** a registered repo, or one whose owner cannot be told, for a caller who is not a root admin */
export function adminOnlyRefusal(
  name: string,
  whose: WorkspaceWhose,
  rootAdmin: boolean | undefined,
): UserError | null {
  if (rootAdmin === true) return null;
  if (whose.owner === "operator") return operatorWorkspaceAdminOnly(name);
  if (whose.owner === "unknown") return ownerUnknownAdminOnly(name);
  return null;
}

export function operatorWorkspaceAdminOnly(name: string): UserError {
  return new UserError(
    `Workspace ${name} is a repo the host's user registered, so only the root's admins may suspend or resume it.`,
    OPERATOR_WORKSPACE_CODE,
  );
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
  /** host for one in the host's workspaces folder or one a request created, operator for any other registered repo */
  readonly owner?: HostedWorkspaceOwner;
}

export async function summarizeHostedWorkspace(
  deps: HostedWorkspaceDeps,
  name: string,
  owner?: HostedWorkspaceOwner,
  /** for a name not listed, whether another workspace has its `workspaces/<name>` folder */
  claimed?: boolean,
): Promise<HostedWorkspaceSummary> {
  const [wanted, status] = await Promise.all([
    deps.repository.findByName(name),
    readHostedWorkspaceStatus(deps.workspacesDir, name),
  ]);
  const found = status.kind === "found" ? status.status : null;
  // the other name is not given: the caller may hold no grant on it
  const reason = claimed
    ? "Its folder is registered under another name, so it is listed under that name, not this one."
    : wanted.kind === "unreadable"
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
      // the host starts no registered repo without a wanted file
      ? owner === "operator" ? "suspended" : "active"
      : null,
    state: found?.state ?? null,
    restarts: found?.restarts ?? null,
    reason,
    ...(owner === undefined ? {} : { owner }),
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

/** the summary of a name as list and get show it */
export async function summarizeListedName(
  deps: HostedWorkspaceDeps,
  names: { workspaces: ReadonlyMap<string, HostedWorkspaceFolder> },
  name: string,
): Promise<HostedWorkspaceSummary> {
  const listing = names.workspaces.get(name);
  const claimedBy = listing === undefined
    ? await hostFolderClaimedBy({
      workspacesDir: deps.workspacesDir,
      name,
      workspaces: names.workspaces.values(),
    })
    : null;
  return await summarizeHostedWorkspace(
    deps,
    name,
    listing?.owner,
    claimedBy !== null,
  );
}

/** a workspace the host would run, or a wanted file with or without one */
export async function hostedWorkspaceNames(
  deps: Pick<
    HostedWorkspaceDeps,
    | "workspacesDir"
    | "hostFolder"
    | "workspaceStore"
    | "repository"
    | "rootRepo"
  >,
): Promise<{
  workspaces: ReadonlyMap<string, HostedWorkspaceFolder>;
  all: string[];
  /** false while the registry cannot be read, when whose a name is may be unknown */
  registryRead: boolean;
}> {
  const scan = await scanWorkspaces(deps.workspacesDir, {
    repos: deps.hostFolder,
  });
  // the host logs a registry it cannot read; a request is answered as a host started then serves
  const registry = registryOfRead(
    await readHostedRegistry(deps.workspaceStore),
  );
  const wanted = new Map<string, HostedWorkspace>();
  // with no host folder a wanted file decides whose an entry is
  if (registry === null || !deps.hostFolder) {
    for (const name of scan.wantedFiles) {
      const read = await deps.repository.findByName(name);
      if (read.kind === "found") wanted.set(name, read.workspace);
    }
  }
  const roster = await hostedWorkspaceFolders({
    workspacesDir: deps.workspacesDir,
    hostFolder: deps.hostFolder,
    scanned: scan.workspaces,
    registry,
    rootRepo: deps.rootRepo,
    wanted,
  });
  const workspaces = new Map(roster.workspaces.map((w) => [w.name, w]));
  return {
    workspaces,
    all: [...new Set([...workspaces.keys(), ...scan.wantedFiles])].sort(),
    registryRead: registry !== null,
  };
}

/** unknown: not listed while the registry cannot be read, so it may be a registered repo */
export interface WorkspaceWhose {
  readonly owner: HostedWorkspaceOwner | "unknown";
  readonly shadows: boolean;
  /** false while the registry cannot be read, when no clash can be seen */
  readonly registryRead: boolean;
}

// only a change to a registered repo writes a folder, and an unreadable registry may hide one
function whoseOf(
  listing: HostedWorkspaceFolder | undefined,
  names: { registryRead: boolean },
  read: HostedWorkspaceRead,
  hostFolder: boolean,
): WorkspaceWhose {
  if (listing !== undefined) {
    return {
      owner: listing.owner,
      shadows: listing.shadows,
      registryRead: names.registryRead,
    };
  }
  // a name with neither is not found, which the caller says
  if (!names.registryRead && read.kind !== "absent") {
    return {
      owner: "unknown",
      shadows: false,
      registryRead: names.registryRead,
    };
  }
  // with no host folder a name no entry holds is the host's own only as a create left it
  if (
    read.kind === "found" &&
    (hostFolder
      ? read.workspace.folder !== null
      : read.workspace.creator === null || read.workspace.folder === null)
  ) {
    return {
      owner: "operator",
      shadows: false,
      registryRead: names.registryRead,
    };
  }
  return { owner: "host", shadows: false, registryRead: names.registryRead };
}

export interface HostedWorkspaceChange {
  readonly apply: (workspace: HostedWorkspace, at: Date) => HostedWorkspace;
  /** a refusal decided under the lock from whose the workspace is; null allows */
  readonly refuse: (name: string, whose: WorkspaceWhose) => UserError | null;
  /** for a name not listed whose `workspaces/<name>` folder another workspace has */
  readonly refuseClaimed?: (name: string) => UserError;
}

/**
 * every change writes a new changedAt and names the folder it was written for,
 * none for one in workspaces/; an unreadable wanted file is left for the operator
 */
export async function changeHostedWorkspace(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
  rawName: string,
  change: HostedWorkspaceChange,
): Promise<HostedWorkspace> {
  const name = parseWorkspaceName(rawName);
  return await deps.withLock(name, async () => {
    const names = await hostedWorkspaceNames(deps);
    const listing = names.workspaces.get(name);
    const read = await deps.repository.findByName(name);
    const refusal = change.refuse(
      name,
      whoseOf(listing, names, read, deps.hostFolder),
    );
    if (refusal !== null) throw refusal;
    if (listing === undefined && change.refuseClaimed !== undefined) {
      const claimedBy = await hostFolderClaimedBy({
        workspacesDir: deps.workspacesDir,
        name,
        workspaces: names.workspaces.values(),
      });
      if (claimedBy !== null) throw change.refuseClaimed(name);
    }
    let current: HostedWorkspace;
    if (read.kind === "found") {
      current = read.workspace;
    } else if (read.kind === "unreadable") {
      ctx.logger.warn`${read.reason}; workspace ${name} is left as it is`;
      throw new UserError(
        `The wanted file of workspace ${name} cannot be read, so it is left as it is. Fix or remove it on the host, then retry.`,
        "wanted_unreadable",
      );
    } else if (listing !== undefined) {
      current = HostedWorkspace.active(name);
    } else {
      throw hostedWorkspaceNotFound(name);
    }
    // deleted is final only for the host's own: nothing was removed for a registered repo
    if (listing?.owner === "operator" && current.wanted === "deleted") {
      current = HostedWorkspace.fromRecord({
        ...current.toRecord(),
        wanted: "suspended",
      });
    }
    let next = change.apply(current, deps.now());
    if (listing !== undefined) {
      next = next.withFolder(
        listing.owner === "operator" || !deps.hostFolder
          ? listing.folder
          : null,
      );
    }
    if (read.kind === "absent" || !next.equals(current)) {
      await deps.repository.save(next);
    }
    return next;
  });
}
