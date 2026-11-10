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

import { assertEquals, assertRejects } from "@std/assert";
import type { MergedServeOptions, ServeConfigFile } from "./serve_config.ts";
import { mergeServeOptions } from "./serve_config.ts";
import {
  type AppliedSettingKey,
  SETTING_CATALOGUE,
  type SettingsReloadReport,
} from "./serve_settings_reload.ts";
import {
  createServeSettingsReloader,
  type ReloadFollowUp,
  type ServeSettingsReloaderDeps,
  type SettingAppliers,
  type SettingApplyResult,
} from "./serve_settings_reloader.ts";

interface Harness {
  file: ServeConfigFile | null;
  calls: string[];
  results: Partial<Record<AppliedSettingKey, SettingApplyResult>>;
  deps: ServeSettingsReloaderDeps<MergedServeOptions, string>;
}

function harness(
  initial: ServeConfigFile | null,
  overrides: Partial<ServeSettingsReloaderDeps<MergedServeOptions, string>> =
    {},
): Harness {
  const h: Harness = {
    file: initial,
    calls: [],
    results: {},
    deps: undefined as unknown as Harness["deps"],
  };
  const appliedKeys =
    (Object.keys(SETTING_CATALOGUE) as (keyof MergedServeOptions)[])
      .filter((key) => SETTING_CATALOGUE[key].reloadClass === "applied");
  const appliers = Object.fromEntries(
    appliedKeys.map((key) => [key, () => {
      h.calls.push(`apply:${key}`);
      return h.results[key as AppliedSettingKey];
    }]),
  ) as unknown as SettingAppliers<MergedServeOptions, string>;
  h.deps = {
    initialConfig: initial,
    explicitFlags: new Set(),
    envLookup: () => undefined,
    load: () => h.file,
    merge: (file) => mergeServeOptions(file, {}, new Set(), () => undefined),
    resolve: (merged) => {
      if (merged.maxConcurrentRuns === 0) {
        throw new Error("--max-concurrent-runs must be a positive integer");
      }
      return merged;
    },
    prepare: () => {
      h.calls.push("prepare");
      return Promise.resolve("prepared");
    },
    notRunning: () => ({}),
    pending: () => [],
    appliers,
    beforeCommit: (report: SettingsReloadReport) => {
      h.calls.push(`audit:${report.applied.join(",")}`);
    },
    afterCommit: (_candidate, applied) => {
      h.calls.push(`overlay:${applied.join(",")}`);
    },
    followUps: () => [],
    ...overrides,
  };
  return h;
}

const reload = { trigger: "reload" as const };

Deno.test("createServeSettingsReloader: applies only what changed, audits before any applier, then overlays", async () => {
  const h = harness({ "max-concurrent-runs": 5 });
  h.file = { "max-concurrent-runs": 9, dashboard: true };
  const outcome = await createServeSettingsReloader(h.deps)(reload);
  assertEquals(h.calls, [
    "prepare",
    "audit:dashboard,max-concurrent-runs",
    "apply:dashboard",
    "apply:maxConcurrentRuns",
    "overlay:dashboard,maxConcurrentRuns",
  ]);
  assertEquals(outcome.report.applied, ["dashboard", "max-concurrent-runs"]);
});

Deno.test("createServeSettingsReloader: a file startup would refuse changes nothing", async () => {
  const h = harness({ "max-concurrent-runs": 5 });
  h.file = { "max-concurrent-runs": 0, dashboard: true };
  await assertRejects(
    () => createServeSettingsReloader(h.deps)(reload),
    Error,
    "positive integer",
  );
  assertEquals(h.calls, []);
});

Deno.test("createServeSettingsReloader: a prepare failure changes nothing", async () => {
  const h = harness(null, {
    prepare: () => Promise.reject(new Error("lookup refused")),
  });
  h.file = { dashboard: true };
  await assertRejects(
    () => createServeSettingsReloader(h.deps)(reload),
    Error,
    "lookup refused",
  );
  assertEquals(h.calls, []);
});

Deno.test("createServeSettingsReloader: a partly applied setting is both applied and waiting for a restart", async () => {
  const h = harness(null);
  h.results.dashboard = { partial: "bob waits for a restart" };
  h.file = { dashboard: true };
  const outcome = await createServeSettingsReloader(h.deps)(reload);
  assertEquals(outcome.report.applied, ["dashboard"]);
  assertEquals(outcome.report.needsRestart, [
    { setting: "dashboard", reason: "bob waits for a restart" },
  ]);
});

Deno.test("createServeSettingsReloader: a setting whose consumer is not running needs a restart and is not applied", async () => {
  const h = harness(null, {
    notRunning: () => ({ triggerOverrides: "no scheduler runs here" }),
  });
  h.file = { triggers: { nightly: { schedule: "0 3 * * *" } } };
  const outcome = await createServeSettingsReloader(h.deps)(reload);
  assertEquals(h.calls.includes("apply:triggerOverrides"), false);
  assertEquals(outcome.report.needsRestart, [
    { setting: "triggers", reason: "no scheduler runs here" },
  ]);
});

Deno.test("createServeSettingsReloader: a pending setting is applied again though the file did not change it", async () => {
  const h = harness({ dashboard: true }, {
    pending: () => ["dashboard"],
  });
  const outcome = await createServeSettingsReloader(h.deps)(reload);
  assertEquals(outcome.report.applied, ["dashboard"]);
  assertEquals(h.calls.includes("apply:dashboard"), true);
});

Deno.test("createServeSettingsReloader: the next reload diffs against what the last one applied", async () => {
  const h = harness(null);
  h.file = { dashboard: true };
  const reloader = createServeSettingsReloader(h.deps);
  await reloader(reload);
  h.calls.length = 0;
  const again = await reloader(reload);
  assertEquals(again.report.applied, []);
  assertEquals(h.calls.filter((c) => c.startsWith("apply:")), []);
});

Deno.test("createServeSettingsReloader: a follow-up that fails is a warning, keeps the new values, and the rest still run", async () => {
  const ran: string[] = [];
  const followUps: ReloadFollowUp[] = [
    {
      name: "swamp-club re-registration",
      run: () => Promise.reject(new Error("club unreachable")),
    },
    {
      name: "poller re-arm",
      run: () => {
        ran.push("poller");
        return Promise.resolve();
      },
    },
  ];
  const h = harness(null, { followUps: () => followUps });
  h.file = { dashboard: true };
  const outcome = await createServeSettingsReloader(h.deps)(reload);
  assertEquals(outcome.report.applied, ["dashboard"]);
  const warnings = await outcome.followUp();
  assertEquals(ran, ["poller"]);
  assertEquals(warnings, [
    "swamp-club re-registration did not complete; the reloaded values are in force: club unreachable",
  ]);
});

Deno.test("createServeSettingsReloader: not-running reasons see the reloaded values, so turning a service off needs a restart", async () => {
  const h = harness({ "continuation-sweep-interval": "60s" }, {
    notRunning: ({ merged }) =>
      merged.continuationSweepInterval === "0"
        ? {
          continuationSweepInterval:
            "turning the continuation sweep off needs a restart",
        }
        : {},
  });
  h.file = { "continuation-sweep-interval": "0" };
  const outcome = await createServeSettingsReloader(h.deps)(reload);
  assertEquals(outcome.report.applied, []);
  assertEquals(outcome.report.needsRestart, [{
    setting: "continuation-sweep-interval",
    reason: "turning the continuation sweep off needs a restart",
  }]);
});
