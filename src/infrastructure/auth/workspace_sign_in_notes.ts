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

import {
  serverLoginHint,
  serverTokenRefusedHint,
  type WorkspaceSignInNote,
  workspaceTokenRefusalHint,
} from "../../domain/auth/server_login_hint.ts";
import { normalizeServerUrl } from "../../domain/auth/server_url.ts";
import { processRuntimeSlot } from "../runtime/process_runtime.ts";

// read by the remote-run and datastore clients, which build their refusal
// messages without seeing how the CLI resolved the token
const notes = processRuntimeSlot(() => new Map<string, WorkspaceSignInNote>());

export function recordWorkspaceSignIn(
  workspaceAddress: string,
  hostAddress: string,
  kind: WorkspaceSignInNote["kind"],
): void {
  const key = normalizedOrUndefined(workspaceAddress);
  if (key !== undefined) notes().set(key, { hostAddress, kind });
}

/** the workspace offers sign-in through its host, but no host token is usable */
export function hasWorkspaceSignInGap(workspaceAddress: string): boolean {
  const kind = noteFor(workspaceAddress)?.kind;
  return kind !== undefined && kind !== "exchanged-token";
}

export function loginHintFor(serverUrl: string): string {
  return serverLoginHint(serverUrl, noteFor(serverUrl));
}

export function tokenRefusedHintFor(serverUrl: string): string {
  return serverTokenRefusedHint(serverUrl, noteFor(serverUrl));
}

export function workspaceRefusalHintFor(serverUrl: string): string | undefined {
  return workspaceTokenRefusalHint(noteFor(serverUrl));
}

function noteFor(serverUrl: string): WorkspaceSignInNote | undefined {
  const key = normalizedOrUndefined(serverUrl);
  return key === undefined ? undefined : notes().get(key);
}

function normalizedOrUndefined(serverUrl: string): string | undefined {
  try {
    return normalizeServerUrl(serverUrl);
  } catch {
    return undefined;
  }
}
