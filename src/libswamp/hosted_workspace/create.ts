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
import { join, resolve } from "@std/path";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import { UserError } from "../../domain/errors.ts";
import {
  HostedWorkspace,
  type HostedWorkspaceWanted,
} from "../../domain/serve/hosted_workspace.ts";
import { parseWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import {
  creatingFolderName,
  creatingFolderOwner,
} from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import {
  registerHostedWorkspaces,
  unregisterCreatedWorkspace,
} from "../workspace/hosted_registration.ts";
import { readHostedRegistry } from "../workspace/hosted_roster.ts";
import {
  checkNewWorkspaceFolder,
  loadWorkspaceRegistry,
  newWorkspaceLocation,
  realPathOrSelf,
} from "../workspace/workspace_store.ts";
import {
  type HostedWorkspaceCaller,
  type HostedWorkspaceDeps,
  hostedWorkspaceErrorEvent,
  type HostedWorkspacePlacement,
  type HostedWorkspaceProvisionSpec,
  type HostedWorkspaceRootAccess,
} from "./deps.ts";

export interface HostedWorkspaceCreateInput {
  readonly name: string;
  readonly caller: HostedWorkspaceCaller;
  readonly access: HostedWorkspaceRootAccess;
}

export interface HostedWorkspaceCreateData {
  readonly name: string;
  readonly address: string;
  readonly wanted: HostedWorkspaceWanted;
}

export type HostedWorkspaceCreateEvent =
  | { kind: "completed"; data: HostedWorkspaceCreateData }
  | { kind: "error"; error: SwampError };

const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 200;
/** the refusals create writes for remote callers; any other user error stays in the host's log */
const OWN_CODES: ReadonlySet<string> = new Set([
  "already_exists",
  "provision_failed",
]);

/** the repo is renamed into place last, so no scan lists the workspace before it is whole */
export async function* hostedWorkspaceCreate(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
  input: HostedWorkspaceCreateInput,
): AsyncIterable<HostedWorkspaceCreateEvent> {
  yield* withGeneratorSpan(
    "swamp.hosted_workspace.create",
    {},
    (async function* () {
      try {
        const name = parseWorkspaceName(input.name);
        const spec = provisionSpecOf(input);
        const at = deps.now();
        // listed at once, but no serve starts until a resume
        const workspace = HostedWorkspace.create(
          name,
          input.caller.principal,
          at,
        ).suspend(at);
        const { placement } = deps;
        // never the state folder, which holds no repo
        if (!deps.hostFolder && placement === null) {
          throw new Error("This root has no workspace location to create in.");
        }
        await deps.withLock(
          name,
          () =>
            placement === null || deps.hostFolder
              ? createUnderLock(ctx, deps, workspace, spec)
              : createInLocation(ctx, deps, placement, workspace, spec, at),
        );
        yield {
          kind: "completed" as const,
          data: {
            name,
            address: deps.addressOf(name),
            wanted: workspace.wanted,
          },
        };
      } catch (error) {
        yield hostedWorkspaceErrorEvent(ctx, error);
      }
    })(),
  );
}

function provisionSpecOf(
  input: HostedWorkspaceCreateInput,
): HostedWorkspaceProvisionSpec {
  const { access, caller } = input;
  if (access.mode === "none") {
    return { access, admin: null, adminSubject: null };
  }
  if (access.mode === "token") {
    return { access, admin: caller.principal, adminSubject: null };
  }
  if (!caller.principal.startsWith("user:")) {
    throw new UserError(
      "Only a user can create an oauth workspace.",
      "not_a_user",
    );
  }
  const { username } = caller;
  // serve skips an oauth admin that is not a plain username, and a workspace with no admin never starts
  if (username === null || username === "" || username.includes(":")) {
    throw new UserError(
      "An oauth workspace's first admin is its creator's username, and yours is not known here. Log in to the host's root again, then retry.",
      "username_unknown",
    );
  }
  return {
    access,
    admin: username,
    adminSubject: caller.principal.slice("user:".length),
  };
}

async function createUnderLock(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
  workspace: HostedWorkspace,
  spec: HostedWorkspaceProvisionSpec,
): Promise<void> {
  const { name } = workspace;
  const { workspacesDir } = deps;
  const target = join(workspacesDir, name);
  if (
    await entryExists(target) ||
    (await deps.repository.findByName(name)).kind !== "absent" ||
    await registeredElsewhere(deps, name)
  ) {
    throw nameTaken(name);
  }
  await removeLeftovers(ctx, workspacesDir, name);
  const temp = join(workspacesDir, creatingFolderName(name));
  await Deno.mkdir(temp);
  let wroteWanted = false;
  try {
    await provision(ctx, deps, temp, name, spec);
    await deps.repository.save(workspace);
    wroteWanted = true;
    await renameIntoPlace(deps, temp, target, name);
  } catch (error) {
    // the lock is held, so the wanted file is still the one written above
    if (wroteWanted) {
      await deps.repository.remove(name).catch((cause) => {
        ctx.logger
          .error`Removing the wanted file of workspace ${name} after a failed create failed: ${
          messageOf(cause)
        }`;
      });
    }
    await Deno.remove(temp, { recursive: true }).catch((cause) => {
      ctx.logger
        .error`Removing the set-up folder of workspace ${name} after a failed create failed: ${
        messageOf(cause)
      }`;
    });
    throw error;
  }
  await registerInHostFolder(ctx, deps, name);
}

/**
 * with no host folder the entry makes the workspace the host's own, so it is
 * written strictly and before the rename: a create stopped at any step leaves
 * only a hidden folder, or a name a delete finishes
 */
async function createInLocation(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
  placement: HostedWorkspacePlacement,
  workspace: HostedWorkspace,
  spec: HostedWorkspaceProvisionSpec,
  at: Date,
): Promise<void> {
  try {
    await createInLocationUnchecked(
      ctx,
      deps,
      placement,
      workspace,
      spec,
      at,
    );
  } catch (error) {
    if (error instanceof LockTimeoutError) throw busy(workspace.name);
    // the location's and the registry's own messages name host paths
    if (error instanceof UserError && !OWN_CODES.has(error.code ?? "")) {
      throw new Error(
        `Workspace ${workspace.name} is not created: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function createInLocationUnchecked(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
  placement: HostedWorkspacePlacement,
  workspace: HostedWorkspace,
  spec: HostedWorkspaceProvisionSpec,
  at: Date,
): Promise<void> {
  const { name } = workspace;
  const store = deps.workspaceStore;
  const location = await newWorkspaceLocation({
    ...store,
    os: Deno.build.os,
    configuredParent: placement.configuredParent,
  }, { name });
  const { parent, path: target } = location;
  await placement.withCreateLock(name, async () => {
    // adopting first, as every registry writer does, so no first write drops the data dir's repos
    const registry = await loadWorkspaceRegistry(store);
    if ((await deps.repository.findByName(name)).kind !== "absent") {
      throw nameTaken(name);
    }
    try {
      await checkNewWorkspaceFolder(store, registry, location);
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      // its message names host paths, which stay in the host's log
      ctx.logger.info`Workspace ${name} is not created: ${error.message}`;
      throw nameTaken(name);
    }
    await ensureDir(parent);
    await removeLeftovers(ctx, parent, name);
    const temp = join(parent, creatingFolderName(name));
    await Deno.mkdir(temp);
    let wroteWanted = false;
    let registered = false;
    try {
      await provision(ctx, deps, temp, name, spec);
      await deps.repository.save(workspace.withFolder(target));
      wroteWanted = true;
      await registerInLocation(ctx, store, name, target, at);
      registered = true;
      await refuseClaimedTemp(ctx, store, temp, name);
      await renameIntoPlace(deps, temp, target, name);
    } catch (error) {
      if (registered) {
        await unregisterCreatedWorkspace(store, { name, folder: target })
          .then((result) => {
            if (result.kind === "unreadable") throw new Error(result.reason);
          })
          .catch((cause) => {
            ctx.logger
              .error`Removing the registry entry of workspace ${name} after a failed create failed: ${
              messageOf(cause)
            }`;
          });
      }
      // the lock is held, so the wanted file is still the one written above
      if (wroteWanted) {
        await deps.repository.remove(name).catch((cause) => {
          ctx.logger
            .error`Removing the wanted file of workspace ${name} after a failed create failed: ${
            messageOf(cause)
          }`;
        });
      }
      await Deno.remove(temp, { recursive: true }).catch((cause) => {
        ctx.logger
          .error`Removing the set-up folder of workspace ${name} after a failed create failed: ${
          messageOf(cause)
        }`;
      });
      throw error;
    }
  });
}

/** strict: a name or folder an import took meanwhile fails the create */
async function registerInLocation(
  ctx: LibSwampContext,
  store: HostedWorkspaceDeps["workspaceStore"],
  name: string,
  target: string,
  at: Date,
): Promise<void> {
  try {
    await store.registry.update((registry) => {
      registry.register({
        name,
        path: target,
        createdAt: at.toISOString(),
        origin: "created",
      });
    });
  } catch (error) {
    if (!(error instanceof UserError) || error.code === "registry_unreadable") {
      throw error;
    }
    ctx.logger.info`Workspace ${name} is not created: ${error.message}`;
    throw nameTaken(name);
  }
}

// a set-up folder imported under another name would otherwise be moved by the rename
async function refuseClaimedTemp(
  ctx: LibSwampContext,
  store: HostedWorkspaceDeps["workspaceStore"],
  temp: string,
  name: string,
): Promise<void> {
  const read = await readHostedRegistry(store);
  if (read.kind === "unreadable" || read.registry === null) return;
  const own = await realPathOrSelf(resolve(temp));
  for (const entry of read.registry.list()) {
    if (await realPathOrSelf(resolve(entry.path)) === own) {
      ctx.logger
        .warn`The set-up folder of workspace ${name} was registered as ${entry.name}, so it is not moved into place`;
      throw nameTaken(name);
    }
  }
}

async function provision(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
  temp: string,
  name: string,
  spec: HostedWorkspaceProvisionSpec,
): Promise<void> {
  try {
    await deps.provisioner.provision(
      temp,
      spec,
      AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(deps.provisionTimeoutMs),
      ]),
    );
  } catch (error) {
    ctx.logger.error`Setting up workspace ${name} failed: ${messageOf(error)}`;
    const failure = new UserError(
      `Setting up workspace ${name} failed. The host's log has the details.`,
      "provision_failed",
    );
    failure.cause = error;
    throw failure;
  }
}

/** the workspace is whole without its entry; the host's next rescan registers it */
async function registerInHostFolder(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
  name: string,
): Promise<void> {
  try {
    const result = await registerHostedWorkspaces(deps.workspaceStore, {
      workspacesDir: deps.workspacesDir,
      names: [name],
    });
    const outcome = result.kind === "unreadable"
      ? result.kind
      : result.workspaces[0]?.kind ?? "gone";
    if (outcome !== "registered" && outcome !== "present") {
      ctx.logger
        .warn`Workspace ${name} was created but not registered (${outcome}); the host's log says why`;
    }
  } catch (error) {
    ctx.logger
      .warn`Registering workspace ${name} failed, and the host registers it at its next rescan: ${
      messageOf(error)
    }`;
  }
}

/** a folder an earlier create left; the lock proves no create still owns it */
async function removeLeftovers(
  ctx: LibSwampContext,
  dir: string,
  name: string,
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (creatingFolderOwner(entry.name) !== name) continue;
    ctx.logger
      .info`Removing ${entry.name}, left by an earlier create of workspace ${name}`;
    // removes a link itself, never what it points at
    await Deno.remove(join(dir, entry.name), { recursive: true });
  }
}

async function renameIntoPlace(
  deps: Pick<HostedWorkspaceDeps, "rename">,
  temp: string,
  target: string,
  name: string,
): Promise<void> {
  // a rename onto an empty folder replaces it on Linux, so a taken target is refused first
  if (await entryExists(target)) throw nameTaken(name);
  for (let attempt = 1;; attempt++) {
    try {
      await deps.rename(temp, target);
      return;
    } catch (error) {
      if (await entryExists(target)) throw nameTaken(name);
      // Windows holds a folder briefly after the process that wrote it exits
      const transient = error instanceof Deno.errors.PermissionDenied ||
        error instanceof Deno.errors.Busy;
      if (!transient || attempt >= RENAME_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
    }
  }
}

// an entry for `workspaces/<name>` itself holds no other repo; an unreadable registry is the host's to report
async function registeredElsewhere(
  deps: HostedWorkspaceDeps,
  name: string,
): Promise<boolean> {
  const read = await readHostedRegistry(deps.workspaceStore);
  const entry = read.kind === "read" ? read.registry?.get(name) : undefined;
  if (entry === undefined) return false;
  const spots = new Set([
    join(resolve(deps.workspacesDir), name),
    join(await realPathOrSelf(deps.workspacesDir), name),
  ]);
  return !spots.has(resolve(entry.path));
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function busy(name: string): UserError {
  return new UserError(
    `Workspace ${name} is busy with another change. Retry in a moment.`,
    "busy",
  );
}

function nameTaken(name: string): UserError {
  return new UserError(
    `The name ${name} is taken: a workspace, a link, a wanted file or a registered repo already holds it.`,
    "already_exists",
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
