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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import type { WorkspaceAbsence } from "../client/connection.ts";

/** What a page says about a workspace the host does not run right now. */
export function workspaceAbsenceText(
  workspace: string,
  absence: Exclude<WorkspaceAbsence, { kind: "refused" }>,
): string {
  if (absence.kind === "absent") {
    return `There is no workspace named ${workspace} on this host.`;
  }
  switch (absence.state) {
    case "stopped":
      return `The workspace ${workspace} is stopped.`;
    case "starting":
    case "backoff":
      return `The workspace ${workspace} is starting. This page opens when it is ready.`;
    case null:
      return `The workspace ${workspace} is not running.`;
    default:
      return `The workspace ${workspace} is not running (${absence.state}).`;
  }
}

/** Takes the place of the sign-in for a workspace that is absent or not running. */
export function WorkspaceUnavailable(
  { workspace, absence }: {
    workspace: string;
    absence: Exclude<WorkspaceAbsence, { kind: "refused" }>;
  },
) {
  return (
    <div className="login-container">
      <div className="login-card" role="status">
        <p>{workspaceAbsenceText(workspace, absence)}</p>
      </div>
    </div>
  );
}
