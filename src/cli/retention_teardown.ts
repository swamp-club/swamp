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
import { dirname } from "@std/path";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { RetentionPolicy } from "../domain/retention/retention_policy.ts";
import { RepoMarkerRepository } from "../infrastructure/persistence/repo_marker_repository.ts";
import { hourStartOf } from "../infrastructure/persistence/control_plane_retention_watermark_repository.ts";
import { atomicWriteTextFile } from "../infrastructure/persistence/atomic_write.ts";
import { swampPath } from "../infrastructure/persistence/paths.ts";
import {
  compactRetentionQuietly,
  confirmV3CommandReplicated,
  v3DatastoreConfigOf,
  v3DatastoreFor,
} from "../infrastructure/datastore_v3/v3_repo_context.ts";
import { runRepoRetention } from "../libswamp/retention/run.ts";
import type { RetentionPassResult } from "../libswamp/retention/pass.ts";
import { runInCoordinatorRoot } from "./coordinator_root.ts";
import { flushDatastoreSync } from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { takeRetentionCandidate } from "./retention_candidate.ts";
import {
  requireInitializedRepo,
  resolveDatastoreForRepo,
} from "./repo_context.ts";
import { autoDefinitionRetentionSourcesOf } from "../libswamp/retention/auto_definitions.ts";

const logger = getLogger(["swamp", "cli", "retention"]);

export const CLI_RETENTION_MIN_INTERVAL_MS = 60 * 60 * 1000;
/** A CLI pass stops starting batches after this long; the next continues. */
export const CLI_RETENTION_BUDGET_MS = 10_000;
/**
 * How long the pass's v3 history compaction and chunk sweep may each run;
 * an aborted one resumes on the next pass.
 */
export const CLI_RETENTION_COMPACTION_TIMEOUT_MS = 10_000;
export const CLI_RETENTION_LOCK_WAIT_MS = 2_000;

const LAST_ATTEMPT_FILE = "retention-last-attempt.json";

/**
 * a repo-local timestamp claims the hourly pass, so a command reads no remote
 * state at all within the hour
 */
async function takeLocalGate(repoDir: string, now: Date): Promise<boolean> {
  const path = swampPath(repoDir, LAST_ATTEMPT_FILE);
  try {
    const raw = JSON.parse(await Deno.readTextFile(path)) as {
      attemptedAt?: unknown;
    };
    const at = typeof raw.attemptedAt === "string"
      ? Date.parse(raw.attemptedAt)
      : NaN;
    if (
      !Number.isNaN(at) && at <= now.getTime() &&
      now.getTime() - at < CLI_RETENTION_MIN_INTERVAL_MS
    ) {
      return false;
    }
  } catch (error) {
    if (
      !(error instanceof Deno.errors.NotFound) &&
      !(error instanceof SyntaxError)
    ) {
      throw error;
    }
  }
  await Deno.mkdir(dirname(path), { recursive: true });
  await atomicWriteTextFile(
    path,
    JSON.stringify({ attemptedAt: now.toISOString() }) + "\n",
  );
  return true;
}

/**
 * runs after the command's own locks are released, at most once per hour per
 * checkout and datastore, and never throws: retention must not fail the command
 * that triggered it
 */
export async function runRetentionAtCommandEnd(
  options: { now?: () => Date } = {},
): Promise<RetentionPassResult | undefined> {
  const repoDir = takeRetentionCandidate();
  if (!repoDir) return undefined;
  const now = options.now?.() ?? new Date();
  try {
    const marker = await new RepoMarkerRepository().read(
      RepoPath.create(repoDir),
    );
    const policy = RetentionPolicy.fromConfig(marker?.garbageCollection);
    if (!policy.automatic || !policy.hasAnyRetention) return undefined;
    if (!(await takeLocalGate(repoDir, now))) return undefined;

    // the command's own v3 commits are confirmed first so a sync failing for
    // the pass's commits never fails the command; commits not confirmed now are
    // the command's own and the closing sync reports them, so the pass waits
    try {
      await confirmV3CommandReplicated();
    } catch (error) {
      logger
        .debug`Skipped the retention pass: this command's v3 commits are not confirmed replicated: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return undefined;
    }

    const { datastoreConfig, engine, serveUpstream } =
      await resolveDatastoreForRepo(repoDir);
    // a datastore written through serve is kept by serve: its retention pass
    // runs there, and this checkout holds only a copy
    if (serveUpstream !== undefined) {
      takeRetentionCandidate();
      return undefined;
    }
    const repo = await requireInitializedRepo({
      repoDir,
      outputMode: "log",
      lockWaitMs: CLI_RETENTION_LOCK_WAIT_MS,
    });
    // Opening the repository above noted it again; this pass is the last.
    takeRetentionCandidate();
    return await runInCoordinatorRoot(repo.repoContext, async () => {
      const watermarks = repo.repoContext.retentionWatermarks;
      if (
        watermarks &&
        !(await watermarks.claimHourlyPass(
          hourStartOf(now),
          `cli:${Deno.hostname()}:${Deno.pid}`,
          "cli",
        ))
      ) {
        return undefined;
      }
      const v3 = engine === "v3"
        ? v3DatastoreFor(
          repo.repoDir,
          await v3DatastoreConfigOf(repo.repoDir, datastoreConfig),
        )
        : undefined;
      return await runRepoRetention(
        {
          repoDir: repo.repoDir,
          datastoreResolver: repo.datastoreResolver,
          markDirty: repo.repoContext.markDirty,
          signalWaits: repo.repoContext.signalWaits,
          continuationClaims: repo.repoContext.continuationClaims?.store,
          dataRepos: {
            catalogStore: repo.repoContext.catalogStore,
            unifiedDataRepo: repo.repoContext.unifiedDataRepo,
            workflowRunRepo: repo.repoContext.workflowRunRepo,
          },
          watermarks,
          // the datastore lock held for the pass keeps runs from taking
          // a model lock, so no per-model lock is tried
          autoDefinitions: autoDefinitionRetentionSourcesOf(repo.repoContext),
          // The command holds the lock for the whole pass; its root unit
          // of work pushes once at the end.
          runBatch: (fn) => fn(),
          afterPass: async () => {
            repo.repoContext.catalogStore.checkpoint();
            if (v3) {
              await compactRetentionQuietly(
                v3,
                new Date(),
                CLI_RETENTION_COMPACTION_TIMEOUT_MS,
              );
            }
          },
        },
        { policy, budgetMs: CLI_RETENTION_BUDGET_MS, quiet: true },
      );
    });
  } catch (error) {
    logger.debug`Skipped the retention pass: ${
      error instanceof Error ? error.message : String(error)
    }`;
    // A failure after the lock was taken (a per-model drain timing out,
    // say) leaves it registered; teardown's own flush has already run, so
    // release it here rather than leave it to its TTL.
    try {
      await flushDatastoreSync();
    } catch (flushError) {
      logger.debug`Releasing the retention pass's datastore lock failed: ${
        flushError instanceof Error ? flushError.message : String(flushError)
      }`;
    }
    return undefined;
  }
}
