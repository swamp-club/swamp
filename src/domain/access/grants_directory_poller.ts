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

import { getLogger } from "@logtape/logtape";
import { withPollCycleSpan } from "../../infrastructure/tracing/mod.ts";
import { join } from "@std/path";
import {
  readGrantsDirSource,
  readGrantsFileSource,
} from "./grant_file_loader.ts";
import {
  type ConditionValidator,
  type GrantFileEntry,
  type GrantFileError,
  readGrantFiles,
} from "./grant_file.ts";
import {
  type FileGrantStore,
  reconcileAllFileGrants,
} from "./grant_file_reconciler.ts";
import {
  GRANTS_FILE_SOURCE_NAME,
  isGrantsDirSourceName,
} from "./grant_source.ts";
import type { PolicySnapshotLoader } from "./policy_snapshot_loader.ts";

const logger = getLogger(["swamp", "domain", "access", "grants-poller"]);

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface GrantsDirectoryPollerOptions {
  grantsDir: string;
  externalGrantsFile?: string;
  externalGrantsDir?: string;
  validateCondition?: ConditionValidator;
  fileGrantStore: FileGrantStore;
  policySnapshotLoader: PolicySnapshotLoader;
  pollIntervalMs?: number;
  /**
   * Runs each reconcile (store writes and snapshot reload) as one unit.
   * Serve passes a wrapper that holds the sync gate and pushes the writes
   * to the datastore; without one the unit runs as is.
   */
  commitReconcile?: (reconcile: () => Promise<void>) => Promise<void>;
}

export class GrantsDirectoryPoller {
  readonly #grantsDir: string;
  readonly #externalGrantsFile: string | undefined;
  readonly #externalGrantsDir: string | undefined;
  readonly #validateCondition: ConditionValidator | undefined;
  readonly #fileGrantStore: FileGrantStore;
  readonly #policySnapshotLoader: PolicySnapshotLoader;
  readonly #pollIntervalMs: number;
  readonly #commitReconcile: (
    reconcile: () => Promise<void>,
  ) => Promise<void>;
  #timer: ReturnType<typeof setInterval> | null = null;
  #contentHash: string = "";
  #pendingReconcile: Promise<void> = Promise.resolve();
  #reconciling = false;

  constructor(options: GrantsDirectoryPollerOptions) {
    this.#grantsDir = options.grantsDir;
    this.#externalGrantsFile = options.externalGrantsFile;
    this.#externalGrantsDir = options.externalGrantsDir;
    this.#validateCondition = options.validateCondition;
    this.#fileGrantStore = options.fileGrantStore;
    this.#policySnapshotLoader = options.policySnapshotLoader;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#commitReconcile = options.commitReconcile ??
      ((reconcile) => reconcile());
  }

  async start(): Promise<void> {
    if (this.#timer) return;
    this.#contentHash = await this.#computeContentHash();
    this.#timer = setInterval(() => {
      this.#poll();
    }, this.#pollIntervalMs);
    const intervalSec = this.#pollIntervalMs / 1000;
    logger
      .info`Grants directory poller started (interval: ${intervalSec}s)`;
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#pendingReconcile;
  }

  #poll(): void {
    if (this.#reconciling) return;

    this.#pendingReconcile = this.#pendingReconcile.then(() =>
      withPollCycleSpan("grants_directory", () => this.#checkAndReconcile())
    );
  }

  async #checkAndReconcile(): Promise<void> {
    this.#reconciling = true;
    try {
      const newHash = await this.#computeContentHash();
      if (newHash === this.#contentHash) return;

      logger.info`Grants directory change detected, reconciling`;

      // Auto-reload does what a restart would do with the same files. Where
      // startup refuses to start - a file that fails to read or validate, a
      // missing --grants-file or --grants-dir - the source keeps its stored
      // grants: reconciling it as empty would revoke them, and a broken deny
      // file would fail open (swamp-club#2823). Where startup accepts the
      // input - a deleted or emptied file, no repository grants/ directory -
      // its grants are revoked, as they always have been.
      const validEntries = new Map<string, GrantFileEntry[]>();
      const unavailable = new Set<string>();
      let externalDirUnavailable = false;

      const grantFileResults = await readGrantFiles(
        this.#grantsDir,
        this.#validateCondition,
      );
      for (const [filename, result] of grantFileResults) {
        if (result.errors.length > 0) {
          this.#logUnavailable(filename, result.errors);
          unavailable.add(filename);
          continue;
        }
        validEntries.set(filename, result.entries);
      }

      if (this.#externalGrantsFile) {
        const load = await readGrantsFileSource(this.#externalGrantsFile, {
          validateCondition: this.#validateCondition,
        });
        if (load.status !== "loaded") {
          this.#logUnavailable(load.path, [{
            filename: load.path,
            message: `Failed to read: ${load.cause}`,
          }]);
          unavailable.add(GRANTS_FILE_SOURCE_NAME);
        } else if (load.file.result !== null) {
          if (load.file.result.errors.length > 0) {
            this.#logUnavailable(load.path, load.file.result.errors);
            unavailable.add(GRANTS_FILE_SOURCE_NAME);
          } else {
            validEntries.set(GRANTS_FILE_SOURCE_NAME, load.file.result.entries);
          }
        }
      }

      if (this.#externalGrantsDir) {
        const load = await readGrantsDirSource(this.#externalGrantsDir, {
          validateCondition: this.#validateCondition,
        });
        if (load.status === "missing" || load.status === "unreadable") {
          // Startup refuses a missing or unreadable --grants-dir; an
          // unmounted volume must not revoke its grants.
          logger
            .error`Failed to read grants directory ${load.path} during auto-reload, keeping the stored grants of its files unchanged: ${load.cause}`;
          externalDirUnavailable = true;
        } else if (load.status === "loaded") {
          for (const file of load.files) {
            if (file.readError !== undefined) {
              // Deleted since the directory was listed: revoke, as a delete.
              if (file.readError instanceof Deno.errors.NotFound) continue;
              this.#logUnavailable(file.path, [{
                filename: file.path,
                message: `Failed to read: ${file.readError}`,
              }]);
              unavailable.add(file.sourceName);
              continue;
            }
            if (file.result === null) continue;
            if (file.result.errors.length > 0) {
              this.#logUnavailable(file.path, file.result.errors);
              unavailable.add(file.sourceName);
              continue;
            }
            validEntries.set(file.sourceName, file.result.entries);
          }
        }
      }

      const isSourceUnavailable = (filename: string) =>
        unavailable.has(filename) ||
        (externalDirUnavailable && isGrantsDirSourceName(filename));

      await this.#commitReconcile(async () => {
        const reconcileResult = await reconcileAllFileGrants(
          validEntries,
          this.#fileGrantStore,
          { isSourceUnavailable },
        );

        if (
          reconcileResult.totalCreated > 0 ||
          reconcileResult.totalRevoked > 0 ||
          reconcileResult.totalReactivated > 0
        ) {
          logger
            .info`Grants auto-reload reconciled (${reconcileResult.filesProcessed} file(s)): ${reconcileResult.totalCreated} created, ${reconcileResult.totalRevoked} revoked, ${reconcileResult.totalReactivated} reactivated, ${reconcileResult.totalUnchanged} unchanged`;
        }

        await this.#policySnapshotLoader.load();
      });
      this.#contentHash = newHash;
    } catch (error) {
      logger.error`Grants directory poll failed: ${error}`;
    } finally {
      this.#reconciling = false;
    }
  }

  #logUnavailable(source: string, errors: GrantFileError[]): void {
    for (const error of errors) {
      const loc = error.entryIndex !== undefined
        ? `${error.filename} entry ${error.entryIndex + 1}`
        : error.filename;
      logger
        .error`Grant file error during auto-reload: ${loc}: ${error.message}`;
    }
    logger
      .error`Keeping the stored grants from ${source} unchanged until it loads without errors`;
  }

  async #computeContentHash(): Promise<string> {
    const parts: string[] = [];

    try {
      const dirEntries: Deno.DirEntry[] = [];
      for await (const entry of Deno.readDir(this.#grantsDir)) {
        dirEntries.push(entry);
      }

      const files = dirEntries
        .filter((e) =>
          (e.isFile || e.isSymlink) &&
          (e.name.endsWith(".yaml") || e.name.endsWith(".yml")) &&
          !e.name.startsWith(".")
        )
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const file of files) {
        const path = join(this.#grantsDir, file.name);
        try {
          const content = await Deno.readTextFile(path);
          parts.push(`${file.name}:${content}`);
        } catch {
          parts.push(`${file.name}:ERROR`);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    if (this.#externalGrantsFile) {
      try {
        const content = await Deno.readTextFile(this.#externalGrantsFile);
        parts.push(`EXTERNAL:${content}`);
      } catch {
        parts.push("EXTERNAL:ERROR");
      }
    }

    if (this.#externalGrantsDir) {
      try {
        const dirEntries: Deno.DirEntry[] = [];
        for await (const entry of Deno.readDir(this.#externalGrantsDir)) {
          dirEntries.push(entry);
        }
        const files = dirEntries
          .filter((e) =>
            (e.isFile || e.isSymlink) &&
            (e.name.endsWith(".yaml") || e.name.endsWith(".yml")) &&
            !e.name.startsWith(".")
          )
          .sort((a, b) => a.name.localeCompare(b.name));

        for (const file of files) {
          const path = join(this.#externalGrantsDir, file.name);
          try {
            const content = await Deno.readTextFile(path);
            parts.push(`EXTDIR:${file.name}:${content}`);
          } catch {
            parts.push(`EXTDIR:${file.name}:ERROR`);
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
        // A missing --grants-dir keeps its grants while an empty one revokes
        // them, so the two must hash differently: a volume that unmounts and
        // comes back empty has to trigger a reconcile.
        parts.push("EXTDIR:MISSING");
      }
    }

    const data = new TextEncoder().encode(parts.join("\n"));
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray).map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
