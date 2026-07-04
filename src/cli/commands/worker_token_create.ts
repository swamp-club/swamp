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

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  acquireModelLocks,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import type { MaxEnrollments } from "../../domain/models/worker/enrollment_token_model.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import {
  consumeStream,
  createLibSwampContext,
  createWorkerTokenCreateDeps,
  parseDuration,
  withDefaults,
  workerTokenCreate,
  type WorkerTokenCreateData,
  type WorkerTokenCreateEvent,
} from "../../libswamp/mod.ts";
import { renderWorkerTokenCreate } from "../../presentation/output/worker_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workerTokenCreateCommand = new Command()
  .name("create")
  .description(
    "Mint a named worker enrollment token; the plaintext is shown once",
  )
  .example(
    "Mint a 24-hour token",
    "swamp worker token create ci-runner-3 --duration 24h",
  )
  .example(
    "Choose the vault that stores the plaintext",
    "swamp worker token create ci-runner-3 --duration 7d --vault prod-vault",
  )
  .arguments("<name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--duration <duration:string>",
    "Token lifetime (e.g. 30m, 1h, 24h, 7d) — a hard deadline: the enrolled worker is disconnected when it elapses",
    { required: true },
  )
  .option(
    "--vault <vault:string>",
    "Vault that stores the token plaintext (defaults to the sole configured vault)",
  )
  .option(
    "--max-enrollments <n:string>",
    'Maximum machines this token can enroll (positive integer or "unlimited"). Default: 1',
  )
  .action(async function (options: AnyOptions, name: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "worker",
      "token",
      "create",
    ]);

    const durationMs = parseDuration(options.duration as string);
    if (durationMs <= 0) {
      throw new UserError(
        `Invalid --duration value "${options.duration}": must be positive`,
      );
    }

    let maxEnrollments: MaxEnrollments = 1;
    if (options.maxEnrollments !== undefined) {
      const raw = options.maxEnrollments as string;
      if (raw === "unlimited") {
        maxEnrollments = "unlimited";
      } else {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new UserError(
            `Invalid --max-enrollments value "${raw}": must be a positive integer or "unlimited"`,
          );
        }
        maxEnrollments = parsed;
      }
    }

    const { repoDir, repoContext, datastoreConfig, syncService } =
      await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

    cliCtx.logger.debug`Minting enrollment token ${name}`;

    const libCtx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createWorkerTokenCreateDeps(
      libCtx,
      repoDir,
      repoContext,
    );

    // Per-model lock: only relevant when a definition with this name already
    // exists (a re-mint attempt) — mirrors `swamp model method run`.
    const preResult = await findDefinitionByIdOrName(
      repoContext.definitionRepo,
      name,
    );
    let flushModelLocks: (() => Promise<void>) | null = null;
    if (preResult) {
      const lockResult = await acquireModelLocks(
        datastoreConfig,
        [
          {
            modelType: preResult.type.normalized,
            modelId: preResult.definition.id,
          },
        ],
        repoDir,
        syncService,
        repoContext.catalogStore,
      );
      if (lockResult.synced) repoContext.catalogStore.invalidate();
      flushModelLocks = lockResult.flush;
    }

    try {
      let data: WorkerTokenCreateData | undefined;
      await consumeStream(
        workerTokenCreate(libCtx, deps, {
          name,
          durationMs,
          vaultName: options.vault as string | undefined,
          maxEnrollments,
        }),
        withDefaults<WorkerTokenCreateEvent>({
          completed: (event) => {
            data = event.data;
          },
          error: (event) => {
            throw new UserError(event.error.message);
          },
        }),
      );
      if (data === undefined) {
        throw new UserError(
          `Minting token '${name}' ended without completing`,
        );
      }
      renderWorkerTokenCreate(data, cliCtx.outputMode);
    } finally {
      if (flushModelLocks) {
        try {
          await flushModelLocks();
        } catch (releaseError) {
          cliCtx.logger.warn(
            "Failed to release locks during cleanup: {error}",
            {
              error: releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
            },
          );
        }
      }
    }

    cliCtx.logger.debug("Worker token create command completed");
  });
