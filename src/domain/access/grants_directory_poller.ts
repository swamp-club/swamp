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
import { join } from "@std/path";
import {
  type ConditionValidator,
  type GrantFileEntry,
  parseGrantFile,
  readGrantFiles,
} from "./grant_file.ts";
import {
  type FileGrantStore,
  reconcileAllFileGrants,
} from "./grant_file_reconciler.ts";
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
}

export class GrantsDirectoryPoller {
  readonly #grantsDir: string;
  readonly #externalGrantsFile: string | undefined;
  readonly #externalGrantsDir: string | undefined;
  readonly #validateCondition: ConditionValidator | undefined;
  readonly #fileGrantStore: FileGrantStore;
  readonly #policySnapshotLoader: PolicySnapshotLoader;
  readonly #pollIntervalMs: number;
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
      this.#checkAndReconcile()
    );
  }

  async #checkAndReconcile(): Promise<void> {
    this.#reconciling = true;
    try {
      const newHash = await this.#computeContentHash();
      if (newHash === this.#contentHash) return;

      logger.info`Grants directory change detected, reconciling`;

      const grantFileResults = await readGrantFiles(
        this.#grantsDir,
        this.#validateCondition,
      );

      const validEntries = new Map<string, GrantFileEntry[]>();
      for (const [filename, result] of grantFileResults) {
        if (result.errors.length > 0) {
          for (const error of result.errors) {
            const loc = error.entryIndex !== undefined
              ? `${error.filename} entry ${error.entryIndex + 1}`
              : error.filename;
            logger
              .warn`Grant file error during auto-reload: ${loc}: ${error.message}`;
          }
        }
        validEntries.set(filename, result.entries);
      }

      if (this.#externalGrantsFile) {
        try {
          const content = await Deno.readTextFile(this.#externalGrantsFile);
          if (content.trim().length > 0) {
            const externalResult = parseGrantFile(
              this.#externalGrantsFile,
              content,
              this.#validateCondition,
            );
            if (externalResult.errors.length > 0) {
              for (const error of externalResult.errors) {
                logger
                  .warn`External grants file error during auto-reload: ${error.message}`;
              }
            }
            validEntries.set(this.#externalGrantsFile, externalResult.entries);
          }
        } catch (error) {
          logger
            .warn`Failed to read external grants file during auto-reload: ${error}`;
        }
      }

      if (this.#externalGrantsDir) {
        try {
          const dirEntries: Deno.DirEntry[] = [];
          for await (const entry of Deno.readDir(this.#externalGrantsDir)) {
            dirEntries.push(entry);
          }
          const yamlFiles = dirEntries
            .filter((e) =>
              (e.isFile || e.isSymlink) &&
              (e.name.endsWith(".yaml") || e.name.endsWith(".yml")) &&
              !e.name.startsWith(".")
            )
            .sort((a, b) => a.name.localeCompare(b.name));

          for (const file of yamlFiles) {
            const filePath = join(this.#externalGrantsDir, file.name);
            try {
              const content = await Deno.readTextFile(filePath);
              if (content.trim().length === 0) continue;
              const result = parseGrantFile(
                filePath,
                content,
                this.#validateCondition,
              );
              if (result.errors.length > 0) {
                for (const error of result.errors) {
                  const loc = error.entryIndex !== undefined
                    ? `${error.filename} entry ${error.entryIndex + 1}`
                    : error.filename;
                  logger
                    .warn`External grants dir file error during auto-reload: ${loc}: ${error.message}`;
                }
              }
              validEntries.set(filePath, result.entries);
            } catch (error) {
              logger
                .warn`Failed to read external grants dir file ${filePath} during auto-reload: ${error}`;
            }
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            logger
              .warn`Failed to read external grants directory during auto-reload: ${error}`;
          }
        }
      }

      const reconcileResult = await reconcileAllFileGrants(
        validEntries,
        this.#fileGrantStore,
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
      this.#contentHash = newHash;
    } catch (error) {
      logger.error`Grants directory poll failed: ${error}`;
    } finally {
      this.#reconciling = false;
    }
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
      }
    }

    const data = new TextEncoder().encode(parts.join("\n"));
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray).map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
