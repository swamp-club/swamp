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

import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  type RepoInitResult,
  RepoService,
  type RepoUpgradeResult,
} from "../../domain/repo/repo_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import {
  extensionInstall,
  type ExtensionInstallDeps,
  type ExtensionInstallEvent,
} from "../extensions/install.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the repo init output.
 *
 * `tools` is the canonical multi-tool field. `tool` is the deprecated
 * single-tool field — always present (never omitted), set to the primary
 * tool when `tools.length === 1`, explicit `null` when `tools.length !== 1`,
 * so SDK consumers cannot silently miss a multi-tool repo.
 *
 * @deprecated `tool` field — read `tools` instead.
 */
export interface RepoInitData {
  path: string;
  version: string;
  initializedAt: string;
  skillsCopied: string[];
  instructionsFileCreated: boolean;
  settingsCreated: boolean;
  gitignoreAction: string;
  tools: string[];
  removedTools: string[];
  /** @deprecated Read `tools` instead. `null` when not single-tool. */
  tool: string | null;
}

export type RepoInitEvent =
  | { kind: "initializing" }
  | { kind: "completed"; data: RepoInitData }
  | { kind: "error"; error: SwampError };

/**
 * Input for the repo init operation.
 *
 * Provide `tools` for multi-tool support; the deprecated `tool` is accepted
 * for backwards compat (single-tool callers) and wraps to `[tool]`. When both
 * are passed, `tools` wins.
 */
export interface RepoInitInput {
  path: string;
  force: boolean;
  tools?: string[];
  /** @deprecated Pass `tools` instead. */
  tool?: string;
  version: string;
}

/** Dependencies for the repo init operation. */
export interface RepoInitDeps {
  init: (
    repoPath: RepoPath,
    options: { force?: boolean; tools?: string[] },
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
          tools: resolveToolsInput(input.tools, input.tool),
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
        tools: result.tools,
        removedTools: result.removedTools,
        tool: legacyToolField(result.tools),
      };

      yield { kind: "completed", data };
    })(),
  );
}

/**
 * Resolves the input tools list, accepting either the new `tools` field or
 * the deprecated `tool` single-value field. `tools` wins when both are
 * supplied. Returns `undefined` when neither is given so the caller can
 * apply its own default (e.g. RepoService.init falls back to `["claude"]`).
 */
function resolveToolsInput(
  tools: string[] | undefined,
  tool: string | undefined,
): string[] | undefined {
  if (tools !== undefined) {
    return tools;
  }
  if (tool !== undefined) {
    return [tool];
  }
  return undefined;
}

/**
 * Maps the canonical `tools` array onto the deprecated single-value `tool`
 * field for SDK backwards compat:
 *
 *  - `tools: []` (the `--tool none` case) → `"none"`, matching the legacy
 *    sentinel value the user passed and preserving the prior contract.
 *  - `tools: [X]` (single tool enrolled) → `X`, the primary tool.
 *  - `tools: [X, Y, ...]` (multi-tool) → `null` so SDK consumers cannot
 *    silently miss the second enrolled tool — they must read `tools`.
 */
function legacyToolField(tools: string[]): string | null {
  if (tools.length === 0) return "none";
  if (tools.length === 1) return tools[0];
  return null;
}

// --- Repo Upgrade ---

/**
 * Data structure for the repo upgrade output.
 *
 * `tools` is the canonical multi-tool field; `addedTools` and `removedTools`
 * describe the diff against the previous marker. `extensionsToReinstall`
 * lists pulled extensions present in the previous primary tool's skills dir
 * that did NOT propagate to a newly-added tool's dir, so the consumer can
 * surface a "re-run `swamp extension pull <name>`" message. `tool` is the
 * deprecated single-value field — always present, `null` when not
 * single-tool.
 *
 * @deprecated `tool` field — read `tools` instead.
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
  /** Enrolled tools as recorded by `marker.tools` BEFORE this upgrade. */
  previousTools: string[];
  tools: string[];
  addedTools: string[];
  removedTools: string[];
  extensionsToReinstall: { tool: string; names: string[] }[];
  /** @deprecated Read `tools` instead. `null` when not single-tool. */
  tool: string | null;
}

/**
 * Events yielded by `repoUpgrade`. The `extensions` variant wraps each
 * event from the extension install sub-stream so the renderer can
 * delegate to the install renderer without a bespoke vocabulary for
 * upgrade's installing/migrating progress.
 */
export type RepoUpgradeEvent =
  | { kind: "upgrading" }
  | { kind: "extensions"; event: ExtensionInstallEvent }
  | { kind: "completed"; data: RepoUpgradeData }
  | { kind: "error"; error: SwampError };

/**
 * Input for the repo upgrade operation.
 *
 * Provide `tools` to set the full enrolled tool list (replace semantics).
 * The deprecated `tool` is accepted for backwards compat (single-tool
 * callers) and wraps to `[tool]`; `tools` wins when both are passed. Pass
 * neither to preserve `marker.tools` and just bump the swamp version.
 */
export interface RepoUpgradeInput {
  path: string;
  tools?: string[];
  /** @deprecated Pass `tools` instead. */
  tool?: string;
  includeGitignore?: boolean;
  version: string;
  /**
   * Dependencies for the extension install pass that runs after the
   * core upgrade. When absent, the install pass is skipped — useful for
   * callers that do not have registry access wired (e.g. some tests).
   * Production callers always supply this; the CLI builds it from the
   * repo marker and registry client.
   */
  extensionInstallDeps?: ExtensionInstallDeps;
}

/** Dependencies for the repo upgrade operation. */
export interface RepoUpgradeDeps {
  upgrade: (
    repoPath: RepoPath,
    options: { tools?: string[]; includeGitignore?: boolean },
  ) => Promise<RepoUpgradeResult>;
}

/** Wires real infrastructure into RepoUpgradeDeps. */
export function createRepoUpgradeDeps(version: string): RepoUpgradeDeps {
  const service = new RepoService(version);
  return {
    upgrade: (repoPath, options) => service.upgrade(repoPath, options),
  };
}

/**
 * Upgrades an existing swamp repository, including migrating any
 * legacy-layout extensions to the current per-extension subtree
 * layout.
 *
 * The upgrade runs in two phases: (1) the domain `upgrade()` call that
 * refreshes the marker, skills, and tool-specific settings; (2) an
 * `extensionInstall` pass that brings the on-disk extension state into
 * alignment with the lockfile. Any entry tracked at a legacy (gen-1 or
 * gen-2) path is re-pulled into the per-extension subtree and the
 * legacy files are swept. On install failure, the legacy files are
 * preserved and the caller gets a clear error with a recovery command.
 */
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
          tools: resolveToolsInput(input.tools, input.tool),
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

      // Run the extension install pass so any legacy-layout entries
      // tracked in the lockfile get re-pulled into the per-extension
      // subtree and their legacy files swept. `extensionInstall` is
      // idempotent: on repos with no legacy layout and no missing
      // files, it's a no-op.
      if (input.extensionInstallDeps) {
        const failures: Array<{ name: string; error: string }> = [];
        try {
          for await (
            const event of extensionInstall(ctx, input.extensionInstallDeps)
          ) {
            yield { kind: "extensions", event };
            if (event.kind === "completed") {
              for (const entry of event.data.entries) {
                if (entry.status === "failed") {
                  failures.push({
                    name: entry.name,
                    error: entry.error ?? "unknown error",
                  });
                }
              }
            }
          }
        } catch (error) {
          // extensionInstall catches per-entry failures internally;
          // anything that reaches us here is an infrastructure error
          // (corrupt lockfile JSON, permission error, filesystem issue).
          // Surface it the same way deps.upgrade() failures are
          // surfaced: a clean error event so the renderer throws a
          // UserError rather than a raw stack trace.
          yield {
            kind: "error",
            error: validationFailed(
              error instanceof Error ? error.message : String(error),
            ),
          };
          return;
        }
        if (failures.length > 0) {
          const list = failures
            .map((f) => `  - ${f.name}: ${f.error}`)
            .join("\n");
          yield {
            kind: "error",
            error: validationFailed(
              `Extension migration failed for ${failures.length} ` +
                `extension(s). Legacy files have been preserved. ` +
                `Re-run 'swamp repo upgrade' once the issue is ` +
                `resolved (usually registry access):\n${list}`,
            ),
          };
          return;
        }
      }

      const data: RepoUpgradeData = {
        path: result.path,
        previousVersion: result.previousVersion,
        newVersion: result.newVersion,
        upgradedAt: result.upgradedAt,
        skillsUpdated: result.skillsUpdated,
        instructionsUpdated: result.instructionsUpdated,
        settingsUpdated: result.settingsUpdated,
        gitignoreAction: result.gitignoreAction,
        previousTools: result.previousTools,
        tools: result.tools,
        addedTools: result.addedTools,
        removedTools: result.removedTools,
        extensionsToReinstall: result.extensionsToReinstall,
        tool: legacyToolField(result.tools),
      };

      yield { kind: "completed", data };
    })(),
  );
}
