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

import type { MergedServeOptions, ServeConfigFile } from "./serve_config.ts";
import {
  type AppliedSettingKey,
  classifyServeSettingChanges,
  settingName,
  type SettingsReloadReport,
} from "./serve_settings_reload.ts";
import type { ServeReloadCaller } from "./serve_config_reload_audit.ts";

/** the reloaded file as startup would read it, validated */
export interface ReloadCandidate<S> {
  readonly file: ServeConfigFile | null;
  readonly merged: MergedServeOptions;
  readonly startup: S;
}

/** a reason when only part of the value applied; the rest waits for a restart */
export type SettingApplyResult = void | { readonly partial: string };

/**
 * Sets one setting's new value where serve reads it. Runs in commit, so it
 * must only assign: anything that can fail belongs in prepare or a follow-up.
 */
export type SettingApplier<S, P> = (
  candidate: ReloadCandidate<S>,
  prepared: P,
) => SettingApplyResult;

export type SettingAppliers<S, P> = {
  readonly [K in AppliedSettingKey]: SettingApplier<S, P>;
};

/** async work after commit; a throw is a warning that keeps the new values */
export interface ReloadFollowUp {
  readonly name: string;
  run(): Promise<void>;
}

export interface ServeSettingsReloaderDeps<S, P> {
  readonly initialConfig: ServeConfigFile | null;
  readonly explicitFlags: ReadonlySet<string>;
  envLookup(name: string): string | undefined;
  /** strict read of serve.yaml; a throw refuses the reload */
  load(): ServeConfigFile | null;
  /** merged with the startup flags and env, which keep winning */
  merge(file: ServeConfigFile | null): MergedServeOptions;
  /** the checks startup runs; a throw refuses the reload */
  resolve(merged: MergedServeOptions): S;
  /** everything else that can fail before anything changes */
  prepare(
    candidate: ReloadCandidate<S>,
    changed: readonly AppliedSettingKey[],
    before: ServeConfigFile | null,
  ): Promise<P>;
  /** changes outside the catalogue that prepare settled, for the report */
  extraChanges?(prepared: P): {
    readonly applied: readonly string[];
    readonly needsRestart: readonly { setting: string; reason: string }[];
  };
  /** assigns them after the audit event; returns notes for the operator */
  commitExtra?(prepared: P): readonly string[];
  /**
   * applied settings whose consumer is not running here, or that would start
   * or stop it, with the reason
   */
  notRunning(
    candidate: ReloadCandidate<S>,
  ): Partial<Record<keyof MergedServeOptions, string>>;
  /** applied settings to re-apply though the file did not change them */
  pending(): readonly AppliedSettingKey[];
  appliers: SettingAppliers<S, P>;
  /** runs in commit before any applier, so it sees the policy in force */
  beforeCommit(
    report: SettingsReloadReport,
    context: ServeReloadCaller,
  ): void;
  afterCommit(
    candidate: ReloadCandidate<S>,
    applied: readonly AppliedSettingKey[],
    prepared: P,
  ): void;
  followUps(
    candidate: ReloadCandidate<S>,
    prepared: P,
    applied: readonly AppliedSettingKey[],
  ): readonly ReloadFollowUp[];
}

export interface SettingsReloadOutcome {
  readonly config: ServeConfigFile | null;
  readonly report: SettingsReloadReport;
  /** runs the follow-ups; returns one warning per follow-up that failed */
  followUp(): Promise<string[]>;
}

/**
 * Reload in three phases: prepare may fail and then nothing changes; commit
 * only assigns and cannot fail; follow-ups do the async work after it.
 */
export function createServeSettingsReloader<S, P>(
  deps: ServeSettingsReloaderDeps<S, P>,
): (context: ServeReloadCaller) => Promise<SettingsReloadOutcome> {
  let liveConfig = deps.initialConfig;
  return async (context) => {
    const file = deps.load();
    const merged = deps.merge(file);
    const startup = deps.resolve(merged);
    const candidate: ReloadCandidate<S> = { file, merged, startup };
    const changes = classifyServeSettingChanges({
      before: liveConfig,
      after: file,
      explicitFlags: deps.explicitFlags,
      envLookup: (name) => deps.envLookup(name),
      notRunning: deps.notRunning(candidate),
    });
    const toApply = [...changes.applied];
    for (const key of deps.pending()) {
      if (!toApply.includes(key)) toApply.push(key);
    }
    const prepared = await deps.prepare(candidate, toApply, liveConfig);
    const extra = deps.extraChanges?.(prepared) ??
      { applied: [], needsRestart: [] };

    const needsRestart = changes.needsRestart.map(({ key, reason }) => ({
      setting: settingName(key),
      reason,
    }));
    for (const entry of extra.needsRestart) needsRestart.push(entry);
    const overridden = changes.overridden.map(({ key, by }) => ({
      setting: settingName(key),
      by,
    }));
    deps.beforeCommit({
      applied: [...toApply.map(settingName), ...extra.applied],
      needsRestart,
      overridden,
    }, context);
    const applied: string[] = [];
    for (const key of toApply) {
      const result = deps.appliers[key](candidate, prepared);
      applied.push(settingName(key));
      if (result) {
        needsRestart.push({
          setting: settingName(key),
          reason: result.partial,
        });
      }
    }
    for (const setting of extra.applied) applied.push(setting);
    const notes = deps.commitExtra?.(prepared) ?? [];
    deps.afterCommit(candidate, toApply, prepared);
    liveConfig = file;

    const followUps = deps.followUps(candidate, prepared, toApply);
    return {
      config: file,
      report: { applied, needsRestart, overridden },
      followUp: async () => {
        const warnings: string[] = [...notes];
        for (const followUp of followUps) {
          try {
            await followUp.run();
          } catch (err) {
            warnings.push(
              `${followUp.name} did not complete; the reloaded values are in force: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
        }
        return warnings;
      },
    };
  };
}
