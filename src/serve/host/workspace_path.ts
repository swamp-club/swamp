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

import { parseWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import { WORKSPACE_PATH_PREFIX } from "../../domain/workspace/workspace_address.ts";

export { hostedWorkspaceAddress } from "../../domain/workspace/workspace_address.ts";

export type WorkspacePathMatch =
  | { readonly kind: "workspace"; readonly name: string; readonly path: string }
  | { readonly kind: "root"; readonly path: string }
  | { readonly kind: "unknown" };

/** the workspace a child's address names under the root's; null when it names none */
export function workspaceNameUnder(
  rootAddress: string,
  address: string,
): string | null {
  const prefix = `${rootAddress}${WORKSPACE_PATH_PREFIX}/`;
  if (!address.startsWith(prefix)) return null;
  const name = address.slice(prefix.length);
  return isWorkspaceName(name) ? name : null;
}

/**
 * where a request path goes: the `/w/` prefix belongs to the host, so a path
 * under it never reaches the root, even when it names no valid workspace
 */
export function matchWorkspacePath(pathname: string): WorkspacePathMatch {
  if (pathname !== WORKSPACE_PATH_PREFIX && !pathname.startsWith("/w/")) {
    return { kind: "root", path: pathname };
  }
  const rest = pathname.slice(WORKSPACE_PATH_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  const segment = slash === -1 ? rest : rest.slice(0, slash);
  if (!isWorkspaceName(segment)) return { kind: "unknown" };
  return {
    kind: "workspace",
    name: segment,
    path: slash === -1 ? "/" : rest.slice(slash),
  };
}

function isWorkspaceName(segment: string): boolean {
  try {
    parseWorkspaceName(segment);
    return true;
  } catch {
    return false;
  }
}
