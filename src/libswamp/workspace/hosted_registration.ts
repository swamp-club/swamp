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

import { resolve } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import { readHostedRegistry } from "./hosted_roster.ts";
import {
  realPathOrSelf,
  type WorkspaceRegistryAccess,
} from "./workspace_store.ts";

export type HostedRegistryDeps = WorkspaceRegistryAccess;

export type HostedUnregistration =
  | { readonly kind: "removed" | "absent" | "not_ours" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** removes the entry for `name` only while it names `folder`, a folder a request created */
export async function unregisterCreatedWorkspace(
  deps: HostedRegistryDeps,
  input: { name: string; folder: string },
): Promise<HostedUnregistration> {
  const { name } = input;
  const target = await realPathOrSelf(resolve(input.folder));
  const read = await readHostedRegistry(deps);
  if (read.kind === "unreadable") return read;
  const before = read.registry?.get(name);
  if (before === undefined) return { kind: "absent" };
  // exact first: a folder already removed no longer resolves to the entry's spelling
  const matches = before.path === input.folder ||
    await realPathOrSelf(resolve(before.path)) === target;
  if (!matches) return { kind: "not_ours" };
  try {
    return await deps.registry.update((current): HostedUnregistration => {
      const now = current.get(name);
      if (now === undefined) return { kind: "absent" };
      if (now.path !== before.path) return { kind: "not_ours" };
      current.remove(name);
      return { kind: "removed" };
    });
  } catch (error) {
    if (isUnreadable(error)) {
      return { kind: "unreadable", reason: error.message };
    }
    throw error;
  }
}

/** the folder the registry, read afresh, names for `name`, as written and real; null for no entry */
export async function registeredFolderOf(
  deps: Pick<HostedRegistryDeps, "registry">,
  name: string,
): Promise<
  | { kind: "read"; folder: { path: string; real: string } | null }
  | { kind: "unreadable"; reason: string }
> {
  const read = await readHostedRegistry(deps);
  if (read.kind === "unreadable") return read;
  const entry = read.registry?.get(name);
  if (entry === undefined) return { kind: "read", folder: null };
  return {
    kind: "read",
    folder: {
      path: entry.path,
      real: await realPathOrSelf(resolve(entry.path)),
    },
  };
}

function isUnreadable(error: unknown): error is UserError {
  return error instanceof UserError && error.code === "registry_unreadable";
}
