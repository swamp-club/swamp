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

import type { LogRecord, Sink } from "@logtape/logtape";
import { dirname } from "@std/path";
import type { SecretRedactor } from "../../domain/secrets/mod.ts";
import { assertSafePath } from "../persistence/safe_path.ts";
import { textFormatter } from "./log_format.ts";

const formatRecord = textFormatter();

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

export const RUN_ID_PROPERTY = "swampRunId";

interface FileWriter {
  fd: Deno.FsFile;
  encoder: TextEncoder;
  prefix: string[];
  redactor?: SecretRedactor;
  runId?: string;
}

/**
 * keyed by opaque handle, not prefix: concurrent runs share the catch-all
 * prefix, so a prefix key would let one run's unregister close a sibling's open
 * fd
 */
export class RunFileSink {
  private writers = new Map<string, FileWriter>();
  private redactors = new Map<string, SecretRedactor>();

  /**
   * test-only, unused by production code; lets tests assert a run's log handle
   * was released without counting OS file descriptors
   */
  get activeCount(): number {
    return this.writers.size;
  }

  /**
   * failure-atomic: all fallible I/O completes before the writer is recorded,
   * so a throw leaves the writer map and open descriptors untouched
   */
  async register(
    categoryPrefix: string[],
    filePath: string,
    redactor?: SecretRedactor,
    boundary?: string,
    options?: { append?: boolean; runId?: string },
  ): Promise<string> {
    if (boundary) {
      await assertSafePath(filePath, boundary);
    }

    const dir = dirname(filePath);
    if (dir && dir !== ".") {
      await Deno.mkdir(dir, { recursive: true });
    }

    const fd = await Deno.open(filePath, {
      write: true,
      create: true,
      ...(options?.append ? { append: true } : { truncate: true }),
    });

    // Only mutate the map once all fallible I/O has succeeded.
    const handle = crypto.randomUUID();
    this.writers.set(handle, {
      fd,
      encoder: new TextEncoder(),
      prefix: categoryPrefix,
      redactor,
      runId: options?.runId,
    });
    return handle;
  }

  /**
   * no-ops for an unknown or undefined handle, such as after a register that
   * threw, so callers can unregister unconditionally
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
   * registers a redactor with no log file so every sink using redactActive
   * masks its secrets; the dispatch runner needs it because its stderr is
   * re-logged by the supervisor
   */
  registerRedactor(redactor: SecretRedactor): string {
    const handle = crypto.randomUUID();
    this.redactors.set(handle, redactor);
    return handle;
  }

  unregisterRedactor(handle: string | undefined): void {
    if (handle === undefined) return;
    this.redactors.delete(handle);
  }

  get hasActiveSecrets(): boolean {
    return [...this.writers.values()].some((writer) =>
      writer.redactor?.hasSecrets
    ) || [...this.redactors.values()].some((redactor) => redactor.hasSecrets);
  }

  /**
   * whether text is, whole, a registered secret; lets a sink exporting a number
   * or boolean mask a secret delivered as one while keeping numbers that merely
   * contain its digits
   */
  isActiveSecret(text: string): boolean {
    return [...this.writers.values()].some((writer) =>
      writer.redactor?.isSecret(text)
    ) || [...this.redactors.values()].some((redactor) =>
      redactor.isSecret(text)
    );
  }

  /**
   * applies the union of all active redactors for sinks beyond the run files
   * (OTLP, stderr, console guard); over-redaction across concurrent runs is
   * negligible since secrets are long and unique
   */
  redactActive(text: string): string {
    let result = text;
    for (const writer of this.writers.values()) {
      if (writer.redactor?.hasSecrets) {
        result = writer.redactor.redact(result);
      }
    }
    for (const redactor of this.redactors.values()) {
      if (redactor.hasSecrets) {
        result = redactor.redact(result);
      }
    }
    return result;
  }

  get sink(): Sink {
    return (record: LogRecord) => {
      const formatted = formatRecord(record);
      const line = formatted.endsWith("\n") ? formatted : formatted + "\n";

      for (const writer of this.writers.values()) {
        if (!categoryMatchesPrefix(record.category, writer.prefix)) continue;
        if (
          writer.runId &&
          record.properties[RUN_ID_PROPERTY] !== writer.runId
        ) {
          continue;
        }
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
    };
  }

  dispose(): void {
    for (const writer of this.writers.values()) {
      try {
        writer.fd.close();
      } catch {
        // Already closed
      }
    }
    this.writers.clear();
    this.redactors.clear();
  }
}

export const runFileSink = new RunFileSink();
