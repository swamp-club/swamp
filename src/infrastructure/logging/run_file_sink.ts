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

import { getTextFormatter, type LogRecord, type Sink } from "@logtape/logtape";
import { dirname } from "@std/path";
import type { SecretRedactor } from "../../domain/secrets/mod.ts";
import { assertSafePath } from "../persistence/safe_path.ts";

/**
 * Formats a LogRecord as a plain text line for file output.
 */
const formatRecord = getTextFormatter();

/**
 * Checks whether `category` starts with `prefix`.
 */
function categoryMatchesPrefix(
  category: readonly string[],
  prefix: string[],
): boolean {
  if (category.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (category[i] !== prefix[i]) return false;
  }
  return true;
}

interface FileWriter {
  fd: Deno.FsFile;
  encoder: TextEncoder;
  prefix: string[];
  redactor?: SecretRedactor;
}

/**
 * A LogTape sink that routes log records to per-run log files.
 * Registered once at startup. File targets are added/removed dynamically
 * as runs start and complete.
 *
 * Each {@link register} call is keyed by a unique opaque handle rather than by
 * its category prefix. Concurrent runs (forEach children, parent+child) share
 * the same catch-all `[]` prefix, so keying by the prefix would collide on a
 * single map entry and let one run's register/unregister close a sibling run's
 * still-open file descriptor — surfacing as Deno's "Bad resource ID". The
 * handle decouples a registration's identity from its routing rule (the prefix
 * is retained only for record matching).
 */
export class RunFileSink {
  private writers = new Map<string, FileWriter>();

  /**
   * Number of currently registered writers (each holds one open file
   * descriptor). Test-only observability: lets tests assert that a run's log
   * handle was released without counting raw OS file descriptors (which is not
   * portable across Linux, macOS, and Windows). Not used by production code.
   */
  get activeCount(): number {
    return this.writers.size;
  }

  /**
   * Register a log file for a category prefix and return an opaque handle that
   * identifies this registration. All log records matching the prefix while the
   * registration is active are written to the file. Pass the returned handle to
   * {@link unregister} to close the file.
   *
   * Failure-atomic: all fallible I/O (path validation, directory creation, file
   * open) completes before the writer is recorded, so a throw leaves the writer
   * map and every open descriptor untouched and requires no caller cleanup.
   */
  async register(
    categoryPrefix: string[],
    filePath: string,
    redactor?: SecretRedactor,
    boundary?: string,
  ): Promise<string> {
    // Validate the file path stays within the expected boundary
    if (boundary) {
      await assertSafePath(filePath, boundary);
    }

    // Ensure parent directory exists
    const dir = dirname(filePath);
    if (dir && dir !== ".") {
      await Deno.mkdir(dir, { recursive: true });
    }

    const fd = await Deno.open(filePath, {
      write: true,
      create: true,
      truncate: true,
    });

    // Only mutate the map once all fallible I/O has succeeded.
    const handle = crypto.randomUUID();
    this.writers.set(handle, {
      fd,
      encoder: new TextEncoder(),
      prefix: categoryPrefix,
      redactor,
    });
    return handle;
  }

  /**
   * Unregister and close the file writer for a registration handle. No-ops if
   * the handle is unknown or undefined (e.g. when a `register` call threw before
   * returning a handle), so callers can unregister unconditionally on cleanup.
   */
  unregister(handle: string | undefined): void {
    if (handle === undefined) return;
    const writer = this.writers.get(handle);
    if (writer) {
      try {
        writer.fd.close();
      } catch {
        // Already closed — closing twice must never throw "Bad resource ID".
      }
      this.writers.delete(handle);
    }
  }

  /**
   * The sink function to pass to LogTape configure().
   * Writes to all registered prefixes that match the record's category.
   */
  get sink(): Sink {
    return (record: LogRecord) => {
      const formatted = formatRecord(record);
      const line = formatted.endsWith("\n") ? formatted : formatted + "\n";

      for (const writer of this.writers.values()) {
        if (categoryMatchesPrefix(record.category, writer.prefix)) {
          try {
            const redactedLine = writer.redactor?.hasSecrets
              ? writer.redactor.redact(line)
              : line;
            writer.fd.writeSync(writer.encoder.encode(redactedLine));
          } catch {
            // Logging infrastructure must not throw — a broken log file
            // should never crash a running workflow.
          }
        }
      }
    };
  }

  /**
   * Close all open file writers.
   */
  dispose(): void {
    for (const writer of this.writers.values()) {
      try {
        writer.fd.close();
      } catch {
        // Already closed
      }
    }
    this.writers.clear();
  }
}

/**
 * Global singleton RunFileSink instance.
 * Created once at startup and registered with LogTape.
 */
export const runFileSink = new RunFileSink();
