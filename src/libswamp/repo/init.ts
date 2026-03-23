// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  type AiTool,
  type RepoInitResult,
  RepoService,
  type RepoUpgradeResult,
} from "../../domain/repo/repo_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the repo init output.
 */
export interface RepoInitData {
  path: string;
  version: string;
  initializedAt: string;
  skillsCopied: string[];
  instructionsFileCreated: boolean;
  settingsCreated: boolean;
  gitignoreAction: string;
  tool: string;
}

export type RepoInitEvent =
  | { kind: "initializing" }
  | { kind: "completed"; data: RepoInitData }
  | { kind: "error"; error: SwampError };

/** Input for the repo init operation. */
export interface RepoInitInput {
  path: string;
  force: boolean;
  tool: string;
  version: string;
}

/** Dependencies for the repo init operation. */
export interface RepoInitDeps {
  init: (
    repoPath: RepoPath,
    options: { force?: boolean; tool?: AiTool },
  ) => Promise<RepoInitResult>;
}

/** Wires real infrastructure into RepoInitDeps. */
export function createRepoInitDeps(version: string): RepoInitDeps {
  const service = new RepoService(version);
  return {
    init: (repoPath, options) => service.init(repoPath, options),
  };
}

/** Initializes a new swamp repository. */
export async function* repoInit(
  ctx: LibSwampContext,
  deps: RepoInitDeps,
  input: RepoInitInput,
): AsyncIterable<RepoInitEvent> {
  yield* withGeneratorSpan(
    "swamp.repo.create",
    {},
    (async function* () {
      yield { kind: "initializing" };

      ctx.logger.debug`Initializing repository at: ${input.path}`;

      const repoPath = RepoPath.create(input.path);

      let result: RepoInitResult;
      try {
        result = await deps.init(repoPath, {
          force: input.force,
          tool: input.tool as AiTool,
        });
      } catch (error) {
        yield {
          kind: "error",
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }

      ctx.logger.debug`Repository initialized: ${result.path}`;

      const data: RepoInitData = {
        path: result.path,
        version: result.version,
        initializedAt: result.initializedAt,
        skillsCopied: result.skillsCopied,
        instructionsFileCreated: result.instructionsFileCreated,
        settingsCreated: result.settingsCreated,
        gitignoreAction: result.gitignoreAction,
        tool: result.tool,
      };

      yield { kind: "completed", data };
    })(),
  );
}

// --- Repo Upgrade ---

/**
 * Data structure for the repo upgrade output.
 */
export interface RepoUpgradeData {
  path: string;
  previousVersion: string;
  newVersion: string;
  upgradedAt: string;
  skillsUpdated: string[];
  instructionsUpdated: boolean;
  settingsUpdated: boolean;
  gitignoreAction: string;
  tool: string;
}

export type RepoUpgradeEvent =
  | { kind: "upgrading" }
  | { kind: "completed"; data: RepoUpgradeData }
  | { kind: "error"; error: SwampError };

/** Input for the repo upgrade operation. */
export interface RepoUpgradeInput {
  path: string;
  tool?: string;
  includeGitignore?: boolean;
  version: string;
}

/** Dependencies for the repo upgrade operation. */
export interface RepoUpgradeDeps {
  upgrade: (
    repoPath: RepoPath,
    options: { tool?: AiTool; includeGitignore?: boolean },
  ) => Promise<RepoUpgradeResult>;
}

/** Wires real infrastructure into RepoUpgradeDeps. */
export function createRepoUpgradeDeps(version: string): RepoUpgradeDeps {
  const service = new RepoService(version);
  return {
    upgrade: (repoPath, options) => service.upgrade(repoPath, options),
  };
}

/** Upgrades an existing swamp repository. */
export async function* repoUpgrade(
  ctx: LibSwampContext,
  deps: RepoUpgradeDeps,
  input: RepoUpgradeInput,
): AsyncIterable<RepoUpgradeEvent> {
  yield* withGeneratorSpan(
    "swamp.repo.upgrade",
    {},
    (async function* () {
      yield { kind: "upgrading" };

      ctx.logger.debug`Upgrading repository at: ${input.path}`;

      const repoPath = RepoPath.create(input.path);

      let result: RepoUpgradeResult;
      try {
        result = await deps.upgrade(repoPath, {
          tool: input.tool as AiTool | undefined,
          includeGitignore: input.includeGitignore,
        });
      } catch (error) {
        yield {
          kind: "error",
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }

      ctx.logger.debug`Repository upgraded: ${result.path}`;

      const data: RepoUpgradeData = {
        path: result.path,
        previousVersion: result.previousVersion,
        newVersion: result.newVersion,
        upgradedAt: result.upgradedAt,
        skillsUpdated: result.skillsUpdated,
        instructionsUpdated: result.instructionsUpdated,
        settingsUpdated: result.settingsUpdated,
        gitignoreAction: result.gitignoreAction,
        tool: result.tool,
      };

      yield { kind: "completed", data };
    })(),
  );
}
