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
import { stringify as stringifyYaml } from "@std/yaml";
import type { ObservedServeState } from "../../domain/serve/managed_serve.ts";
import type { HostedWorkspaceWanted } from "../../domain/serve/hosted_workspace.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import {
  removeIfPresent,
  statusFileName,
} from "./hosted_workspace_file_repository.ts";

export interface HostedWorkspaceStatus {
  readonly state: ObservedServeState;
  readonly wanted: HostedWorkspaceWanted;
  readonly restarts: number;
  /** a wanted-file problem, an admission refusal, or the last exit in backoff or failed; else null */
  readonly reason: string | null;
  readonly updatedAt: string;
}

export async function writeHostedWorkspaceStatus(
  workspacesDir: string,
  name: string,
  status: HostedWorkspaceStatus,
): Promise<void> {
  const { state, wanted, restarts, reason, updatedAt } = status;
  await atomicWriteTextFile(
    join(workspacesDir, statusFileName(name)),
    stringifyYaml({ state, wanted, restarts, reason, updatedAt }),
  );
}

export async function removeHostedWorkspaceStatus(
  workspacesDir: string,
  name: string,
): Promise<void> {
  await removeIfPresent(join(workspacesDir, statusFileName(name)));
}
