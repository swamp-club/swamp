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

// A reload changes grant reload mode, grant sources, the explicit-grant rules
// and removes admins through the module serve wires, on a real repository.
import { assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { atomicWriteTextFile } from "../src/infrastructure/persistence/atomic_write.ts";
import { validateGrantCondition } from "../src/infrastructure/cel/grant_condition_environment.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { GrantsDirectoryPoller } from "../src/domain/access/grants_directory_poller.ts";
import {
  createAdminGrantStore,
  materializeAdmins,
} from "../src/domain/access/admin_materializer.ts";
import { createFileGrantStore } from "../src/domain/access/grant_file_reconciler.ts";
import { readServeGrantFiles } from "../src/domain/access/grant_file_loader.ts";
import {
  buildServeAuthConfig,
  type ServeAuthConfig,
} from "../src/domain/access/serve_auth_config.ts";
import { parsePrincipal } from "../src/domain/access/principal.ts";
import type { Action } from "../src/domain/access/action.ts";
import {
  type MergedServeOptions,
  mergeServeOptions,
  type ServeConfigFile,
} from "../src/serve/serve_config.ts";
import { SETTING_CATALOGUE } from "../src/serve/serve_settings_reload.ts";
import {
  createServeSettingsReloader,
  type SettingAppliers,
} from "../src/serve/serve_settings_reloader.ts";
import {
  checkReloadedGrantSources,
  createGrantSettingsReload,
  GRANT_WRITES_ELSEWHERE,
  type GrantReloadPrepared,
  type GrantReloadStartup,
} from "../src/serve/serve_grant_reload.ts";
import { ADMIN_ADDITION_NEEDS_RESTART } from "../src/serve/serve_admin_reload.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const RUN_GRANT = `grants:
  - subject: "user:dev"
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;
const DEPLOY_GRANT = `grants:
  - subject: "user:dev"
    effect: allow
    actions: [run]
    resource: "workflow:deploy"
`;
const USERNAME_GRANT = `grants:
  - subject: "username:dave"
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;

function config(
  options: {
    admins?: string[];
    grantReload?: "manual" | "auto";
    grantsFile?: string;
    approveExplicit?: boolean;
  } = {},
): ServeConfigFile {
  return {
    ...(options.grantReload ? { "grant-reload": options.grantReload } : {}),
    ...(options.grantsFile ? { "grants-file": options.grantsFile } : {}),
    auth: {
      mode: "token",
      admins: options.admins ?? ["user:alice"],
      ...(options.approveExplicit
        ? { "approve-requires-explicit-grant": true }
        : {}),
    },
  } as unknown as ServeConfigFile;
}

const merge = (file: ServeConfigFile | null) =>
  mergeServeOptions(file, {}, new Set(), () => undefined);

const toAuth = (merged: MergedServeOptions): ServeAuthConfig =>
  buildServeAuthConfig({
    authMode: merged.authMode,
    admins: merged.admins,
    allowedCollectives: merged.allowedCollectives,
    allowedUsers: merged.allowedUsers,
    oauthProvider: merged.oauthProvider,
    oauthClientId: merged.oauthClientId,
    groupsField: merged.groupsField,
    restrictedModelTypes: merged.restrictedModelTypes,
    restrictedCommands: merged.restrictedCommands,
    approveRequiresExplicitGrant: merged.approveRequiresExplicitGrant,
    signalRequiresExplicitGrant: merged.signalRequiresExplicitGrant,
    tagRequiresExplicitGrant: merged.tagRequiresExplicitGrant,
  });

const toStartup = (merged: MergedServeOptions): GrantReloadStartup => ({
  authConfig: toAuth(merged),
  grantReloadMode: merged.grantReload as "manual" | "auto",
});

type RepoContext = ReturnType<typeof createRepositoryContext>;

interface InstanceOptions {
  /** when this instance read its admins; a stale peer has an earlier one */
  readonly bootedAt?: Date;
  readonly leads?: () => boolean;
  readonly failGrantWrites?: () => boolean;
}

/** serve's grant wiring at startup and on reload, over one repository */
async function startInstance(
  repoDir: string,
  repo: RepoContext,
  initial: ServeConfigFile,
  options: InstanceOptions = {},
) {
  let file: ServeConfigFile | null = initial;
  const merged = merge(initial);
  const startup = toStartup(merged);
  const authConfig = startup.authConfig;
  const loader = new PolicySnapshotLoader(
    repo.unifiedDataRepo,
    repo.eventBus,
    startup.grantReloadMode,
    {
      runImpliesApprove: !authConfig.approveRequiresExplicitGrant,
      runImpliesSignal: !authConfig.signalRequiresExplicitGrant,
      writeImpliesTag: !authConfig.tagRequiresExplicitGrant,
    },
  );
  const adminGrantStore = createAdminGrantStore(
    repo.definitionRepo,
    repo.definitionRepo,
    repo.unifiedDataRepo,
  );
  const sources = checkReloadedGrantSources(
    await readServeGrantFiles(repoDir, {
      grantsFile: merged.grantsFile,
      grantsDir: merged.grantsDir,
      validateCondition: validateGrantCondition,
    }),
  );
  let accessReloadSources = sources;
  const poller = new GrantsDirectoryPoller({
    grantsDir: join(repoDir, "grants"),
    ...sources,
    validateCondition: validateGrantCondition,
    fileGrantStore: createFileGrantStore(
      repo.definitionRepo,
      repo.definitionRepo,
      repo.unifiedDataRepo,
    ),
    policySnapshotLoader: loader,
    pollIntervalMs: 20,
  });
  const commitGrantWrites = <T>(fn: () => Promise<T>): Promise<T> =>
    options.failGrantWrites?.()
      ? Promise.reject(new Error("datastore unreachable"))
      : fn();
  if (!options.bootedAt) {
    await materializeAdmins(
      authConfig.mode,
      authConfig.admins,
      adminGrantStore,
    );
    await poller.reconcileNow();
  }
  await loader.load();
  if (startup.grantReloadMode === "auto") await poller.start();

  const grantReload = createGrantSettingsReload({
    repoDir,
    authConfig,
    initialAdminsConfigured: [...authConfig.admins],
    policySnapshotLoader: loader,
    poller,
    adminGrantStore,
    validateCondition: validateGrantCondition,
    commitGrantWrites,
    leadsGrantWrites: options.leads ?? (() => true),
    publishGrantConfig: () => Promise.resolve(),
    oauthNameCache: () => undefined,
    setAccessReloadSources: (next) => {
      accessReloadSources = next;
    },
    ...(options.bootedAt ? { now: () => options.bootedAt! } : {}),
  });
  const noop = () => {};
  const appliers = {
    ...Object.fromEntries(
      (Object.keys(SETTING_CATALOGUE) as (keyof MergedServeOptions)[])
        .filter((key) => SETTING_CATALOGUE[key].reloadClass === "applied")
        .map((key) => [key, noop]),
    ),
    ...grantReload.appliers,
  } as unknown as SettingAppliers<GrantReloadStartup, GrantReloadPrepared>;
  const reloader = createServeSettingsReloader<
    GrantReloadStartup,
    GrantReloadPrepared
  >({
    initialConfig: initial,
    explicitFlags: new Set(),
    envLookup: () => undefined,
    load: () => file,
    merge,
    resolve: toStartup,
    prepare: ({ merged: next, startup: s }, toApply) =>
      grantReload.prepare(next, s, toApply),
    notRunning: ({ startup: s }) => grantReload.notRunning(s),
    pending: () => [],
    appliers,
    beforeCommit: noop,
    afterCommit: noop,
    followUps: ({ startup: s }, prepared, applied) =>
      grantReload.followUps(s, prepared, applied),
  });

  const decide = (subject: string, action: Action, workflow = "deploy") =>
    loader.decisionService.decide(
      {
        principal: parsePrincipal(subject),
        collectives: [],
        groups: [],
        client: undefined,
        delegation: undefined,
      },
      action,
      action === "admin"
        ? { kind: "access", name: "*", fields: {} }
        : { kind: "workflow", name: workflow, fields: {} },
    )?.effect === "allow";

  return {
    poller,
    authConfig,
    accessReloadSources: () => accessReloadSources,
    async reload(next: ServeConfigFile) {
      file = next;
      const outcome = await reloader({ trigger: "reload" });
      const warnings = await outcome.followUp();
      return { report: outcome.report, warnings };
    },
    isAdmin: (subject: string) => decide(subject, "admin"),
    allows: (subject: string, action: Action, workflow?: string) =>
      decide(subject, action, workflow),
    /** what serve runs on taking the lead in team mode */
    async takeLead() {
      await commitGrantWrites(() =>
        materializeAdmins(
          authConfig.mode,
          authConfig.admins,
          adminGrantStore,
          grantReload.leadOptions(),
        )
      );
      await loader.load();
    },
    async close() {
      await poller.close();
      await loader.dispose();
    },
  };
}

async function withRepo(
  fn: (repoDir: string, repo: RepoContext) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-grant-reload-" });
  const repoDir = join(dir, "repo");
  await ensureDir(join(repoDir, "grants"));
  const repo = createRepositoryContext({ repoDir });
  try {
    await fn(repoDir, repo);
  } finally {
    repo.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("serve grant reload: grant mode manual to auto picks up a grant file without a restart, and auto to manual stops the poller", async () => {
  await withRepo(async (repoDir, repo) => {
    const grantsFile = join(repoDir, "team-grants.yaml");
    await atomicWriteTextFile(grantsFile, DEPLOY_GRANT);
    const serve = await startInstance(
      repoDir,
      repo,
      config({ grantsFile }),
    );
    try {
      assertEquals(serve.allows("user:dev", "run", "build"), false);
      await atomicWriteTextFile(grantsFile, RUN_GRANT);
      const toAuto = await serve.reload(
        config({ grantsFile, grantReload: "auto" }),
      );
      assertEquals(toAuto.report.applied, ["grant-reload"]);
      assertEquals(toAuto.report.needsRestart, []);
      // the file changed while manual is applied by the switch itself
      assertEquals(serve.allows("user:dev", "run", "build"), true);

      // and later changes by the poller
      await atomicWriteTextFile(grantsFile, DEPLOY_GRANT);
      await waitFor(
        () => !serve.allows("user:dev", "run", "build"),
        "the poller to apply the narrowed grant",
      );

      const toManual = await serve.reload(
        config({ grantsFile, grantReload: "manual" }),
      );
      assertEquals(toManual.report.applied, ["grant-reload"]);
      // paused, with no next poll: an emptied source revokes on one reconcile
      await atomicWriteTextFile(grantsFile, "");
      await serve.poller.reconcileNow();
      assertEquals(serve.allows("user:dev", "run", "deploy"), false);
    } finally {
      await serve.close();
    }
  });
});

Deno.test("serve grant reload: a changed grants file is loaded and the old one's grants revoked; a refused source refuses the reload and keeps its grants", async () => {
  await withRepo(async (repoDir, repo) => {
    const first = join(repoDir, "first.yaml");
    const second = join(repoDir, "second.yaml");
    await atomicWriteTextFile(first, DEPLOY_GRANT);
    await atomicWriteTextFile(
      second,
      RUN_GRANT.replace("user:dev", "user:ops"),
    );
    const serve = await startInstance(
      repoDir,
      repo,
      config({ grantsFile: first }),
    );
    try {
      assertEquals(serve.allows("user:dev", "run"), true);

      const moved = await serve.reload(config({ grantsFile: second }));
      assertEquals(moved.report.applied, ["grants-file"]);
      assertEquals(moved.report.needsRestart, []);
      assertEquals(serve.allows("user:dev", "run"), false);
      assertEquals(serve.allows("user:ops", "run"), true);
      assertEquals(serve.accessReloadSources().externalGrantsFile, second);

      await assertRejects(
        () => serve.reload(config({ grantsFile: join(repoDir, "gone.yaml") })),
        Error,
        "External grants file not found",
      );
      await atomicWriteTextFile(first, "grants: [not: valid");
      await assertRejects(
        () => serve.reload(config({ grantsFile: first })),
        Error,
        "validation failed",
      );
      assertEquals(serve.allows("user:ops", "run"), true);
      assertEquals(serve.accessReloadSources().externalGrantsFile, second);
    } finally {
      await serve.close();
    }
  });
});

Deno.test("serve grant reload: a new source whose usernames cannot be resolved reports the setting partly applied", async () => {
  await withRepo(async (repoDir, repo) => {
    const named = join(repoDir, "named.yaml");
    await atomicWriteTextFile(named, USERNAME_GRANT);
    const serve = await startInstance(repoDir, repo, config());
    try {
      const reloaded = await serve.reload(config({ grantsFile: named }));
      assertEquals(reloaded.report.applied, ["grants-file"]);
      assertEquals(reloaded.report.needsRestart.length, 1);
      assertEquals(reloaded.report.needsRestart[0].setting, "grants-file");
    } finally {
      await serve.close();
    }
  });
});

Deno.test("serve grant reload: turning each explicit-grant rule on or off changes the next decision", async () => {
  await withRepo(async (repoDir, repo) => {
    const grantsFile = join(repoDir, "grants.yaml");
    await atomicWriteTextFile(
      grantsFile,
      RUN_GRANT.replace("actions: [run]", "actions: [run, write]"),
    );
    const serve = await startInstance(repoDir, repo, config({ grantsFile }));
    try {
      assertEquals(serve.allows("user:dev", "approve"), true);
      assertEquals(serve.allows("user:dev", "signal"), true);
      assertEquals(serve.allows("user:dev", "tag"), true);

      const strict = {
        ...config({ grantsFile }),
        auth: {
          mode: "token",
          admins: ["user:alice"],
          "approve-requires-explicit-grant": true,
          "signal-requires-explicit-grant": true,
          "tag-requires-explicit-grant": true,
        },
      } as unknown as ServeConfigFile;
      const on = await serve.reload(strict);
      assertEquals(on.report.needsRestart, []);
      assertEquals(serve.allows("user:dev", "approve"), false);
      assertEquals(serve.allows("user:dev", "signal"), false);
      assertEquals(serve.allows("user:dev", "tag"), false);
      assertEquals(serve.allows("user:dev", "run"), true);

      await serve.reload(config({ grantsFile }));
      assertEquals(serve.allows("user:dev", "approve"), true);
      assertEquals(serve.allows("user:dev", "tag"), true);
    } finally {
      await serve.close();
    }
  });
});

Deno.test("serve grant reload: removing an admin revokes their grant before the report says applied", async () => {
  await withRepo(async (repoDir, repo) => {
    const serve = await startInstance(
      repoDir,
      repo,
      config({ admins: ["user:alice", "user:bob"] }),
    );
    try {
      assertEquals(serve.isAdmin("user:bob"), true);
      const reloaded = await serve.reload(config({ admins: ["user:alice"] }));
      assertEquals(reloaded.report.applied, ["auth.admins"]);
      assertEquals(reloaded.report.needsRestart, []);
      assertEquals(serve.isAdmin("user:bob"), false);
      assertEquals(serve.isAdmin("user:alice"), true);
    } finally {
      await serve.close();
    }
  });
});

Deno.test("serve grant reload: a revocation that fails is not reported applied, and the next reload retries it", async () => {
  await withRepo(async (repoDir, repo) => {
    let fail = false;
    const serve = await startInstance(
      repoDir,
      repo,
      config({ admins: ["user:alice", "user:bob"] }),
      { failGrantWrites: () => fail },
    );
    try {
      fail = true;
      const failed = await serve.reload(config({ admins: ["user:alice"] }));
      assertEquals(failed.report.applied, []);
      assertEquals(failed.report.needsRestart.map((r) => r.setting), [
        "auth.admins",
      ]);
      assertEquals(serve.isAdmin("user:bob"), true);

      fail = false;
      const retried = await serve.reload(config({ admins: ["user:alice"] }));
      assertEquals(retried.report.applied, ["auth.admins"]);
      assertEquals(serve.isAdmin("user:bob"), false);
    } finally {
      await serve.close();
    }
  });
});

Deno.test("serve grant reload: adding an admin by reload needs a restart and changes nothing", async () => {
  await withRepo(async (repoDir, repo) => {
    const serve = await startInstance(repoDir, repo, config());
    try {
      const reloaded = await serve.reload(
        config({ admins: ["user:alice", "user:carol"] }),
      );
      assertEquals(reloaded.report.applied, []);
      assertEquals(reloaded.report.needsRestart, [{
        setting: "auth.admins",
        reason: ADMIN_ADDITION_NEEDS_RESTART,
      }]);
      assertEquals(serve.isAdmin("user:carol"), false);
    } finally {
      await serve.close();
    }
  });
});

Deno.test("serve grant reload: swapping one admin for another applies the removal and reports the addition as needing a restart", async () => {
  await withRepo(async (repoDir, repo) => {
    const serve = await startInstance(repoDir, repo, config());
    try {
      const swapped = await serve.reload(config({ admins: ["user:bob"] }));
      assertEquals(swapped.report.applied, ["auth.admins"]);
      assertEquals(swapped.report.needsRestart, [{
        setting: "auth.admins",
        reason: ADMIN_ADDITION_NEEDS_RESTART,
      }]);
      assertEquals(serve.isAdmin("user:alice"), false);
      assertEquals(serve.isAdmin("user:bob"), false);
      assertEquals(serve.authConfig.admins, []);
    } finally {
      await serve.close();
    }
    // the restart adds bob
    const restarted = await startInstance(
      repoDir,
      repo,
      config({ admins: ["user:bob"] }),
    );
    try {
      assertEquals(restarted.isAdmin("user:bob"), true);
      assertEquals(restarted.isAdmin("user:alice"), false);
    } finally {
      await restarted.close();
    }
  });
});

Deno.test("serve grant reload: team mode keeps a removed admin revoked when a leader that has not reloaded takes over, and keeps an admin a newer restart added", async () => {
  await withRepo(async (repoDir, repo) => {
    const leader = await startInstance(
      repoDir,
      repo,
      config({ admins: ["user:alice", "user:bob"] }),
    );
    // booted before the leader's reload and never reloaded since
    const stale = await startInstance(
      repoDir,
      repo,
      config({ admins: ["user:alice", "user:bob"] }),
      { bootedAt: new Date(Date.now() - 60_000) },
    );
    try {
      await leader.reload(config({ admins: ["user:alice"] }));
      assertEquals(leader.isAdmin("user:bob"), false);

      await stale.takeLead();
      assertEquals(stale.isAdmin("user:bob"), false);
      assertEquals(stale.isAdmin("user:alice"), true);
    } finally {
      await leader.close();
    }
    // a restart swapped alice for carol; the stale node then leads again
    const restarted = await startInstance(
      repoDir,
      repo,
      config({ admins: ["user:carol"] }),
    );
    try {
      await stale.takeLead();
      assertEquals(stale.isAdmin("user:carol"), true);
      assertEquals(stale.isAdmin("user:alice"), false);
    } finally {
      await restarted.close();
      await stale.close();
    }
  });
});

Deno.test("serve grant reload: a node that does not lead grant writes reports the removal for the leader, and revokes it on taking the lead", async () => {
  await withRepo(async (repoDir, repo) => {
    let leads = false;
    const follower = await startInstance(
      repoDir,
      repo,
      config({ admins: ["user:alice", "user:bob"] }),
      { leads: () => leads },
    );
    try {
      const reloaded = await follower.reload(
        config({ admins: ["user:alice"] }),
      );
      assertEquals(reloaded.report.applied, ["auth.admins"]);
      assertEquals(reloaded.report.needsRestart, [{
        setting: "auth.admins",
        reason: GRANT_WRITES_ELSEWHERE,
      }]);
      assertEquals(follower.isAdmin("user:bob"), true);

      leads = true;
      await follower.takeLead();
      assertEquals(follower.isAdmin("user:bob"), false);
    } finally {
      await follower.close();
    }
  });
});

Deno.test("serve grant reload: a switch to auto after shutdown closed the poller leaves no poller running", async () => {
  await withRepo(async (repoDir, repo) => {
    const grantsFile = join(repoDir, "grants.yaml");
    await atomicWriteTextFile(grantsFile, RUN_GRANT);
    const serve = await startInstance(repoDir, repo, config({ grantsFile }));
    try {
      await serve.poller.close();
      await serve.reload(config({ grantsFile, grantReload: "auto" }));
      // never started, so one reconcile applies an emptied source at once
      await atomicWriteTextFile(grantsFile, "");
      await serve.poller.reconcileNow();
      assertEquals(serve.allows("user:dev", "run"), false);
    } finally {
      await serve.close();
    }
  });
});
