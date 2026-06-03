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

import { ensureDir } from "@std/fs";
import { dirname } from "@std/path";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import type {
  SourceMetadata,
  SourceMetadataRepository,
} from "../../domain/source/mod.ts";
import { SourceMetadataSchema } from "../../domain/source/mod.ts";
import { getSourceMetaPath, getSwampSourceDir } from "./source_paths.ts";

/**
 * JSON file-based implementation of SourceMetadataRepository.
 */
export class JsonSourceMetadataRepository implements SourceMetadataRepository {
  private readonly metaPath: string;
  private readonly sourceDir: string;

  constructor() {
    this.metaPath = getSourceMetaPath();
    this.sourceDir = getSwampSourceDir();
  }

  /**
   * Get the source directory path.
   */
  getSourceDir(): string {
    return this.sourceDir;
  }

  /**
   * Read source metadata from disk.
   */
  async read(): Promise<SourceMetadata | null> {
    try {
      const content = await Deno.readTextFile(this.metaPath);
      const data = JSON.parse(content);
      const result = SourceMetadataSchema.safeParse(data);
      if (!result.success) {
        return null;
      }
      return result.data;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Write source metadata to disk.
   */
  async write(metadata: SourceMetadata): Promise<void> {
    await ensureDir(dirname(this.metaPath));
    const content = JSON.stringify(metadata, null, 2);
    await atomicWriteTextFile(this.metaPath, content);
  }

  /**
   * Delete source metadata file.
   */
  async delete(): Promise<void> {
    try {
      await Deno.remove(this.metaPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
}
