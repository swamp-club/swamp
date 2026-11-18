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

import { UserError } from "../domain/errors.ts";
import {
  createHostedWorkspaceDeps,
  type HostedWorkspaceDeps,
  type HostedWorkspaceRootAccess,
} from "../libswamp/hosted_workspace/deps.ts";
import {
  HOST_ADDRESS_FLAG,
  HOST_WORKSPACES_DIR_FLAG,
} from "./host/serve_process.ts";
import { hostedWorkspaceAddress } from "./host/workspace_path.ts";
import { childHostedWorkspaceProvisioner } from "./workspace_provision_process.ts";

/** what a host's root answers workspace requests with */
export interface HostRootWorkspaces {
  readonly services: HostedWorkspaceDeps;
  /** read per request: a reload changes the lists and the name cache */
  readonly rootAccess: () => HostedWorkspaceRootAccess;
}

/**
 * undefined for a serve the host did not start as its root; `env` is the
 * root's own, which the host already built with hostChildEnv
 */
export function hostRootWorkspaces(
  flags: { readonly dir?: string; readonly address?: string },
  env: Readonly<Record<string, string>>,
  rootAccess: () => HostedWorkspaceRootAccess,
): HostRootWorkspaces | undefined {
  const { dir, address } = flags;
  if (dir === undefined && address === undefined) return undefined;
  if (!dir || !address) {
    throw new UserError(
      `${HOST_WORKSPACES_DIR_FLAG} and ${HOST_ADDRESS_FLAG} are given together, by the host to its root.`,
    );
  }
  return {
    services: createHostedWorkspaceDeps({
      workspacesDir: dir,
      provisioner: childHostedWorkspaceProvisioner(env),
      addressOf: (name) => hostedWorkspaceAddress(address, name),
    }),
    rootAccess,
  };
}
