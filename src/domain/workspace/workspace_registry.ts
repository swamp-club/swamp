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

import { markErrorPaths, UserError } from "../errors.ts";

export type WorkspaceOrigin = "created" | "imported";

export interface WorkspaceEntry {
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  /**
   * unset on entries written before it was recorded; those are told apart by
   * where the folder is (see isImportedWorkspace)
   */
  readonly origin?: WorkspaceOrigin;
  /**
   * kept in the config dir and never read from the workspace, since a cloned
   * repo can carry any session state it likes
   */
  readonly trustedAt?: string;
}

export class WorkspaceRegistry {
  private constructor(
    private entries: WorkspaceEntry[],
    private agent: string | undefined,
  ) {}

  static empty(): WorkspaceRegistry {
    return new WorkspaceRegistry([], undefined);
  }

  static fromEntries(
    entries: readonly WorkspaceEntry[],
    lastAgent?: string,
  ): WorkspaceRegistry {
    const registry = new WorkspaceRegistry([], lastAgent);
    for (const entry of entries) registry.register(entry);
    return registry;
  }

  lastAgent(): string | undefined {
    return this.agent;
  }

  rememberAgent(id: string): boolean {
    if (this.agent === id) return false;
    this.agent = id;
    return true;
  }

  list(): WorkspaceEntry[] {
    return [...this.entries];
  }

  get(name: string): WorkspaceEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  register(entry: WorkspaceEntry): boolean {
    const byName = this.get(entry.name);
    if (byName) {
      if (byName.path === entry.path) return false;
      throw markErrorPaths(
        new UserError(
          `A workspace named "${entry.name}" is already registered at ${byName.path}.`,
        ),
        [byName.path],
      );
    }
    const byPath = this.entries.find((e) => e.path === entry.path);
    if (byPath) {
      throw markErrorPaths(
        new UserError(
          `${entry.path} is already registered as the workspace "${byPath.name}".`,
        ),
        [entry.path],
      );
    }
    this.entries = [...this.entries, entry];
    return true;
  }

  isTrusted(path: string): boolean {
    return this.entries.some((e) => e.path === path && e.trustedAt);
  }

  markTrusted(path: string, at: string): boolean {
    const entry = this.entries.find((e) => e.path === path);
    if (!entry || entry.trustedAt) return false;
    this.entries = this.entries.map((e) =>
      e === entry ? { ...e, trustedAt: at } : e
    );
    return true;
  }

  remove(name: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.name !== name);
    return this.entries.length !== before;
  }
}

export interface WorkspaceRegistryRepository {
  /**
   * throws registry_unreadable when a registry exists but cannot be read; that
   * is never reported as missing
   */
  load(): Promise<WorkspaceRegistry | null>;
  /** throws, writing nothing, when the stored registry cannot be read */
  update<T>(change: (registry: WorkspaceRegistry) => T): Promise<T>;
}
