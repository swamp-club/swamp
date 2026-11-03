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

import { dirname, join } from "@std/path";
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import { atomicWriteFile } from "./atomic_write.ts";
import { cleanupEmptyParentDirs } from "./directory_cleanup.ts";
import { assertContainedPath } from "./safe_path.ts";

const PARENT_ATTEMPTS = 5;

export type MakeDirectory = (
  path: string,
  options: Deno.MkdirOptions,
) => Promise<void>;

export class FileSystemControlPlaneStore implements ControlPlaneStore {
  readonly #rootDir: string;
  readonly #mkdir: MakeDirectory;

  constructor(datastorePath: string, mkdir: MakeDirectory = Deno.mkdir) {
    this.#rootDir = join(datastorePath, "_control");
    this.#mkdir = mkdir;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.#keyToPath(key);
    await this.#writeInParent(path, () => atomicWriteFile(path, data));
  }

  async putIfAbsent(key: string, data: Uint8Array): Promise<boolean> {
    const path = this.#keyToPath(key);
    // Written in full beside the key, then linked into place: a hard link
    // fails when the key exists, and a reader never sees a record half
    // written. `list` skips the `.tmp` name.
    const staged = `${path}.${crypto.randomUUID()}.tmp`;
    await this.#writeInParent(
      path,
      () => Deno.writeFile(staged, data, { createNew: true }),
    );
    try {
      await Deno.link(staged, path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) return false;
      // A filesystem without hard links: create the key itself.
      return await this.#createNew(path, data);
    } finally {
      try {
        await Deno.remove(staged);
      } catch { /* best-effort cleanup */ }
    }
  }

  // A concurrent delete removes a parent it emptied, at any level, between
  // the mkdir and the write; once the write lands the parent is non-empty.
  async #writeInParent(
    path: string,
    write: () => Promise<void>,
  ): Promise<void> {
    for (let attempt = 1;; attempt++) {
      try {
        await this.#mkdir(dirname(path), { recursive: true });
        await write();
        return;
      } catch (error) {
        if (
          !(error instanceof Deno.errors.NotFound) ||
          attempt === PARENT_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
  }

  async #createNew(path: string, data: Uint8Array): Promise<boolean> {
    try {
      const file = await Deno.open(path, { createNew: true, write: true });
      try {
        let written = 0;
        while (written < data.length) {
          written += await file.write(data.subarray(written));
        }
      } catch (writeError) {
        file.close();
        try {
          await Deno.remove(path);
        } catch { /* best-effort cleanup */ }
        throw writeError;
      }
      file.close();
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        return false;
      }
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await Deno.readFile(this.#keyToPath(key));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.#keyToPath(key);
    try {
      await Deno.remove(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return;
      }
      throw error;
    }
    await cleanupEmptyParentDirs(path, this.#rootDir);
  }

  async list(prefix: string): Promise<string[]> {
    const searchDir = prefix === "" ? this.#rootDir : this.#keyToPath(prefix);
    const keys: string[] = [];
    try {
      await this.#collectKeys(searchDir, this.#rootDir, keys);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }
    return keys.sort();
  }

  async #collectKeys(
    dir: string,
    rootDir: string,
    keys: string[],
  ): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isSymlink) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory) {
        await this.#collectKeys(fullPath, rootDir, keys);
      } else if (entry.isFile && !entry.name.endsWith(".tmp")) {
        const relative = fullPath.slice(rootDir.length + 1);
        keys.push(relative.replaceAll("\\", "/"));
      }
    }
  }

  #keyToPath(key: string): string {
    assertContainedPath(key, this.#rootDir);
    return join(this.#rootDir, ...key.split("/"));
  }
}
