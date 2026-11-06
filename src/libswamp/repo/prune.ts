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

import { enrolledTools } from "../../domain/repo/primary_tool.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  type PruneAction,
  type PruneOutcome,
  type PrunePlan,
  type PruneSkip,
  ToolSettingsPruner,
} from "../../domain/repo/tool_settings_pruner.ts";
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import { type SwampError, validationFailed } from "../errors.ts";

export interface RepoPruneItem {
  tool: string;
  path: string;
  action: "edit" | "delete";
  removed: string[];
}

export interface RepoPruneSkip {
  tool: string;
  path: string;
  reason: string;
}

export interface RepoPrunePreview {
  path: string;
  enrolledTools: string[];
  items: RepoPruneItem[];
  skipped: RepoPruneSkip[];
  /** handed back to repoPrune so it applies exactly what was previewed */
  plan: PrunePlan;
}

/** with dryRun, pruned lists what would be removed */
export interface RepoPruneData {
  path: string;
  dryRun: boolean;
  enrolledTools: string[];
  pruned: RepoPruneItem[];
  skipped: RepoPruneSkip[];
}

export type RepoPruneEvent =
  | { kind: "pruning" }
  | { kind: "completed"; data: RepoPruneData }
  | { kind: "error"; error: SwampError };

export interface RepoPruneInput {
  path: string;
  dryRun: boolean;
  preview?: RepoPrunePreview;
}

export interface RepoPruneDeps {
  /** null when the path is not a swamp repository */
  readEnrolledTools: (repoPath: RepoPath) => Promise<string[] | null>;
  find: (repoRoot: string, enrolledTools: string[]) => Promise<PrunePlan>;
  apply: (repoRoot: string, plan: PrunePlan) => Promise<PruneOutcome>;
}

export function createRepoPruneDeps(): RepoPruneDeps {
  const markerRepo = new RepoMarkerRepository();
  return {
    readEnrolledTools: async (repoPath) => {
      const marker = await markerRepo.read(repoPath);
      return marker ? enrolledTools(marker) : null;
    },
    find: (repoRoot, enrolledTools) =>
      new ToolSettingsPruner(repoRoot, atomicWriteTextFile).find(enrolledTools),
    apply: (repoRoot, plan) =>
      new ToolSettingsPruner(repoRoot, atomicWriteTextFile).apply(plan),
  };
}

function toItem(action: PruneAction): RepoPruneItem {
  return {
    tool: action.tool,
    path: action.path,
    action: action.kind,
    removed: action.removed,
  };
}

function toSkip(skip: PruneSkip): RepoPruneSkip {
  return { tool: skip.tool, path: skip.path, reason: skip.reason };
}

function notARepository(path: string): SwampError {
  return validationFailed(
    `Not a swamp repository: ${path}. Run 'swamp repo init' first.`,
  );
}

/** null when the path is not a swamp repository */
export async function repoPrunePreview(
  _ctx: LibSwampContext,
  deps: RepoPruneDeps,
  input: { path: string },
): Promise<RepoPrunePreview | null> {
  const repoPath = RepoPath.create(input.path);
  const enrolledTools = await deps.readEnrolledTools(repoPath);
  if (enrolledTools === null) return null;
  const plan = await deps.find(repoPath.value, enrolledTools);
  return {
    path: repoPath.value,
    enrolledTools,
    items: plan.actions.map(toItem),
    skipped: plan.skipped.map(toSkip),
    plan,
  };
}

export async function* repoPrune(
  ctx: LibSwampContext,
  deps: RepoPruneDeps,
  input: RepoPruneInput,
): AsyncIterable<RepoPruneEvent> {
  yield* withGeneratorSpan(
    "swamp.repo.prune",
    {},
    (async function* () {
      yield { kind: "pruning" };

      let preview: RepoPrunePreview | null;
      try {
        preview = input.preview ??
          await repoPrunePreview(ctx, deps, { path: input.path });
      } catch (error) {
        yield {
          kind: "error",
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }
      if (preview === null) {
        yield { kind: "error", error: notARepository(input.path) };
        return;
      }

      if (input.dryRun) {
        yield {
          kind: "completed",
          data: {
            path: preview.path,
            dryRun: true,
            enrolledTools: preview.enrolledTools,
            pruned: preview.items,
            skipped: preview.skipped,
          },
        };
        return;
      }

      ctx.logger.debug`Pruning ${preview.items.length} tool settings file(s)`;
      let outcome: PruneOutcome;
      try {
        outcome = await deps.apply(preview.path, preview.plan);
      } catch (error) {
        yield {
          kind: "error",
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }

      yield {
        kind: "completed",
        data: {
          path: preview.path,
          dryRun: false,
          enrolledTools: preview.enrolledTools,
          pruned: outcome.applied.map(toItem),
          skipped: outcome.skipped.map(toSkip),
        },
      };
    })(),
  );
}
