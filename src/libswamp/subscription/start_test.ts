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

import { assertEquals } from "@std/assert";
import {
  type AuthCredentials,
  DEFAULT_SWAMP_CLUB_URL,
} from "../../domain/auth/auth_credentials.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  createSubscriptionStartDeps,
  subscriptionStart,
  type SubscriptionStartDeps,
  type SubscriptionStartEvent,
  type SubscriptionStartInput,
} from "./start.ts";

const credentials: AuthCredentials = {
  serverUrl: "https://club.example.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "keeb",
};

function makeDeps(overrides: {
  serverUrl?: string;
  opens?: boolean;
} = {}): { deps: SubscriptionStartDeps; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    deps: {
      resolveServerUrl: () =>
        Promise.resolve(overrides.serverUrl ?? "https://swamp-club.com"),
      openBrowser: (url) => {
        opened.push(url);
        return Promise.resolve(overrides.opens ?? true);
      },
    },
  };
}

function run(
  deps: SubscriptionStartDeps,
  input: Partial<SubscriptionStartInput> = {},
): Promise<SubscriptionStartEvent[]> {
  return collect<SubscriptionStartEvent>(
    subscriptionStart(createLibSwampContext(), deps, {
      noBrowser: false,
      ...input,
    }),
  );
}

Deno.test("subscriptionStart: opens the billing page", async () => {
  const { deps, opened } = makeDeps();

  assertEquals(await run(deps), [
    { kind: "opening_browser", url: "https://swamp-club.com/billing" },
    {
      kind: "completed",
      result: {
        url: "https://swamp-club.com/billing",
        collective: null,
        browser: "opened",
      },
    },
  ]);
  assertEquals(opened, ["https://swamp-club.com/billing"]);
});

Deno.test("subscriptionStart: a collective opens its own billing page", async () => {
  const { deps, opened } = makeDeps();

  const events = await run(deps, { collective: "acme" });

  assertEquals(events.at(-1), {
    kind: "completed",
    result: {
      url: "https://swamp-club.com/o/acme/billing",
      collective: "acme",
      browser: "opened",
    },
  });
  assertEquals(opened, ["https://swamp-club.com/o/acme/billing"]);
});

Deno.test("subscriptionStart: a slug with spaces and an ampersand is encoded", async () => {
  const { deps, opened } = makeDeps();

  const events = await run(deps, { collective: "a b&c" });

  assertEquals(opened, ["https://swamp-club.com/o/a%20b%26c/billing"]);
  assertEquals(events.at(-1), {
    kind: "completed",
    result: {
      url: "https://swamp-club.com/o/a%20b%26c/billing",
      collective: "a b&c",
      browser: "opened",
    },
  });
});

Deno.test("subscriptionStart: a trailing slash on the server is stripped", async () => {
  const { deps, opened } = makeDeps({ serverUrl: "https://swamp-club.com/" });

  await run(deps);

  assertEquals(opened, ["https://swamp-club.com/billing"]);
});

Deno.test("subscriptionStart: noBrowser hands back the URL and never calls the opener", async () => {
  const { deps, opened } = makeDeps();

  assertEquals(await run(deps, { noBrowser: true, collective: "acme" }), [
    {
      kind: "completed",
      result: {
        url: "https://swamp-club.com/o/acme/billing",
        collective: "acme",
        browser: "skipped",
      },
    },
  ]);
  assertEquals(opened, []);
});

Deno.test("subscriptionStart: an opener failure is an outcome, not an error", async () => {
  const { deps } = makeDeps({ opens: false });

  assertEquals(await run(deps), [
    { kind: "opening_browser", url: "https://swamp-club.com/billing" },
    {
      kind: "completed",
      result: {
        url: "https://swamp-club.com/billing",
        collective: null,
        browser: "failed",
      },
    },
  ]);
});

Deno.test("createSubscriptionStartDeps: SWAMP_CLUB_URL wins over the stored credential", async () => {
  let loaded = false;
  const deps = createSubscriptionStartDeps({
    loadCredentials: () => {
      loaded = true;
      return Promise.resolve(credentials);
    },
  });

  const serverUrl = await withMockedEnv(
    { SWAMP_CLUB_URL: "https://override.example.com" },
    () => deps.resolveServerUrl(),
  );

  assertEquals(serverUrl, "https://override.example.com");
  assertEquals(loaded, false);
});

Deno.test("createSubscriptionStartDeps: the stored credential's server is next", async () => {
  const deps = createSubscriptionStartDeps({
    loadCredentials: () => Promise.resolve(credentials),
  });

  const serverUrl = await withMockedEnv(
    { SWAMP_CLUB_URL: undefined },
    () => deps.resolveServerUrl(),
  );

  assertEquals(serverUrl, "https://club.example.com");
});

Deno.test("createSubscriptionStartDeps: the default server without credentials", async () => {
  const deps = createSubscriptionStartDeps({
    loadCredentials: () => Promise.resolve(null),
  });

  const serverUrl = await withMockedEnv(
    { SWAMP_CLUB_URL: undefined },
    () => deps.resolveServerUrl(),
  );

  assertEquals(serverUrl, DEFAULT_SWAMP_CLUB_URL);
});
