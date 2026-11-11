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

import type { ServeAuthConfig } from "../domain/access/serve_auth_config.ts";
import type { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";
import type {
  GrantsDirectoryPoller,
  GrantsReconcileOutcome,
} from "../domain/access/grants_directory_poller.ts";
import {
  type AdminGrantStore,
  materializeAdmins,
  type MaterializeAdminsOptions,
} from "../domain/access/admin_materializer.ts";
import {
  readServeGrantFiles,
  type ServeGrantFiles,
} from "../domain/access/grant_file_loader.ts";
import type {
  ConditionValidator,
  GrantFileError,
} from "../domain/access/grant_file.ts";
import {
  GRANTS_FILE_SOURCE_NAME,
  isGrantsDirSourceName,
} from "../domain/access/grant_source.ts";
import { errorPaths, markErrorPaths, UserError } from "../domain/errors.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { MergedServeOptions } from "./serve_config.ts";
import { settingName } from "./serve_settings_reload.ts";
import type {
  ReloadFollowUp,
  SettingApplyResult,
} from "./serve_settings_reloader.ts";
import {
  ADMIN_ADDITION_NEEDS_RESTART,
  type AdminReloadPlan,
  oauthAdminSubjectOf,
  planAdminReload,
} from "./serve_admin_reload.ts";

const logger = getSwampLogger(["serve", "grant-reload"]);

export const GRANT_WRITES_ELSEWHERE =
  "this node does not lead grant writes; the leading node applies it when it reloads, and this node does when it takes the lead";

export interface GrantSources {
  readonly externalGrantsFile?: string;
  readonly externalGrantsDir?: string;
}

export interface GrantReloadStartup {
  readonly authConfig: ServeAuthConfig;
  readonly grantReloadMode: "manual" | "auto";
}

export interface GrantReloadPrepared {
  admins?: AdminReloadPlan;
  grantSources?: GrantSources;
}

export interface GrantSettingsReloadDeps {
  readonly repoDir: string;
  /** serve's own: appliers change it in place, as every reader holds it */
  readonly authConfig: ServeAuthConfig;
  /** the configured admin entries startup put in force */
  readonly initialAdminsConfigured: readonly string[];
  readonly policySnapshotLoader: Pick<
    PolicySnapshotLoader,
    "setMode" | "setDecisionOptions" | "load"
  >;
  readonly poller: Pick<
    GrantsDirectoryPoller,
    "setSources" | "reconcileNow" | "start" | "pause"
  >;
  readonly adminGrantStore: AdminGrantStore;
  /** the external sources startup loaded */
  readonly initialSources: GrantSources;
  readonly validateCondition?: ConditionValidator;
  /** runs grant writes as one unit under the sync gate */
  commitGrantWrites<T>(fn: () => Promise<T>): Promise<T>;
  leadsGrantWrites(): boolean;
  publishGrantConfig(): Promise<void>;
  /** the OAuth name map, to find the subject an admin name was resolved to */
  oauthNameCache(): Readonly<Record<string, string>> | undefined;
  /** where access reload reads the external sources from */
  setAccessReloadSources(sources: GrantSources): void;
  now?(): Date;
}

type GrantSettingKey =
  | "approveRequiresExplicitGrant"
  | "signalRequiresExplicitGrant"
  | "tagRequiresExplicitGrant"
  | "grantReload"
  | "grantsFile"
  | "grantsDir"
  | "admins";

type GrantApplier = (
  candidate: { readonly startup: GrantReloadStartup },
  prepared: GrantReloadPrepared,
) => SettingApplyResult;

/**
 * grant reload mode, grant sources, the explicit-grant rules and admin
 * removal, as a reload applies them. Grant writes land in follow-ups that
 * carry their settings, so a write that fails is not reported applied
 */
export function createGrantSettingsReload(deps: GrantSettingsReloadDeps) {
  const { authConfig } = deps;
  const now = () => deps.now?.() ?? new Date();
  let adminsConfigured = [...deps.initialAdminsConfigured];
  let adminsReadAt = now();
  let adminsWaitingSubjects: readonly string[] = [];
  // what a failed reconcile restores, so the old sources stay in force
  let sourcesInForce: GrantSources = deps.initialSources;

  const subjectOf = (entry: string): string | undefined =>
    authConfig.mode === "oauth"
      ? oauthAdminSubjectOf(deps.oauthNameCache(), entry)
      : entry;
  const planAdmins = (configured: readonly string[]) =>
    planAdminReload({
      configuredBefore: adminsConfigured,
      configuredAfter: configured,
      inForce: authConfig.admins,
      subjectOf,
    });

  const applyExplicitGrantRule = (
    startup: GrantReloadStartup,
    key:
      | "approveRequiresExplicitGrant"
      | "signalRequiresExplicitGrant"
      | "tagRequiresExplicitGrant",
  ): SettingApplyResult => {
    authConfig[key] = startup.authConfig[key];
    deps.policySnapshotLoader.setDecisionOptions({
      runImpliesApprove: !authConfig.approveRequiresExplicitGrant,
      runImpliesSignal: !authConfig.signalRequiresExplicitGrant,
      writeImpliesTag: !authConfig.tagRequiresExplicitGrant,
    });
    if (authConfig.mode === "none" && authConfig[key]) {
      logger.warn(
        "{setting} is set but --auth-mode is {mode} — it will have no effect",
        { setting: settingName(key), mode: authConfig.mode },
      );
    }
  };

  const appliers: { readonly [K in GrantSettingKey]: GrantApplier } = {
    approveRequiresExplicitGrant: ({ startup }) =>
      applyExplicitGrantRule(startup, "approveRequiresExplicitGrant"),
    signalRequiresExplicitGrant: ({ startup }) =>
      applyExplicitGrantRule(startup, "signalRequiresExplicitGrant"),
    tagRequiresExplicitGrant: ({ startup }) =>
      applyExplicitGrantRule(startup, "tagRequiresExplicitGrant"),
    // the poller starts or pauses in a follow-up
    grantReload: ({ startup }) => {
      deps.policySnapshotLoader.setMode(startup.grantReloadMode);
    },
    // access reload reads the new sources at once; the poller in a follow-up
    grantsFile: (_candidate, prepared) => {
      if (prepared.grantSources) {
        deps.setAccessReloadSources(prepared.grantSources);
      }
    },
    grantsDir: (_candidate, prepared) => {
      if (prepared.grantSources) {
        deps.setAccessReloadSources(prepared.grantSources);
      }
    },
    admins: (_candidate, prepared) => {
      const plan = prepared.admins;
      if (!plan) return;
      // in place: every reader holds this array
      authConfig.admins.length = 0;
      for (const subject of plan.inForce) authConfig.admins.push(subject);
      adminsConfigured = [...plan.configured];
      adminsWaitingSubjects = plan.waitingSubjects;
      adminsReadAt = now();
      if (plan.inForce.length === 0) {
        logger.warn(
          "No admin is in force until serve restarts with the admins now configured",
        );
      }
      if (plan.waiting.length === 0) return undefined;
      return {
        partial: plan.inForce.length === 0
          ? `the removal applied and no admin is in force until a restart; ${ADMIN_ADDITION_NEEDS_RESTART}`
          : `the removal applied; ${ADMIN_ADDITION_NEEDS_RESTART}`,
      };
    },
  };

  return {
    appliers,

    /** the configured admin entries in force, as the config view shows them */
    get adminsConfigured(): readonly string[] {
      return adminsConfigured;
    },

    /** what a node taking the lead materializes admins with */
    leadOptions(): MaterializeAdminsOptions {
      return { adminsReadAt, retain: adminsWaitingSubjects };
    },

    /** an addition alone changes nothing until a restart */
    notRunning(
      startup: GrantReloadStartup,
    ): Partial<Record<keyof MergedServeOptions, string>> {
      const plan = planAdmins(startup.authConfig.admins);
      return plan.removedSubjects.length === 0 && plan.waiting.length > 0
        ? { admins: ADMIN_ADDITION_NEEDS_RESTART }
        : {};
    },

    /** everything that can refuse the reload; a refusal changes nothing */
    async prepare(
      next: MergedServeOptions,
      startup: GrantReloadStartup,
      toApply: readonly string[],
    ): Promise<GrantReloadPrepared> {
      const prepared: GrantReloadPrepared = {};
      if (toApply.includes("grantsFile") || toApply.includes("grantsDir")) {
        prepared.grantSources = checkReloadedGrantSources(
          await readServeGrantFiles(deps.repoDir, {
            grantsFile: next.grantsFile,
            grantsDir: next.grantsDir,
            validateCondition: deps.validateCondition,
          }),
        );
      }
      if (toApply.includes("admins")) {
        prepared.admins = planAdmins(startup.authConfig.admins);
      }
      return prepared;
    },

    followUps(
      startup: GrantReloadStartup,
      prepared: GrantReloadPrepared,
      applied: readonly string[],
    ): ReloadFollowUp[] {
      const followUps: ReloadFollowUp[] = [];
      const poller = deps.poller;
      const sourcesChanged = applied.includes("grantsFile") ||
        applied.includes("grantsDir");
      if (sourcesChanged && prepared.grantSources) {
        const sources = prepared.grantSources;
        followUps.push({
          name: "Reconciling the grant sources",
          settings: ["grantsFile", "grantsDir"],
          run: async () => {
            await poller.setSources(sources);
            const outcome = await poller.reconcileNow();
            if (outcome.status === "failed") {
              await poller.setSources(sourcesInForce);
              deps.setAccessReloadSources(sourcesInForce);
              throw new Error(outcome.error ?? "the grant reconcile failed");
            }
            sourcesInForce = sources;
            return heldGrantSourceReason(outcome, sources.externalGrantsDir);
          },
        });
      }
      if (applied.includes("grantReload")) {
        const mode = startup.grantReloadMode;
        followUps.push({
          name: mode === "auto"
            ? "Starting the grants poller"
            : "Pausing the grants poller",
          settings: ["grantReload"],
          run: async () => {
            if (mode === "manual") {
              await poller.pause();
              return;
            }
            // what changed while manual applies now, not at a later change
            const outcome = sourcesChanged
              ? undefined
              : await poller.reconcileNow();
            if (outcome?.status === "failed") {
              deps.policySnapshotLoader.setMode("manual");
              throw new Error(outcome.error ?? "the grant reconcile failed");
            }
            await poller.start();
          },
        });
      }
      if (applied.includes("admins") && prepared.admins) {
        followUps.push({
          name: "Revoking removed admin grants",
          settings: ["admins"],
          run: async () => {
            if (!deps.leadsGrantWrites()) {
              return { partial: GRANT_WRITES_ELSEWHERE };
            }
            const result = await deps.commitGrantWrites(() =>
              materializeAdmins(
                authConfig.mode,
                authConfig.admins,
                deps.adminGrantStore,
                { adminsReadAt, retain: adminsWaitingSubjects },
              )
            );
            if (result.revoked > 0) {
              logger.info("Admin grants revoked by reload: {count}", {
                count: result.revoked,
              });
            }
            await deps.policySnapshotLoader.load();
            await deps.publishGrantConfig();
          },
        });
      }
      return followUps;
    },
  };
}

export type GrantSettingsReload = ReturnType<typeof createGrantSettingsReload>;

// a held new source reads as applied but created nothing, so say why
function heldGrantSourceReason(
  outcome: GrantsReconcileOutcome,
  externalGrantsDir: string | undefined,
): SettingApplyResult {
  if (outcome.status === "deferred") {
    return { partial: GRANT_WRITES_ELSEWHERE };
  }
  const held = outcome.held.filter(({ source }) =>
    source === GRANTS_FILE_SOURCE_NAME || isGrantsDirSourceName(source) ||
    source === externalGrantsDir
  );
  if (held.length === 0) return undefined;
  return {
    partial: `kept the stored grants of ${
      held.map(({ source, reason }) => `${source} (${reason})`).join(", ")
    }; fix the source and reload again`,
  };
}

function formatErrors(errors: readonly GrantFileError[]): string {
  return errors.map((e) => {
    const loc = e.entryIndex !== undefined
      ? `${e.filename} entry ${e.entryIndex + 1}`
      : e.filename;
    return `  ${loc}: ${e.message}`;
  }).join("\n");
}

/**
 * the external grant sources a reload points serve at; a source startup would
 * refuse refuses the reload, so its stored grants stay as they are
 */
export function checkReloadedGrantSources(
  files: Pick<ServeGrantFiles, "grantsFile" | "grantsDir">,
): GrantSources {
  const file = files.grantsFile;
  if (file) {
    if (file.status === "missing") {
      throw markErrorPaths(
        new UserError(`External grants file not found: ${file.path}`),
        [file.path],
      );
    }
    if (file.status === "unreadable") {
      throw markErrorPaths(
        new UserError(
          `Failed to read external grants file ${file.path}: ${file.cause}`,
        ),
        [file.path, ...errorPaths(file.cause)],
      );
    }
    if (file.file.result && file.file.result.errors.length > 0) {
      throw markErrorPaths(
        new UserError(
          `External grants file validation failed:\n${
            formatErrors(file.file.result.errors)
          }`,
        ),
        [file.path],
      );
    }
  }
  const dir = files.grantsDir;
  if (dir?.status === "missing") {
    throw markErrorPaths(
      new UserError(`External grants directory not found: ${dir.path}`),
      [dir.path],
    );
  }
  if (dir?.status === "unreadable") {
    throw markErrorPaths(
      new UserError(
        `Failed to read external grants directory ${dir.path}: ${dir.cause}`,
      ),
      [dir.path, ...errorPaths(dir.cause)],
    );
  }
  if (dir?.status === "loaded") {
    for (const entry of dir.files) {
      if (entry.readError !== undefined) {
        throw markErrorPaths(
          new UserError(
            `Failed to read grants file ${entry.path}: ${entry.readError}`,
          ),
          [entry.path, ...errorPaths(entry.readError)],
        );
      }
      if (entry.result && entry.result.errors.length > 0) {
        throw markErrorPaths(
          new UserError(
            `Grants directory file validation failed:\n${
              formatErrors(entry.result.errors)
            }`,
          ),
          [entry.path],
        );
      }
    }
  }
  return {
    ...(file ? { externalGrantsFile: file.path } : {}),
    ...(dir && dir.status !== "same-as-repo"
      ? { externalGrantsDir: dir.path }
      : {}),
  };
}
