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
import { ensureDir } from "@std/fs";
import { z } from "zod";
import {
  WorkspaceRegistry,
  type WorkspaceRegistryRepository,
} from "../../domain/workspace/workspace_registry.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { FileLock } from "./file_lock.ts";
import { getSwampConfigDir } from "./paths.ts";

const SCHEMA_VERSION = 1;
const FILE_NAME = "workspaces.json";

const RegistryFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  workspaces: z.array(z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    createdAt: z.string(),
    trustedAt: z.string().optional(),
  })),
  // A preference: a value that can't be used is dropped, never a reason to
  // call the whole workspace list unreadable.
  lastAgent: z.string().min(1).optional().catch(undefined),
});

/**
 * Stores the workspace registry in `<config dir>/workspaces.json`, beside
 * `auth.json`, written atomically with mode 0600 under a file lock.
 */
export class WorkspaceRegistryFileRepository
  implements WorkspaceRegistryRepository {
  constructor(private readonly configDir: string = getSwampConfigDir()) {}

  private get path(): string {
    return join(this.configDir, FILE_NAME);
  }

  /**
   * The registry, or null when the file doesn't exist.
   *
   * @throws {UserError} code `registry_unreadable` when the file exists but
   *   can't be used: damaged JSON, an unexpected shape, a newer schema
   *   version, or duplicate entries. It is never treated as missing, so the
   *   workspaces it lists are never silently dropped.
   */
  async load(): Promise<WorkspaceRegistry | null> {
    const path = this.path;
    let raw: string;
    try {
      raw = await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
    const unreadable = (why: string) =>
      markErrorPaths(
        new UserError(
          `Swamp can't read its workspace list at ${path}: ${why}. Fix the file or move it aside; Swamp won't change it until then.`,
          "registry_unreadable",
        ),
        [path],
      );
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw unreadable("it isn't valid JSON");
    }
    const version = (json as { schemaVersion?: unknown } | null)
      ?.schemaVersion;
    if (typeof version === "number" && version > SCHEMA_VERSION) {
      throw unreadable(
        `it was written by a newer version of Swamp (schema ${version})`,
      );
    }
    const parsed = RegistryFileSchema.safeParse(json);
    if (!parsed.success) throw unreadable("its contents aren't as expected");
    const twice = () => unreadable("it lists a workspace name or folder twice");
    let registry: WorkspaceRegistry;
    try {
      registry = WorkspaceRegistry.fromEntries(
        parsed.data.workspaces,
        parsed.data.lastAgent,
      );
    } catch (error) {
      if (error instanceof UserError) throw twice();
      throw error;
    }
    // An exact repeat registers once; it is a duplicate all the same.
    if (registry.list().length !== parsed.data.workspaces.length) {
      throw twice();
    }
    return registry;
  }

  async update<T>(change: (registry: WorkspaceRegistry) => T): Promise<T> {
    await ensureDir(this.configDir);
    const lock = new FileLock(this.configDir, {
      lockKey: `${FILE_NAME}.lock`,
    });
    await lock.acquire();
    try {
      // An unreadable file throws here, before anything is written.
      const registry = (await this.load()) ?? WorkspaceRegistry.empty();
      const result = change(registry);
      const lastAgent = registry.lastAgent();
      await atomicWriteTextFile(
        this.path,
        JSON.stringify(
          {
            schemaVersion: SCHEMA_VERSION,
            workspaces: registry.list(),
            ...(lastAgent !== undefined ? { lastAgent } : {}),
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      return result;
    } finally {
      await lock.release();
    }
  }
}
