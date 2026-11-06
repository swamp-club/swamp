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

import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
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
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { ToolSettingsPruner } from "../../domain/repo/tool_settings_pruner.ts";
import { enrolledTools } from "../../domain/repo/primary_tool.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface PrunableToolSettings {
  tool: string;
  paths: string[];
}

export type FindPrunableSettings = (
  repoRoot: string,
) => Promise<PrunableToolSettings[]>;

async function findPrunableSettings(repoRoot: string) {
  const marker = await new RepoMarkerRepository().read(
    RepoPath.create(repoRoot),
  );
  if (!marker) return [];
  const plan = await new ToolSettingsPruner(repoRoot, atomicWriteTextFile)
    .find(enrolledTools(marker));
  const byTool = new Map<string, string[]>();
  for (const action of plan.actions) {
    byTool.set(action.tool, [...byTool.get(action.tool) ?? [], action.path]);
  }
  return [...byTool].map(([tool, paths]) => ({ tool, paths }));
}

// reporting leftovers must never fail an init or upgrade that succeeded
async function prunableSettingsFor(
  ctx: LibSwampContext,
  find: FindPrunableSettings | undefined,
  repoRoot: string,
): Promise<PrunableToolSettings[]> {
  if (!find) return [];
  try {
    return await find(repoRoot);
  } catch (error) {
    ctx.logger.debug`Could not look for prunable tool settings: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return [];
  }
}

/**
 * tools is the canonical field; tool is deprecated and always present: the
 * primary tool when tools.length === 1, null otherwise, so SDK consumers cannot
 * silently miss a multi-tool repo
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
  prunableSettings: PrunableToolSettings[];
  /**
   * The repository's default vault: `created` is false when a vault named
   * `default` already existed and was kept. `null` when init was told not
   * to set one up.
   */
  vault: { name: string; type: string; created: boolean } | null;
  tool: string | null;
}

export type RepoInitEvent =
  | { kind: "initializing" }
  | { kind: "completed"; data: RepoInitData }
  | { kind: "error"; error: SwampError };

/**
 * the deprecated tool is accepted for single-tool callers and wraps to [tool];
 * when both are passed, tools wins
 */
export interface RepoInitInput {
  path: string;
  force: boolean;
  tools?: string[];
  tool?: string;
  version: string;
  serverAddress?: string;
  /**
   * whether to set up the default vault: a local_encryption vault named
   * default, recorded as defaultVault. Defaults to true so every new repository
   * has one; false skips it
   */
  vault?: boolean;
}

export interface RepoInitDeps {
  init: (
    repoPath: RepoPath,
    options: {
      force?: boolean;
      tools?: string[];
      serverAddress?: string;
      defaultVault?: boolean;
    },
  ) => Promise<RepoInitResult>;
  findPrunableSettings?: FindPrunableSettings;
}

export function createRepoInitDeps(version: string): RepoInitDeps {
  const service = new RepoService(version);
  return {
    init: (repoPath, { defaultVault, ...options }) =>
      service.init(repoPath, {
        ...options,
        // The repo's own vaults/ dir: a new repository has no datastore
        // config tier to put it in.
        defaultVaultStore: defaultVault
          ? new YamlVaultConfigRepository(
            repoPath.value,
            undefined,
            join(repoPath.value, "vaults"),
          )
          : undefined,
      }),
    findPrunableSettings,
  };
}

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
          serverAddress: input.serverAddress,
          defaultVault: input.vault ?? true,
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
        prunableSettings: await prunableSettingsFor(
          ctx,
          deps.findPrunableSettings,
          result.path,
        ),
        vault: result.vault,
        tool: legacyToolField(result.tools),
      };

      yield { kind: "completed", data };
    })(),
  );
}

/**
 * tools wins when both are supplied; undefined when neither is given so the
 * caller applies its own default
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
 * tools [] maps to "none" (the legacy sentinel), one tool to that tool, several
 * to null so SDK consumers cannot silently miss the second tool
 */
function legacyToolField(tools: string[]): string | null {
  if (tools.length === 0) return "none";
  if (tools.length === 1) return tools[0];
  return null;
}

/**
 * addedTools and removedTools are the diff against the previous marker;
 * extensionsToReinstall lists pulled extensions in the previous primary tool's
 * skills dir that did not reach a newly added tool
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
  previousTools: string[];
  tools: string[];
  addedTools: string[];
  removedTools: string[];
  prunableSettings: PrunableToolSettings[];
  extensionsToReinstall: { tool: string; names: string[] }[];
  localSkillCopies: { skillsDir: string; names: string[] }[];
  changedFiles: string[];
  /** collectives referenced in the lockfile that are not trusted */
  untrustedCollectives: string[];
  /**
   * Present only when the untrusted-collectives check did not run because
   * the extension lockfile could not be resolved, so an empty
   * `untrustedCollectives` means "not checked" rather than "none found".
   */
  untrustedCollectivesSkipped?: true;
  /**
   * true when the extension install pass did not run because its dependencies
   * could not be built (e.g. the managed config base is unresolved)
   */
  installSkipped: boolean;
  installSkippedReason?: string;
  tool: string | null;
}

/**
 * the extensions variant wraps the install sub-stream's events so the renderer
 * can delegate to the install renderer
 */
export type RepoUpgradeEvent =
  | { kind: "upgrading" }
  | { kind: "extensions"; event: ExtensionInstallEvent }
  | { kind: "completed"; data: RepoUpgradeData }
  | { kind: "error"; error: SwampError };

/**
 * tools sets the full enrolled list (replace semantics); deprecated tool wraps
 * to [tool], and tools wins when both are passed. Pass neither to keep
 * marker.tools and just bump the version
 */
export interface RepoUpgradeInput {
  path: string;
  tools?: string[];
  tool?: string;
  includeGitignore?: boolean;
  version: string;
  /**
   * dependencies for the extension install pass after the core upgrade; when
   * absent the pass is skipped (callers without registry access, e.g. some
   * tests)
   */
  extensionInstallDeps?: ExtensionInstallDeps;
  /**
   * Set when the caller could not build `extensionInstallDeps` and the
   * install pass is skipped for that reason; reported in the result.
   */
  extensionInstallSkippedReason?: string;
  /**
   * The resolved extension lockfile, for the untrusted-collectives check.
   * `null` when it could not be resolved (the check is skipped).
   */
  lockfilePath?: string | null;
}

export interface RepoUpgradeDeps {
  upgrade: (
    repoPath: RepoPath,
    options: {
      tools?: string[];
      includeGitignore?: boolean;
      lockfilePath?: string | null;
    },
  ) => Promise<RepoUpgradeResult>;
  findPrunableSettings?: FindPrunableSettings;
}

export function createRepoUpgradeDeps(version: string): RepoUpgradeDeps {
  const service = new RepoService(version);
  return {
    upgrade: (repoPath, options) => service.upgrade(repoPath, options),
    findPrunableSettings,
  };
}

/**
 * two phases: domain upgrade() refreshes the marker, skills and tool settings;
 * then extensionInstall re-pulls legacy-layout entries into the per-extension
 * subtree and sweeps legacy files. On install failure the legacy files are kept
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
          lockfilePath: input.lockfilePath,
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

      // the install pass re-pulls legacy-layout lockfile entries and sweeps
      // their legacy files; idempotent. A UserError from it is raised after the
      // upgrade result is reported
      let installError: UserError | undefined;
      if (input.extensionInstallDeps) {
        try {
          for await (
            const event of extensionInstall(ctx, input.extensionInstallDeps)
          ) {
            yield { kind: "extensions", event };
          }
        } catch (error) {
          if (error instanceof UserError) {
            installError = error;
          } else {
            // extensionInstall catches per-entry failures, so anything reaching
            // here is an infrastructure error; surface it as an error event for
            // the renderer.
            yield {
              kind: "error",
              error: validationFailed(
                error instanceof Error ? error.message : String(error),
              ),
            };
            return;
          }
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
        prunableSettings: await prunableSettingsFor(
          ctx,
          deps.findPrunableSettings,
          result.path,
        ),
        extensionsToReinstall: result.extensionsToReinstall,
        localSkillCopies: result.localSkillCopies,
        changedFiles: result.changedFiles,
        untrustedCollectives: result.untrustedCollectives,
        ...(input.lockfilePath === null
          ? { untrustedCollectivesSkipped: true as const }
          : {}),
        installSkipped: input.extensionInstallSkippedReason !== undefined,
        ...(input.extensionInstallSkippedReason !== undefined
          ? { installSkippedReason: input.extensionInstallSkippedReason }
          : {}),
        tool: legacyToolField(result.tools),
      };

      yield { kind: "completed", data };
      if (installError) throw installError;
    })(),
  );
}
