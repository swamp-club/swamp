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
  type GrantUsernameResolver,
  type ParsedGrantSource,
  resolveGrantFileUsernames,
  unresolvableUsernames,
} from "./grant_username_resolution.ts";
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
   * Resolves `username:` subjects (swamp-club#3123). Without one, a file
   * that names a username is held back.
   */
  usernameResolver?: GrantUsernameResolver;
  /** Called with the subs each reload resolved, mapped to their usernames. */
  onUsernamesResolved?: (usernamesBySub: Record<string, string>) => void;
  /**
   * Runs each reconcile (store writes and snapshot reload) as one unit.
   * Serve passes a wrapper that holds the sync gate and pushes the writes
   * to the datastore; without one the unit runs as is.
   */
  commitReconcile?: (
    reconcile: () => Promise<void>,
  ) => Promise<void | "deferred">;
}

/** a source a reconcile left as stored, with the first reason it gave */
export interface HeldGrantSource {
  readonly source: string;
  readonly reason: string;
}

export interface GrantsReconcileOutcome {
  /** deferred: a node without the lease wrote nothing */
  readonly status: "reconciled" | "unchanged" | "deferred" | "failed";
  readonly held: readonly HeldGrantSource[];
  readonly error?: string;
}

export class GrantsDirectoryPoller {
  readonly #grantsDir: string;
  #externalGrantsFile: string | undefined;
  #externalGrantsDir: string | undefined;
  readonly #validateCondition: ConditionValidator | undefined;
  readonly #fileGrantStore: FileGrantStore;
  readonly #policySnapshotLoader: PolicySnapshotLoader;
  readonly #pollIntervalMs: number;
  readonly #usernameResolver: GrantUsernameResolver;
  readonly #onUsernamesResolved:
    | ((usernamesBySub: Record<string, string>) => void)
    | undefined;
  readonly #commitReconcile: (
    reconcile: () => Promise<void>,
  ) => Promise<void | "deferred">;
  #timer: ReturnType<typeof setInterval> | null = null;
  #contentHash: string = "";
  #pendingReconcile: Promise<void> = Promise.resolve();
  #reconciling = false;
  /** External sources that read as empty on the last poll. */
  #sourcesSeenEmpty = new Set<string>();
  /** Stays set after stop, so a poll in flight at shutdown still holds; pause clears it. */
  #started = false;
  /** set by close, which shutdown calls; start then does nothing */
  #closed = false;

  constructor(options: GrantsDirectoryPollerOptions) {
    this.#grantsDir = options.grantsDir;
    this.#externalGrantsFile = options.externalGrantsFile;
    this.#externalGrantsDir = options.externalGrantsDir;
    this.#validateCondition = options.validateCondition;
    this.#fileGrantStore = options.fileGrantStore;
    this.#policySnapshotLoader = options.policySnapshotLoader;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#usernameResolver = options.usernameResolver ??
      unresolvableUsernames("username subjects are not resolved here");
    this.#onUsernamesResolved = options.onUsernamesResolved;
    this.#commitReconcile = options.commitReconcile ??
      ((reconcile) => reconcile());
  }

  async start(): Promise<void> {
    if (this.#timer || this.#closed) return;
    this.#started = true;
    this.#contentHash = await this.#computeContentHash();
    this.#timer = setInterval(() => {
      this.#poll();
    }, this.#pollIntervalMs);
    const intervalSec = this.#pollIntervalMs / 1000;
    logger
      .info`Grants directory poller started (interval: ${intervalSec}s)`;
  }

  /**
   * Reconciles the grant sources as they are now, whatever the last poll
   * saw: what serve's node runs when it takes the lead in team mode
   * (swamp-club#4096), since a follower's polls applied nothing. Waits for a
   * poll in flight first.
   */
  reconcileNow(): Promise<GrantsReconcileOutcome> {
    const run = this.#pendingReconcile.then(() => {
      this.#contentHash = "";
      return withPollCycleSpan(
        "grants_directory",
        () => this.#checkAndReconcile(),
      );
    });
    this.#pendingReconcile = run.then(() => {});
    return run;
  }

  /**
   * points the poller at other external sources; the next reconcile reads
   * them, and a source no longer named has its grants revoked
   */
  setSources(sources: {
    readonly externalGrantsFile?: string;
    readonly externalGrantsDir?: string;
  }): Promise<void> {
    this.#pendingReconcile = this.#pendingReconcile.then(() => {
      this.#externalGrantsFile = sources.externalGrantsFile;
      this.#externalGrantsDir = sources.externalGrantsDir;
      this.#contentHash = "";
      this.#sourcesSeenEmpty = new Set();
    });
    return this.#pendingReconcile;
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#pendingReconcile;
  }

  /**
   * stops polling for a switch to manual reload: with no next poll, the
   * next reconcileNow applies an emptied source at once, as one never started does
   */
  async pause(): Promise<void> {
    await this.stop();
    if (!this.#timer) {
      this.#started = false;
      this.#sourcesSeenEmpty = new Set();
    }
  }

  /** stops for good: a reload racing shutdown cannot start it again */
  async close(): Promise<void> {
    this.#closed = true;
    await this.stop();
  }

  #poll(): void {
    if (this.#reconciling) return;

    this.#pendingReconcile = this.#pendingReconcile.then(async () => {
      await withPollCycleSpan(
        "grants_directory",
        () => this.#checkAndReconcile(),
      );
    });
  }

  async #checkAndReconcile(): Promise<GrantsReconcileOutcome> {
    this.#reconciling = true;
    const held = new Map<string, string>();
    const hold = (source: string, reason: string) => {
      if (!held.has(source)) held.set(source, reason);
    };
    const heldList = () =>
      [...held].map(([source, reason]) => ({ source, reason }));
    try {
      const newHash = await this.#computeContentHash();
      if (newHash === this.#contentHash) {
        return { status: "unchanged", held: [] };
      }

      logger.info`Grants directory change detected, reconciling`;

      // Auto-reload does what a restart would do with the same files. Where
      // startup refuses to start - a file that fails to read or validate, a
      // missing --grants-file or --grants-dir - the source keeps its stored
      // grants: reconciling it as empty would revoke them, and a broken deny
      // file would fail open (swamp-club#2823). Where startup accepts the
      // input - a deleted file, no repository grants/ directory - its grants
      // are revoked, and so are those of an emptied external file once a
      // second poll confirms it is empty.
      const parsed = new Map<string, ParsedGrantSource>();
      const unavailable = new Set<string>();
      let externalDirUnavailable = false;
      const emptySources = new Set<string>();

      const grantFileResults = await readGrantFiles(
        this.#grantsDir,
        this.#validateCondition,
      );
      for (const [filename, result] of grantFileResults) {
        if (result.errors.length > 0) {
          this.#logUnavailable(filename, result.errors);
          hold(filename, result.errors[0].message);
          unavailable.add(filename);
          continue;
        }
        parsed.set(filename, { filename, entries: result.entries });
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
          hold(GRANTS_FILE_SOURCE_NAME, `failed to read: ${load.cause}`);
          unavailable.add(GRANTS_FILE_SOURCE_NAME);
        } else if (load.file.result !== null) {
          if (load.file.result.errors.length > 0) {
            this.#logUnavailable(load.path, load.file.result.errors);
            hold(GRANTS_FILE_SOURCE_NAME, load.file.result.errors[0].message);
            unavailable.add(GRANTS_FILE_SOURCE_NAME);
          } else {
            parsed.set(GRANTS_FILE_SOURCE_NAME, {
              filename: load.path,
              entries: load.file.result.entries,
            });
          }
        } else {
          emptySources.add(GRANTS_FILE_SOURCE_NAME);
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
          hold(load.path, `failed to read: ${load.cause}`);
        } else if (load.status === "loaded") {
          for (const file of load.files) {
            if (file.readError !== undefined) {
              // Deleted since the directory was listed: revoke, as a delete.
              if (file.readError instanceof Deno.errors.NotFound) continue;
              this.#logUnavailable(file.path, [{
                filename: file.path,
                message: `Failed to read: ${file.readError}`,
              }]);
              hold(file.sourceName, `failed to read: ${file.readError}`);
              unavailable.add(file.sourceName);
              continue;
            }
            if (file.result === null) {
              emptySources.add(file.sourceName);
              continue;
            }
            if (file.result.errors.length > 0) {
              this.#logUnavailable(file.path, file.result.errors);
              hold(file.sourceName, file.result.errors[0].message);
              unavailable.add(file.sourceName);
              continue;
            }
            parsed.set(file.sourceName, {
              filename: file.path,
              entries: file.result.entries,
            });
          }
        }
      }

      // A file being rewritten in place reads as empty between its truncate and
      // its write, so one empty read is not enough to revoke its grants, which
      // would fail open for a deny (swamp-club#4272). The next poll revokes
      // them if it is still empty. A poller never started, in manual reload
      // mode, has no next poll, so its reconcileNow applies what it reads.
      const heldEmpty = !this.#started
        ? []
        : [...emptySources].filter((s) => !this.#sourcesSeenEmpty.has(s));
      this.#sourcesSeenEmpty = emptySources;
      // This poll applies every other source, so the old hash stops describing
      // the store. Files that return to those bytes must still reconcile.
      if (heldEmpty.length > 0) this.#contentHash = "";
      for (const source of heldEmpty) {
        logger
          .warn`Grant source ${source} reads as empty, keeping its stored grants until the next poll confirms it`;
        hold(
          source,
          "reads as empty; its stored grants stay until the next poll confirms it",
        );
        unavailable.add(source);
      }

      // Resolved after every source is read, so a pin is forgotten only when
      // no source is held back for a read or parse error.
      const resolution = await resolveGrantFileUsernames(
        parsed,
        this.#usernameResolver,
        { complete: unavailable.size === 0 && !externalDirUnavailable },
      );
      const validEntries = new Map<string, GrantFileEntry[]>();
      for (const [source, resolved] of resolution.sources) {
        if (resolved.errors.length > 0) {
          this.#logUnavailable(parsed.get(source)!.filename, resolved.errors);
          hold(source, resolved.errors[0].message);
          unavailable.add(source);
          continue;
        }
        validEntries.set(source, resolved.entries);
      }
      this.#onUsernamesResolved?.(resolution.usernamesBySub);

      const isSourceUnavailable = (filename: string) =>
        unavailable.has(filename) ||
        (externalDirUnavailable && isGrantsDirSourceName(filename));

      const committed = await this.#commitReconcile(async () => {
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
      // Deferred (a serve follower, which writes nothing): the change is not
      // applied, so the next poll tries it again.
      if (committed === "deferred") return { status: "deferred", held: [] };
      // A held source is not applied, so the next poll must look at it again.
      if (heldEmpty.length === 0) this.#contentHash = newHash;
      return { status: "reconciled", held: heldList() };
    } catch (error) {
      logger.error`Grants directory poll failed: ${error}`;
      return {
        status: "failed",
        held: heldList(),
        error: error instanceof Error ? error.message : String(error),
      };
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
