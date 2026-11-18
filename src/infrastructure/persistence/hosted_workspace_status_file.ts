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
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import type { ObservedServeState } from "../../domain/serve/managed_serve.ts";
import {
  HOSTED_WORKSPACE_WANTED,
  type HostedWorkspaceWanted,
} from "../../domain/serve/hosted_workspace.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import {
  messageOf,
  readCapped,
  removeIfPresent,
  statusFileName,
} from "./hosted_workspace_file_repository.ts";

// a reason holds at most the last 20 stderr lines of 8 KiB each
export const MAX_STATUS_FILE_BYTES = 256 * 1024;

const OBSERVED_SERVE_STATES = [
  "stopped",
  "starting",
  "ready",
  "backoff",
  "failed",
] as const satisfies readonly ObservedServeState[];

const StatusFileSchema = z.object({
  state: z.enum(OBSERVED_SERVE_STATES),
  wanted: z.enum(HOSTED_WORKSPACE_WANTED),
  restarts: z.number().int().nonnegative(),
  reason: z.string().nullable(),
  updatedAt: z.union([z.string().min(1), z.date()]).transform((value) =>
    value instanceof Date ? value.toISOString() : value
  ),
}).strict();

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

export type HostedWorkspaceStatusRead =
  | { readonly kind: "found"; readonly status: HostedWorkspaceStatus }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

export async function readHostedWorkspaceStatus(
  workspacesDir: string,
  name: string,
): Promise<HostedWorkspaceStatusRead> {
  const path = join(workspacesDir, statusFileName(name));
  const unreadable = (reason: string): HostedWorkspaceStatusRead => ({
    kind: "unreadable",
    reason: `The status file of workspace ${name} cannot be read: ${reason}`,
  });
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: "absent" };
    return unreadable(messageOf(error));
  }
  if (!info.isFile) return unreadable("it is not a regular file");
  let text: string;
  try {
    const read = await readCapped(path, MAX_STATUS_FILE_BYTES);
    if (read === "not a file") return unreadable("it is not a regular file");
    if (read === null) {
      return unreadable(`it is larger than ${MAX_STATUS_FILE_BYTES} bytes`);
    }
    text = read;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: "absent" };
    return unreadable(messageOf(error));
  }
  let yaml: unknown;
  try {
    yaml = parseYaml(text);
  } catch {
    return unreadable("it is not valid YAML");
  }
  const parsed = StatusFileSchema.safeParse(yaml);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length > 0 ? issue.path.join(".") : "the file";
    return unreadable(`${where}: ${issue.message}`);
  }
  return { kind: "found", status: parsed.data };
}
