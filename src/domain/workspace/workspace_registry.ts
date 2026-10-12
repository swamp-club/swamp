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

/** One registered workspace. */
export interface WorkspaceEntry {
  readonly name: string;
  /** Absolute path of the workspace folder. */
  readonly path: string;
  readonly createdAt: string;
  /**
   * When the user confirmed, on this machine, that agents may work in the
   * folder. Kept here, in the config dir, and never read from the workspace:
   * a cloned repo can carry any session state it likes.
   */
  readonly trustedAt?: string;
}

/**
 * Every workspace Swamp knows about on this machine. Names and paths are
 * unique; registering the same name at the same path again changes nothing.
 */
export class WorkspaceRegistry {
  private constructor(private entries: WorkspaceEntry[]) {}

  static empty(): WorkspaceRegistry {
    return new WorkspaceRegistry([]);
  }

  static fromEntries(entries: readonly WorkspaceEntry[]): WorkspaceRegistry {
    const registry = WorkspaceRegistry.empty();
    for (const entry of entries) registry.register(entry);
    return registry;
  }

  list(): WorkspaceEntry[] {
    return [...this.entries];
  }

  get(name: string): WorkspaceEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  /** Adds a workspace; true when it was new. */
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

  /** True when the user confirmed trust for the workspace at `path`. */
  isTrusted(path: string): boolean {
    return this.entries.some((e) => e.path === path && e.trustedAt);
  }

  /**
   * Records that the user trusts the workspace at `path`; true when that
   * changed anything (false for an unregistered or already trusted path).
   */
  markTrusted(path: string, at: string): boolean {
    const entry = this.entries.find((e) => e.path === path);
    if (!entry || entry.trustedAt) return false;
    this.entries = this.entries.map((e) =>
      e === entry ? { ...e, trustedAt: at } : e
    );
    return true;
  }

  /** Removes a workspace; true when it was registered. */
  remove(name: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.name !== name);
    return this.entries.length !== before;
  }
}

/** Stores the registry. */
export interface WorkspaceRegistryRepository {
  /**
   * The registry, or null when none has been written yet. Throws a
   * UserError (code `registry_unreadable`) when one exists but can't be
   * read; that is never reported as missing.
   */
  load(): Promise<WorkspaceRegistry | null>;
  /**
   * Runs `change` on the current registry (an empty one when none exists)
   * under the registry's lock, and saves the result. Throws, writing
   * nothing, when the stored registry can't be read.
   */
  update<T>(change: (registry: WorkspaceRegistry) => T): Promise<T>;
}
