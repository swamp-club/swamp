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

import { UserError } from "../errors.ts";
import type { WantedServeState } from "./managed_serve.ts";
import { parseWorkspaceName } from "../workspace/workspace_name.ts";

export const HOSTED_WORKSPACE_WANTED = [
  "active",
  "suspended",
  "deleted",
] as const;

export type HostedWorkspaceWanted = typeof HOSTED_WORKSPACE_WANTED[number];

export interface HostedWorkspaceRecord {
  readonly name: string;
  /** null for a workspace whose folder was made by hand */
  readonly creator: string | null;
  readonly wanted: HostedWorkspaceWanted;
  /** null when the wanted file names no time */
  readonly changedAt: string | null;
  /** the folder it was written for; absent or null stands for `workspaces/<name>` */
  readonly folder?: string | null;
  /** the repoId of the repo create made; absent or null for any other */
  readonly repoId?: string | null;
}

/** the file says active where the supervisor says running; this is the one mapping */
export function serveWantedOf(wanted: HostedWorkspaceWanted): WantedServeState {
  return wanted === "active" ? "running" : wanted;
}

/** default off: a workspace with no wanted file read whole is not started */
export function serveWantedOfRecord(
  record: HostedWorkspace | null,
): WantedServeState {
  return record?.toServeWanted() ?? "suspended";
}

export function hostedWantedOf(
  wanted: WantedServeState,
): HostedWorkspaceWanted {
  return wanted === "running" ? "active" : wanted;
}

export class HostedWorkspace {
  private constructor(private readonly record: HostedWorkspaceRecord) {}

  static active(name: string): HostedWorkspace {
    return new HostedWorkspace({
      name: parseWorkspaceName(name),
      creator: null,
      wanted: "active",
      changedAt: null,
    });
  }

  static create(name: string, creator: string, at: Date): HostedWorkspace {
    if (creator.length === 0) {
      throw new UserError("A hosted workspace needs a creator.");
    }
    return new HostedWorkspace({
      name: parseWorkspaceName(name),
      creator,
      wanted: "active",
      changedAt: at.toISOString(),
    });
  }

  static fromRecord(record: HostedWorkspaceRecord): HostedWorkspace {
    if (record.creator === "") {
      throw new UserError("A hosted workspace's creator cannot be empty.");
    }
    if (!HOSTED_WORKSPACE_WANTED.includes(record.wanted)) {
      throw new UserError(
        `Invalid wanted state "${record.wanted}". Use active, suspended or deleted.`,
      );
    }
    return new HostedWorkspace(
      recordWithRepoId(
        recordWithFolder(
          { ...record, name: parseWorkspaceName(record.name) },
          record.folder ?? null,
        ),
        record.repoId ?? null,
      ),
    );
  }

  get name(): string {
    return this.record.name;
  }

  get creator(): string | null {
    return this.record.creator;
  }

  get wanted(): HostedWorkspaceWanted {
    return this.record.wanted;
  }

  get changedAt(): string | null {
    return this.record.changedAt;
  }

  get folder(): string | null {
    return this.record.folder ?? null;
  }

  get repoId(): string | null {
    return this.record.repoId ?? null;
  }

  toRecord(): HostedWorkspaceRecord {
    return { ...this.record };
  }

  toServeWanted(): WantedServeState {
    return serveWantedOf(this.record.wanted);
  }

  equals(other: HostedWorkspace): boolean {
    const a = this.record;
    const b = other.record;
    return a.name === b.name && a.creator === b.creator &&
      a.wanted === b.wanted && a.changedAt === b.changedAt &&
      (a.folder ?? null) === (b.folder ?? null) &&
      (a.repoId ?? null) === (b.repoId ?? null);
  }

  withFolder(folder: string | null): HostedWorkspace {
    return new HostedWorkspace(recordWithFolder(this.record, folder));
  }

  withRepoId(repoId: string | null): HostedWorkspace {
    return new HostedWorkspace(recordWithRepoId(this.record, repoId));
  }

  suspend(at: Date): HostedWorkspace {
    return this.#change("suspended", at);
  }

  resume(at: Date): HostedWorkspace {
    return this.#change("active", at);
  }

  markDeleted(at: Date): HostedWorkspace {
    if (this.wanted === "deleted") return this;
    return new HostedWorkspace({
      ...this.record,
      wanted: "deleted",
      changedAt: at.toISOString(),
    });
  }

  #change(wanted: HostedWorkspaceWanted, at: Date): HostedWorkspace {
    if (this.wanted === "deleted") {
      throw new UserError(
        `Workspace ${this.name} is being deleted, so it cannot be ${
          wanted === "active" ? "resumed" : "suspended"
        }.`,
      );
    }
    // a new changedAt even for the same state: a changed active record is what takes a workspace out of failed
    return new HostedWorkspace({
      ...this.record,
      wanted,
      changedAt: at.toISOString(),
    });
  }
}

// no key for no folder, so a workspace in workspaces/ keeps the record an older host reads
function recordWithFolder(
  record: HostedWorkspaceRecord,
  folder: string | null,
): HostedWorkspaceRecord {
  if (folder === "") {
    throw new UserError("A hosted workspace's folder cannot be empty.");
  }
  const { folder: _dropped, ...rest } = record;
  return folder === null ? rest : { ...rest, folder };
}

function recordWithRepoId(
  record: HostedWorkspaceRecord,
  repoId: string | null,
): HostedWorkspaceRecord {
  if (repoId === "") {
    throw new UserError("A hosted workspace's repoId cannot be empty.");
  }
  const { repoId: _dropped, ...rest } = record;
  return repoId === null ? rest : { ...rest, repoId };
}

export type HostedWorkspaceRead =
  | { readonly kind: "found"; readonly workspace: HostedWorkspace }
  | { readonly kind: "absent" }
  /** never read as a default state: the caller keeps what it had */
  | { readonly kind: "unreadable"; readonly reason: string };

export interface HostedWorkspaceRepository {
  findByName(name: string): Promise<HostedWorkspaceRead>;
  save(workspace: HostedWorkspace): Promise<void>;
  /** a workspace with no stored record is already removed */
  remove(name: string): Promise<void>;
}
