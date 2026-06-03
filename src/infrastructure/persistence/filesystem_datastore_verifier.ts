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
import type {
  DatastoreHealthResult,
  DatastoreVerifier,
} from "../../domain/datastore/datastore_health.ts";

/**
 * Verifies a filesystem datastore is accessible and writable.
 *
 * Checks:
 * 1. Directory exists
 * 2. Directory is writable (writes and deletes a temp file)
 */
export class FilesystemDatastoreVerifier implements DatastoreVerifier {
  constructor(private readonly path: string) {}

  async verify(): Promise<DatastoreHealthResult> {
    const start = performance.now();

    try {
      // Check directory exists
      const stat = await Deno.stat(this.path);
      if (!stat.isDirectory) {
        return {
          healthy: false,
          message: `Path exists but is not a directory: ${this.path}`,
          latencyMs: performance.now() - start,
          datastoreType: "filesystem",
          details: { path: this.path },
        };
      }

      // Check writability by writing and deleting a temp file
      const tempFile = join(
        this.path,
        `.swamp-health-check-${crypto.randomUUID()}`,
      );
      try {
        await Deno.writeTextFile(tempFile, "health-check");
        await Deno.remove(tempFile);
      } catch (error) {
        return {
          healthy: false,
          message: `Directory exists but is not writable: ${this.path}. ${
            error instanceof Error ? error.message : String(error)
          }`,
          latencyMs: performance.now() - start,
          datastoreType: "filesystem",
          details: { path: this.path },
        };
      }

      return {
        healthy: true,
        message: `Filesystem datastore at ${this.path} is healthy`,
        latencyMs: performance.now() - start,
        datastoreType: "filesystem",
        details: { path: this.path },
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return {
          healthy: false,
          message:
            `Datastore directory does not exist: ${this.path}. Run 'swamp datastore setup filesystem --path ${this.path}' to create it.`,
          latencyMs: performance.now() - start,
          datastoreType: "filesystem",
          details: { path: this.path },
        };
      }

      return {
        healthy: false,
        message: `Cannot access datastore: ${
          error instanceof Error ? error.message : String(error)
        }`,
        latencyMs: performance.now() - start,
        datastoreType: "filesystem",
        details: { path: this.path },
      };
    }
  }
}
