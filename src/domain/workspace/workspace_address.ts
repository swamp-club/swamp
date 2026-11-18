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

import { isWorkspaceName } from "./workspace_name.ts";

export const WORKSPACE_PATH_PREFIX = "/w";

export interface WorkspaceAddress {
  readonly hostAddress: string;
  readonly name: string;
}

export function hostedWorkspaceAddress(
  hostAddress: string,
  name: string,
): string {
  return `${hostAddress}${WORKSPACE_PATH_PREFIX}/${name}`;
}

/**
 * the host is read only from the address given, never from a serve's answer,
 * since the host's token is sent there; null when the address names no
 * workspace
 */
export function splitWorkspaceAddress(
  normalizedAddress: string,
): WorkspaceAddress | null {
  let url: URL;
  try {
    url = new URL(normalizedAddress);
  } catch {
    return null;
  }
  const marker = `${WORKSPACE_PATH_PREFIX}/`;
  const path = url.pathname;
  const at = path.lastIndexOf(marker);
  if (at === -1) return null;
  const name = path.slice(at + marker.length);
  if (!isWorkspaceName(name)) return null;
  const hostPath = path.slice(0, at);
  return { hostAddress: `${url.protocol}//${url.host}${hostPath}`, name };
}
