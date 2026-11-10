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

// A reload that changes allowed-users or allowed-collectives reaches every
// admission check serve makes, through the reloader that serve wires.
import { assertEquals } from "@std/assert";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  type MergedServeOptions,
  mergeServeOptions,
  type ServeConfigFile,
} from "../src/serve/serve_config.ts";
import {
  buildServeAuthConfig,
  type ServeAuthConfig,
} from "../src/domain/access/serve_auth_config.ts";
import { checkAdmission } from "../src/domain/access/admission.ts";
import { createTokenAdmissionChecker } from "../src/serve/token_admission.ts";
import {
  type AllowedUsersReloadPlan,
  planAllowedUsersReload,
} from "../src/serve/serve_access_list_reload.ts";
import {
  createServeSettingsReloader,
  type SettingAppliers,
} from "../src/serve/serve_settings_reloader.ts";
import { SETTING_CATALOGUE } from "../src/serve/serve_settings_reload.ts";

await initializeLogging({});

const PROVIDER = "https://club.example";

interface Prepared {
  allowedUsers?: AllowedUsersReloadPlan;
}

function oauthFile(users: string[], collectives: string[] = []) {
  return {
    auth: {
      mode: "oauth",
      "oauth-provider": PROVIDER,
      "oauth-client-id": "client-1",
      admins: ["root"],
      ...(users.length > 0 ? { "allowed-users": users } : {}),
      ...(collectives.length > 0 ? { "allowed-collectives": collectives } : {}),
    },
  } as unknown as ServeConfigFile;
}

/** serve's wiring of the access lists, with a lookup table for swamp-club */
function serveLike(initial: ServeConfigFile, subs: Record<string, string>) {
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
  const merge = (file: ServeConfigFile | null) =>
    mergeServeOptions(file, {}, new Set(), () => undefined);
  const authConfig = toAuth(merge(initial));
  let cache: Record<string, string> = Object.create(null);
  for (const name of authConfig.allowedUsers) {
    cache[`allowed:${name}`] = subs[name];
  }
  authConfig.allowedUsers.splice(
    0,
    authConfig.allowedUsers.length,
    ...authConfig.allowedUsers.map((name) => subs[name]),
  );
  let deferred = false;
  let file: ServeConfigFile | null = initial;
  let lookupsUp = true;

  const applyUsers = (prepared: Prepared) => {
    const plan = prepared.allowedUsers!;
    authConfig.allowedUsers.splice(
      0,
      authConfig.allowedUsers.length,
      ...plan.allowedUsers,
    );
    cache = { ...plan.cache };
    deferred = plan.deferred.length > 0;
  };
  const noop = () => {};
  const appliers = Object.fromEntries(
    (Object.keys(SETTING_CATALOGUE) as (keyof MergedServeOptions)[])
      .filter((key) => SETTING_CATALOGUE[key].reloadClass === "applied")
      .map((key) => [key, noop]),
  ) as unknown as SettingAppliers<{ authConfig: ServeAuthConfig }, Prepared>;
  const reloader = createServeSettingsReloader<
    { authConfig: ServeAuthConfig },
    Prepared
  >({
    initialConfig: initial,
    explicitFlags: new Set(),
    envLookup: () => undefined,
    load: () => file,
    merge,
    resolve: (merged) => ({ authConfig: toAuth(merged) }),
    prepare: async ({ startup }) => ({
      allowedUsers: await planAllowedUsersReload({
        configured: startup.authConfig.allowedUsers,
        allowedCollectives: startup.authConfig.allowedCollectives,
        cache,
        resolve: (name) =>
          lookupsUp && Object.hasOwn(subs, name)
            ? Promise.resolve(subs[name])
            : Promise.reject(new Error("club unreachable")),
        now: () => "2026-11-10T00:00:00.000Z",
      }),
    }),
    notRunning: () => ({}),
    pending: () => deferred ? ["allowedUsers"] : [],
    appliers: {
      ...appliers,
      allowedUsers: (_candidate, prepared) => applyUsers(prepared),
      allowedCollectives: ({ startup }, prepared) => {
        authConfig.allowedCollectives.splice(
          0,
          authConfig.allowedCollectives.length,
          ...startup.authConfig.allowedCollectives,
        );
        applyUsers(prepared);
      },
    },
    beforeCommit: noop,
    afterCommit: noop,
    followUps: () => [],
  });
  const admission = createTokenAdmissionChecker({
    lists: () => authConfig,
    hasStoredLogin: () => Promise.resolve(true),
  });
  // the delegation link service holds the arrays themselves
  const delegationLists = {
    allowedCollectives: authConfig.allowedCollectives,
    allowedUsers: authConfig.allowedUsers,
  };
  return {
    authConfig,
    admission,
    delegationLists,
    write: (next: ServeConfigFile) => file = next,
    setLookups: (up: boolean) => lookupsUp = up,
    reload: () => reloader({ trigger: "reload" }),
  };
}

function loginToken(sub: string) {
  return {
    name: `tok-${sub}`,
    principalId: `user:${sub}`,
    collectives: [] as string[],
    createdAt: "2026-11-01T00:00:00.000Z",
    vaultName: "default",
    oauthIdentity: { email: `${sub}@example.com` },
  };
}

async function admittedEverywhere(
  serve: ReturnType<typeof serveLike>,
  sub: string,
): Promise<boolean[]> {
  return [
    // server tokens and dashboard sessions
    (await serve.admission.serverToken(loginToken(sub))).admitted,
    // delegation refresh
    serve.admission.delegation({ sub, collectives: [] }).admitted,
    // delegation consent
    checkAdmission(
      sub,
      [],
      serve.delegationLists.allowedCollectives,
      serve.delegationLists.allowedUsers,
    ).admitted,
  ];
}

Deno.test("serve access list reload: a person removed from allowed-users is refused by every admission check", async () => {
  const serve = serveLike(oauthFile(["alice", "bob"]), {
    alice: "sub-a",
    bob: "sub-b",
  });
  assertEquals(await admittedEverywhere(serve, "sub-b"), [true, true, true]);
  serve.write(oauthFile(["alice"]));
  const outcome = await serve.reload();
  assertEquals(outcome.report.applied, ["auth.allowed-users"]);
  assertEquals(await admittedEverywhere(serve, "sub-b"), [
    false,
    false,
    false,
  ]);
  assertEquals(await admittedEverywhere(serve, "sub-a"), [true, true, true]);
});

Deno.test("serve access list reload: [A] to [B] with B not resolvable admits nobody, reports B, and a later reload admits B", async () => {
  const serve = serveLike(oauthFile(["alice"]), {
    alice: "sub-a",
    bob: "sub-b",
  });
  serve.setLookups(false);
  serve.write(oauthFile(["bob"]));
  const first = await serve.reload();
  assertEquals(await admittedEverywhere(serve, "sub-a"), [
    false,
    false,
    false,
  ]);
  assertEquals(await admittedEverywhere(serve, "sub-b"), [
    false,
    false,
    false,
  ]);
  assertEquals(first.report.applied, ["auth.allowed-users"]);

  serve.setLookups(true);
  // the file is unchanged; the deferred name is retried
  const second = await serve.reload();
  assertEquals(second.report.applied, ["auth.allowed-users"]);
  assertEquals(await admittedEverywhere(serve, "sub-b"), [true, true, true]);
});

Deno.test("serve access list reload: emptying the collectives keeps a list of deferred names closed", async () => {
  const serve = serveLike(oauthFile(["alice"], ["acme"]), {
    alice: "sub-a",
  });
  serve.setLookups(false);
  serve.write(oauthFile(["carol"], ["acme"]));
  await serve.reload();
  serve.write(oauthFile(["carol"]));
  await serve.reload();
  assertEquals(await admittedEverywhere(serve, "sub-anyone"), [
    false,
    false,
    false,
  ]);
});
