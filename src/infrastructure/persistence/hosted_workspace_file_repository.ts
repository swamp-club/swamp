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

import { isAbsolute, join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import {
  HOSTED_WORKSPACE_WANTED,
  HostedWorkspace,
  type HostedWorkspaceRead,
  type HostedWorkspaceRepository,
} from "../../domain/serve/hosted_workspace.ts";
import { parseWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { FileLock } from "./file_lock.ts";

export const WANTED_FILE_SUFFIX = ".wanted.yaml";
export const STATUS_FILE_SUFFIX = ".status.yaml";
// workspace code runs as the host's user and can write this file
export const MAX_WANTED_FILE_BYTES = 4096;

const WantedFileSchema = z.object({
  wanted: z.enum(HOSTED_WORKSPACE_WANTED),
  creator: z.string().min(1).nullable().optional(),
  // YAML reads an unquoted timestamp an operator types as a date
  changedAt: z.union([z.string().min(1), z.date()]).transform((value) =>
    value instanceof Date ? value.toISOString() : value
  ).nullable().optional(),
  folder: z.string().min(1).refine(isAbsolute, "must be an absolute path")
    .optional(),
  repoId: z.string().min(1).optional(),
}).strict();

/** the per-name lock every create and change holds; hidden, so no scan or list sees it */
export function hostedWorkspaceLock(
  workspacesDir: string,
  name: string,
  maxWaitMs: number,
  contentionLogLevel: "warn" | "debug" = "warn",
): FileLock {
  return new FileLock(workspacesDir, {
    lockKey: `.${parseWorkspaceName(name)}.lock`,
    maxWaitMs,
    contentionLogLevel,
  });
}

export function wantedFileName(name: string): string {
  return `${parseWorkspaceName(name)}${WANTED_FILE_SUFFIX}`;
}

export function statusFileName(name: string): string {
  return `${parseWorkspaceName(name)}${STATUS_FILE_SUFFIX}`;
}

/** the workspace a wanted or status file belongs to, or null for any other entry */
export function hostedWorkspaceFileOf(
  entry: string,
): { readonly name: string; readonly kind: "wanted" | "status" } | null {
  for (
    const [suffix, kind] of [
      [WANTED_FILE_SUFFIX, "wanted"],
      [STATUS_FILE_SUFFIX, "status"],
    ] as const
  ) {
    if (!entry.endsWith(suffix)) continue;
    const name = entry.slice(0, -suffix.length);
    try {
      return { name: parseWorkspaceName(name), kind };
    } catch {
      return null;
    }
  }
  return null;
}

/** one wanted file per workspace, beside its folder in the workspaces folder */
export class HostedWorkspaceFileRepository
  implements HostedWorkspaceRepository {
  constructor(private readonly workspacesDir: string) {}

  async findByName(name: string): Promise<HostedWorkspaceRead> {
    const path = join(this.workspacesDir, wantedFileName(name));
    const unreadable = (reason: string): HostedWorkspaceRead => ({
      kind: "unreadable",
      reason: `The wanted file ${path} cannot be read: ${reason}`,
    });
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return { kind: "absent" };
      return unreadable(messageOf(error));
    }
    // a link or pipe swapped in after this is workspace code acting as the host's user, outside what the host defends
    if (!info.isFile) return unreadable("it is not a regular file");
    let text: string;
    try {
      const read = await readCapped(path, MAX_WANTED_FILE_BYTES);
      if (read === "not a file") return unreadable("it is not a regular file");
      if (read === null) {
        return unreadable(`it is larger than ${MAX_WANTED_FILE_BYTES} bytes`);
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
    const parsed = WantedFileSchema.safeParse(yaml);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue.path.length > 0 ? issue.path.join(".") : "the file";
      return unreadable(`${where}: ${issue.message}`);
    }
    return {
      kind: "found",
      workspace: HostedWorkspace.fromRecord({
        name,
        creator: parsed.data.creator ?? null,
        wanted: parsed.data.wanted,
        changedAt: parsed.data.changedAt ?? null,
        folder: parsed.data.folder ?? null,
        repoId: parsed.data.repoId ?? null,
      }),
    };
  }

  async save(workspace: HostedWorkspace): Promise<void> {
    const { creator, wanted, changedAt, folder, repoId } = workspace
      .toRecord();
    // no key for a workspace in workspaces/, so its file stays one an older host reads
    await atomicWriteTextFile(
      join(this.workspacesDir, wantedFileName(workspace.name)),
      stringifyYaml({
        wanted,
        creator,
        changedAt,
        ...(folder ? { folder } : {}),
        ...(repoId ? { repoId } : {}),
      }),
    );
  }

  async remove(name: string): Promise<void> {
    await removeIfPresent(join(this.workspacesDir, wantedFileName(name)));
  }
}

export async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** null when the file holds more than `cap` bytes; "not a file" when the opened handle is not a regular file */
export async function readCapped(
  path: string,
  cap: number,
): Promise<string | null | "not a file"> {
  using file = await Deno.open(path, { read: true });
  if (!(await file.stat()).isFile) return "not a file";
  const buffer = new Uint8Array(cap + 1);
  let filled = 0;
  while (filled < buffer.length) {
    const read = await file.read(buffer.subarray(filled));
    if (read === null) break;
    filled += read;
  }
  if (filled > cap) return null;
  return new TextDecoder("utf-8", { fatal: true }).decode(
    buffer.subarray(0, filled),
  );
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
