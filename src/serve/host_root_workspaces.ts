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

import { SignInCodeStore } from "../domain/access/sign_in_code.ts";
import { UserError } from "../domain/errors.ts";
import {
  createHostedWorkspaceDeps,
  type HostedWorkspaceDeps,
  type HostedWorkspacePlacement,
  type HostedWorkspaceRootAccess,
} from "../libswamp/hosted_workspace/deps.ts";
import {
  HOST_ADDRESS_FLAG,
  HOST_NO_FOLDER_FLAG,
  HOST_WORKSPACES_DIR_FLAG,
} from "./host/serve_process.ts";
import { hostedWorkspaceAddress } from "./host/workspace_path.ts";
import { hostConfiguredParent } from "./host/workspace_registration.ts";
import { withWorkspaceCreateLock } from "../libswamp/workspace/deps.ts";
import type { HostedRegistryDeps } from "../libswamp/workspace/hosted_registration.ts";
import { childHostedWorkspaceProvisioner } from "./workspace_provision_process.ts";

/** what a host's root answers workspace requests with */
export interface HostRootWorkspaces {
  readonly services: HostedWorkspaceDeps;
  /** read per request: a reload changes the lists and the name cache */
  readonly rootAccess: () => HostedWorkspaceRootAccess;
  /** in this process alone: only it holds the folder, and the root's address routes here */
  readonly signInCodes: SignInCodeStore;
}

// a hand-started root may carry these; they would point the provisioner at another repo
const PROVISION_DROPPED_NAMES: ReadonlySet<string> = new Set([
  "SWAMP_REPO_DIR",
  "SWAMP_DATASTORE",
]);

/**
 * undefined for a serve the host did not start as its root; `env` is the root's
 * own, and `workspaceStore` is called only for a root
 */
export function hostRootWorkspaces(
  flags: {
    readonly dir?: string;
    readonly address?: string;
    /** the host has no host folder, so the state folder holds no repo */
    readonly noFolder?: boolean;
    /** the root's own repo, never listed as one of its workspaces */
    readonly repoDir?: string;
  },
  env: Readonly<Record<string, string>>,
  rootAccess: () => HostedWorkspaceRootAccess,
  workspaceStore: () => HostedRegistryDeps,
  /** called only for a root whose host has no host folder */
  placement: () => HostedWorkspacePlacement,
): HostRootWorkspaces | undefined {
  const { dir, address } = flags;
  if (dir === undefined && address === undefined) {
    if (flags.noFolder === true) {
      throw new UserError(
        `${HOST_NO_FOLDER_FLAG} is given with ${HOST_WORKSPACES_DIR_FLAG} and ${HOST_ADDRESS_FLAG}, by the host to its root.`,
      );
    }
    return undefined;
  }
  if (!dir || !address) {
    throw new UserError(
      `${HOST_WORKSPACES_DIR_FLAG} and ${HOST_ADDRESS_FLAG} are given together, by the host to its root.`,
    );
  }
  return {
    services: createHostedWorkspaceDeps({
      workspacesDir: dir,
      hostFolder: flags.noFolder !== true,
      placement: flags.noFolder === true ? placement() : null,
      provisioner: childHostedWorkspaceProvisioner(provisionEnv(env)),
      addressOf: (name) => hostedWorkspaceAddress(address, name),
      workspaceStore: workspaceStore(),
      rootRepo: flags.repoDir ?? null,
    }),
    rootAccess,
    signInCodes: new SignInCodeStore(),
  };
}

/** where a root with no host folder creates, as swamp workspace create would */
export function hostWorkspacePlacement(dirs: {
  readonly dataDir: string;
  readonly configDir: string;
}): HostedWorkspacePlacement {
  return {
    configuredParent: hostConfiguredParent(dirs.configDir),
    withCreateLock: (name, fn) =>
      withWorkspaceCreateLock(dirs.dataDir, name, fn),
  };
}

export function provisionEnv(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  // Windows spells names in any case
  return Object.fromEntries(
    Object.entries(env).filter(([name]) =>
      !PROVISION_DROPPED_NAMES.has(name.toUpperCase())
    ),
  );
}
